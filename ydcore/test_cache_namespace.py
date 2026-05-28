"""DiskLRU 命名空间拆分: cache.py 不再硬编码 't_' 前缀, 改由调用方注入 splitter。"""
import os
import tempfile
import unittest

from ydcore.cache import DiskLRU


def _seg(url, vid, lru, n=10):
    lru.put((url, vid), ("video/mp2t", b"x" * n))


class NamespaceSplitterTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ns_test_")
        self.lru = DiskLRU(10 * 1024 * 1024, persist_dir=self.dir)

    def test_default_splitter_is_identity(self):
        # 不注入 splitter: 所有 vid 进 real, thumb 空 (cache.py 不再认识 't_')
        _seg("http://h/a.ts", "vid1", self.lru)
        _seg("http://h/b.ts", "t_vid2", self.lru)
        st = self.lru.vid_stats()
        self.assertIn("vid1", st["real"])
        self.assertIn("t_vid2", st["real"])  # 默认下 't_vid2' 是普通 vid
        self.assertEqual(st["thumb"], {})

    def test_injected_splitter_routes_thumb(self):
        # 注入 gateway 的拆分规则: 't_' 前缀 → thumb 桶, key 去前缀
        self.lru.set_namespace_splitter(
            lambda vid: ("thumb", vid[2:]) if isinstance(vid, str) and vid.startswith("t_") else ("real", vid)
        )
        _seg("http://h/a.ts", "vid1", self.lru)
        _seg("http://h/b.ts", "t_vid1", self.lru)
        st = self.lru.vid_stats()
        self.assertEqual(st["real"]["vid1"]["segments"], 1)
        self.assertEqual(st["thumb"]["vid1"]["segments"], 1)
        self.assertNotIn("t_vid1", st["real"])


if __name__ == "__main__":
    unittest.main()
