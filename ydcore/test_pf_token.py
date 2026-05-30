"""预缓存 per-worker token 守卫(#11): A→B→A 快切时, 被切走的旧 worker 退出后
其 finally 不得清掉【新】A worker 刚抢到的 pf_active。

根因: 旧 finally 用 `if pf_active["vid"] == vid: pf_active["vid"] = None`。
A→B→A 后, 新 A worker 把 pf_active 设回 {"vid": A}; 此时旧 A worker 的 finally 一跑,
看到 vid 仍是 A 就把 pf_active 清空 -> 新 A worker 的循环条件 `pf_active["vid"]==A`
立刻不成立 -> 新 A 预缓存被"误杀", 停在半截。

治本: 每个 worker 拿一个唯一 generation token; pf_active 同时记录当前 owner token;
finally 只在 vid 且 token 双双匹配(CAS)时才清。旧 worker token 已过期 -> 不动新 A。

本测试用 _init_persist_min seam 搭最小骨架(不起真实线程/网络), 直接驱动
token 分配 + finally-CAS 清理逻辑。负向信号: 把 CAS 退回只比 vid -> 断言变红。
"""
import tempfile
import unittest

from ydcore.gateway import Gateway


class PfTokenTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pftoken_")
        self.gw = Gateway.__new__(Gateway)
        self.gw._init_persist_min(self.dir, ok=True)

    def test_pf_active_carries_token(self):
        # pf_active 结构带 token 字段, 且有单调分配器。
        self.assertIn("token", self.gw.pf_active)
        t1 = self.gw._pf_new_token("A")
        t2 = self.gw._pf_new_token("B")
        self.assertNotEqual(t1, t2)            # 每次分配唯一
        # 分配后 pf_active 记录最新 owner(vid+token)。
        self.assertEqual(self.gw.pf_active["vid"], "B")
        self.assertEqual(self.gw.pf_active["token"], t2)

    def test_stale_worker_finally_does_not_clear_new_owner(self):
        # 模拟 A→B→A: 三次分配 token(A1, B, A2)。
        tA1 = self.gw._pf_new_token("A")       # A 第一次启动
        self.gw._pf_new_token("B")             # 切到 B
        tA2 = self.gw._pf_new_token("A")       # 切回 A(新 worker)
        # 此刻 pf_active 属于新 A worker(token=tA2)。
        self.assertEqual(self.gw.pf_active, {"vid": "A", "token": tA2})

        # 旧 A worker(token=tA1)退出, 其 finally 跑 CAS 清理:
        self.gw._pf_clear_if_owner("A", tA1)
        # 必须【不清】: vid 虽都是 A 但 token 不匹配 -> 新 A 的 pf_active 完好。
        self.assertEqual(self.gw.pf_active, {"vid": "A", "token": tA2})

    def test_current_owner_finally_clears(self):
        # 当前 owner 自己退出(token 匹配)-> 正常清掉 pf_active。
        tA = self.gw._pf_new_token("A")
        self.gw._pf_clear_if_owner("A", tA)
        self.assertIsNone(self.gw.pf_active["vid"])

    def test_clear_no_op_when_vid_mismatch(self):
        # vid 都不对(token 也不会对)-> 不动。
        self.gw._pf_new_token("A")
        owner_token = self.gw.pf_active["token"]
        self.gw._pf_clear_if_owner("Z", 99999)
        self.assertEqual(self.gw.pf_active, {"vid": "A", "token": owner_token})


if __name__ == "__main__":
    unittest.main()
