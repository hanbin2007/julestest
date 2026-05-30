# Task Event Log — 操作历史真治本(网关事件日志)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 superpowers:executing-plans, 逐 Task 执行。步骤用 checkbox。
>
> **状态:2026-05-29 设计完成, 未执行。** 由 Opus 4.8(1M)穷举所有状态转换点 + 对抗式查漏产出。这是对 `2026-05-29-operation-history-cleanup.md` 的**根因替代**:那份的写入侧补丁(Task 1/2/5 过滤+清理)被本方案取代;其展示层(面板折叠/全屏完整时间线/不转圈,即那份 Task 3/4)**仍有效, 在本方案之上做**。

**Goal:** 让「操作历史」从「web 轮询快照 diff + 字符串去重」(会静默丢事件)改成**真事件日志**:网关在每个真实终态转换点 append 一条带单调 `seq` 的事件 → web 按 `seq>上次` 拉增量写 `TaskHistory`。结果:历史天生准确、同一任务可合法多次 done 各记一行、失败永不被采样窗口漏掉、不依赖轮询时机。

**根因回顾:** `done → 重缓存(working) → done`,因 working 不记 + 字符串去重,第二个 done 被当「与上次相同」吞掉。物理基础:`buf_state[vid]` 完成后恒为 `done`(LRU 淘汰分片不回改 state,`cache.py` 只删 `seg_cache.meta`),且 working 是无独立序号的中间态。**修法:发射点钉死在「终态落地」而非「状态值变化」,两侧都不做按状态值去重,靠单调 seq 区分。**

**Architecture(端到端):**
```
网关 _emit_task_event(kind,vid,state,reason)   # 挂在 10 个真实转换点, 取最内层 task_lock
  → self._task_seq+=1; append {seq,ts,kind,vid,state,reason} 进 deque(maxlen=2000)
  → _save_task_events()  # 现有 _atomic_write_json, 落 seg_cache.dir/task_events.json {seq, events[]}
  → /api/task_events?since=N  返回 {seq:_task_seq, events:[seq>N 升序]}
web build() 顶部 ingestTaskEvents():
  读 SyncState['taskEventSeq']=since → GET /api/task_events?since → fresh=events.filter(seq>since)
  → $transaction[ taskHistory.createMany({data: 'evt-{seq}' 行, at:new Date(ts*1000)}, skipDuplicates)
                , syncState.upsert('taskEventSeq', maxSeq) ]
  → 网关掉线 catch, since 不动, 下轮续传(不漏不重)
allTasks = taskHistory.findMany(orderBy at desc, take 500)   # 不变; 展示层折叠仍在面板客户端做
```

**Tech Stack:** Python 3 stdlib(`threading`/`collections.deque`/`time`/`http.server`);Next.js 15 + Prisma 6/SQLite;Node ESM e2e(`fetch`+`playwright-core`)。

---

## 已定默认(原 4 个待定项, 取最优解, 无需再问)

1. **首次上线游标初值 = 0。** 网关 `task_events.json` 是全新文件、上线初无历史事件,置 0 无回灌问题;上线前的旧历史靠存量 `TaskHistory`(seq=NULL)行继续展示。
2. **lastSeq 存独立 `SyncState{key,value,at}` 表**(语义干净;若发现已有等价 `SyncMeta` 则复用,执行前 grep 确认)。
3. **ts = 浮点秒**(网关 `time.time()`),web `new Date(ts*1000)`。两侧单位必须对齐(秒当毫秒会变 1970)。
4. **事件日志保留 `_TASK_EVENTS_KEEP=2000` 条 ring**(web 高频拉,正常永不落后 2000;数日停机才丢极老事件,由 `full→done` 回填兜底)。

---

## 不变量 / 查漏铁律(违反=丢事件或重复,实现时逐条对照)

- **R1 发射点钉死「终态落地」, 不挂「状态值变化」。** `done→working→done` 物理上两次进入 buffer worker 终态落地行;任何基于 `(vid,state)` 值相等的去重(网关或 web)都会吞掉第二个 done。两侧**绝不按状态值去重**,只靠单调 `seq`。
- **R2 done/error 由 worker 发, paused/cancelled 由 act_buffer 发, 严格二分不交叉。** worker 终态落地行有 `buf_state==working` 守卫;pause/cancel 时 act 已把 state 改走,守卫不成立 → worker 不发。若全挂 worker,pause/cancel 永远发不出;若两处都挂同一终态则重复发。
- **R3 init 期唯一「新终态」必须能发。** 启动僵尸 `queued→error`(无 buf_jobs 上下文,带 reason「重启后丢失任务上下文」)是 init 阶段唯一*新发生*的终态,发生在 web 轮询建立之前。**`seq`+deque+emit 能力必须在 `__init__` 最早就绪(line133 gate 之后、所有回载之前)**,否则这条 error 永久丢(web 也抓不到)。同理 thumb init `gen→error 'interrupted'`(166)。
- **R4 回载的终态一律不发。** init 回载的 done/cancelled/paused/error/ready 原样(296/304/311-312/162/168)都是历史快照、不是新转换;若补发=每次重启把全部历史终态重灌进事件日志。**只 309(僵尸 error)和 166(interrupted)发,其余 init 全静默。**
- **R5 纯落盘函数不可挂 emit。** `_save_buf_state`/`_save_thumb_index`/`_save_pf_done`/`_recover_flush_loop` 被 init/worker/start/act/掉盘恢复六处共用,不代表语义转换。emit 只挂具体转换行。
- **R6 prefetch done 幂等守卫。** `pf_done` 是 set,`add` 对已存在元素 no-op 但代码每次落盘;无条件 emit 会让同讲反复看满重复发。守卫:`was_done = vid in self.pf_done` 后仅 `not was_done` 才发。
- **R7 cancel 排队条目的静默丢弃路径不补发。** act cancel 一个 queued 后,buf_q 残留 job 被 worker 出队复查丢弃(不产生 state 变化)→ 绝不在此补发(cancelled 已在 act 发过),否则一次 cancel 出两条。thumb 出队复查 cancelled 跳过同理。
- **R8 error reason 取值时机。** buffer error reason 在 worker 终态落地那一刻读 `self._last_buf_error.get(vid)`(此时多片失败已写到最终值),不在分片循环里发。thumb error reason 在各分支就地取(rc 文本/no headers/str(e))。
- **R9 persist=False(临时缓存目录)边界。** `task_events_path=None` 时 `_emit` 内 seq 仍递增(内存权威),`_save_task_events` 开头 `if not path: return` 静默跳过、**不崩**。临时目录重启丢历史与其它持久化态同命运,可接受。
- **R10 web 双保险。** 即便网关 seq 单调,web ingest 仍 `fresh=events.filter(seq>since)` + `createMany skipDuplicates`;`res.seq<since` 时 `console.warn`(疑似网关日志被重置),可观测不静默。

---

## 发射点清单(10 处, Task 2 据此插入; 行号漂移则 grep 符号)

| # | gateway.py | 转换 | emit | reason |
|---|-----------|------|------|--------|
| 1 | **877** worker 终态落地(守卫 `buf_state==working`) | working→done/error | `buffer/result` | error 时 `_last_buf_error.get(vid)` |
| 2 | **915** act_buffer pause 且 ok | working→paused | `buffer/paused` | — |
| 3 | **925** act_buffer cancel 且 ok | q/w/p→cancelled | `buffer/cancelled` | — |
| 4 | **309** init 僵尸 | queued→error | `buffer/error` | 「重启后丢失任务上下文, 请重新缓存」 |
| 5 | **749** _gen_thumbs_inner ready(rc==0 且 jpeg_ok) | gen→ready | `thumb/done` | — |
| 6 | **756** _gen_thumbs_inner error(rc!=0 或 bad jpeg) | gen→error | `thumb/error` | `ffmpeg rc=N` / `bad jpeg` |
| 7 | **686** _gen_thumbs_inner no headers 早 return | →error | `thumb/error` | `no headers` |
| 8 | **668** _thumb_worker except(守卫 `state!=cancelled`) | →error | `thumb/error` | `str(e)[:200]` |
| 9 | **166** init thumb interrupted | gen→error | `thumb/error` | `interrupted` |
| 10 | **1059** _prefetch_worker 整集满(守卫 `not was_done`) | →done | `prefetch/done` | — |

**不发:** working/queued(861/894)、resume(919)、retry(930)、thumb gen、thumb cancel(957)、所有回载原样态、cancel 后队列丢弃路径、纯落盘函数。

---

## Task 1 — 网关: task_events 基础设施(常量+实例态+emit+save+回载+掉盘重刷)

**Files:** Modify `ydcore/gateway.py`;Create `ydcore/test_task_events.py`(纯 unit)

- [ ] 顶部 `import collections`;line97 旁 `_TASK_EVENTS_KEEP = 2000`。
- [ ] `__init__` line133 gate 之后**立即**(早于 thumb 回载 155、buf_state 回载 273):
```python
self.task_lock = threading.Lock()
self._task_seq = 0
self.task_events = collections.deque(maxlen=_TASK_EVENTS_KEEP)
self.task_events_path = os.path.join(self.seg_cache.dir, "task_events.json") if self.seg_cache.persist else None
# 回载: _task_seq = max(顶层 seq, events 内 max seq), 永不倒退; 损坏走 _quarantine_corrupt 降级 seq=0
self._load_task_events()
```
- [ ] `_emit_task_event(self, kind, vid, state, reason=None)`:`with self.task_lock:` → `self._task_seq+=1` → `ev={seq,ts:time.time(),kind,vid:str(vid),state,reason:(reason[:200] if reason else None)}` → `append` → `_save_task_events()`。**临界区只取 task_lock,绝不取 buf_lock/thumb_lock/pf_lock**(避免死锁;调用方已持有那些锁)。
- [ ] `_save_task_events()`:`if not self.task_events_path: return`(R9);用现有 `_atomic_write_json` 写 `{seq:self._task_seq, events:list(self.task_events)}`。
- [ ] `_load_task_events()`:读文件,`_task_seq=max(顶层 seq, max(e.seq))`,events 灌回 deque;parse 失败 `_quarantine_corrupt` + seq=0。
- [ ] `_save_pf_done`(455)旁登记 `_save_task_events` 到落盘集合;`_recover_flush_loop`(487-516)掉盘恢复重刷加 `with self.task_lock: self._save_task_events()`。
- [ ] **unit test**(`test_task_events.py`,无 live server):emit 三条 → seq 单调 123;deque maxlen 截断后 `_task_seq` 不倒退;`_load_task_events` 回载后 seq=峰值;persist=False 时 emit 不崩、不落盘。先写失败再实现。

## Task 2 — 网关: 10 个终态转换点插 _emit_task_event

**Files:** Modify `ydcore/gateway.py`(依发射点清单)

- [ ] 逐行插入(对照上表 + 不变量 R1-R8)。每处插入前 grep 确认符号/守卫仍在。
- [ ] **失败信号(隔离 e2e Task 6 覆盖,这里先 grep 自检):** `grep -n "_emit_task_event" gateway.py` 应恰好 10 处;working/queued/resume/retry/thumb cancel/回载行附近不得出现。

## Task 3 — 网关: /api/task_events 端点 + (可选)/api/status tasks.maxSeq

**Files:** Modify `ydcore/gateway.py`(do_GET 分发 ~1133)

- [ ] `elif path == "/api/task_events": self._api_task_events(qs)`。
- [ ] `_api_task_events(qs)`:`since=int(qs.get("since",[0])[0])`;`with gw.task_lock:` 快照 `cur=gw._task_seq`,`evs=[e for e in gw.task_events if e["seq"]>since]`(升序);`_send_json({"seq":cur,"events":evs})`。
- [ ] (可选)`/api/status` 加 `tasks:{maxSeq:gw._task_seq}`,web 先判 maxSeq 没涨就跳过拉增量(省一次请求)。
- [ ] **e2e:** Task 6/7 覆盖。

## Task 4 — web schema: TaskHistory.seq + SyncState 表 + 类型

**Files:** Modify `web/prisma/schema.prisma`、`web/src/types/api.ts`;Create migration

- [ ] `TaskHistory` 加 `seq Int? @unique`(可空:存量随机-id 行 seq=NULL,SQLite UNIQUE 允许多 NULL;@unique 让同 seq 二次插入被 skipDuplicates 拦=幂等)。state 注释更新为 `done|error|cancelled|paused`(运行态不再入库)。
- [ ] 新 `model SyncState { key String @id  value String  at DateTime @updatedAt }`(先 grep 是否已有等价 SyncMeta,有则复用)。
- [ ] 迁移 SQL:`ALTER TABLE TaskHistory ADD COLUMN seq INTEGER; CREATE UNIQUE INDEX ...; CREATE TABLE SyncState(...); INSERT SyncState('taskEventSeq','0');`(初值 0,见已定默认 1)。
- [ ] `types/api.ts`:`TaskEvent{seq,kind,videoId,state,reason,ts}` + `TaskEventsResp{events:TaskEvent[],seq:number}`;`GwStatus` 可选 `tasks?:{maxSeq:number}`。
- [ ] `prisma migrate dev` + `generate`。**注意 [[julestest-no-prod-db-writes]]:迁移在生产 app.db 上跑是正常 schema 演进(非测试写入),但 e2e 必须用隔离 test.db。**

## Task 5 — web route.ts: ingestTaskEvents 替换 appendTaskHistory

**Files:** Modify `web/src/app/api/courses/status/route.ts`

- [ ] 写 `ingestTaskEvents()`:读 `SyncState['taskEventSeq']` 当 since → `gatewayGet<TaskEventsResp>("/api/task_events?since="+since, 10000)` → `fresh=events.filter(e=>e.seq>since)` → `prisma.$transaction([ taskHistory.createMany({data: fresh.map(e=>({id:`evt-${e.seq}`, kind:e.kind, videoId:e.videoId, state:e.state, reason:e.reason??null, at:new Date(e.ts*1000), seq:e.seq})), skipDuplicates:true}), syncState.upsert({where:{key:'taskEventSeq'}, create:{key:'taskEventSeq', value:String(res.seq)}, update:{value:String(res.seq)}}) ])`。catch 静默,since 不动;`res.seq<since` → `console.warn`(R10)。
- [ ] `build()` 顶部(或 mirror 内)调 `ingestTaskEvents()` **替换** `appendTaskHistory(gw)`。
- [ ] **删除**:`lastTaskState` Map、`lastTaskStateInited`、`appendTaskHistory` 整个 diff/session/50 条/354 洪水逻辑。
- [ ] **保留并迁移**到 `initSyncOnce()`:90 天清理 + `full→done` 回填(回填行 `seq=NULL` + 随机 id)。
- [ ] `mkHistRow` 改用 `evt-{seq}` id + `at=new Date(ts*1000)`(仅事件路径;回填路径仍随机 id/now)。
- [ ] `allTasks` findMany **不变**;展示层折叠/不转圈仍由 `2026-05-29-operation-history-cleanup.md` 的 Task 3/4 在面板/ TaskRow 做(本方案不重复)。

## Task 6 — 隔离 e2e harness + 核心失败信号(不碰生产 DB)

**Files:** Create `web/scripts/_e2e_task_events_isolated.mjs`(+ 公共 harness 供 7/8 复用)

> 硬约束 [[julestest-no-prod-db-writes]]:绝不写生产 app.db / 生产缓存目录。

- [ ] **三件套隔离:**(1)`TMPDIR/test.db` + `DATABASE_URL='file:'+test.db` + `npx prisma migrate deploy`;(2)`TMPDIR/cache` 传隔离网关(确认 `youdao_course.py serve` 能透传 `cache_dir`/env;不能则临时加 env `CACHE_DIR`);(3)隔离网关另起端口(如 8809)+隔离 cache_dir,自起实例不碰 run.sh 监督的生产 8808;(4)web 侧推荐**跳过 next**:node 脚本直接用 `@prisma/client` 连 test.db + 自己 `fetch` 隔离网关 `/api/task_events`,跑 ingest 逻辑。teardown:杀隔离进程 + `rm -rf TMPDIR`。
- [ ] **核心失败信号:** 制造 `done → cancel(离开 done) → 重缓存 working → done`,断言 test.db 的 `TaskHistory` 出现**两条 seq 不同的 done**(旧字符串-diff 方案此处只 1 条 = FAIL)。
- [ ] 附带断言:thumb `no headers`/worker except error 进历史;thumb cancelled **不**进;prefetch 反复满只 1 条 done。
- [ ] **连跑两次都过**(每次全新 TMPDIR,无 stateful 污染)。

## Task 7 — 跨重启 e2e(隔离实例 kill-9, 不碰生产网关)

**Files:** extend `_e2e_task_events_isolated.mjs`

- [ ] 隔离环境内 emit 几条 → `kill-9` 隔离网关实例 → 重启 → 断言:`_task_seq` 不倒退(新事件 seq 续增不撞旧)、`task_events.json` 回载、web `since` 续传不漏不重。
- [ ] 验 **R3**:造一个无 buf_jobs 的 `queued`(僵尸)+ 一个 `gen` 态 thumb_index,kill-9 重启,观察 init `309`(buffer error)与 `166`(thumb interrupted)各产**一条** error 事件入 test.db 的 TaskHistory。
- [ ] 连跑两次都过。

## Task 8 — 改造 _e2e_persist_robust.mjs 不再违约

**Files:** Modify `web/scripts/_e2e_persist_robust.mjs`

- [ ] 它现 `line20` DB 指生产 `app.db`,违反 [[julestest-no-prod-db-writes]]。迁到 Task 6 的隔离 harness(隔离 test.db + 隔离 CACHE_DIR + 隔离网关实例),或最低限度改只读/抓包。

---

## 执行顺序

```
1 (网关基础设施) → 2 (插发射点) → 3 (API)        [网关三件, 改完一次 kill-9 重启]
4 (web schema/迁移) → 5 (web ingest)             [web 两件, 改完 build+重启]
6 (隔离 harness + 核心信号) → 7 (跨重启) → 8 (迁旧测试)
```
1→2→3 与 4 可部分并行(网关 vs prisma schema 不同文件);但 5 依赖 3+4,6/7/8 依赖全部部署。每个 Task 落地跑自带 unit/e2e,全绿再进。

---

## 核对记录(2026-05-29, Opus 4.8 穷举, 行号对工作树)

- buffer `buf_state` 赋值仅 11 处 + 2 整表重置,无单 vid del;eviction(`cache.py` put→LRU)只动 `seg_cache.meta` 不回改 state(=`done` 物理恒定,根因物理基础)。
- 发射点 877/915/925/309/749/756/686/668/166/1059 由两份穷举 + 综合查漏交叉确认;paused/cancelled 与 done/error 发射点互斥已验证(worker `==working` 守卫)。
- web 写入唯一在 `route.ts` 的 `appendTaskHistory`(网关零事件,本方案给网关补上事件源)。
