"""mustFix-3 reload 无锁并发治本: _reload_all_persist 在运行期重绑/改写
buf_state/video_meta/seg_urls/thumb_meta/playhead/_task_seq/task_events, 若不上锁,
并发的 web/worker(读这些 dict / 调 _emit_task_event 写 task_events deque)会撞到
半重置的容器 -> dict/deque mutated-during-iteration -> web 500。

治本: _reload_all_persist 入口按与 _flush_all_persist 一致的固定锁序
buf_lock -> thumb_lock -> meta_lock -> pf_lock 包住整个重载; _load_task_events 写
_task_seq/_task_epoch/task_events 整段进 task_lock。

本测试:
  1. 锁序一致性 / 不死锁: 一个线程反复 _reload_all_persist, 多个线程并发 _emit_task_event
     + 读 buf_state/task_events, 全部在超时内完成(死锁则超时挂死 = 失败信号)。
  2. 并发读 task_events / buf_state 期间不抛 RuntimeError(mutated during iteration)。
"""
import json
import os
import shutil
import tempfile
import threading
import unittest

from ydcore.gateway import Gateway


class ReloadConcurrencyTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="reloadconc_")
        # 盘上铺一些真实持久化态, 让每次重载都有东西可载(放大并发窗口)。
        with open(os.path.join(self.d, "buf_state.json"), "w") as f:
            json.dump({str(i): "done" for i in range(50)}, f)
        with open(os.path.join(self.d, "video_metadata.json"), "w") as f:
            json.dump({str(i): {"videoId": i} for i in range(50)}, f)
        with open(os.path.join(self.d, "seg_urls.json"), "w") as f:
            json.dump({str(i): ["http://h/%d.ts" % i] for i in range(50)}, f)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_reload_concurrent_with_emit_and_reads_no_deadlock_no_race(self):
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=True)
        gw._ever_loaded = False  # 走重载支路

        stop = threading.Event()
        errors = []

        def reloader():
            for _ in range(60):
                if stop.is_set():
                    return
                try:
                    gw._reload_all_persist()
                except Exception as e:  # noqa: BLE001
                    errors.append(("reload", repr(e)))
                    return

        def emitter(tag):
            for i in range(200):
                if stop.is_set():
                    return
                try:
                    gw._emit_task_event("buffer", "%s_%d" % (tag, i), "error", "x")
                except Exception as e:  # noqa: BLE001
                    errors.append(("emit", repr(e)))
                    return

        def reader():
            # 并发读 task_events / buf_state: 半重置 dict/deque 会抛 RuntimeError。
            for _ in range(2000):
                if stop.is_set():
                    return
                try:
                    list(gw.task_events)
                    dict(gw.buf_state)
                    dict(gw.video_meta)
                except RuntimeError as e:  # mutated during iteration = bug
                    errors.append(("read", repr(e)))
                    return
                except Exception:  # noqa: BLE001
                    pass

        threads = [threading.Thread(target=reloader)]
        threads += [threading.Thread(target=emitter, args=("e%d" % i,)) for i in range(3)]
        threads += [threading.Thread(target=reader) for _ in range(3)]
        for t in threads:
            t.start()
        # 死锁会让 join 超时挂住; 给足余量。
        for t in threads:
            t.join(timeout=30)
        stop.set()
        alive = [t for t in threads if t.is_alive()]
        self.assertEqual(alive, [], "有线程未在 30s 内结束 -> 疑似死锁(锁序不一致)")
        self.assertEqual(errors, [], "并发期出现竞态/异常: %r" % errors)


if __name__ == "__main__":
    unittest.main()
