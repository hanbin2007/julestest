# Operation History (TaskHistory) Cleanup & De-noise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.
>
> **状态:2026-05-29 仅诊断+计划,尚未执行。** 由 Opus 4.8(1M)4 维并行审计产出,所有 file:line 已对工作树核对(本文件末尾「核对记录」)。

**Goal:** 让设置页「操作历史」从一堆噪声(85% 是缩略图取消、永久转圈的僵尸 working、`reason` 永远为空的失败、e2e 测试桩)恢复成一个**可读的、每任务一行最新态的回顾视图**:缩略图取消完全不进历史、运行态(working/queued)不进历史、失败带真实原因、测试不再污染生产库。

**根因(总):** `TaskHistory` 不是事件流,而是 **web 轮询对网关全量状态快照做 diff 写入**的 append-only 日志。每次 `GET /api/courses/status`(200ms 防抖)→ `mirror()` → `appendTaskHistory(gw)`(`web/src/app/api/courses/status/route.ts:383,450`)读取网关 `/api/status` 返回的 `gw.buffer.states` / `gw.thumb.states` / `gw.live.done` 三份「当前全量状态快照」,与进程内 `lastTaskState` Map 逐 `(kind,videoId)` 比对,把「与上次不同」的写一行。`grep` 全 `ydcore/` 无 `TaskHistory` 字样——网关完全不写历史。所以历史里出现哪些行,取决于轮询恰好采到哪些瞬时态,而非任务真实经历了哪些转换。

**Architecture:** 两进程。Python 网关(`ydcore/gateway.py`)在 `127.0.0.1:8808`,持有 HLS resolve / AES 解密 / 磁盘段缓存 / ffmpeg 缩略图,并通过 `/api/status`(`_api_status` @ `gateway.py:1408`)暴露全量状态快照(含 `buffer.states`/`buffer.perVid`/`thumb.states`/`thumb.session`/`live.done`)。Next.js web(`web/`)在 `:3000`,镜像网关状态进 SQLite(`/Users/zhb/.youdao_course/app.db`),其中 `TaskHistory` 表(`web/prisma/schema.prisma:140-150`)是「操作历史」的唯一数据源。本计划**只动 web 镜像/历史层 + 一处网关 thumb reason 导出**,不碰段缓存/优先级/解密。

**Tech Stack:** Python 3(stdlib `http.server`/`subprocess`/`threading`),ffmpeg;Next.js 15 App Router + MUI v7 + Prisma 6/SQLite;Node ESM e2e 脚本(`fetch` + `playwright-core` 系统 Chrome,见 `web/scripts/smoke.mjs` 与 `_e2e_*.mjs`)。

---

## Decisions baked in(用户已拍板,2026-05-29)

1. **缩略图取消(thumb `cancelled`)完全不进历史。** 写入侧从 `appendTaskHistory` 剔除 thumb cancelled;存量 354 行一并 `DELETE`。理由:缩略图取消是廉价 ffmpeg 操作噪声,用户基本不需逐条看到。
2. **分两层:面板折叠概览 / 全屏完整时间线。**(2026-05-29 二次确认)
   - **面板**(`TaskQueuePanel`「操作历史」标签):折叠成「每任务 `(videoId,kind)` 一行最新态」,干净概览。
   - **展开全屏**(`TaskQueueFullscreenDialog`):显示**完整终态时间线**(同任务多次完成/取消/失败各一行,带**时间戳 + 原因**)= 详细信息。
   - **关键:折叠是面板组件的客户端行为,不在 API 做**(`allTasks` 与全屏共用同一数组,若在 API 折叠会连全屏一起丢详情)。API 返回完整时间线,面板自己 collapse-then-slice。
   - **两种「去重」别混:** ① 写入侧去重(`route.ts:484`,同 `(kind,vid)` 连续相同 state 不重复写)**必须保留**——否则 200ms 轮询每次给每任务写一行、瞬间爆库;它是写入防抖,不是显示层。② 显示侧折叠(本条)只作用于面板,全屏不折叠。
   - **红利:** Task 1 已从源头删噪(无 thumb cancelled、无 working/queued),所以全屏的「完整时间线」本身就干净(只剩真实终态事件);面板折叠又让翻转 churn(48186 当前 6 行)在概览里只剩一行 → **不需要**写入侧去重状态机(审计原 rank6 砍掉,降复杂度)。
3. **本次只出计划文档,不改代码。** 实际执行另起;执行时严格按 CLAUDE.md:每条修复有可重复 e2e + 失败信号 + 涉持久化必 kill-9 重启验证。

---

## Out of scope(本计划明确不做)

- **去重状态机(原 rank6):** 面板折叠让 churn 在概览里只剩一行,全屏则**有意保留**翻转时间线作为详情;两边都不需要在写入侧分辨「翻转 vs 真转换」,故砍掉状态机。
- **完整 cache/thumb 子系统重构:** 见 `docs/superpowers/plans/2026-05-28-thumbnail-decoupling.md` 等 4 份计划([[julestest-cache-thumb-rearchitecture]])。本计划只治「操作历史可读性」,不改 thumb_index 持久化语义、不动 DiskLRU 命名空间。
- **历史 UI 分组/过滤 chip(原 B 维 rank4):** 折叠 + 去噪后历史已可读,分组 chip 作为后续可选增强,不在本计划。

---

## Assumptions / depends on

- 与 `docs/superpowers/plans/2026-05-28-*.md` 四份计划**相互独立**,本计划不依赖它们落地;但若那些计划改动了 `appendTaskHistory` 或 `_api_status` 的 thumb 段结构,执行本计划前需重新 `grep` 对应符号核对行号。
- **更正(2026-05-29 核对):`TaskItem` 没有 `reason` 也没有 `at`**(`types/api.ts:155-164`)。此前误以为 @172 有 reason——那个 reason 属于 `TaskActionResult`(@172),不是 `TaskItem`。所以 Task 3 需给 `TaskItem` **同时加 `at?: number` 和 `reason?: string | null`**。好消息:`mkHistRow(kind,videoId,state,reason?)` **已收 reason 参数**(`route.ts:394`)且 `createMany` 已透传(`route.ts:491`),Prisma `TaskHistory` 已有 `reason`/`at` 列(`schema.prisma:145,146`)——写入侧/DB 侧无需改,只缺类型字段 + 映射填充。
- 网关 `/api/status` **已暴露** `thumb.session`(`gateway.py:1463`,`tsession=sorted(gw.thumb_session)` @1413)与 `buffer.perVid[vid].reason`(仅 error 时,`gateway.py:1447-1451`);web 侧 `route.ts:249` 已在读 `gw.thumb.session`。**唯一缺口:** thumb error 的 `reason` 存在 `thumb_meta[vid].reason`(`gateway.py:668/686/756`)但 `tstates`(`gateway.py:1458`)只导出 state、丢弃 reason —— Task 2 需补这一处网关导出。
- 改 Python(`ydcore/`)必须 `kill -9` 网关进程再启(`run.sh` 监督模式 ~2-4s 自愈);改 Web(`web/src/`)必须 `npm run build` + 重启 next。见 [[julestest-deploy-restart]]。
- DB 路径 `/Users/zhb/.youdao_course/app.db`(`web/.env` 的 `DATABASE_URL`)。

---

## 现状数据画像(执行前快照,用作回归对照)

```
DB 共 414 行 TaskHistory:
- thumb cancelled = 354 (85%);  thumb done = 18
- buffer: working=10(残留僵尸), done=17, cancelled=6, error=4, paused=1, queued=1
- prefetch done = 3
- state=error 4 行 reason 全 NULL,videoId = 999000111/888000222/777000333(测试桩)
- 397 distinct (videoId,kind) vs 414 行;噪音主因是 353 个不同缩略图各 cancelled 一次,
  且 353 行 at 完全相同(=1779985868714,单次 createMany 批写=网关重启回载,非用户逐次取消)
```

执行前先存一份基线,供 Task 7 回归对照:

```bash
DB=/Users/zhb/.youdao_course/app.db
sqlite3 -header -column "$DB" "SELECT kind,state,COUNT(*) n FROM TaskHistory GROUP BY kind,state ORDER BY n DESC;"
```

---

## Task 1 — 写入侧止血:缩略图取消不入库 + 运行态不入库 + thumb session 过滤 + 批量上限防呆

**Files:**
- Modify: `web/src/app/api/courses/status/route.ts`(`appendTaskHistory` buffer 循环 458-462、thumb 循环 465-472、createMany 488-492)
- Test: `web/scripts/_e2e_operation_history.mjs`(Create — 见 Task 7,本 Task 先写入库断言部分)

写入侧当前两个分支语义不一致且都漏(`route.ts:458-472`):

```
// buffer: 无过滤,working/queued/paused 照单写
for (const [vid, st] of Object.entries(bufStates)) { rows.push({ kind: "buffer", videoId, state: st }); }
// thumb: 有 continue 过滤瞬态 gen,但 NO session 过滤 → 回载的 352 个非本会话 cancelled 全灌库
for (const [vid, st] of Object.entries(gw.thumb.states ?? {})) {
  if (st !== "ready" && st !== "error" && st !== "cancelled") continue;
  rows.push({ kind: "thumb", videoId, state: st === "ready" ? "done" : st });
}
```

- [ ] 先确认现状(应看到 buffer 无过滤、thumb 无 `thSession` 引用):

```bash
cd /Users/zhb/Documents/julestest && sed -n '450,493p' web/src/app/api/courses/status/route.ts
```

- [ ] **buffer 循环(458-462):只写终态。** queued/working/paused 是运行态,已由实时 `tasks` 数组(`route.ts:262-270`)展示,不该进 append-only 历史。改为:

```typescript
  // buffer: 只把终态写历史(done/error/cancelled);运行态(working/queued/paused)由实时 tasks 数组展示。
  // 杜绝"working 进历史→历史里永久转圈"的僵尸行(见 2026-05-29 操作历史清理计划 Task 5)。
  const bufStates = gw.buffer.states ?? {};
  for (const [vid, st] of Object.entries(bufStates)) {
    const videoId = Number(vid);
    if (!videoId || !st) continue;
    if (st !== "done" && st !== "error" && st !== "cancelled") continue;
    const reason = st === "error" ? (gw.buffer.perVid?.[vid]?.reason ?? null) : null; // Task 2 填 reason
    rows.push({ kind: "buffer", videoId, state: st, reason });
  }
```

- [ ] **thumb 循环(465-472):剔除 cancelled + 加 session 过滤。** 决策 1:缩略图取消完全不进历史。决策同时要求只记本会话(否则网关重启回载的旧 ready/error 也会被当新事件)。复用 `route.ts:249` 已有的 `thSession`:

```typescript
  // thumb: 决策(2026-05-29)缩略图取消完全不进历史 → 只写 ready→done 与 error;且只记本会话
  // (thSession),避免网关重启回载的非本会话状态被当新事件灌库(那正是 354 行 cancelled 洪水的来源)。
  const thSession = new Set(gw.thumb.session ?? []);
  for (const [vid, st] of Object.entries(gw.thumb.states ?? {})) {
    const videoId = Number(vid);
    if (!videoId || !st) continue;
    if (!thSession.has(vid)) continue;          // 非本会话(回载态)一律不进历史
    if (st !== "ready" && st !== "error") continue; // cancelled/gen 都不进
    rows.push({ kind: "thumb", videoId, state: st === "ready" ? "done" : "error", reason: null }); // thumb reason 见 Task 2
  }
```

> 注:`thSession` 在 `appendTaskHistory` 作用域内需可见。`route.ts:249` 的 `thSession` 在 `build()` 里;`appendTaskHistory` 是独立函数,需在其内部重新 `const thSession = new Set(gw.thumb.session ?? [])`(`gw` 已是入参)。不要把 build() 的局部变量跨函数引用。

- [ ] **批量上限防呆(createMany 前,488-492):** 兜底防任何一次镜像把大批回载态误当新事件灌库(治本是上面的 session 过滤,这是安全网):

```typescript
  if (fresh.length === 0) return;
  if (fresh.length > 50) {
    // 异常:单次轮询不该产生 >50 条新历史事件(正常用户操作一次最多个位数)。
    // 极可能是回载态被误判为新事件(参见 2026-05-28 16:31 那次 353 行 thumb cancelled 批写)。记 warn 并截断。
    console.warn(`[appendTaskHistory] 单次 fresh=${fresh.length} 异常,截断到 50 防灌库`);
    fresh.length = 50;
  }
```

- [ ] **失败信号 e2e(Task 7 的子集,先验这一段):** 重启网关 + web 后,反复 `curl /api/courses/status` 触发多轮镜像,断言:
  - DB 不再新增任何 `kind='thumb' AND state='cancelled'` 行(决策 1);
  - DB 不再新增 `kind='buffer' AND state IN ('working','queued')` 行(运行态不入库);
  - 非本会话的 thumb vid(造一个回载但不在 session 的)不产生历史行。
  - **失败信号:** 故意先注释掉 thumb session 过滤,跑脚本应 FAIL(看到新 cancelled 行),证明断言有效。

---

## Task 2 — 失败带真实原因:补 thumb reason 网关导出 + 写入侧填 reason

**Files:**
- Modify: `ydcore/gateway.py`(`_api_status` thumb 段 1458 附近,新增 reason 导出)
- Modify: `web/src/app/api/courses/status/route.ts`(thumb 循环填 reason;buffer 已在 Task 1 填)
- Modify: `web/src/types/api.ts`(`GwStatus.thumb` 加 `reasons?: Record<string,string|null>`;`GwStatus.buffer.perVid` 值类型加 `reason?: string|null`)——与 Task 3 的 types/api.ts 改动同属一文件,由同一人/agent 做
- `mkHistRow` 已收 reason 参数(`route.ts:394`),无需改签名

DB 实测 414/414 行 reason 全 NULL。buffer error 的 reason 网关已在 `perVid[vid].reason` 暴露(`gateway.py:1447-1451`,Task 1 已读取);**缺口是 thumb error reason**:`thumb_meta[vid].reason` 有值(`gateway.py:668/686/756`),但 `tstates`(`gateway.py:1458`)只导出 state。

- [ ] 确认 `_api_status` thumb 段现状:

```bash
cd /Users/zhb/Documents/julestest && sed -n '1408,1472p' ydcore/gateway.py
```

- [ ] 网关导出 thumb error reason(新增 `treasons` map,不改 `tstates` 形状以免影响其它消费者):

```python
        # treasons: 仅 error 态附原因(thumb_meta[vid].reason),供 web 写历史/展示失败原因用。
        treasons = {v: m.get("reason") for v, m in gw.thumb_meta.items()
                    if isinstance(m, dict) and m.get("state") == "error" and m.get("reason")}
```

并加进返回 dict 的 thumb 段(`gateway.py:1458-1465` 内):`"reasons": treasons,`

- [ ] web thumb 循环填 reason(Task 1 的 thumb 块基础上):

```typescript
    const thReasons = gw.thumb.reasons ?? {};
    rows.push({ kind: "thumb", videoId, state: st === "ready" ? "done" : "error",
                reason: st === "error" ? (thReasons[vid] ?? null) : null });
```

- [ ] 补 `GwStatus` 类型(`web/src/types/api.ts` 或 route.ts 内的网关响应类型)thumb 段加 `reasons?: Record<string,string|null>`。

- [ ] **失败信号 e2e:** 造一个 buffer error(用不可达 m3u8 或注入)和 thumb error,重启后断言对应 TaskHistory 行 `reason` 非空且文案正确(buffer:`分片下载失败 N 个`/`AES key 拉取失败`/僵尸`重启后丢失任务上下文`;thumb:`ffmpeg rc=N`/`no headers` 等)。**失败信号:** 修前跑应 FAIL(reason 为 NULL)。
- [ ] 改 Python 必须 `kill -9` 网关重启(见 [[julestest-deploy-restart]]),否则旧解释器仍跑老代码、reason 仍空。

---

## Task 3 — 分两层:API 返回完整时间线 + 面板客户端折叠 + 全屏显示详情

**Files:**
- Modify: `web/src/app/api/courses/status/route.ts`(`allTasks` 映射 307-322:补 `at`/`reason`)
- Modify: `web/src/types/api.ts`(`TaskItem` 加 `at?: number`;`reason` 已存在 @172)
- Modify: `web/src/components/settings/TaskQueuePanel.tsx`(历史标签客户端折叠,50-52)
- Modify: `web/src/components/settings/TaskRow.tsx`(历史模式显示时间戳 + 原因)

决策 2(分两层)。**API 不折叠**——`allTasks` 与全屏共用同一数组(`TaskQueuePanel.tsx:50` / `TaskQueueFullscreenDialog.tsx:29` 都吃 `allTasks`),在 API 折叠会连全屏一起丢详情。所以:API 返回完整终态时间线(Task 1 后已无噪音),面板自己 collapse,全屏原样展示。

- [ ] **API 侧(`route.ts:307-322`):保留完整时间线,只补 `at` 和 `reason` 两个字段**(不折叠,`take:500` 不变):

```typescript
    allTasks = history.map((h) => {
      const m = byVid.get(h.videoId);
      const b = perVidGw[String(h.videoId)];
      const showSegs = h.kind !== "thumb";
      return {
        vid: h.videoId,
        title: m?.title ?? `视频 ${h.videoId}`,
        courseName: m?.courseName ?? "未知课程",
        courseId: m?.courseId ?? 0,
        kind: h.kind as TaskItem["kind"],
        state: h.state as TaskItem["state"],
        cached: showSegs ? b?.cached : undefined,
        total: showSegs ? (b?.total ?? null) : null,
        at: h.at.getTime(),            // 新增:全屏时间线显示时间
        reason: h.reason ?? null,      // 新增:失败原因透传(配合 Task 2)
      };
    });
```

- [ ] `web/src/types/api.ts`:`TaskItem` **同时加 `at?: number` 和 `reason?: string | null`**(两者都没有;@172 的 reason 是 `TaskActionResult` 的)。同文件 Task 2 还要加 `GwStatus.thumb.reasons` 与 `GwStatus.buffer.perVid.reason`。

- [ ] **面板侧(`TaskQueuePanel.tsx:50-52`):历史标签客户端折叠**(每 `(vid,kind)` 取最新一行)。因 API 已 `at desc`,首见即最新:

```typescript
  const collapseLatest = (rows: TaskItem[]) => {
    const seen = new Set<string>(); const out: TaskItem[] = [];
    for (const t of rows) { const k = `${t.kind}:${t.vid}`; if (seen.has(k)) continue; seen.add(k); out.push(t); }
    return out;
  };
  const lists = [tasks, allTasks];
  const current = lists[tab] ?? [];
  // 历史标签(tab===1)在面板里折叠成每任务最新态;进行中标签不折叠。全屏(TaskQueueFullscreenDialog)不折叠。
  const display = isHistoryTab ? collapseLatest(current) : current;
  const shown = display.slice(0, PANEL_CAP);
```

> `TaskQueueFullscreenDialog.tsx` **不改折叠逻辑**——它直接 `allTasks`(`:29` lists)按时间线全量展示,正是「展开看详情」。

- [ ] **TaskRow 历史模式显示时间戳 + 原因(`TaskRow.tsx`):** `isHistory` 时在标题行尾或副行显示 `task.at` 格式化时间(`HH:mm` 或 `MM-DD HH:mm`)与 `task.reason`(失败态)。面板折叠后同任务只一行,时间意义不大可省;全屏时间线**必须**显示时间区分同任务多行。建议:`isHistory && task.at` 才渲染时间,`task.reason` 有值才渲染原因(灰色小字)。

- [ ] **失败信号 e2e:**
  - 对同一 vid 制造 `done`→(重缓存取消)→`cancelled`→(再缓存)→`done` 三条终态行。断言:**面板**历史标签该 `(vid,'buffer')` **只 1 行**且 state=最新(done);**全屏**该 vid **3 行**,按 `at` 倒序,各带时间。
  - **失败信号:** 修前面板会显示多行(FAIL);若误把折叠加到全屏,全屏只剩 1 行(FAIL)。两个方向都要能区分。

---

## Task 4 — UI 防呆:历史模式 isHistory 冻结非终态,不转圈

**Files:**
- Modify: `web/src/components/settings/TaskRow.tsx`(`working` 判定 88、渲染 101-102)

`TaskRow.tsx:88` `const working = st === "working"` 与 `isHistory` 无关,`:101` 对 working 一律 `CircularProgress`。历史是冻结快照,不该有转圈。这是 Task 5(清存量僵尸)落地前/后的纵深防御——即便 DB 仍残留 working,历史也不无限转圈。

- [ ] 改判定(`TaskRow.tsx:88`):

```typescript
  const working = st === "working" && !isHistory; // 历史是冻结快照:非终态不转圈,降级成静态点
```

- [ ] 确认 `:95-96` 的 `dotColor` 对 `working`(落到默认 `text.disabled` 灰点)展示合理;历史里残留 working 显示成灰点 + 「进行中」chip(只读),不转圈。

> **与 Task 3 同改 `TaskRow.tsx`:** Task 3 在历史模式加「时间戳 + 原因」展示(改标题/副行),本 Task 改 `working` 判定(88)与渲染(101)。两处不冲突,建议一并提交,改完一起跑 Task 3/4 的 e2e。
- [ ] **e2e/截图证据:** 用 `web/scripts/smoke.mjs` 截「操作历史」标签:断言无 `CircularProgress`(role/选择器)出现在 history 列表;留 PNG 到 `docs/superpowers/uac-shots/`。见 [[julestest-testing]]。

---

## Task 5 — 数据清理:幂等启动迁移(测试桩 + 僵尸 working + 存量 thumb cancelled)

**Files:**
- Modify: `web/src/app/api/courses/status/route.ts`(`initLastTaskStateOnce` 启动清理段 423-428,已有 90 天裁剪的同类位置)

把一次性清理做成**幂等的启动迁移**,放在已有的 90 天裁剪旁(`route.ts:423-428`),既清存量又防 web 进程重启后回填僵尸。仅删「确定无价值」的:测试桩 + 被更晚终态取代的僵尸 working + 决策 1 要清的 thumb cancelled。

- [ ] 在 `initLastTaskStateOnce` 的 try 块里(90 天裁剪之后)加:

```typescript
  try {
    // (a) e2e 测试桩(合成 vid,grep 仓库无真实引用)
    await prisma.taskHistory.deleteMany({ where: { videoId: { in: [999000111, 888000222, 777000333] } } });
    // (c) 决策 2026-05-29:缩略图取消完全不进历史 → 清存量 354 行
    await prisma.taskHistory.deleteMany({ where: { kind: "thumb", state: "cancelled" } });
    // (b) 被更晚终态取代的僵尸 working/queued(append-only 残骸)。用原生 SQL 做 EXISTS 子查询。
    await prisma.$executeRawUnsafe(
      `DELETE FROM TaskHistory WHERE state IN ('working','queued') AND EXISTS (
         SELECT 1 FROM TaskHistory t2 WHERE t2.kind=TaskHistory.kind
         AND t2.videoId=TaskHistory.videoId AND t2.at > TaskHistory.at)`
    );
  } catch { /* 清理失败不致命 */ }
```

> 说明:`(b)` 只删「有更晚终态行」的 working/queued(已 SQL 验证 10 条 working 每条都有更晚 done/cancelled/error)。没有更晚终态的 working(真·正在进行)不删——但 Task 1 之后运行态根本不再入库,这种行只会是历史残留。Task 1+5 合力后,历史只剩终态。

- [ ] **可重复性验证:** 连跑两次启动(kill-9 网关+web 重启两轮),第二轮 deleteMany 影响 0 行也不报错(幂等)。CLAUDE.md 硬性要求。
- [ ] **失败信号 e2e:** 修前 DB 有 5 测试桩 + 10 僵尸 + 354 cancelled;启动后断言这些归零、真实 done/error 行保留。**失败信号:** 若误删真实 done,断言真实任务数应 FAIL。

---

## Task 6 — e2e 测试隔离:_e2e_persist_robust.mjs 不再污染生产库

**Files:**
- Modify: `web/scripts/_e2e_persist_robust.mjs`(`cleanupSeed` 92-103)

根因:该脚本把假 vid(999/888)写进真实缓存目录 JSON,经 web 轮询沉淀进生产 `TaskHistory`,而 `cleanupSeed` 只清缓存目录 JSON、从不 `DELETE FROM TaskHistory`(`_e2e_persist_robust.mjs:92-103`)。违反 CLAUDE.md「连跑两次都通过(警惕 stateful side effects)」。

- [ ] **方案 A(快速堵漏,本计划采用):** 给 `cleanupSeed` 追加 DB teardown,且测试**开头也先清一遍**保证可重复:

```javascript
// teardown:清测试桩在 TaskHistory 的沉淀(否则每跑一次多 N 条假 error 行污染生产历史)
import { execSync } from "node:child_process";
const DB = process.env.DATABASE_FILE || "/Users/zhb/.youdao_course/app.db";
execSync(`sqlite3 "${DB}" "DELETE FROM TaskHistory WHERE videoId IN (999000111,888000222,777000333);"`);
```

在 `cleanupSeed` 内(清 buf_state/buf_errors/buf_jobs/playhead 的 999/888 旁)调用;并在脚本 `main()` 最开头先 `cleanupSeed()` 一次。

- [ ] **方案 B(后续根治,记 TODO,不在本计划):** 测试用独立临时 `CACHE_DIR` + 独立 test `DATABASE_URL`(env 覆盖),fixture 跑完整目录删除,彻底不碰生产 `app.db`。本计划只做 A;B 写进 TODO 注释。
- [ ] **可重复性验证:** `_e2e_persist_robust.mjs` 连跑两次都 PASS,且跑完 `SELECT COUNT(*) FROM TaskHistory WHERE videoId IN (999000111,888000222,777000333)` = 0。

---

## Task 7 — 总验收 e2e:_e2e_operation_history.mjs(可重复 + 失败信号 + kill-9 重启)

**Files:**
- Create: `web/scripts/_e2e_operation_history.mjs`

把 Task 1/3/4/5 的断言收进一个可重复脚本(CLAUDE.md:每个修复有 e2e + 失败信号 + 涉持久化必 kill-9 重启)。

- [ ] 脚本流程:
  1. 记录基线 `SELECT kind,state,COUNT(*)`。
  2. 真实路径:开始缓存一讲→看完→取消另一讲→生成一张缩略图→取消缩略图;反复 `GET /api/courses/status` 触发多轮镜像。
  3. **kill -9 网关 → 等监督自愈(~2-4s,`run.sh`)→ 再轮询**:断言重启回载的 thumb 状态**不**新增历史行(session 过滤生效)。
  4. 断言:
     - 无 `thumb cancelled` 历史行(决策 1);
     - 无 `buffer working/queued` 历史行(运行态不入库);
     - 同 `(vid,kind)` 在 `allTasks` 只一行最新态(决策 2);
     - 失败任务 `reason` 非空(Task 2);
     - 「操作历史」标签截图无转圈(Task 4)→ PNG 存证。
  5. **连跑两次都 PASS**(警惕 side effects)。
- [ ] **失败信号:** 每条断言都要能区分「修了 vs 没修」——脚本里对每个 Task 注明「修前预期 FAIL 的行为」,reviewer 可临时 revert 单个 Task 验证脚本会红。
- [ ] 截图统一存 `docs/superpowers/uac-shots/`(命名 `oh_*`)。

---

## 执行顺序与依赖

```
Task 1 (写入止血) ──┬─→ Task 3 (API完整时间线 + 面板折叠 + 全屏详情)
                    │      └─ 依赖 Task 2 的 reason 才能在时间线显示原因(弱依赖,可后补)
                    ├─→ Task 5 (清存量,依赖 Task1 的"不再产生新噪声"才不会清完又长出来)
Task 2 (reason) ────┘     (Task 2 改 Python,需 kill-9 重启)
Task 4 (UI 冻结) 与 Task 3 同改 TaskRow.tsx,建议合并一起做
Task 6 (测试隔离) 独立,可并行
Task 7 (总验收) 最后,依赖 1/2/3/4/5/6
```

建议:1 → 2 → 3+4(同改 TaskRow,一起做) → 6(并行) → 5 → 7。每个 Task 落地后立即跑其自带 e2e 段,全绿再进下一个。

---

## 不变量(实现时勿破坏)

- `CacheStatus`/`ThumbStatus` 故意只按 `videoId` 镜像(与网关物理 vid-only 磁盘缓存一一对应,同讲跨课只一份),**勿改成复合键**(`route.ts:365-366` 注释 / [[julestest-videoid-orphan-risk]])。本计划只动 `TaskHistory`,不碰这两表的键。
- `tasks`/`completedTasks`/`failedTasks`(实时,`route.ts:262-293`)是「进行中/已完成/失败」三标签的数据源,**与 `allTasks`(历史)分开**。本计划只改 `allTasks` 与写入侧;实时三标签的 `thSession.has` 过滤(`route.ts:277`)已正确,勿动。
- 网关 `_api_status` 的 `tstates` 形状(`gateway.py:1458`)有多个消费者,Task 2 **新增** `reasons` map 而非改 `tstates`,避免回归。

---

## 核对记录(2026-05-29,对工作树)

| 断言 | 位置 | 状态 |
|------|------|------|
| 网关不写 TaskHistory | `grep -rn TaskHistory ydcore/` 无结果 | ✓ |
| 真正写入点 | `route.ts:383`(mirror 调)→ `:450`(appendTaskHistory) | ✓ |
| buffer 分支无过滤写所有 state | `route.ts:458-461` | ✓ |
| thumb 分支有 continue 无 session 过滤 | `route.ts:465-472`(对照 `:277` thEntries 有过滤) | ✓ |
| 去重只比相邻 state 字符串 | `route.ts:484` | ✓ |
| mkHistRow 已收 reason / createMany 已透传 | `route.ts:394` / `:491` | ✓ |
| 网关暴露 thumb.session | `gateway.py:1463`(`tsession` @1413);web 已读 `route.ts:249` | ✓ |
| buffer.perVid reason 仅 error 时带 | `gateway.py:1447-1451` | ✓ |
| thumb reason 在 thumb_meta 但 tstates 未导出 | `gateway.py:1458` vs `668/686/756` | ✓(Task 2 补) |
| TaskItem.reason 已存在 | `types/api.ts:172` | ✓ |
| TaskRow working 渲染不看 isHistory | `TaskRow.tsx:88,101` | ✓ |
| 测试桩来源 | `web/scripts/_e2e_persist_robust.mjs`(999/888);777 为旧版遗留,仓库无引用 | ✓ |
| 354 thumb cancelled 单次批写 | DB:353 行 at 全=1779985868714 | ✓ |
```
