"""缩略图源段物理隔离(#1,#8): 缩略图源段进独立小桶 DiskLRU(thumb_seg_cache),
不再和播放段共享 256MB seg_cache。这样生成 D 的缩略图绝不会把已缓存的 A/B/C
播放段挤出(它们不在 _live_vid/_extra_protect 里), 且生成完即 drop 源段。"""
import os
import tempfile
import unittest

from ydcore.gateway import Gateway, _THUMB_CACHE_BYTES


def _seg(lru, url, vid, n):
    lru.put((url, vid), ("video/mp2t", b"x" * n))


class ThumbIsolationTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="thumbiso_")
        self.gw = Gateway.__new__(Gateway)
        self.gw._init_persist_min(self.dir, ok=True)

    def test_separate_bounded_thumb_cache_exists(self):
        # 第二个 DiskLRU, 小硬上限, 与 seg_cache 物理分离(不同目录、不同 size)。
        self.assertTrue(hasattr(self.gw, "thumb_seg_cache"))
        self.assertIsNot(self.gw.thumb_seg_cache, self.gw.seg_cache)
        self.assertNotEqual(self.gw.thumb_seg_cache.dir, self.gw.seg_cache.dir)
        # 小桶上限明显小于 256MB 播放桶
        self.assertEqual(self.gw.thumb_seg_cache.max, _THUMB_CACHE_BYTES)
        self.assertLess(self.gw.thumb_seg_cache.max, self.gw.seg_cache.max)

    def test_seg_cache_for_routes_by_prefix(self):
        # 路由 seam: t_ 前缀 -> thumb 桶; 其余 -> 播放桶。
        self.assertIs(self.gw._seg_cache_for("t_123"), self.gw.thumb_seg_cache)
        self.assertIs(self.gw._seg_cache_for("123"), self.gw.seg_cache)

    def test_thumb_prefetch_does_not_evict_playback(self):
        # A/B/C 各灌满播放段, 把 seg_cache 顶到接近上限(都不在保护集)。
        n = 8 * 1024 * 1024
        per_vid = self.gw.seg_cache.max // (3 * n)  # 每集多少段把三集合计接近上限
        self.assertGreaterEqual(per_vid, 2)
        for v in ("A", "B", "C"):
            for i in range(per_vid):
                _seg(self.gw.seg_cache, "http://h/%s_%d.ts" % (v, i), v, n)
        before = {v: self.gw.seg_cache.count_vid(v) for v in ("A", "B", "C")}
        self.assertTrue(all(c == per_vid for c in before.values()))
        seg_size_before = self.gw.seg_cache.size

        # 给 D 灌缩略图源段, 量上超过 thumb 桶上限 -> 必须 thumb 桶自淘汰,
        # 绝不能碰 seg_cache 里的 A/B/C 播放段。走 _seg_cache_for 路由(生产同一路径)。
        tvid = "t_D"
        over = (self.gw.thumb_seg_cache.max // n) + 4  # 远超 thumb 桶
        for i in range(over):
            cache = self.gw._seg_cache_for(tvid)
            _seg(cache, "http://h/D_%d.ts" % i, tvid, n)

        # (a) A/B/C 播放段一片不少, seg_cache 总字节不变
        after = {v: self.gw.seg_cache.count_vid(v) for v in ("A", "B", "C")}
        self.assertEqual(after, before)
        self.assertEqual(self.gw.seg_cache.size, seg_size_before)
        # 缩略图源段绝不在 seg_cache 里
        self.assertEqual(self.gw.seg_cache.count_vid(tvid), 0)
        # (b) thumb 桶自己在自己的上限内自淘汰
        self.assertLessEqual(self.gw.thumb_seg_cache.size, self.gw.thumb_seg_cache.max)
        self.assertGreater(self.gw.thumb_seg_cache.count_vid(tvid), 0)

    def test_drop_after_gen_releases_thumb_source(self):
        # 生成完调 drop_vid('t_'+vid): thumb 桶里该 vid 源段立即清空。
        n = 1024 * 1024
        tvid = "t_E"
        for i in range(5):
            _seg(self.gw._seg_cache_for(tvid), "http://h/E_%d.ts" % i, tvid, n)
        self.assertGreater(self.gw.thumb_seg_cache.count_vid(tvid), 0)
        self.gw.thumb_seg_cache.drop_vid(tvid)
        self.assertEqual(self.gw.thumb_seg_cache.count_vid(tvid), 0)
        self.assertEqual(self.gw.thumb_seg_cache.size, 0)

    def test_negative_control_single_bucket_would_evict_playback(self):
        """真 negative control: 证明上面的隔离断言不是恒真。若把路由【退化成单桶】
        (旧 broken 行为: 缩略图源段也灌进同一 256MB 播放桶), 大批缩略图源段会把已缓存
        的 A/B/C 播放段挤出 -> count 下降。这条恰好相反地"应当被挤出", 用来证明物理分桶
        路由(_seg_cache_for)才是隔离生效的真正原因, 而非测试构造的巧合。"""
        n = 8 * 1024 * 1024
        per_vid = self.gw.seg_cache.max // (3 * n)
        self.assertGreaterEqual(per_vid, 2)
        for v in ("A", "B", "C"):
            for i in range(per_vid):
                _seg(self.gw.seg_cache, "http://h/%s_%d.ts" % (v, i), v, n)
        before = {v: self.gw.seg_cache.count_vid(v) for v in ("A", "B", "C")}
        self.assertTrue(all(c == per_vid for c in before.values()))

        # 退化路由: 直接把缩略图源段灌进【播放桶 seg_cache】(模拟旧 broken: 无 _seg_cache_for)。
        tvid = "t_D"
        over = (self.gw.seg_cache.max // n) + 4  # 远超播放桶
        for i in range(over):
            _seg(self.gw.seg_cache, "http://h/D_%d.ts" % i, tvid, n)  # 故意灌进播放桶

        # 单桶下: A/B/C 播放段被挤出(总和下降), 这正是隔离要防止的。
        after_total = sum(self.gw.seg_cache.count_vid(v) for v in ("A", "B", "C"))
        before_total = sum(before.values())
        self.assertLess(after_total, before_total,
                        "单桶退化下播放段【应当】被缩略图源段挤出(否则隔离断言是恒真巧合): "
                        "before=%d after=%d" % (before_total, after_total))


if __name__ == "__main__":
    unittest.main()
