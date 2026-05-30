"""缩略图源段预取可取消 (#6, #9) — 无 live server, 纯内存 + 临时目录 + 桩 pri_fetch。

覆盖:
  · _gen_thumbs_inner 里 `for u in urls` 预取循环必须每轮复查 thumb_meta[vid].state:
    一旦取消(act_thumb 把 state 置 "cancelled"), 预取应立即 break/return, 不再下载剩余源段,
    也不应继续去 Popen 启动 ffmpeg。
  · 与出队复查(_thumb_worker)/ffmpeg 后复查同口径: 预取阶段也响应取消。

失败信号(区分"修复生效"vs"旧无复查"):
  旧代码 for u in urls 不复查 cancelled → 取消后整批源段(本测 6 段)全被 pri_fetch 拉完,
  且会继续进入 Popen 逻辑。修复后取消瞬间停在第 1~2 段, 后续段不再 fetch, 且不启动 ffmpeg。
"""
import os
import tempfile
import unittest

from ydcore.gateway import Gateway


def _mk_gateway(cache_dir):
    return Gateway({"User-Agent": "test"}, session={"User-Agent": "test"},
                   prefetch=False, port=0, cache_dir=cache_dir)


# 6 段的低清 m3u8(无 #EXT-X-KEY, 简化), ffmpeg 阶段本测不关心(取消应在预取期就 return)。
_M3U8 = "\n".join([
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:10",
    "#EXTINF:10,", "seg0.ts",
    "#EXTINF:10,", "seg1.ts",
    "#EXTINF:10,", "seg2.ts",
    "#EXTINF:10,", "seg3.ts",
    "#EXTINF:10,", "seg4.ts",
    "#EXTINF:10,", "seg5.ts",
    "#EXT-X-ENDLIST",
])


class ThumbCancelPrefetchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ydtest_thumbcancel_")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _prep(self, gw, vid, cancel_after):
        """桩 pri_fetch:
          · 第一次调用(m3u8 文本) → 返回 _M3U8。
          · 之后每个源段 → 返回小段数据; 第 `cancel_after` 段被取(下载)后, 把 state 置 cancelled,
            模拟取消恰发生在预取进行中。
        返回一个 calls 列表(记录被 fetch 的源段 url), 供断言"取消后不再下载"。
        """
        tvid = "t_" + vid
        with gw.vh_lock:
            gw.video_headers[tvid] = {"User-Agent": "test"}
        with gw.thumb_lock:
            gw.thumb_meta[vid] = {"state": "gen"}

        seg_calls = []
        state = {"seg_n": 0}

        def _stub(t, hdrs, url, range_header=None):
            if url.endswith(".m3u8"):
                return (_M3U8.encode("utf-8"), "application/vnd.apple.mpegurl", None)
            # 源段 fetch
            seg_calls.append(url)
            state["seg_n"] += 1
            if state["seg_n"] >= cancel_after:
                # 取消恰在预取进行中发生(模拟 act_thumb cancel 把 state 置 cancelled)
                with gw.thumb_lock:
                    gw.thumb_meta[vid] = {"state": "cancelled"}
            return (b"\x00" * 16, "video/mp2t", None)

        gw.pri_fetch = _stub
        return seg_calls

    def test_prefetch_stops_on_cancel(self):
        """6 段, 在下载到第 2 段时取消 → 预取应停在第 2 段, 不下载 seg2..seg5,
        且不进入 Popen(state 保持 cancelled, thumb_procs 无登记)。"""
        gw = _mk_gateway(self.tmp)
        vid = "910000001"
        seg_calls = self._prep(gw, vid, cancel_after=2)
        out = os.path.join(gw.thumb_dir, "%s.jpg" % vid)

        # 直接调 inner(同步): 修复后取消应让它在预取期 return, 不启动 ffmpeg。
        gw._gen_thumbs_inner(vid, "t_" + vid, "http://x/low.m3u8", 2, out, 1, 1)

        # 修复前: 整批 6 段全被 fetch(无复查)。修复后: 取消瞬间停 → 最多 2 段。
        self.assertLessEqual(
            len(seg_calls), 2,
            "取消后仍继续下载源段(预取未复查 cancelled): 实下载 %d 段 %r" % (len(seg_calls), seg_calls),
        )
        # 没有把 cancelled 覆盖成 ready/error; 也没启动 ffmpeg(没登记 proc)。
        self.assertEqual((gw.thumb_meta.get(vid) or {}).get("state"), "cancelled",
                         "取消态被覆盖, 实得 %r" % gw.thumb_meta.get(vid))
        self.assertNotIn(vid, gw.thumb_procs,
                         "取消后不应再 Popen 启动 ffmpeg, 实得 thumb_procs 含 %s" % vid)
        # 没有生成 jpg 产物(预取期就 return)。
        self.assertFalse(os.path.exists(out), "取消后不应产出缩略图 jpg")

    def test_no_cancel_downloads_all(self):
        """对照组: 不取消时预取应把全部 6 段都拉下来(证明桩与循环本身工作, 失败信号有效)。
        注: 这里桩不置 cancelled(cancel_after 给一个超过段数的值), ffmpeg 会因无真 ffmpeg/网络
        走 error/坏 jpeg, 但我们只断言预取把 6 段都 fetch 了。"""
        gw = _mk_gateway(self.tmp)
        vid = "910000002"
        seg_calls = self._prep(gw, vid, cancel_after=999)  # 永不取消
        out = os.path.join(gw.thumb_dir, "%s.jpg" % vid)

        gw._gen_thumbs_inner(vid, "t_" + vid, "http://x/low.m3u8", 2, out, 1, 1)

        self.assertEqual(len(seg_calls), 6,
                         "不取消时应预取全部 6 段, 实得 %d 段 %r" % (len(seg_calls), seg_calls))


if __name__ == "__main__":
    unittest.main()
