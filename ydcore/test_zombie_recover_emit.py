"""僵尸 recover 终态事件去重(shouldFix; 给 mustFix-2/3 真失败信号):

场景: 盘上 buf_state={"555":"queued"} 但无 buf_jobs(僵尸: 永远跑不起来) + 启动即掉盘。
真实 __init__ 流程:
  · __init__ 调 _load_persist_tables(emit_init_events=True): 识别僵尸 queued->error,
    经 _emit_init_event 发一条; 但掉盘期(ok=False)落盘失败 -> 暂存到 _pending_init_events。
  · 盘回来 -> _recover_once 走重载支路 _reload_all_persist:
      - mustFix-2: _reload_all_persist 调 _load_persist_tables() 必须传 emit_init_events=False,
        否则重载又识别同一僵尸再发一条 -> 双发僵尸事件(web 多写一行历史)。
      - 之后 _replay_pending_init_events 把 __init__ 期暂存的那条补发落盘 -> 恰一条。

失败信号(修前应红): _reload_all_persist 漏传 emit_init_events(默认 True) ->
重载又发一条僵尸 error + 补发一条 -> vid=555 的 error 事件 >1 行。修后恰 1 行。
"""
import json
import os
import shutil
import tempfile
import unittest

from ydcore.gateway import Gateway


def _read_events(d):
    p = os.path.join(d, "task_events.json")
    if not os.path.isfile(p):
        return []
    with open(p, encoding="utf-8") as f:
        return (json.load(f) or {}).get("events") or []


class ZombieRecoverEmitTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="zombierec_")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _write(self, name, obj):
        with open(os.path.join(self.d, name), "w", encoding="utf-8") as f:
            json.dump(obj, f)

    def test_zombie_queued_emits_exactly_one_error_after_recover(self):
        # 盘上僵尸: queued 但无 buf_jobs 上下文
        self._write("buf_state.json", {"555": "queued"})
        # 没有 buf_jobs.json (僵尸的关键)

        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=False)   # 启动即掉盘

        # 模拟真实 __init__ 的回载: 掉盘期识别僵尸 -> 发 init 事件(落盘失败 -> 暂存)
        gw._load_persist_tables(emit_init_events=True)
        self.assertEqual(gw.buf_state.get("555"), "error", "僵尸 queued 应转 error")
        # 掉盘期没落盘, 暂存了一条待补发
        self.assertEqual(len(gw._pending_init_events), 1)
        self.assertEqual(_read_events(self.d), [], "掉盘期不应落盘任何事件")

        # 盘回来 -> 恢复(走重载支路)
        gw.seg_cache.ok = True
        gw._recover_once()

        # 盘上 vid=555 的 error 事件【恰一行】(不双发)
        evs = [e for e in _read_events(self.d)
               if e.get("vid") == "555" and e.get("state") == "error"
               and e.get("kind") == "buffer"]
        self.assertEqual(len(evs), 1,
                         "vid=555 的 buffer error 事件应恰一行, 实得 %d 行: %r"
                         % (len(evs), evs))
        # 暂存已清空
        self.assertEqual(gw._pending_init_events, [])
        # 内存里 buf_state 仍是 error
        self.assertEqual(gw.buf_state.get("555"), "error")


if __name__ == "__main__":
    unittest.main()
