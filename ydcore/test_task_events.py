"""task_events 基础设施单元测试 (无 live server, 纯内存 + 临时目录)。

覆盖:
  · emit 三条 -> seq 单调 1,2,3
  · deque maxlen 截断后 _task_seq 不倒退 (峰值权威)
  · _load_task_events 回载后 seq=历史峰值 (即便 events 已被截断)
  · persist=False (task_events_path=None) 时 emit 不崩、不落盘

不需要网络: 用全新空缓存目录构造 Gateway, video_meta 为空 -> 无 play_headers 回载,
后台 worker 线程对空队列阻塞、对本测试无副作用。
"""
import json
import os
import tempfile
import unittest

from ydcore.gateway import Gateway, _TASK_EVENTS_KEEP


def _mk_gateway(cache_dir):
    """构造一个最小 Gateway: 空 base_headers, 持久化到 cache_dir。"""
    return Gateway({"User-Agent": "test"}, session={"User-Agent": "test"},
                   prefetch=False, port=0, cache_dir=cache_dir)


class TaskEventsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ydtest_te_")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_emit_seq_monotonic(self):
        """emit 三条 -> seq 单调 1,2,3, 字段齐全。"""
        gw = _mk_gateway(self.tmp)
        self.assertEqual(gw._task_seq, 0)
        gw._emit_task_event("buffer", "111", "done")
        gw._emit_task_event("thumb", 222, "error", "boom")
        gw._emit_task_event("prefetch", "333", "done")
        evs = list(gw.task_events)
        self.assertEqual([e["seq"] for e in evs], [1, 2, 3])
        self.assertEqual(gw._task_seq, 3)
        # vid 一律 str
        self.assertEqual(evs[1]["vid"], "222")
        self.assertEqual(evs[1]["kind"], "thumb")
        self.assertEqual(evs[1]["state"], "error")
        self.assertEqual(evs[1]["reason"], "boom")
        # 非 error 的 reason 为 None
        self.assertIsNone(evs[0]["reason"])
        # ts 是浮点秒
        self.assertIsInstance(evs[0]["ts"], float)

    def test_reason_truncated_200(self):
        """reason 超 200 字符被截断到 200。"""
        gw = _mk_gateway(self.tmp)
        gw._emit_task_event("buffer", "1", "error", "x" * 500)
        self.assertEqual(len(list(gw.task_events)[0]["reason"]), 200)

    def test_seq_not_regress_after_deque_truncation(self):
        """deque 截满淘汰旧事件后, _task_seq 仍是历史峰值 (不随 deque 长度回退)。"""
        gw = _mk_gateway(self.tmp)
        total = _TASK_EVENTS_KEEP + 50
        for i in range(total):
            gw._emit_task_event("buffer", str(i), "done")
        # deque 最多保留 maxlen 条
        self.assertEqual(len(gw.task_events), _TASK_EVENTS_KEEP)
        # 但 _task_seq 必须是发射总次数 (峰值), 不被截断影响
        self.assertEqual(gw._task_seq, total)
        # deque 里最老一条的 seq = total - maxlen + 1 (旧的被淘汰)
        self.assertEqual(list(gw.task_events)[0]["seq"], total - _TASK_EVENTS_KEEP + 1)

    def test_load_restores_peak_seq(self):
        """落盘后重启回载: _task_seq = 文件顶层 seq (峰值), 即便 events 数组已被截断。"""
        gw = _mk_gateway(self.tmp)
        total = _TASK_EVENTS_KEEP + 50
        for i in range(total):
            gw._emit_task_event("buffer", str(i), "done")
        path = gw.task_events_path
        self.assertTrue(os.path.isfile(path))
        with open(path, "r", encoding="utf-8") as f:
            saved = json.load(f)
        # 文件顶层 seq = 峰值, events 有界
        self.assertEqual(saved["seq"], total)
        self.assertEqual(len(saved["events"]), _TASK_EVENTS_KEEP)

        # 新实例从同目录回载
        gw2 = _mk_gateway(self.tmp)
        self.assertEqual(gw2._task_seq, total)  # 峰值续上, 不归零
        self.assertEqual(len(gw2.task_events), _TASK_EVENTS_KEEP)
        # 续发不撞旧 seq
        gw2._emit_task_event("buffer", "next", "done")
        self.assertEqual(gw2._task_seq, total + 1)

    def test_load_seq_is_max_of_top_and_events(self):
        """顶层 seq 与 events 内 max seq 取较大者 (防文件被部分篡改)。"""
        path = os.path.join(self.tmp, "task_events.json")
        # 故意构造: 顶层 seq 低于 events 内 max
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"seq": 5, "events": [
                {"seq": 5, "ts": 1.0, "kind": "buffer", "vid": "a", "state": "done", "reason": None},
                {"seq": 9, "ts": 2.0, "kind": "buffer", "vid": "b", "state": "done", "reason": None},
            ]}, f)
        gw = _mk_gateway(self.tmp)
        self.assertEqual(gw._task_seq, 9)

    def test_corrupt_file_quarantined_seq_zero(self):
        """损坏 JSON 被隔离 + seq 降级为 0, 不崩。"""
        path = os.path.join(self.tmp, "task_events.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not valid json")
        gw = _mk_gateway(self.tmp)
        self.assertEqual(gw._task_seq, 0)
        self.assertEqual(len(gw.task_events), 0)
        # 原损坏文件被搬走 (隔离), 新发射能正常落盘
        gw._emit_task_event("buffer", "x", "done")
        self.assertEqual(gw._task_seq, 1)

    def test_persist_false_no_crash_no_write(self):
        """persist=False (无 cache_dir) -> task_events_path=None, emit 不崩、不落盘。"""
        gw = Gateway({"User-Agent": "test"}, session={"User-Agent": "test"},
                     prefetch=False, port=0, cache_dir=None)
        self.assertIsNone(gw.task_events_path)
        gw._emit_task_event("buffer", "1", "done")
        gw._emit_task_event("buffer", "2", "error", "x")
        # seq 仍递增 (内存权威)
        self.assertEqual(gw._task_seq, 2)
        self.assertEqual(len(gw.task_events), 2)
        # 临时缓存目录里不应出现 task_events.json (path=None 时不写)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "task_events.json")))

    def test_save_writes_top_seq_and_events(self):
        """_save_task_events 写 {seq: 峰值, events: [...]} 结构。"""
        gw = _mk_gateway(self.tmp)
        gw._emit_task_event("buffer", "1", "done")
        gw._emit_task_event("buffer", "2", "done")
        with open(gw.task_events_path, "r", encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["seq"], 2)
        self.assertEqual([e["seq"] for e in saved["events"]], [1, 2])

    def test_api_since_filter_semantics(self):
        """/api/task_events 的核心过滤逻辑(since 增量): 复刻 handler 的 [e for e if seq>since]。
        断言: since=0 全量; since=N 只返回 seq>N; cur 永远是当前峰值。"""
        gw = _mk_gateway(self.tmp)
        for i in range(5):
            gw._emit_task_event("buffer", str(i), "done")

        def api(since):
            # 与 Handler._api_task_events 内部逻辑一致(同 task_lock 语义, 单线程测试无需取锁)
            cur = gw._task_seq
            evs = [e for e in gw.task_events if e["seq"] > since]
            return {"seq": cur, "events": evs}

        r0 = api(0)
        self.assertEqual(r0["seq"], 5)
        self.assertEqual([e["seq"] for e in r0["events"]], [1, 2, 3, 4, 5])
        r3 = api(3)
        self.assertEqual(r3["seq"], 5)
        self.assertEqual([e["seq"] for e in r3["events"]], [4, 5])
        # since 已追平峰值 → 无新事件, 但 cur 仍报峰值(web 据此知道不必再拉)
        r5 = api(5)
        self.assertEqual(r5["seq"], 5)
        self.assertEqual(r5["events"], [])

    def test_double_done_not_deduped(self):
        """根因回归: done -> (离开 done) -> 再 done, 两个 done 各占一条不同 seq 的事件。
        旧"按状态值字符串去重"方案此处只剩 1 条 = 丢事件; 事件日志靠 seq 区分必须留 2 条。"""
        gw = _mk_gateway(self.tmp)
        gw._emit_task_event("buffer", "777", "done")       # 首次缓存完成
        gw._emit_task_event("buffer", "777", "cancelled")  # 用户取消(离开 done)
        gw._emit_task_event("buffer", "777", "done")       # 重缓存再次完成
        dones = [e for e in gw.task_events
                 if e["vid"] == "777" and e["state"] == "done"]
        self.assertEqual(len(dones), 2)
        self.assertNotEqual(dones[0]["seq"], dones[1]["seq"])

    def test_epoch_bumps_on_reload_so_reused_seq_is_distinct_id(self):
        """Task 2 (#3): 每条事件带 per-boot epoch。掉盘期 seq 在内存涨但盘没写,
        kill-9 重启从盘载老 seq → 新事件复用旧 seq; 但 epoch 必涨, 故 evt-<epoch>-<seq>
        是不同行, web 不会误去重丢事件。"""
        gw = _mk_gateway(self.tmp)
        gw._emit_task_event("buffer", "1", "done")    # epoch=E, seq=1
        e1 = list(gw.task_events)[-1]
        self.assertIn("epoch", e1)                     # 事件必须带 epoch 字段

        gw2 = _mk_gateway(self.tmp)                    # 从同目录重载(新 boot)
        gw2._emit_task_event("buffer", "2", "done")    # epoch=E+1, seq 可能复用
        e2 = list(gw2.task_events)[-1]

        self.assertNotEqual(e1["epoch"], e2["epoch"])  # 跨重启 epoch 必不同
        self.assertGreater(e2["epoch"], e1["epoch"])   # 单调递增(新 boot 更大)

    def test_epoch_bumps_even_when_seq_reused(self):
        """构造 seq 真撞: 盘上停在 {epoch:E, seq:3}, 但内存继续涨到 5(掉盘期未落盘),
        kill-9 丢内存 → 重启从盘载 epoch=E,seq=3 → 续发 seq=4(撞掉盘期的 4)但 epoch=E+1。
        断言: 同 seq 不同 epoch, 拼出的 id 不同。"""
        path = os.path.join(self.tmp, "task_events.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"epoch": 7, "seq": 3, "events": [
                {"epoch": 7, "seq": 3, "ts": 1.0, "kind": "buffer",
                 "vid": "a", "state": "done", "reason": None},
            ]}, f)
        gw = _mk_gateway(self.tmp)
        # 重载: epoch = 盘上 epoch + 1 = 8; seq = 盘上峰值 3(续发从 4 起)。
        self.assertEqual(gw._task_epoch, 8)
        self.assertEqual(gw._task_seq, 3)
        gw._emit_task_event("buffer", "b", "done")     # seq=4, epoch=8
        ev = list(gw.task_events)[-1]
        self.assertEqual(ev["seq"], 4)
        self.assertEqual(ev["epoch"], 8)
        # 和盘上老事件 (epoch=7, seq=3) 比: 这是不同 (epoch,seq) → 不同 id。
        self.assertNotEqual((ev["epoch"], ev["seq"]), (7, 3))

    def test_first_boot_epoch_starts_at_one(self):
        """首次启动(无盘文件): epoch 从 1 起(load 不到 → epoch=0+1)。"""
        gw = _mk_gateway(self.tmp)
        self.assertEqual(gw._task_epoch, 1)
        gw._emit_task_event("buffer", "1", "done")
        self.assertEqual(list(gw.task_events)[-1]["epoch"], 1)

    def test_save_writes_epoch_top_level(self):
        """_save_task_events 写 {epoch, seq, events}; 落盘后可被下次 load 读到。"""
        gw = _mk_gateway(self.tmp)
        gw._emit_task_event("buffer", "1", "done")
        with open(gw.task_events_path, "r", encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["epoch"], gw._task_epoch)
        self.assertEqual(saved["seq"], 1)
        self.assertEqual(saved["events"][0]["epoch"], gw._task_epoch)

    def test_api_returns_epoch(self):
        """/api/task_events 返回体含 epoch(复刻 handler 逻辑)。"""
        gw = _mk_gateway(self.tmp)
        gw._emit_task_event("buffer", "1", "done")

        def api(since):
            cur = gw._task_seq
            evs = [e for e in gw.task_events if e["seq"] > since]
            return {"epoch": gw._task_epoch, "seq": cur, "events": evs}

        r = api(0)
        self.assertEqual(r["epoch"], gw._task_epoch)
        self.assertEqual(r["events"][0]["epoch"], gw._task_epoch)

    def test_emit_holds_only_task_lock(self):
        """死锁守护: emit 临界区只取 task_lock, 在持有 buf_lock/thumb_lock/pf_lock 时调用不死锁。
        (worker/act 调用 emit 时往往已持那些锁, 锁序必须是 X_lock -> task_lock 单向)。"""
        gw = _mk_gateway(self.tmp)
        for lk in (gw.buf_lock, gw.thumb_lock, gw.pf_lock):
            with lk:
                gw._emit_task_event("buffer", "z", "done")  # 不应卡死
        self.assertEqual(gw._task_seq, 3)


if __name__ == "__main__":
    unittest.main()
