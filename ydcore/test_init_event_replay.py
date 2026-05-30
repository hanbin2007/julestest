"""init 期终态事件掉盘补发 (#18): 启动期(或启动即掉盘)若磁盘不可写, init 期发生的
终态事件(僵尸 buffer queued->error / thumb gen->error interrupted)只在内存 deque 里、
没落盘; 此后 kill-9 会永久丢这些真终态。

治本: init 期事件经 _emit_init_event 发射 —— 正常落盘则照常; 若因掉盘没落成, 暂存到
self._pending_init_events; 盘回来后(_recover_once 两条恢复支路都)重新 emit(全新 seq/epoch,
保证落盘后是一条带新 id 的事件, web 不会误去重), 并清空暂存。

纯单元测试, 无 live server: Gateway.__new__ + _init_persist_min/_recover_once 两个测试 seam,
直接注入掉盘/恢复状态。失败信号: 去掉补发逻辑 -> 掉盘期 init 事件停留在内存、盘上 task_events.json
没有它 -> test_pending_replayed_on_recover 变红。
"""
import json
import os
import shutil
import tempfile
import unittest

from ydcore.gateway import Gateway


def _read_task_events(d):
    """读 cache_dir 下 task_events.json, 不存在返回 None。"""
    p = os.path.join(d, "task_events.json")
    if not os.path.isfile(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


class InitEventReplayTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="initreplay_")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _write(self, name, obj):
        with open(os.path.join(self.d, name), "w", encoding="utf-8") as f:
            json.dump(obj, f)

    def test_emit_init_event_persists_when_disk_ok(self):
        """盘可写时: _emit_init_event 与普通 emit 同效 —— 进 deque + 落盘, 不暂存。"""
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=True)
        gw._emit_init_event("buffer", "999", "error", "重启后丢失任务上下文")
        # 进了内存 deque
        evs = list(gw.task_events)
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]["vid"], "999")
        self.assertEqual(evs[0]["state"], "error")
        # 落了盘
        saved = _read_task_events(self.d)
        self.assertIsNotNone(saved)
        self.assertEqual([e["vid"] for e in saved["events"]], ["999"])
        # 不需要暂存补发
        self.assertEqual(gw._pending_init_events, [])

    def test_emit_init_event_stashed_when_disk_down(self):
        """启动即掉盘(ok=False)时: 事件仍进内存 deque(内存权威), 但落盘失败 ->
        暂存到 _pending_init_events 待补发; 盘上不应出现 task_events.json。"""
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=False)
        gw._emit_init_event("buffer", "999", "error", "重启后丢失任务上下文")
        # 内存权威: deque 里有
        self.assertEqual([e["vid"] for e in gw.task_events], ["999"])
        # 但没落盘(掉盘)
        self.assertIsNone(_read_task_events(self.d))
        # 暂存了一条待补发(kind/vid/state/reason 齐全)
        self.assertEqual(len(gw._pending_init_events), 1)
        kind, vid, state, reason = gw._pending_init_events[0]
        self.assertEqual((kind, vid, state), ("buffer", "999", "error"))
        self.assertEqual(reason, "重启后丢失任务上下文")

    def test_pending_replayed_on_recover_reload_branch(self):
        """核心场景: 启动即掉盘, init 期发了僵尸终态(只在内存)。盘回来 -> _recover_once
        走重载支路(_ever_loaded=False), 必须把暂存事件【重新 emit 并落盘】, 否则 kill-9 丢。
        失败信号: 去掉补发, 盘上 task_events.json 没有 vid=999 这条 -> 本断言红。"""
        # 盘上已有真实持久化态(模拟之前进程), 让重载有东西可载
        self._write("buf_state.json", {"123": "done"})
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=False)        # 启动即掉盘
        # init 期发生的僵尸终态(掉盘期, 只进内存, 没落盘)
        gw._emit_init_event("buffer", "999", "error", "重启后丢失任务上下文")
        self.assertIsNone(_read_task_events(self.d))   # 确认确实没落盘
        self.assertEqual(len(gw._pending_init_events), 1)

        # 盘"回来": ok False->True, 跑一次恢复(走重载支路)
        gw.seg_cache.ok = True
        gw._recover_once()

        # 暂存被清空(已补发)
        self.assertEqual(gw._pending_init_events, [])
        # 关键: 盘上 task_events.json 现在含这条终态(补发后落盘了)
        saved = _read_task_events(self.d)
        self.assertIsNotNone(saved)
        vids = [e["vid"] for e in saved["events"]]
        self.assertIn("999", vids)
        # 补发的那条 state/kind 正确
        replayed = [e for e in saved["events"] if e["vid"] == "999"]
        self.assertTrue(any(e["state"] == "error" and e["kind"] == "buffer"
                            for e in replayed))

    def test_pending_replayed_on_recover_reflush_branch(self):
        """运行中掉盘支路(_ever_loaded=True, 刷回盘): 暂存的 init 事件也要被补发落盘。
        (这条多半已由 _flush_all_persist 整 deque 刷盘覆盖, 此处确保补发逻辑对刷回支路也清空暂存。)"""
        self._write("buf_state.json", {"123": "done"})
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=True)
        gw._ever_loaded = True
        # 掉盘期发 init 事件: 强制 ok=False 让落盘失败 -> 暂存
        gw.seg_cache.ok = False
        gw._emit_init_event("thumb", "888", "error", "interrupted")
        self.assertEqual(len(gw._pending_init_events), 1)
        # 盘回来 -> 刷回支路
        gw.seg_cache.ok = True
        gw._recover_once()
        self.assertEqual(gw._pending_init_events, [])
        saved = _read_task_events(self.d)
        self.assertIsNotNone(saved)
        self.assertIn("888", [e["vid"] for e in saved["events"]])

    def test_replay_uses_fresh_seq_distinct_id(self):
        """补发的事件用全新 seq(不复用暂存时的内存 seq)+ 当前 epoch, 落盘后是带新 id 的行,
        web 端 evt-<epoch>-<seq> 不会与任何旧行撞、不会被误去重。"""
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=False)
        gw._emit_init_event("buffer", "999", "error", "zombie")
        seq_at_stash = gw._task_seq                  # 掉盘期内存 seq
        gw.seg_cache.ok = True
        gw._recover_once()
        # 补发后峰值 seq 前进(用了新 seq, 不是原地复用)
        self.assertGreater(gw._task_seq, seq_at_stash)
        saved = _read_task_events(self.d)
        replayed = [e for e in saved["events"] if e["vid"] == "999"]
        self.assertTrue(replayed)
        # 补发那条 seq 是新分配的(> 暂存时), epoch 是当前 boot epoch
        self.assertTrue(any(e["seq"] > seq_at_stash for e in replayed))
        self.assertTrue(all(e["epoch"] == gw._task_epoch for e in replayed))

    def test_recover_noop_when_no_pending(self):
        """没有暂存事件时, 恢复不应误造事件 / 不崩。"""
        self._write("buf_state.json", {"123": "done"})
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=False)
        self.assertEqual(gw._pending_init_events, [])
        gw.seg_cache.ok = True
        gw._recover_once()
        self.assertEqual(gw._pending_init_events, [])
        # 没暂存就不该凭空多出 init 事件(seg/buf 回载本身不发事件)
        saved = _read_task_events(self.d)
        if saved is not None:
            self.assertEqual(saved["events"], [])


if __name__ == "__main__":
    unittest.main()
