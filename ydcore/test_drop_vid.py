"""DiskLRU.drop_vid: 立即释放某 vid 的全部条目(文件+size)，
用于缩略图生成完后丢弃源段, 不必等 LRU 慢慢淘汰。"""
import os
import tempfile
import unittest

from ydcore.cache import DiskLRU


def _seg(lru, url, vid, n=10):
    lru.put((url, vid), ("video/mp2t", b"x" * n))


class DropVidTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dropvid_")
        self.lru = DiskLRU(10 * 1024 * 1024, persist_dir=self.dir)

    def test_drop_vid_removes_only_that_vid(self):
        # A: 3 段, B: 2 段
        _seg(self.lru, "http://h/a1.ts", "A", 100)
        _seg(self.lru, "http://h/a2.ts", "A", 100)
        _seg(self.lru, "http://h/a3.ts", "A", 100)
        _seg(self.lru, "http://h/b1.ts", "B", 50)
        _seg(self.lru, "http://h/b2.ts", "B", 50)
        size_before = self.lru.size
        self.assertEqual(size_before, 100 * 3 + 50 * 2)

        # 记下 A 的盘上文件, 删后应消失
        a_files = [m[2] for (u, v), m in self.lru.meta.items() if v == "A"]
        self.assertEqual(len(a_files), 3)

        removed = self.lru.drop_vid("A")
        self.assertEqual(removed, 3)  # 返回删了几条
        # A 的内存条目全清
        self.assertFalse(any(v == "A" for (u, v) in self.lru.meta))
        # B 完整保留
        self.assertEqual(sum(1 for (u, v) in self.lru.meta if v == "B"), 2)
        # size 精确减去 A 的字节
        self.assertEqual(self.lru.size, 50 * 2)
        # A 的盘文件真删了
        for fn in a_files:
            self.assertFalse(os.path.exists(os.path.join(self.lru.dir, fn)))
        # B 的盘文件还在
        b_files = [m[2] for (u, v), m in self.lru.meta.items() if v == "B"]
        for fn in b_files:
            self.assertTrue(os.path.exists(os.path.join(self.lru.dir, fn)))

    def test_drop_vid_missing_is_noop(self):
        _seg(self.lru, "http://h/b1.ts", "B", 50)
        size_before = self.lru.size
        removed = self.lru.drop_vid("DOES_NOT_EXIST")
        self.assertEqual(removed, 0)
        self.assertEqual(self.lru.size, size_before)


if __name__ == "__main__":
    unittest.main()
