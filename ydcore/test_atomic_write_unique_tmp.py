"""nit #19 治本: _atomic_write_json 的 tmp 名加唯一后缀, 一举覆盖所有 *.json 撕裂洞。

旧版用共享 tmp 名 (path + ".tmp"): 两线程并发写【同一 path】时 ——
  · A open(tmp,"w") 截断 tmp 开始写 -> B 也 open(tmp,"w") 把 A 写一半的 tmp 又截断
  · 两个 os.replace(tmp, path) 交错 -> 目标 JSON 落成截断/撕裂的半文件。
playhead 此前靠专用锁 (_playhead_lock) 串行化绕过, 但 seg_urls/video_meta/pf_done 等
同样并发写同一 path 时无锁保护, 一样会撕裂(#19 治本就是从 tmp 名根上堵死)。

治本: 每次写用唯一 tmp 名 (path + '.' + pid + '.' + tid + '.tmp'), 不同写者各写各的 tmp,
os.replace 是原子的 -> 目标文件任意时刻都是某个完整写入, 永不撕裂。playhead 专用锁可退役。

失败信号: 用共享 tmp 名时, 高并发写同一 path + 不停读盘解析 -> 读到撕裂 JSON 解析炸。
"""
import json
import os
import shutil
import tempfile
import threading
import unittest

from ydcore.gateway import Gateway


class AtomicWriteUniqueTmpTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="atomictmp_")
        self.gw = Gateway.__new__(Gateway)
        self.gw._init_persist_min(self.d, ok=True)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_unique_tmp_name_per_write(self):
        """同一 path 的两次写应使用不同的 tmp 文件名(结构性断言: tmp 名带唯一后缀)。"""
        seen = []
        real_replace = os.replace

        def spy_replace(src, dst):
            if dst == self.gw.seg_urls_path:
                seen.append(src)
            return real_replace(src, dst)

        path = self.gw.seg_urls_path

        def worker(tag):
            os.replace = spy_replace  # 进程级 monkeypatch, 测试内单线程改即可
            self.gw._atomic_write_json(path, {str(tag): list(range(50))})

        # 串行两次写, 收集各自的 tmp 名
        try:
            worker(1)
            worker(2)
        finally:
            os.replace = real_replace
        self.assertEqual(len(seen), 2)
        self.assertNotEqual(seen[0], seen[1],
                            "两次写应使用不同 tmp 名(唯一后缀), 实得相同: %r" % seen)
        # 收尾后目录里不该残留 .tmp(成功 replace 都被消费)
        leftover = [f for f in os.listdir(self.d) if f.endswith(".tmp")]
        self.assertEqual(leftover, [], "成功写后不应残留 .tmp: %r" % leftover)

    def test_concurrent_same_path_never_corrupt(self):
        """多线程高并发写【同一 path】(seg_urls.json) + 另一线程不停读解析: 永不撕裂。

        这是 #19 的根因覆盖: 不依赖任何专用锁, 仅靠唯一 tmp 名 + os.replace 原子性。
        """
        path = self.gw.seg_urls_path
        stop = threading.Event()
        errors = []

        def writer(tag):
            payload = {str(tag): ["x" * 256] * 64}  # 足够大放大撕裂窗口
            for _ in range(60):
                if stop.is_set():
                    return
                self.gw._atomic_write_json(path, payload)

        def reader():
            while not stop.is_set():
                try:
                    with open(path, encoding="utf-8") as f:
                        json.load(f)
                except FileNotFoundError:
                    pass
                except Exception as e:  # noqa: BLE001 撕裂/截断解析失败即 bug
                    errors.append(repr(e))
                    return

        writers = [threading.Thread(target=writer, args=(i,)) for i in range(8)]
        rthreads = [threading.Thread(target=reader) for _ in range(2)]
        for t in rthreads:
            t.start()
        for t in writers:
            t.start()
        for t in writers:
            t.join()
        stop.set()
        for t in rthreads:
            t.join()

        with open(path, encoding="utf-8") as f:
            json.load(f)  # 收尾文件也必须完整
        self.assertEqual(errors, [], "并发写同一 path 读到撕裂 JSON: %r" % errors)
        leftover = [f for f in os.listdir(self.d) if f.endswith(".tmp")]
        self.assertEqual(leftover, [], "并发写后不应残留 .tmp: %r" % leftover)


if __name__ == "__main__":
    unittest.main()
