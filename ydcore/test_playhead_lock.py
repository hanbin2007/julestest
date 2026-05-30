"""playhead 写盘串行化(#19): 5s 节流 flush 与掉盘恢复 reflush 在不同线程, 都走
_save_playhead -> _atomic_write_json(playhead_path, ...)。

旧 bug: _atomic_write_json 用共享 tmp 名 (path + ".tmp"), 两线程并发时:
  · A open(tmp,"w") 截断 tmp 开始写 -> B 也 open(tmp,"w") 把 A 写一半的 tmp 又截断
  · 两个 os.replace(tmp, path) 交错 -> playhead.json 可能落成截断/撕裂的半个 JSON
治本: _save_playhead 的写盘段用一把 _playhead_lock 串行化(同一 path 不并发写)。

纯单元测试, 无 live server: 用 Gateway.__new__ + _init_persist_min 搭出持久化骨架,
直接并发调 _save_playhead, 断言:
  1. 锁存在且写盘段被它包住(两次写盘不交叠);
  2. 高并发反复写后, 盘上 playhead.json 永远是【完整可解析】的 JSON(失败信号)。
"""
import json
import os
import shutil
import tempfile
import threading
import time
import unittest

from ydcore.gateway import Gateway


class PlayheadLockTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="phlock_")
        self.gw = Gateway.__new__(Gateway)
        self.gw._init_persist_min(self.d, ok=True)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_has_playhead_lock(self):
        """_save_playhead 串行化所需的锁必须存在(结构性断言)。"""
        self.assertIsInstance(self.gw._playhead_lock, type(threading.Lock()))

    def test_save_playhead_writes_are_serialized(self):
        """两个线程同时 _save_playhead 时, 其写盘段(_atomic_write_json)不得交叠。

        失败信号: 不加锁 -> 两次写盘临界区重叠, in_flight 峰值 > 1; 加锁后恒为 1。
        """
        gw = self.gw
        real_write = gw._atomic_write_json
        state = {"in_flight": 0, "max_overlap": 0}
        slock = threading.Lock()

        def slow_write(path, data, ok_gate=None):
            # 只盯 playhead.json 的写, 别的(thumb/seg)忽略
            if path != gw.playhead_path:
                return real_write(path, data, ok_gate)
            with slock:
                state["in_flight"] += 1
                state["max_overlap"] = max(state["max_overlap"], state["in_flight"])
            try:
                time.sleep(0.02)  # 放大窗口, 让没锁保护时一定撞上
                return real_write(path, data, ok_gate)
            finally:
                with slock:
                    state["in_flight"] -= 1

        gw._atomic_write_json = slow_write
        try:
            threads = [threading.Thread(target=gw._save_playhead) for _ in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        finally:
            gw._atomic_write_json = real_write

        self.assertEqual(
            state["max_overlap"], 1,
            "playhead 写盘段并发交叠 (max_overlap=%d): _save_playhead 未被锁串行化"
            % state["max_overlap"],
        )

    def test_concurrent_saves_never_corrupt_file(self):
        """高并发反复写后, 盘上 playhead.json 永远是完整可解析 JSON(端到端失败信号)。

        每个线程把 playhead 设成自己专属的大 payload 再写盘; 另一线程不停读盘解析。
        共享 tmp + 无锁时, os.replace 可能落成被另一写者截断的半个文件 -> json 解析炸。
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


if __name__ == "__main__":
    unittest.main()
