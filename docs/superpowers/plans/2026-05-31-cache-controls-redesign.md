# Cache Controls Redesign — Implementation Plan

**Approved design (2026-05-31).** Owner directive: *satisfy a normal user, not the owner's accumulated design* — which, after brainstorming, resolved to: **the cache backend is already solid; make the controls actually work and the surface coherent. Keep the richness (segment counts, thumbnail control, per-lesson detail) — just make it orderly and make every control confirm it landed.**

## Why (grounding)

A 5-agent mapping workflow confirmed the cache/thumb **backend is ~90% migrated and robust** (single-source counts, atomic crash-safe persistence, thumb isolated into its own 64MB bucket, append-only event log). The dissatisfaction is on the **surface + control** axis:

- **Controls feel useless even though the gateway mostly works.** Buffer pause/resume/cancel/retry and thumb cancel/retry *do* function and survive `kill -9`. But the web layer **discards `TaskActionResult{ok,state,reason}`** (`SettingsView.tsx` `handleTaskAction` ~line 144), shows nothing on success and a generic `操作未生效` on failure, and **drops polling to 5s once nothing is `working`** (`hooks/data.ts` ~line 74) — so a paused task looks frozen. Batch submits report `跳过 N` with the reasons thrown away (`SettingsView.tsx` ~line 129).
- **Prefetch (自动) genuinely has no controls**, isn't persisted across restart, yet renders as a task row with no buttons (`gateway.py` ~1941, `TaskRow.tsx` ~31) — so it *looks* stuck/broken.

## Scope

**This plan = Theme A (controls that work).** Theme B (coherent sectioning + unified state vocabulary) is documented at the end as the agreed follow-up; it is NOT implemented here (it heavily rewrites `SettingsView.tsx`/`TaskRow.tsx` and would collide with Theme A — sequence A first).

## Shared API contract (both lanes implement to THIS — do not improvise)

All citations are approximate; **re-`grep` the symbol before editing** (line numbers drift).

### Gateway endpoints

1. **`/api/tasks/action`** (handler ~`gateway.py:1938`) must accept **`kind="prefetch"`** (currently rejected ~1962). For all kinds it returns the existing uniform shape:
   ```json
   { "ok": true|false, "vid": "...", "kind": "buffer|thumb|prefetch", "state": "<new state or null>", "reason": "<plain-language reason or null>" }
   ```
   `reason` MUST be human-readable Chinese for failures (e.g. `任务已完成，无法暂停`, `该讲未在预缓存`).

2. **`act_prefetch(vid, verb)`** — new, mirroring `act_buffer` (~1457). Verbs: `pause | resume | cancel`. Drives a new control flag `pf_control[vid] ∈ {running, paused, cancelled}` (absent ⇒ running).
   - The prefetch worker (`_prefetch_worker`, loop ~1618 checking `stop.is_set()`/`_is_owner()`) gains a flag check: while `paused`, **idle without advancing and without exiting** (so `resume` continues without a new `/api/play`); on `cancelled`, stop like `stop.is_set()`.
   - Persist `pf_control` via `_atomic_write_json` → `pf_control.json`; reload on startup next to `pf_done.json` (~626). Paused/cancelled MUST survive `kill -9`.

3. **Global background-caching switch.** New flag `self._bg_paused` (persisted, `bg_state.json`). New endpoint `POST /api/bg/pause` body `{ "paused": true|false }` → `{ ok, paused }`. All three workers (buffer ~1356, thumb, prefetch ~1618) check `self._bg_paused` at the same point they check their per-task flag: when paused, **idle without advancing, without mutating per-task state**. Surface `bgPaused: bool` in `/api/status`.

4. **Batch skip reasons.** Batch buffer/thumb endpoints (returning `{queued, skipped}`, type `BatchResult` ~`api.ts:97`) add `skippedReasons: { [vid]: string }` (or a categorized `{reason: count}` map). Plain-language reasons.

### Web types (`web/src/types/api.ts`)
- `TaskVerb` includes prefetch-applicable verbs; `TaskActionResult{ok,state,reason}` already exists (~197) — ensure consumed.
- `BatchResult` gains `skippedReasons`.
- `GwStatus`/status payload gains `bgPaused: boolean`.

---

## Lane breakdown (file ownership — no two parallel agents share a file)

### Phase 1 — Backend + isolated web (PARALLEL, disjoint files)

**Lane G — Gateway (Python).** Files: `ydcore/gateway.py`, `ydcore/priority.py`, `ydcore/cache.py`.
- G1. `act_prefetch` + `pf_control` flag + worker flag-check (pause idles, cancel stops). 
- G2. `/api/tasks/action` accepts `kind="prefetch"`; uniform `{ok,state,reason}`.
- G3. Global `_bg_paused` + `/api/bg/pause` + all-worker gate + `bgPaused` in `/api/status`.
- G4. Batch skip reasons in batch buffer/thumb responses.
- G5. Persist `pf_control.json` + `bg_state.json` via `_atomic_write_json`; reload on startup.
- **Test (TDD, write first):** `web/scripts/_e2e_prefetch_control.mjs` — drives the gateway over HTTP on an **isolated port** (env override) with an **isolated cache dir**: asserts pause→worker stops advancing (segment count stable), resume→advances, cancel→stops; then a **`kill -9` mid-paused → restart → state still `paused`** assertion. Must have a clear failure signal (FAIL vs PASS lines, nonzero exit). No prod DB, no prod cache dir.

**Lane W-poll — `web/src/hooks/data.ts` ONLY.** A2: fast-poll (≈1s) whenever any task is non-terminal (`working|queued|paused`) **or** an action was issued in the last ~4s (expose a `markRecentAction()` or include `paused`/`queued` in the predicate ~line 74). `tsc --noEmit` clean.

**Lane W-types — `web/src/types/api.ts` ONLY.** Add `BatchResult.skippedReasons`, `bgPaused` to status, confirm prefetch verbs in `TaskVerb`. `tsc --noEmit` clean.

### Phase 2 — Web components (SEQUENTIAL, single agent — coupled cluster)

**Lane W-core.** Files: `web/src/components/settings/SettingsView.tsx`, `TaskRow.tsx`, `TaskQueuePanel.tsx`, `TaskQueueFullscreenDialog.tsx`, `web/src/lib/api.ts`. Reads the **actual gateway code Lane G wrote** to confirm the contract.
- A1. `handleTaskAction` captures `TaskActionResult`: on `ok` reflect new `state` immediately (optimistic SWR patch + confirm) + brief toast (`已暂停/已继续/已取消/已重试`); on `!ok` toast the `reason`. Batch submit surfaces `skippedReasons` (which lessons + why), not just counts.
- A3-web. Render pause/resume/cancel for `kind==="prefetch"` rows (`availableVerbs` ~`TaskRow.tsx:31`); label prefetch `自动·随播放` so it reads as automatic-but-controllable. Add the single global **暂停所有后台缓存** toggle (calls `/api/bg/pause`, reflects `bgPaused`).
- A4. Failed tasks expose Retry where the user looks (not only buried read-only in history ~`TaskRow.tsx:103`); consolidate the failed-task duplication across tabs.
- `tsc --noEmit` + `npm run build` clean.

### Phase 3 — Integrate & static-verify (single agent)
- `tsc`, `npm run build`, `python -m py_compile ydcore/*.py` all clean. Report any cross-lane integration mismatch (type vs gateway contract).

### Phase 4 — LIVE e2e (orchestrator-run, serialized, port-aware — NOT a parallel agent)
Per CLAUDE.md hard rules, done with **real restart**: rebuild web + `kill -9` gateway + restart, on isolated ports/DB if the user's live instance occupies 3000/8808. Run `_e2e_prefetch_control.mjs` + a buffer/thumb control e2e + `smoke.mjs` screenshots of the task panel showing a control action confirming. Cross-restart persistence asserted live.

---

## Theme B (agreed follow-up — not in this plan)
Sectioned `SettingsView` (系统·存储 / 缓存管理 / 任务 / 历史·诊断), one coherent storage view with a 播放/离线/缩略图 breakdown (replacing two competing budgets), a single canonical state vocabulary across grid/rows/history, and replacing the `已缓存(部分)` static-30% fill with honest progress. Sequenced after Theme A lands and is verified.

## Verification gates (CLAUDE.md)
- Every control (buffer/thumb/prefetch × pause/resume/cancel/retry) has a repeatable e2e with a failure signal.
- Prefetch + global-pause persistence verified by real `kill -9` → restart.
- UI confirmation verified by screenshot, not prose.
- No test writes to the live SQLite DB or prod cache dir.
- Test scripts pass on two consecutive runs (no stateful side effects).
