# julestest — Project Memory

> Exported from Claude Code project memory on 2026-05-22.
> Scope: julestest project architecture (project-type memory only).

**Description:** julestest architecture — Next.js main backend (Prisma/SQLite) + Python decryption gateway; cache traffic priority watch > auto > manual.

---

`~/Documents/julestest` (GitHub hanbin2007/julestest) — a LAN Youdao course player. **Two-process architecture** (migrated 2026-05; see commits P1–P6 on branch `claude/adoring-noether-s6xM9`, plan `~/.claude/plans/eager-tumbling-badger.md`):

- **Next.js main backend + UI (`web/`, port 3000, bound 0.0.0.0 for LAN)**: App Router route handlers + **Prisma 6 / SQLite** at `~/.youdao_course/app.db`. Owns all app state: course catalog (synced from gateway then served from DB — **no re-fetch each load**), watch progress, notes, settings/last-watched, cache/thumb status mirror. `next.config.ts` rewrites ONLY `/p` and `/thumbs` to the gateway (media bytes, Range/206); `/api/*` are Next handlers. `src/lib/gateway.ts` calls the gateway server-side; a catch-all `app/api/[...path]` proxies anything not yet taken over. Client state via SWR hooks in `src/hooks/persist.ts` (revalidateOnFocus = cross-device).
- **Python gateway (`youdao_course.py`, 127.0.0.1:8808)**: kept as the "Youdao network + decryption" layer only — session (`req.txt`), course/video/m3u8 resolve, HLS `/p` decrypt + AES key, ffmpeg thumbnails, and the **persistent disk segment cache with three-tier bandwidth priority LIVE(观看) > AUTO(自动预缓存) > MANUAL(手动缓冲)** via `pri_fetch(tier,…)` + protect-vid LRU eviction (`~/.youdao_course/cache` + atomic index; SIGTERM saves; thumbnails need ffmpeg `-extension_picky 0`).

**Run:** `./run.sh` (starts gateway + `next start`; migrate deploy + build-if-needed). User's Mac has limited downlink → the watch > cache priority matters.

**Testing:** Playwright MCP browser was dead (stale CDP :55238); use `web/scripts/smoke.mjs` (drives system Chrome via `playwright-core`, headless screenshots) instead.
