# Cache/Thumbnail Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 19 confirmed problems from the 2026-05-30 cache/thumb audit — eliminate two silent-data-loss paths, physically bound thumbnail caching/resources, and close the counting/attribution gaps — without regressing the 2026-05-28 re-architecture that already shipped.

**Architecture:** Two processes. Python gateway (`ydcore/gateway.py`, `ydcore/cache.py`, `ydcore/priority.py`) owns HLS resolve / AES decrypt / a single persistent `DiskLRU` segment cache / ffmpeg thumbnails / all `*.json` persistence + a `_recover_flush_loop` for disk-drop recovery. Next.js web mirrors gateway state into SQLite and pulls the task-event log. The fixes are surgical: a load-guard on recovery, an epoch on the event seq, resource bounds + a separate quota for thumb source segments, and productId propagation — each independently testable.

**Tech Stack:** Python 3 stdlib (`threading`, `subprocess`, `collections`, `time`, `os`); ffmpeg; Next.js 15 + Prisma 6/SQLite; Node ESM isolated e2e (`youdao_course.py serve --port/--cache-dir`, `@prisma/client` against a temp `test.db`, `playwright-core`).

---

## Scope & how to split

This plan covers **5 independent root-cause subsystems**. It is sequenced as one plan, but **each Tier can be executed as its own worktree/branch** and shipped independently:

- **Tier 1 — Silent data loss (do first):** RC2 recovery (#2) + RC3 event-seq epoch (#3).
- **Tier 2 — Thumbnail resource/capacity:** RC4 ffmpeg bounds (#4, #7), RC1+ zombie/cancel/decouple (#5, #6, #9, #1, #8).
- **Tier 3 — Counting / attribution / display / edges:** #13, #15, #12, #14, #16, #17, #11, #19, #10, #18.

**Execution hygiene (non-negotiable):**
- Work in a dedicated worktree (`superpowers:using-git-worktrees`), NOT in `op-history-event-log`.
- Changing `ydcore/*.py` requires `kill -9` gateway + restart to take effect. **All e2e run against an isolated gateway (`--port 8809 --cache-dir <TMPDIR>` + `YD_THUMB_DIR=<TMPDIR>`) and an isolated `test.db` — NEVER the production `app.db`/`:8808`/`:3000`/prod cache** ([[julestest-no-prod-db-writes]]). Reuse the harness in `web/scripts/_e2e_task_events_isolated.mjs` (it already boots an isolated gateway + temp DB and tears the whole TMPDIR down).
- Line numbers below are from the 2026-05-30 audit; **re-grep the named symbol before editing** (they drift).

**Background facts (audit, verified):**
- `gateway.py` has **one** `self.seg_cache = DiskLRU(cache_bytes, cache_dir)` (~line 134). The `cache.py` namespace splitter (`_ns_split`, `set_namespace_splitter`) only buckets `t_`-prefixed vids for *accounting* (`vid_stats`); there is **no** physical bucket / sub-quota / per-vid delete.
- Thumb generation protects its own source segs via `add_protect_vid('t_'+vid)` (gateway `_gen_thumbs`) and removes in `finally`. `_pick_victim` (cache.py ~178-189) protects only `_live_vid` + `_extra_protect`.
- `_extra_protect` is persisted into `playhead.json` via `_save_playhead`→`extra_protect_vids()`; reloaded by `set_extra_protect` (cache.py ~172-176) which only `str()`s + drops empties (no `t_` awareness).
- Operation history is the event log shipped in `op-history-event-log` (`_emit_task_event` ×10, `/api/task_events?since=N`, web `ingestTaskEvents` with `evt-<seq>` idempotent upsert + `taskEventSeq` cursor, R10 = `console.warn` only when `res.seq < since`).

---

# TIER 1 — Silent data loss

## Task 1: Recovery must not overwrite disk with empty memory (#2)

**Bug:** Boot with the cache dir missing (external drive not mounted yet) → `seg_cache.ok = False`, nothing is loaded into memory. User remounts the drive (no restart) → `_recover_flush_loop` sees `ok` flip `False→True` and flushes the **empty** in-memory state to disk via `_atomic_write_json`, zeroing `seg_urls.json` / `buf_state.json` / `video_metadata.json` / `playhead.json` / `task_events.json`. "Trying to save the drive wiped the drive."

**Root fix:** Recovery must distinguish *"drop happened while memory was authoritative (reflush memory→disk)"* from *"never loaded — disk is the truth (reload disk→memory)"*. Gate reflush on a `_ever_loaded` flag; if not yet loaded when the drive returns, do a full load instead of a flush.

**Files:**
- Modify: `ydcore/gateway.py` (`__init__` load sequence; `_recover_flush_loop`)
- Test: `ydcore/test_recover_guard.py` (Create — pure unit, no live server)

- [ ] **Step 1: Confirm current shape**

Run: `cd <repo> && grep -n "_recover_flush_loop\|def _load_index\|seg_cache.ok\|_atomic_write_json\|_load_all_persist\|回载" ydcore/gateway.py | head -40`
Read `_recover_flush_loop` and the `__init__` block that loads `task_events.json/seg_urls.json/buf_state.json/...` end to end. Identify the single function (or inline block) that performs the full reload; if it is inline, extract it into `def _reload_all_persist(self)` as Step 3 requires a callable.

- [ ] **Step 2: Write the failing test**

```python
# ydcore/test_recover_guard.py
"""掉盘恢复守卫: 启动即掉盘(从未载入)时, 盘回来必须【重载磁盘】而不是用空内存覆盖磁盘。"""
import json, os, tempfile, unittest
from ydcore.gateway import Gateway   # adjust import to the real Gateway constructor

class RecoverGuardTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="recguard_")

    def _write(self, name, obj):
        with open(os.path.join(self.d, name), "w") as f: json.dump(obj, f)

    def test_startup_drop_then_remount_reloads_not_overwrites(self):
        # 盘上已有真实持久化态(模拟之前进程写好的)
        self._write("buf_state.json", {"123": "done"})
        # 构造一个"启动时 cache 不可用 / 从未成功载入"的 Gateway
        gw = Gateway.__new__(Gateway)             # 绕过真实网络初始化; 只测恢复路径
        gw._init_persist_min(self.d, ok=False)    # 测试辅助: 见 Step 3, 设 ok=False & _ever_loaded=False & 空内存
        # 盘"回来": ok False->True 触发一次恢复 tick
        gw.seg_cache.ok = True
        gw._recover_once()                        # 单次恢复(从 loop 体抽出, 见 Step 3)
        # 断言: 盘上 buf_state 没被空内存覆盖, 反而被载入内存
        with open(os.path.join(self.d, "buf_state.json")) as f:
            self.assertEqual(json.load(f), {"123": "done"})
        self.assertEqual(gw.buf_state.get("123"), "done")

    def test_runtime_drop_then_remount_reflushes_memory(self):
        # 运行中曾载入过(_ever_loaded=True), 内存里有新态, 盘回来应把内存刷回盘
        self._write("buf_state.json", {"123": "done"})
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.d, ok=True)
        gw._ever_loaded = True
        gw.buf_state = {"123": "done", "456": "working"}  # 运行中新增
        gw.seg_cache.ok = False                            # 掉盘
        gw.seg_cache.ok = True                             # 回来
        gw._recover_once()
        with open(os.path.join(self.d, "buf_state.json")) as f:
            self.assertIn("456", json.load(f))             # 内存态刷回盘
```

> If `Gateway` can't be constructed without network, add tiny test-only helpers `_init_persist_min(dir, ok)` (sets `seg_cache` with `dir`/`ok`, empty in-memory dicts, `_ever_loaded=False`) and `_recover_once()` (the body of one `_recover_flush_loop` iteration) — these also make Step 3 testable. Keep them minimal and clearly marked test seams.

- [ ] **Step 3: Run it, see it fail**

Run: `cd <repo> && python3 -m unittest ydcore.test_recover_guard -v`
Expected: FAIL — `test_startup_drop_...` shows `buf_state.json` overwritten to `{}` (current bug) or AttributeError on the new seams.

- [ ] **Step 4: Implement the guard**

In `__init__`: initialize `self._ever_loaded = False` BEFORE any load. After the full successful load of all `*.json`, set `self._ever_loaded = True`. Extract the one-iteration recovery body into `_recover_once()` and have `_recover_flush_loop` call it. In `_recover_once()`:

```python
def _recover_once(self):
    # 仅当 ok 由 False->True(掉盘后回来)才动作; 详见 _recover_flush_loop 现有触发判定
    if not self.seg_cache.ok:
        return
    if not self._ever_loaded:
        # 启动即掉盘、从未载入: 盘才是真相, 重载而非覆盖
        self._reload_all_persist()      # 重跑 _load_index + 回载全部 JSON
        self._ever_loaded = True
        return
    # 运行中掉盘后回来: 内存态权威, 刷回盘(现有行为)
    self._flush_all_persist()           # 现有 _recover_flush_loop 的写盘逻辑
```

(If reload/flush are currently inline, wrap them as `_reload_all_persist` / `_flush_all_persist`. `_reload_all_persist` is the same code path `__init__` uses.)

- [ ] **Step 5: Run tests — both pass**

Run: `cd <repo> && python3 -m unittest ydcore.test_recover_guard -v`
Expected: PASS (both cases).

- [ ] **Step 6: Isolated e2e (real process, drive-drop simulated)**

Create `web/scripts/_e2e_recover_guard.mjs` (model on `_e2e_task_events_isolated.mjs` boot/teardown): boot isolated gateway with `--cache-dir <TMPDIR>/cache` where `<TMPDIR>/cache` **does not exist yet** (or contains pre-seeded `buf_state.json={"123":"done"}` but is made unreadable at boot); after boot, make the dir available with the seeded JSON; wait > recover interval; assert `buf_state.json` still `{"123":"done"}` (NOT `{}`) and `/api/status` reflects it. Failure signal: revert Step 4 → file is zeroed. Run twice.

- [ ] **Step 7: Commit**

```bash
git add ydcore/gateway.py ydcore/test_recover_guard.py web/scripts/_e2e_recover_guard.mjs
git commit -m "fix(cache): recovery reloads disk on startup-drop instead of overwriting with empty memory (#2)"
```

---

## Task 2: Event-seq epoch so drop+kill-9 can't collide seqs (#3)

**Bug:** During a disk-drop window `_task_seq` keeps incrementing in memory but `_save_task_events` silently no-ops (path None / ok False). `kill -9` → restart loads the **old** `_task_seq` from disk → new events reuse seq numbers the web already consumed → web's `evt-<seq>` `skipDuplicates` upsert + `taskEventSeq` cursor (`seq > since`) **silently drop** them. Operation history loses real completions/failures with no error. (R10 only `console.warn`s.)

**Root fix:** Tag every event with a per-boot `epoch`. Event id becomes `evt-<epoch>-<seq>` so a reused seq under a new epoch is a *different* row (no false dedup), and the web cursor advances within an epoch but resets cleanly across epochs.

**Files:**
- Modify: `ydcore/gateway.py` (`_task_seq`/epoch init, `_emit_task_event`, `_api_task_events`, `_save/_load_task_events`)
- Modify: `web/src/app/api/courses/status/route.ts` (`ingestTaskEvents`)
- Modify: `web/src/types/api.ts` (`TaskEvent`/`TaskEventsResp` add `epoch`)
- Test: extend `ydcore/test_task_events.py` + `web/scripts/_e2e_task_events_isolated.mjs`

- [ ] **Step 1: Gateway — add a durable boot epoch**

Re-grep: `grep -n "_task_seq\|task_events_path\|_load_task_events\|_save_task_events\|_emit_task_event\|_api_task_events" ydcore/gateway.py`.
In the task-events init block add `self._task_epoch`. Epoch must be **monotonic across restarts and independent of the droppable cache dir**: persist it in `task_events.json` as a top-level `epoch`, and on load set `self._task_epoch = loaded_epoch + 1` (new boot = new epoch). `_emit_task_event` stamps `epoch=self._task_epoch` on each event. `_save_task_events` writes `{epoch, seq, events:[...]}`; `_load_task_events` reads `epoch`/`seq`, sets `_task_epoch = epoch+1`, `_task_seq = max(top seq, max event seq)` (unchanged). Even if a kill-9 loses the in-flight seq, the **new epoch** guarantees fresh ids.

```python
# event dict now:
ev = {"epoch": self._task_epoch, "seq": self._task_seq, "ts": time.time(),
      "kind": kind, "vid": str(vid), "state": state,
      "reason": (reason[:200] if reason else None)}
```

- [ ] **Step 2: Gateway — expose epoch on the endpoint**

`_api_task_events`: return `{"epoch": gw._task_epoch, "seq": gw._task_seq, "events": [e for e in gw.task_events if e["seq"] > since]}`. (Keep `since` semantics within the current epoch; events from older epochs already in the deque carry their own `epoch`, so include them — web dedups by id.)

- [ ] **Step 3: Unit test (red first)**

Add to `ydcore/test_task_events.py`:

```python
def test_epoch_bumps_on_reload_so_reused_seq_is_distinct_id(self):
    gw = self._fresh_gateway(self.dir)            # existing helper
    gw._emit_task_event("buffer", "1", "done")    # epoch=E, seq=1
    e1 = list(gw.task_events)[-1]
    gw2 = self._fresh_gateway(self.dir)           # reload from same dir
    gw2._emit_task_event("buffer", "2", "done")   # epoch=E+1, seq=1 (seq reused!)
    e2 = list(gw2.task_events)[-1]
    self.assertEqual(e1["seq"], e2["seq"])         # same seq
    self.assertNotEqual(e1["epoch"], e2["epoch"])  # different epoch -> different id
```

Run: `python3 -m unittest ydcore.test_task_events -v` → FAIL (no `epoch` key).
Implement Steps 1-2 → PASS.

- [ ] **Step 4: Web — id includes epoch, cursor closes the loop**

`web/src/types/api.ts`: `TaskEvent` add `epoch: number`; `TaskEventsResp` add `epoch: number`.
`route.ts ingestTaskEvents`: store cursor as `"<epoch>:<seq>"` in `SyncState['taskEventSeq']`. Parse `[curEpoch, curSeq]`. If `res.epoch !== curEpoch`: epoch changed → set `since = 0` (re-pull this epoch from the start; ids `evt-<epoch>-<seq>` are new, upserts are idempotent, nothing double-counts). Else `since = curSeq`. Write rows with `id = `evt-${e.epoch}-${e.seq}``. After ingest, set cursor to `"<res.epoch>:<res.seq>"`. Replace the bare R10 `console.warn` with this epoch-aware reset (the loop is now closed, not just observed).

```typescript
const raw = (await prisma.syncState.findUnique({ where: { key: "taskEventSeq" } }))?.value ?? "0:0";
const [curEpoch, curSeq] = raw.split(":").map(Number);
const res = await gatewayGet<TaskEventsResp>(`/api/task_events?since=${res_epoch_eq_cur ? curSeq : 0}`, 10000);
const since = res.epoch === curEpoch ? curSeq : 0;        // epoch flip -> re-pull
const fresh = res.events.filter((e) => !(e.epoch === curEpoch && e.seq <= curSeq));
// createMany id: `evt-${e.epoch}-${e.seq}`, skipDuplicates
// cursor: `${res.epoch}:${res.seq}`
```

> `id` change from `evt-<seq>` to `evt-<epoch>-<seq>` means **existing** `evt-<n>` rows stay (legacy, harmless); new rows use the new id. No migration needed (id is a free-form string PK). Keep `TaskHistory.seq` column as-is (still the in-epoch seq).

- [ ] **Step 5: Isolated e2e — the drop+collision scenario**

Extend `_e2e_task_events_isolated.mjs` (new assert block): emit seq 1,2,3 (epoch E); simulate drop (point `task_events_path` at an unwritable path OR freeze the file) so seq advances in memory but disk keeps `{epoch:E, seq:3}`; `kill -9` isolated gateway; restart (loads epoch E → bumps to E+1); emit a new event (epoch E+1, seq 1 — collides with old seq 1); GET `/api/courses/status` to ingest; assert `test.db` TaskHistory **gains the new event** (id `evt-<E+1>-1`), not dropped. Failure signal: before Step 4, the new event is deduped/cursor-blocked and missing. Run twice.

- [ ] **Step 6: Commit**

```bash
git add ydcore/gateway.py ydcore/test_task_events.py web/src/app/api/courses/status/route.ts web/src/types/api.ts web/scripts/_e2e_task_events_isolated.mjs
git commit -m "fix(history): boot epoch on task-event seq so drop+kill-9 can't silently drop events (#3)"
```

---

# TIER 2 — Thumbnail resource & capacity

## Task 3: ffmpeg timeout + gen watchdog (#4, #7)

**Bug:** `proc.wait()` in `_gen_thumbs_inner` has no timeout. A hung/slow ffmpeg pins one of the 3 thumb workers forever → the whole thumb queue stalls at `queued`/`gen`, no progress, only manual cancel/restart recovers. `gen` state has no `started_ts`, so no watchdog is even possible (#7).

**Files:** Modify `ydcore/gateway.py` (`_gen_thumbs_inner` ffmpeg invocation; `thumb_meta` gen entry). Test: `web/scripts/_e2e_thumb_timeout.mjs` (isolated, fake-ffmpeg).

- [ ] **Step 1: Re-grep** `grep -n "proc.wait\|Popen\|_gen_thumbs_inner\|thumb_meta\[vid\] = {\"state\": \"gen\"\|started_ts" ydcore/gateway.py`. Confirm `proc.wait()` has no timeout and `gen` dict has no timestamp.

- [ ] **Step 2: Add timestamp + bounded wait**

When setting `gen`: `self.thumb_meta[vid] = {"state": "gen", "started_ts": time.time()}`.
Add module const near other thumb consts: `_THUMB_FFMPEG_TIMEOUT = 120` (seconds; tune). Replace `rc = proc.wait()` with:

```python
try:
    rc = proc.wait(timeout=_THUMB_FFMPEG_TIMEOUT)
except subprocess.TimeoutExpired:
    proc.terminate()
    try: proc.wait(timeout=5)
    except subprocess.TimeoutExpired: proc.kill()
    rc = -1
    self._last_thumb_timeout = vid   # optional, for reason text
```

Map the timeout to the existing error path so the terminal `thumb/error` event fires with reason `"ffmpeg timeout %ds" % _THUMB_FFMPEG_TIMEOUT` (re-use the existing `rc != 0` → `thumb_meta error` + `_emit_task_event("thumb", vid, "error", reason)` branch — make the reason reflect timeout vs `rc=N`/`bad jpeg`). Also add `-rw_timeout` to the ffmpeg input args (microseconds, e.g. `-rw_timeout 30000000`) so a stalled HTTP read fails fast at the source.

- [ ] **Step 3: Failing isolated e2e with a fake hanging ffmpeg**

`_e2e_thumb_timeout.mjs`: write a fake `ffmpeg` shell script (`#!/bin/sh\nsleep 600`) into a TMPDIR `bin/`, boot the isolated gateway with `PATH=<TMPDIR>/bin:$PATH` (so it picks the fake), trigger one thumb gen, assert within `<timeout+10s>` the worker is freed and `test.db`/`/api/status` shows the vid as `thumb/error` (reason mentions timeout) — and a SECOND thumb for another vid completes/errs (queue not stalled). Failure signal: before Step 2, it hangs past timeout and the second never starts. (Set `_THUMB_FFMPEG_TIMEOUT` low via an env override `YD_THUMB_FFMPEG_TIMEOUT` you read in Step 2 to keep the test fast.)

- [ ] **Step 4: Commit** — `fix(thumb): bound ffmpeg wait with timeout+kill so a hung source can't stall the thumb queue (#4,#7)`

---

## Task 4: Strip `t_` from persisted extra_protect (#5)

**Bug:** During gen, `add_protect_vid('t_'+vid)` protects thumb source segs; the 5s `_save_playhead` snapshots `_extra_protect` into `playhead.json`. A restart (kill-9 is the standard redeploy!) landing in the gen window reloads `t_<vid>` into `_extra_protect` with no worker to ever remove it → permanent zombie protection that slowly eats effective cache capacity.

**Files:** Modify `ydcore/gateway.py` (`extra_protect_vids` snapshot used by `_save_playhead`) and/or `ydcore/cache.py` (`set_extra_protect`). Test: `ydcore/test_extra_protect_tprefix.py`.

- [ ] **Step 1: Re-grep** `grep -n "extra_protect_vids\|def set_extra_protect\|_save_playhead\|add_protect_vid" ydcore/gateway.py ydcore/cache.py`.

- [ ] **Step 2: Failing unit test**

```python
# ydcore/test_extra_protect_tprefix.py
import unittest
from ydcore.cache import DiskLRU
class TPrefixProtectTest(unittest.TestCase):
    def test_t_prefixed_not_persisted_and_not_loaded(self):
        lru = DiskLRU(10*1024*1024)              # non-persist ok for set/get of protect set
        lru.add_protect_vid("123"); lru.add_protect_vid("t_999")
        snap = lru.extra_protect_vids()
        self.assertIn("123", snap)
        self.assertNotIn("t_999", snap)          # 生成期保护不落盘
        lru.set_extra_protect(["123", "t_888"])  # 即便盘上有 t_ 也不回载
        self.assertIn("123", lru._extra_protect)
        self.assertNotIn("t_888", lru._extra_protect)
```

Run: `python3 -m unittest ydcore.test_extra_protect_tprefix -v` → FAIL.

- [ ] **Step 3: Implement — filter `t_` at both boundaries**

In `cache.py`: `extra_protect_vids()` returns `[v for v in self._extra_protect if not (isinstance(v, str) and v.startswith("t_"))]`. In `set_extra_protect(vids)`: keep existing `str()`+drop-empty, **plus** `if v.startswith("t_"): continue`. (Belt-and-suspenders: filtering on save is enough, filtering on load also self-heals any already-poisoned `playhead.json`.)

- [ ] **Step 4: Run unit → PASS.**

- [ ] **Step 5: Isolated e2e (self-heal across restart)** — in `_e2e_recover_guard.mjs` or a small `_e2e_zombie_protect.mjs`: seed `playhead.json` with `extra_protect:["t_555","321"]`, boot isolated gateway, assert `/api/_debug` `extraProtect` contains `321` but NOT `t_555`. Failure signal: before Step 3, `t_555` loads. Commit:

```bash
git commit -am "fix(cache): never persist/reload t_-prefixed (thumb) vids into extra_protect — kills zombie protection across restart (#5)"
```

---

## Task 5: Make thumb source-prefetch cancellable (#6, #9)

**Bug:** The `for u in urls` prefetch loop in `_gen_thumbs_inner` (before `Popen`) never re-checks `thumb_meta[vid].state == "cancelled"`, and `act_thumb` cancel can only `terminate` a `thumb_procs[vid]` that doesn't exist yet. Cancelling during prefetch keeps downloading the whole batch of low-clarity source segs (wasted bandwidth + shared-cache pressure); the cancel "looks done" but the background keeps running.

**Files:** Modify `ydcore/gateway.py` (`_gen_thumbs_inner` prefetch loop). Test: `web/scripts/_e2e_thumb_cancel_prefetch.mjs`.

- [ ] **Step 1: Re-grep** the prefetch loop and the existing cancel re-checks at the worker-dequeue site and the post-ffmpeg site (so the new check uses the **same** idiom).

- [ ] **Step 2: Add the re-check** inside the loop body, first line:

```python
for u in urls:
    if (self.thumb_meta.get(vid) or {}).get("state") == "cancelled":
        return  # 与出队(754)/ffmpeg后(849)同口径: 预取阶段也响应取消
    ...
```

- [ ] **Step 3: Isolated e2e** — `_e2e_thumb_cancel_prefetch.mjs`: trigger a thumb gen for a multi-segment lesson (use a fake slow source or `YD_TEST_*` hook so prefetch is observably in progress), call `/api/tasks/action {kind:thumb, vid, verb:cancel}` during prefetch, assert the isolated cache's segment count for `t_<vid>` **stops growing** within ~1s. Failure signal: before Step 2, it keeps growing to the full batch. (If a deterministic slow source is hard, at minimum assert state→cancelled AND no further `t_<vid>` segs appear after a short settle.) Commit: `fix(thumb): re-check cancel inside source-prefetch loop so cancel actually stops downloads (#6,#9)`.

---

## Task 6: Physically bound thumb source cache (#1, #8) — the structural one

**Bug:** Thumb source segs share the single 256MB `DiskLRU` with playback segs, with no sub-quota and no active cleanup. Generating thumbs for D can evict already-cached (but not-currently-watched) playback segs of A/B/C (they're outside `_live_vid`/`_extra_protect`). Source segs also linger after generation, competing for capacity. (`#8` thumbBytes confusion is the visible tail.)

**Approach (recommended): a separate small `DiskLRU` for thumb source segs.** Physical isolation is the only thing that *bounds* the interference; protection windows can't (they don't cover arbitrary already-cached segs). Add `drop_vid()` so a finished thumb releases its source segs immediately.

**Files:** Modify `ydcore/cache.py` (add `drop_vid`/`drop_namespace`), `ydcore/gateway.py` (second `DiskLRU` for thumbs; route thumb prefetch/ffmpeg-loopback reads/writes to it; drop after gen; `/api/status` `thumbBytes` from the thumb cache). Test: `ydcore/test_thumb_isolation.py` + `web/scripts/_e2e_thumb_isolation.mjs`.

- [ ] **Step 1: Decide the seam.** Re-read how thumb source segs are keyed (`(url, 't_'+vid)`) and how the ffmpeg loopback reads them through `/p`. Confirm the only writers/readers of `t_`-keyed entries are the thumb path (grep `t_`). This determines whether a second cache is a clean swap.

- [ ] **Step 2: Add `DiskLRU.drop_vid(vid)`** (cache.py) — remove all entries whose key's vid matches, delete their files, decrement `self.size`, all under `self.lock`. Unit-test it: put 3 segs for vid A + 2 for B, `drop_vid("A")`, assert A's files gone, `size` decremented by exactly A's bytes, B intact.

- [ ] **Step 3: Second cache in gateway.** `self.thumb_seg_cache = DiskLRU(_THUMB_CACHE_BYTES, <thumb_dir>/segcache)` with a small hard cap (e.g. `_THUMB_CACHE_BYTES = 64*1024*1024`). Route the thumb source prefetch `put`/`has`/`get` and the `/p` loopback **for `t_` reads** to `thumb_seg_cache`; playback stays on `seg_cache`. Remove the `t_` namespace from `seg_cache` (the splitter becomes identity again, or stays for back-compat but is unused). `add_protect_vid('t_'+vid)` is now unnecessary for cross-eviction (different cache) — keep only if the thumb cache itself needs intra-protection during gen.

- [ ] **Step 4: Drop after gen.** On `ready` (and on terminal error/cancelled), `self.thumb_seg_cache.drop_vid('t_'+vid)` (source segs are only a regeneration cache; the thumb sprite is already persisted). This fixes #8's lingering-source-segs.

- [ ] **Step 5: `thumbBytes`** in `/api/status` now reads `self.thumb_seg_cache.size` (clean, physically separate) — and the web StorageStrip change in Task 9 (#12) stops double-counting because thumb bytes are no longer inside `seg_cache.size`/`buffer.bytes`.

- [ ] **Step 6: Tests.** Unit `test_thumb_isolation.py`: fill `seg_cache` near cap with playback segs for A/B/C, run a thumb-source prefetch that exceeds `_THUMB_CACHE_BYTES`, assert (a) A/B/C playback segs in `seg_cache` are **untouched**, (b) `thumb_seg_cache` self-evicts within its own cap. Isolated e2e `_e2e_thumb_isolation.mjs`: buffer A/B/C on the isolated gateway, batch-generate thumbs, assert A/B/C `cached` segment counts in `/api/status` don't drop. Failure signal: before this task, A/B/C counts regress. Commit: `feat(thumb): physically isolate thumb source segs into a separate bounded DiskLRU + drop after gen (#1,#8)`.

> **Scope note:** Task 6 is the heaviest and the only one that changes the cache topology. It can ship as its own branch. Tasks 3/4/5 (thumb resource/cancel/zombie) are independent of it and can ship first.

---

# TIER 3 — Counting / attribution / display / edges

Each is small; full step granularity, grouped commits allowed per subsystem.

## Task 7: De-dupe totals across shared lessons (#13)

**Bug:** `totals.lectures/cachedLectures/thumbsReady` use per-course `reduce` sums; a shared lesson (same `videoId` across courses) is counted once per course — contradicting `bufferBytes` which already de-dupes physically. No current consumer, but a latent double-count.
**Files:** `web/src/app/api/courses/status/route.ts` (totals reduce ~`courseStatus.reduce(...)`).
- [ ] Compute these three from **distinct `(videoId, kind)`** sets (or distinct `videoId` for lectures/cached), not per-course sums. Add a unit-style assertion in an existing e2e: construct two courses sharing one videoId, assert `totals.lectures` counts it once.
- [ ] Commit: `fix(status): de-dupe totals.lectures/cachedLectures/thumbsReady across shared lessons (#13)`.

## Task 8: Carry productId so shared-lesson labels attribute correctly (#15)

**Bug:** Web resolves course name from `byVid` (videoId→last-writer course), so a shared lesson shows the wrong course in task/history rows.
**Files:** `ydcore/gateway.py` (`_emit_task_event` payload + buf_jobs already has productId), `web/prisma/schema.prisma` (`TaskHistory` add `productId Int?`), migration, `web/src/types/api.ts` (`TaskEvent` add `productId?`), `route.ts` (ingest writes productId; `allTasks`/tasks resolve course via `(productId, videoId)` when present, else fall back to `byVid`).
- [ ] Thread `productId` from `buf_jobs[vid]`/thumb job into the emitted event; persist; resolve label by `byCourseVid.get(`${productId}:${videoId}`)` with `byVid` fallback. e2e: shared lesson buffered under course X emits productId X → history shows X. Commit: `fix(history): carry productId in events so shared-lesson rows attribute to the right course (#15)`.

## Task 9: StorageStrip — stop double-showing thumb bytes (#12)

**Files:** `web/src/components/.../StorageStrip*` (re-grep `thumbBytes`/`bufferBytes`).
- [ ] After Task 6, `bufferBytes` no longer includes thumb bytes; relabel the buffer figure "缓存(播放)" and keep "缩略图" separate, OR if Task 6 not yet shipped, display `bufferBytes - thumbBytes` for the playback figure. Screenshot via `smoke.mjs`. Commit: `fix(ui): stop counting thumbnail bytes inside the cache figure (#12)`.

## Task 10: ThumbStatus mirror whitelist (#14)

**Files:** `route.ts` (thumb mirror write + offline fallback).
- [ ] Normalize mirrored thumb state to the `TaskState`/thumb whitelist (`ready→done`/`gen`/`error`/null); collapse `cancelled`/unknown to `null`; apply the same whitelist on the offline DB-fallback path. e2e: mirror a `gen`/`cancelled` then go offline, assert no stale "生成中"/miscolor. Commit: `fix(status): whitelist-normalize ThumbStatus mirror + offline fallback (#14)`.

## Task 11: Orphan cleanup must skip `.corrupt-<ts>` (#16)

**Files:** `ydcore/cache.py` (`_load_index` orphan sweep ~103-112).
- [ ] Add to the skip predicate: `or fn.endswith-pattern matching ".corrupt-"` (e.g. `"%s" % fn` contains `.corrupt-`). Unit: put a `playhead.json.corrupt-123` in the dir, run the sweep, assert it survives. Commit: `fix(cache): don't delete .corrupt-<ts> forensic backups during orphan sweep (#16)`.

## Task 12: thumb persistence uses its own ok-gate (#17)

**Files:** `ydcore/gateway.py` (thumb `_atomic_write_json` calls currently gated by `seg_cache.ok`).
- [ ] Gate thumb-dir persistence on a `thumb_dir` health probe independent of `seg_cache.ok` (don't freeze thumb writes because the *segment* drive dropped). Unit/e2e: simulate seg drive down, assert thumb_index still writes. Commit: `fix(persist): decouple thumb persistence health-gate from seg_cache.ok (#17)`.

## Task 13: pf_active per-worker token (#11)

**Files:** `ydcore/gateway.py` (`_prefetch_worker` finally; `pf_active`).
- [ ] Give each prefetch worker a generation token; `finally` clears `pf_active` only if the token still matches (CAS), so a stale worker's finally can't stop the new A after A→B→A. Unit test the token guard with two simulated workers. Commit: `fix(prefetch): per-worker token so a stale worker's finally can't cancel the new prefetch (#11)`.

## Task 14: Lock `_save_playhead` writes (#19)

**Files:** `ydcore/gateway.py` (`_save_playhead`) or `_atomic_write_json`.
- [ ] Wrap the `_save_playhead` write in a `threading.Lock` (or make `_atomic_write_json` use a unique tmp name `path+'.'+pid+'.'+tid+'.tmp'`) so the 5s flush and a recovery reflush can't interleave. Commit: `fix(persist): serialize playhead writes to avoid recover/flush interleave (#19)`.

## Task 15 (optional / may-not-fix): auto-thumb intra-tier yielding (#10)

Document the tradeoff; if changing, give auto-thumb a sub-priority between AUTO and MANUAL so it yields to same-tier prefetch. Default: **leave as-is** (defensible tradeoff — lowering it badly delays first-thumb). No code unless the user wants it.

## Task 16: buffer init-window terminal events (#18)

**Files:** `ydcore/gateway.py` (init-period emit at the `309`/`166` sites; Task 1's `_ever_loaded` reload helps).
- [ ] If the drive is down during init, buffer the init-period terminal events (zombie `queued→error`, thumb `gen→error interrupted`) in memory and re-emit (not just reflush) once the drive returns / on next successful save. Lowest priority — extremely narrow window. Commit: `fix(history): re-emit init-window terminal events when drive returns (#18)`.

---

## Dependency / execution order

```
Tier 1 (ship first, data loss):  Task 1 (recover guard) → Task 2 (seq epoch)
Tier 2 (thumb):                  Task 3 (ffmpeg timeout) ∥ Task 4 (zombie t_) ∥ Task 5 (cancel) → Task 6 (physical isolation, heaviest, own branch)
Tier 3 (cleanup):                Task 7 ∥ 9 ∥ 10 ∥ 11 ∥ 14 ∥ 16 ; Task 8 (needs migration) ; Task 12 ; Task 13
```
Task 9 (#12 display) reads cleanest **after** Task 6. Task 8 (#15) and Task 16 (#18) build on Tier 1's plumbing. Everything else is independent.

## Invariants (don't regress the 2026-05-28 work)

- Keep `cached` = disk truth, `total` = `len(seg_urls)` single-source-of-truth (Plan 1). Don't reintroduce `seg_total` or `cached=max(sum(flags),disk)`.
- `CacheStatus`/`ThumbStatus` stay `videoId`-keyed (mirror physical cache). Task 8 adds `productId` to **TaskHistory/events only**, not to Cache/Thumb tables ([[julestest-videoid-orphan-risk]]).
- ffmpeg loopback stays at MANUAL tier (don't steal LIVE bandwidth) — Task 6's separate cache must not change the tier.
- Persistence stays atomic (`_atomic_write_json` tmp+replace); Task 14 only adds a lock / unique tmp name.

## Self-review notes

- Coverage: all 19 audit items mapped (Tasks 1-16; #10 explicitly may-not-fix). 
- The two silent-data-loss items (#2, #3) are Tier 1 and each has a negative-control e2e (revert the fix → test goes red).
- Audit's un-covered areas (AES/HLS write-correctness, PriorityGate starvation, long-run `self.size` drift, cache-dir live migration, mirror/gateway reconciliation) are **out of scope** here — flag for a follow-up audit before claiming the cache subsystem is fully clean.
