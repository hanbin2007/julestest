"""掉盘恢复守卫(#2): 启动即掉盘(从未载入)时, 盘回来必须【重载磁盘】而不是用空内存覆盖磁盘。

场景:
  · 外置盘没挂载就启动 -> seg_cache.ok=False, 全部 *.json 没载入内存(空内存)。
  · 用户挂回盘(不重启) -> _recover_flush_loop 看到 ok False->True。
旧 bug: 直接把空内存 flush 回盘, 把盘上真实持久化态清零("救盘把盘擦了")。
治本: _ever_loaded 标志区分"运行中掉盘(内存权威, 刷回盘)"vs"启动即掉盘(盘是真相, 重载)"。

纯单元测试, 无 live server: 用 Gateway.__new__ 绕过真实网络初始化, 只测恢复路径,
通过 _init_persist_min / _recover_once 两个测试 seam 注入掉盘/恢复状态。
"""
import json
import os
import shutil
import tempfile
import unittest

from ydcore.gateway import Gateway


class RecoverGuardTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="recguard_")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _write(self, name, obj):
        with open(os.path.join(self.d, name), "w", encoding="utf-8") as f:
            json.dump(obj, f)

    def test_startup_drop_then_remount_reloads_not_overwrites(self):
        """启动即掉盘(从未载入): 盘回来后必须重载磁盘, 而非用空内存覆盖。"""
        # 盘上已有真实持久化态(模拟之前进程写好的)
        self._write("buf_state.json", {"123": "done"})
        # 构造一个"启动时 cache 不可用 / 从未成功载入"的 Gateway
        gw = Gateway.__new__(Gateway)              # 绕过真实网络初始化; 只测恢复路径
        gw._init_persist_min(self.d, ok=False)     # 测试辅助: ok=False & _ever_loaded=False & 空内存
        self.assertFalse(gw._ever_loaded)
        self.assertEqual(gw.buf_state, {})         # 启动即掉盘时内存为空
        # 盘"回来": ok False->True 触发一次恢复 tick
        gw.seg_cache.ok = True
        gw._recover_once()                         # 单次恢复(从 loop 体抽出)
        # 断言: 盘上 buf_state 没被空内存覆盖, 反而被载入内存
        with open(os.path.join(self.d, "buf_state.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"123": "done"})
        self.assertEqual(gw.buf_state.get("123"), "done")
        self.assertTrue(gw._ever_loaded)           # 重载完成后标记为已载入

    def test_runtime_drop_then_remount_reflushes_memory(self):
        """运行中曾载入过(_ever_loaded=True): 盘回来应把(可能更新的)内存态刷回盘。"""
        # 运行中曾载入过, 内存里有新态, 盘回来应把内存刷回盘
        self._write("buf_state.json", {"123": "done"})
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=True)
        gw._ever_loaded = True
        gw.buf_state = {"123": "done", "456": "working"}  # 运行中新增
        gw.seg_cache.ok = False                            # 掉盘
        gw.seg_cache.ok = True                             # 回来
        gw._recover_once()
        with open(os.path.join(self.d, "buf_state.json"), encoding="utf-8") as f:
            self.assertIn("456", json.load(f))             # 内存态刷回盘

    def test_recover_once_noop_when_disk_still_down(self):
        """盘仍不可用时(ok=False) _recover_once 不动作, 不会误清盘也不会误标已载入。"""
        self._write("buf_state.json", {"123": "done"})
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=False)
        gw.seg_cache.ok = False
        gw._recover_once()
        with open(os.path.join(self.d, "buf_state.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"123": "done"})  # 没被碰
        self.assertFalse(gw._ever_loaded)


if __name__ == "__main__":
    unittest.main()
