"""playhead 写盘不撕裂(#19 治本后): playhead 专用锁已退役 —— 撕裂洞由
_atomic_write_json 的【唯一 tmp 名】根上堵死(各写各的 tmp + 原子 os.replace),
不再靠 _playhead_lock 串行化绕过共享 tmp 名。

本测试保留端到端不变量(真正要保证的): 高并发反复写 playhead 后, 盘上 playhead.json
永远是【完整可解析】的 JSON。同时断言专用锁确已退役(治本而非加锁绕过)。

纯单元测试, 无 live server: Gateway.__new__ + _init_persist_min 搭出持久化骨架。
"""
import json
import os
import shutil
import tempfile
import threading
import unittest

from ydcore.gateway import Gateway


class PlayheadWriteTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="phwrite_")
        self.gw = Gateway.__new__(Gateway)
        self.gw._init_persist_min(self.d, ok=True)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_playhead_lock_retired(self):
        """#19 治本: playhead 专用锁退役(唯一 tmp 名根上堵撕裂, 无需串行化锁)。"""
        self.assertFalse(hasattr(self.gw, "_playhead_lock"),
                         "playhead 专用锁应已退役(改由唯一 tmp 名堵撕裂洞)")

    def test_concurrent_saves_never_corrupt_file(self):
        """高并发反复写后, 盘上 playhead.json 永远是完整可解析 JSON(端到端失败信号)。

        每个线程把 playhead 设成自己专属的大 payload 再写盘; 另一线程不停读盘解析。
        共享 tmp + 无锁时, os.replace 可能落成被另一写者截断的半个文件 -> json 解析炸。
        唯一 tmp + 原子 replace 后: 目标永远是某次完整写入。
        """
        gw = self.gw
        stop = threading.Event()
        errors = []

        def writer(tag):
            payload = {str(tag): "x" * 4096}  # 足够大, 放大撕裂窗口
            for _ in range(40):
                if stop.is_set():
                    return
                gw.playhead = dict(payload)
                gw._save_playhead()

        def reader():
            while not stop.is_set():
                try:
                    with open(gw.playhead_path, encoding="utf-8") as f:
                        json.load(f)  # 必须随时都能完整解析
                except FileNotFoundError:
                    pass
                except Exception as e:  # noqa: BLE001 — 撕裂/截断的 JSON 解析失败即 bug
                    errors.append(repr(e))
                    return

        writers = [threading.Thread(target=writer, args=(i,)) for i in range(6)]
        rthread = threading.Thread(target=reader)
        rthread.start()
        for t in writers:
            t.start()
        for t in writers:
            t.join()
        stop.set()
        rthread.join()

        # 收尾: 最终盘上文件也必须是完整 JSON
        with open(gw.playhead_path, encoding="utf-8") as f:
            json.load(f)
        self.assertEqual(errors, [], "并发写期间读到了撕裂/截断的 playhead.json: %r" % errors)
        # 不残留 .tmp(每次写的唯一 tmp 都被原子 replace 消费)
        leftover = [f for f in os.listdir(self.d) if f.endswith(".tmp")]
        self.assertEqual(leftover, [], "并发写后不应残留 .tmp: %r" % leftover)


if __name__ == "__main__":
    unittest.main()
