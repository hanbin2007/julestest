"""nit _ever_loaded 时机: init 成功载入后的 _save_buf_state/_save_buf_errors 若撞瞬时
OSError, _atomic_write_json 会把 seg_cache.ok 翻 False。旧版在这两次落盘【之后】才按
seg_cache.ok 判定 _ever_loaded -> 漏置 -> 后续 _recover_once 误走重载支路双发 init 事件。

治本: _ever_loaded 在这两次落盘【之前】按"载入时盘是否可用"定格; 即便落盘翻了 ok,
_ever_loaded 已定格不受影响。

纯单元测试, 无 live server: 构造真实 Gateway(隔离 cache_dir + thumb_dir, 不碰生产),
class 级 monkeypatch _save_buf_state 模拟落盘瞬时翻 seg_cache.ok=False, 断言
_ever_loaded 仍为 True。
"""
import os
import shutil
import tempfile
import unittest

from ydcore import gateway as gwmod
from ydcore.gateway import Gateway


class EverLoadedTimingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="everload_")
        self._old_thumb_dir = gwmod.THUMB_DIR
        gwmod.THUMB_DIR = os.path.join(self.tmp, "_iso_thumbs")

    def tearDown(self):
        gwmod.THUMB_DIR = self._old_thumb_dir
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_transient_save_oserror_does_not_drop_ever_loaded(self):
        cache_dir = os.path.join(self.tmp, "cache")
        os.makedirs(cache_dir, exist_ok=True)

        orig_save = Gateway._save_buf_state
        calls = {"n": 0}

        def flaky_save(self):
            # 模拟 init 期那次落盘撞瞬时 OSError: _atomic_write_json 会标 seg_cache.ok=False。
            calls["n"] += 1
            self.seg_cache.ok = False
            # 仍调原逻辑(此时 ok=False 会让 _atomic_write_json 直接跳过, 不抛)。
            return orig_save(self)

        Gateway._save_buf_state = flaky_save
        try:
            gw = Gateway({"User-Agent": "t"}, session={"User-Agent": "t"},
                         prefetch=False, port=0, cache_dir=cache_dir)
        finally:
            Gateway._save_buf_state = orig_save

        # init 期那次落盘确实跑过(翻了 ok)
        self.assertGreaterEqual(calls["n"], 1)
        self.assertFalse(gw.seg_cache.ok, "模拟的瞬时 OSError 应已把 ok 翻 False")
        # 关键: _ever_loaded 在落盘之前就按"载入时盘可用"定格了, 不受落盘翻 ok 影响。
        self.assertTrue(gw._ever_loaded,
                        "_ever_loaded 应在落盘前定格为 True, 不被瞬时落盘失败拖累")


if __name__ == "__main__":
    unittest.main()
