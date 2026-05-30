"""shouldFix corrupt epoch 撞号: task_events.json 物理损坏走 except 分支时, 旧版
self._task_epoch = self._task_epoch + 1 在 __init__(epoch=1)下确定性落到 2 ——
可能撞上历史 epoch=2 那批事件的 id(evt-2-<seq>), 致 web 误去重让已删事件 #3 复活。

治本: corrupt 分支 epoch = max(当前, 墙钟) + 1 —— 墙钟单调, 跨重启必比任何历史小 epoch 大,
永不撞历史小 epoch。

失败信号(旧逻辑): corrupt 后 epoch=2; 若历史曾用过 epoch=2, 新事件 id 撞历史。
修后: corrupt 后 epoch 远大于 2(墙钟级), 不会撞; 且 corrupt 后续发的事件正常落盘不漏。
"""
import json
import os
import shutil
import tempfile
import time
import unittest

from ydcore.gateway import Gateway


def _read_events(d):
    p = os.path.join(d, "task_events.json")
    if not os.path.isfile(p):
        return []
    with open(p, encoding="utf-8") as f:
        return (json.load(f) or {}).get("events") or []


class CorruptEpochTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="corruptep_")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_corrupt_epoch_does_not_collide_with_small_history(self):
        """corrupt task_events.json 回载后 epoch 不再确定性落到 2(可撞历史 epoch=2)。"""
        # 写一个物理损坏的 task_events.json
        with open(os.path.join(self.d, "task_events.json"), "w") as f:
            f.write("{ this is not valid json ]]]")
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=True)  # _init_persist_min 不回载
        # 显式回载(模拟 __init__ / reload 的 _load_task_events)
        gw._load_task_events()
        # corrupt 分支应把 epoch 抬到墙钟级(>> 2), 永不撞历史小 epoch=2。
        self.assertGreater(gw._task_epoch, 2,
                           "corrupt 后 epoch 不应确定性落到 2(会撞历史 epoch=2): 实得 %d"
                           % gw._task_epoch)
        self.assertGreaterEqual(gw._task_epoch, int(time.time()),
                                "corrupt 后 epoch 应至少墙钟级, 实得 %d" % gw._task_epoch)
        # 损坏文件被隔离 + 内存 seq 复位为 0(deque 清空)
        self.assertEqual(gw._task_seq, 0)
        self.assertEqual(list(gw.task_events), [])

    def test_emit_after_corrupt_persists_with_fresh_epoch(self):
        """corrupt 回载后续发的事件正常落盘(不漏), 且带新墙钟级 epoch。"""
        with open(os.path.join(self.d, "task_events.json"), "w") as f:
            f.write("not json {{{")
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=True)
        gw._load_task_events()
        ep_after_corrupt = gw._task_epoch

        # 续发一条真实终态事件
        gw._emit_task_event("buffer", "777", "error", "after corrupt")
        evs = [e for e in _read_events(self.d) if e.get("vid") == "777"]
        self.assertEqual(len(evs), 1, "corrupt 后续发事件应正常落盘恰一行, 实得 %r" % evs)
        self.assertEqual(evs[0]["epoch"], ep_after_corrupt,
                         "续发事件应带 corrupt 后的新墙钟级 epoch")
        self.assertGreater(evs[0]["epoch"], 2)

    def test_corrupt_then_restart_epoch_monotonic(self):
        """corrupt -> 落盘 -> 再回载(模拟重启): epoch 仍单调前进, 不倒退也不撞历史。"""
        with open(os.path.join(self.d, "task_events.json"), "w") as f:
            f.write("garbage")
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=True)
        gw._load_task_events()           # 第一次 corrupt 回载
        ep1 = gw._task_epoch
        gw._emit_task_event("buffer", "1", "error", "x")  # 落盘(含 ep1)

        # 模拟重启: 新实例回载刚落盘的(这次是合法 JSON)
        gw2 = Gateway.__new__(Gateway)
        gw2._init_persist_min(self.d, ok=True)
        gw2._load_task_events()
        # 新 boot epoch = 盘上 ep1 + 1, 严格大于 ep1(单调, 不撞)。
        self.assertGreater(gw2._task_epoch, ep1,
                           "重启后 epoch 应严格大于上次(单调), ep1=%d new=%d"
                           % (ep1, gw2._task_epoch))


if __name__ == "__main__":
    unittest.main()
