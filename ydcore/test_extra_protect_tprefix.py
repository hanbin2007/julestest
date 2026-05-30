"""僵尸保护治本(#5): t_ 前缀(缩略图源段生成期保护)绝不落盘/回载进 extra_protect。

重启(kill-9 是标准重部署)若正落在生成窗口, playhead.json 里的 t_<vid> 会被
回载进 _extra_protect 且永无 worker 移除 -> 永久僵尸保护慢慢吃掉有效缓存容量。
两端都过滤 t_: 落盘快照过滤 + 回载过滤(回载过滤还能自愈已被污染的 playhead.json)。
"""
import unittest

from ydcore.cache import DiskLRU


class TPrefixProtectTest(unittest.TestCase):
    def test_t_prefixed_not_persisted_and_not_loaded(self):
        lru = DiskLRU(10 * 1024 * 1024)          # 非持久化即可测 protect 集 set/get
        lru.add_protect_vid("123")
        lru.add_protect_vid("t_999")
        snap = lru.extra_protect_vids()
        self.assertIn("123", snap)
        self.assertNotIn("t_999", snap)          # 生成期保护不落盘
        lru.set_extra_protect(["123", "t_888"])  # 即便盘上有 t_ 也不回载
        self.assertIn("123", lru._extra_protect)
        self.assertNotIn("t_888", lru._extra_protect)


if __name__ == "__main__":
    unittest.main()
