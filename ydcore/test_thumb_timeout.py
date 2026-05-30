"""ffmpeg 超时 watchdog 单元测试 (#4, #7) — 无 live server, 纯内存 + 临时目录 + 假 ffmpeg。

覆盖:
  · _gen_thumbs_inner 里 proc.wait(timeout=...) 必须有界: ffmpeg 挂死时不会无限阻塞 worker,
    超时后 terminate/kill 进程, 终态落 thumb_meta=error 且 reason 含 "timeout"。
  · gen 态带 started_ts (watchdog 可据此判定卡死, #7)。
  · 超时 const 可被环境变量 YD_THUMB_FFMPEG_TIMEOUT 覆盖(让测试不必真等 120s)。

失败信号(区分"修复生效"vs"旧 proc.wait() 无超时"):
  旧代码 proc.wait() 无 timeout → 假 ffmpeg sleep 600s 会把 _gen_thumbs_inner 永久卡住,
  本测试在 (timeout + 余量) 内根本返回不了 → 测试超时/挂死 = FAIL。修复后 rc=-1 → error。
"""
import os
import stat
import tempfile
import threading
import unittest

from ydcore import gateway as gwmod
from ydcore.gateway import Gateway


def _mk_gateway(cache_dir):
    return Gateway({"User-Agent": "test"}, session={"User-Agent": "test"},
                   prefetch=False, port=0, cache_dir=cache_dir)


class _FakeFfmpegMixin:
    """在临时 bin/ 里放一个假 ffmpeg(sleep 很久, 模拟挂死), 注入 PATH 首位。"""

    def _install_hanging_ffmpeg(self, sleep_secs=600):
        binp = os.path.join(self.tmp, "bin")
        os.makedirs(binp, exist_ok=True)
        script = os.path.join(binp, "ffmpeg")
        # exec: 让 sleep 替换 shell 进程, 这样 terminate(proc) 直接命中 sleep, 不留孤儿子进程。
        with open(script, "w") as f:
            f.write("#!/bin/sh\nexec sleep %d\n" % sleep_secs)
        os.chmod(script, os.stat(script).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        self._old_path = os.environ.get("PATH", "")
        os.environ["PATH"] = binp + os.pathsep + self._old_path
        return script

    def _restore_path(self):
        if hasattr(self, "_old_path"):
            os.environ["PATH"] = self._old_path


class ThumbTimeoutTest(_FakeFfmpegMixin, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ydtest_thumbto_")
        # 超时常量调到 2s, 否则真等默认 120s。
        self._old_env_to = os.environ.get("YD_THUMB_FFMPEG_TIMEOUT")
        os.environ["YD_THUMB_FFMPEG_TIMEOUT"] = "2"

    def tearDown(self):
        import shutil
        self._restore_path()
        if self._old_env_to is None:
            os.environ.pop("YD_THUMB_FFMPEG_TIMEOUT", None)
        else:
            os.environ["YD_THUMB_FFMPEG_TIMEOUT"] = self._old_env_to
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _prep_gen(self, gw, vid):
        """让 _gen_thumbs_inner 不早 return: 给 t_<vid> 头, 并跳过真实分片预取(pri_fetch 抛)。"""
        tvid = "t_" + vid
        with gw.vh_lock:
            gw.video_headers[tvid] = {"User-Agent": "test"}
        # 预取阶段(pri_fetch m3u8/分片)走网络 → 用桩抛错, 让其被 try/except 静默跳过, 直奔 ffmpeg。
        def _boom(*a, **k):
            raise RuntimeError("no network in unit test")
        gw.pri_fetch = _boom
        # gen 态(模拟 start_thumbs 已置)。
        with gw.thumb_lock:
            gw.thumb_meta[vid] = {"state": "gen"}

    def test_ffmpeg_timeout_does_not_hang_and_falls_to_error(self):
        """假 ffmpeg sleep 600s; 修复后 proc.wait(timeout=2) 触发 → terminate → rc=-1 → error。
        整个 _gen_thumbs_inner 必须在 (2s 超时 + 余量) 内返回, 否则旧无超时代码会挂死本测试。"""
        self._install_hanging_ffmpeg(sleep_secs=600)
        gw = _mk_gateway(self.tmp)
        vid = "900000001"
        self._prep_gen(gw, vid)
        out = os.path.join(gw.thumb_dir, "%s.jpg" % vid)

        done = threading.Event()
        err = {}

        def run():
            try:
                gw._gen_thumbs_inner(vid, "t_" + vid, "http://x/y.m3u8", 2, out, 1, 1)
            except Exception as e:  # noqa: BLE001
                err["exc"] = e
            finally:
                done.set()

        t = threading.Thread(target=run, daemon=True)
        t.start()
        # 超时 2s + terminate 5s 余量 + 调度 → 给 15s 上限。旧无超时代码这里必 False(挂死)。
        finished = done.wait(timeout=15)
        self.assertTrue(finished,
                        "_gen_thumbs_inner 未在 15s 内返回: proc.wait 仍无超时(修复未生效)")
        self.assertIsNone(err.get("exc"), "不应抛异常, 应走 error 终态: %r" % err.get("exc"))

        meta = gw.thumb_meta.get(vid) or {}
        self.assertEqual(meta.get("state"), "error",
                         "超时后应落 error 终态, 实得 %r" % meta)
        self.assertIn("timeout", (meta.get("reason") or "").lower(),
                      "error reason 应反映 timeout, 实得 %r" % meta.get("reason"))
        # 进程句柄已清理, worker 被释放。
        self.assertNotIn(vid, gw.thumb_procs)
        # 终态事件已发(thumb error)。
        evs = [e for e in list(gw.task_events) if e["vid"] == vid]
        self.assertTrue(any(e["state"] == "error" for e in evs),
                        "应发 thumb error 事件, 实得 %r" % evs)

    def test_gen_state_carries_started_ts(self):
        """start_thumbs 置 gen 态时应带 started_ts (watchdog #7 据此判定卡死)。"""
        gw = _mk_gateway(self.tmp)
        gw.have_ffmpeg = True
        vid = "900000002"
        video = {"videoId": int(vid), "contentId": 1, "cardPackageId": 1, "productId": 1}
        # start_thumbs 会 video_headers 重建 + 入队; worker 不跑(prefetch=False 仍起了 thumb worker,
        # 但队列项需真实网络, 这里只验证置 gen 瞬间的 meta 字段, 故先 stub play_headers 避免网络)。
        gwmod.play_headers = lambda *a, **k: {"User-Agent": "test"}
        res = gw.start_thumbs(video, "http://x/y.m3u8", 600, tier=2)
        self.assertEqual(res.get("state"), "gen")
        meta = gw.thumb_meta.get(vid) or {}
        self.assertEqual(meta.get("state"), "gen")
        self.assertIn("started_ts", meta, "gen 态应带 started_ts (watchdog), 实得 %r" % meta)
        self.assertIsInstance(meta["started_ts"], float)


if __name__ == "__main__":
    unittest.main()
