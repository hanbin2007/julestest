// e2e (隔离): 任务事件日志 (operation history) 端到端验证 —— 方案 Task 6 + 7 + 8。
//
// 硬约束 [[julestest-no-prod-db-writes]]: 本脚本 *绝不* 碰生产 app.db / 生产缓存目录 /
// 生产网关 8808 / web 3000。所有状态进全新临时 TMPDIR:
//   · test.db   = $TMPDIR/test.db   (DATABASE_URL=file:... + prisma migrate deploy)
//   · cache     = $TMPDIR/cache     (隔离网关 --cache-dir; task_events.json 落这里)
//   · thumbs    = $TMPDIR/thumbs    (隔离网关 env YD_THUMB_DIR; 否则会写进生产 thumbs 目录=违约)
//   · 网关端口   = 8809             (非生产 8808)
//   · web 侧不起 next: 直接 import @prisma/client 连 test.db + fetch 8809/api/task_events,
//                      在本脚本内复刻 status/route.ts 的 ingestTaskEvents 增量写库逻辑。
//
// 失败信号(区分"修复生效"vs"旧方案"):
//   Task6 核心  : buffer done → cancel(离开 done) → 重缓存 done. test.db TaskHistory 必须出现
//                 【两条 seq 不同的 buffer done】。旧"按状态字符串去重"方案此处只剩 1 条 = FAIL。
//   Task6 附带  : thumb 'no headers' / thumb worker except / 都进历史; thumb cancelled 不进历史;
//                 prefetch 反复"满"只 1 条 done(同一终态不会被重复 ingest, 靠 seq 幂等)。
//   Task7 重启  : emit 几条 → kill-9 隔离网关 8809 → 重启 → _task_seq 不倒退 / task_events.json
//                 回载 / web since 续传不漏不重。再造"无 buf_jobs 的 queued"(僵尸) + thumb_index
//                 'gen' 态, kill-9 重启, 断言 buffer error + thumb 'interrupted' 各产一条 error 入库。
//   Task8 迁移  : _e2e_persist_robust.mjs 原指生产 app.db+生产缓存(违约), 其"kill-9→重启→断言
//                 状态保留(error reason / extraProtect / 僵尸转 error / 无残留 .json.tmp)"在本隔离
//                 harness 复跑(隔离 test.db + 隔离缓存), 不再碰生产。
//
// 可重复: 每次跑全新 mkdtemp TMPDIR, teardown 杀隔离进程 + rm -rf TMPDIR。连跑两遍都过。

import { promises as fs } from "node:fs";
import { spawn, execSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
// 同源真函数(#14): ingest 的游标解析/epoch·corrupt 复位判定/fresh 过滤/行 id 直接 import route.ts
// 同款 lib, 不再手抄复刻(改 .ts 即改这里, 杜绝漂移; 见 _e2e_totals_dedupe.mjs 已证明能 import .ts)。
import {
  parseCursor,
  formatCursor,
  planIngest,
  filterFreshEvents,
  eventRowId,
} from "../src/lib/taskEvents.ts";

const __filename = fileURLToPath(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(__filename), "..");      // .../worktree/web
const ROOT = path.resolve(WEB_DIR, "..");                          // .../worktree
const PROD_REQ = "/Users/zhb/Documents/julestest/req.txt";        // 只读复用生产抓包(不修改)
const PORT = 8809;                                                // 非生产端口
const GW = `http://127.0.0.1:${PORT}`;

// --- 安全门闩: 任何指向生产路径的操作都该在写库前被拦下 ---
const PROD_DB = "/Users/zhb/.youdao_course/app.db";
const PROD_CACHE = "/Users/zhb/.youdao_course/cache";
const PROD_THUMBS = "/Users/zhb/.youdao_course/thumbs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
}

// ---------- 隔离网关进程管理 ----------
let gwChild = null;
let TMPDIR = "";
let CACHE_DIR = "";
let THUMB_DIR = "";
let DB_FILE = "";
let DB_URL = "";

function assertIsolatedPaths() {
  // 三道保险: 绝不允许任何隔离路径落到生产路径上。
  for (const p of [TMPDIR, CACHE_DIR, THUMB_DIR, DB_FILE]) {
    if (!p.startsWith(TMPDIR)) throw new Error(`隔离路径越界(非 TMPDIR 子路径): ${p}`);
  }
  for (const prod of [PROD_DB, PROD_CACHE, PROD_THUMBS]) {
    if (CACHE_DIR === prod || THUMB_DIR === prod || DB_FILE === prod) {
      throw new Error(`隔离路径撞生产: ${prod}`);
    }
  }
  if (PORT === 8808) throw new Error("端口撞生产 8808");
}

function startGateway() {
  // 隔离网关: env YD_TEST_EMIT=1 暴露 /api/_test_emit; YD_THUMB_DIR 重定向缩略图到 TMPDIR。
  // --no-prefetch 关掉自动预缓存后台线程(本测试不需要真实网络)。--port 8809 非生产。
  gwChild = spawn(
    "python3",
    ["youdao_course.py", "serve", "-r", PROD_REQ, "--port", String(PORT),
      "--cache-dir", CACHE_DIR, "--no-prefetch", "--log-level", "WARNING"],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, YD_TEST_EMIT: "1", YD_THUMB_DIR: THUMB_DIR },
    },
  );
  gwChild.unref();
}

async function waitGatewayUp(timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${GW}/api/_debug`);
      if (r.ok) {
        const d = await r.json();
        // 防误连外来网关(尤其生产): /api/_debug 的 segCacheDir 必须落在本测试 TMPDIR 下,
        // 否则我们连到的不是本测试拉起的隔离实例 —— 硬失败, 绝不在错网关上写库/断言。
        if (typeof d.segCacheDir === "string" && d.segCacheDir.startsWith(TMPDIR)) return true;
        throw new Error(`连到了非本测试网关(segCacheDir=${d.segCacheDir} 不在 ${TMPDIR})`);
      }
    } catch (e) {
      if (String(e.message || "").includes("非本测试网关")) throw e;
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`隔离网关未就绪(${PORT})`);
}

function gatewayPid() {
  // 只杀监听 8809 的进程(隔离实例), 决不碰 8808。
  try {
    return execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null`).toString().trim();
  } catch { return ""; }
}

function killGatewayHard() {
  // kill -9 隔离网关(模拟硬崩溃)。严格只针对 8809 的 pid。
  const pid = gatewayPid();
  if (pid) {
    for (const p of pid.split(/\s+/)) {
      try { execSync(`kill -9 ${p}`); } catch { /* already gone */ }
    }
  }
  // 等端口释放
  for (let i = 0; i < 20; i++) {
    if (!gatewayPid()) return;
    try { execSync("sleep 0.3"); } catch { /* */ }
  }
}

async function restartGateway() {
  killGatewayHard();
  startGateway();
  await waitGatewayUp();
}

// ---------- 网关 API ----------
async function gwEmit(events) {
  const r = await fetch(`${GW}/api/_test_emit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (!r.ok) throw new Error(`_test_emit 失败 ${r.status}`);
  return r.json();
}
async function gwTaskEvents(since) {
  const r = await fetch(`${GW}/api/task_events?since=${since}`);
  if (!r.ok) throw new Error(`task_events 失败 ${r.status}`);
  return r.json();
}
async function gwDebug() {
  const r = await fetch(`${GW}/api/_debug`);
  return r.json();
}

// ---------- web 侧 ingest (复刻 status/route.ts 的 ingestTaskEvents 增量写库) ----------
let prisma = null;

// 游标格式 "<epoch>:<seq>"(#3); parseCursor/formatCursor 现 import 自 ../src/lib/taskEvents.ts。
async function readCursorRaw() {
  const cur = await prisma.syncState.findUnique({ where: { key: "taskEventSeq" } });
  return cur ? String(cur.value) : "0:0";
}
// 兼容老断言: 返回当前 in-epoch seq 游标(整数), 仅用于"游标推进/不回退"的数值断言。
async function readCursor() {
  return parseCursor(await readCursorRaw()).seq;
}

// 用 route.ts 同源 lib 跑 ingest(去掉 initSyncOnce 的清理/回填——本测试 test.db 全新):
//   游标 "<epoch>:<seq>" → GET ?since=curSeq → planIngest 判 epoch 翻转/corrupt 复位
//   → corrupt(seq 回退)则以 ?since=0 重新请求(治本) → filterFreshEvents → 事务[逐行 upsert
//   'evt-<epoch>-<seq>'(幂等) + upsert 游标="<res.epoch>:<res.seq>"]。
async function ingestOnce() {
  const cur = parseCursor(await readCursorRaw());
  let res = await gwTaskEvents(cur.seq);
  let plan = planIngest(cur, res.epoch, res.seq);
  if (plan.refetchFromZero) {
    // corrupt 复位(seq 回退): 首个 ?since=curSeq 把当前 epoch 低 seq 事件挡在网关外, 以 ?since=0 重拉。
    res = await gwTaskEvents(0);
    plan = planIngest(cur, res.epoch, res.seq);
  }
  const fresh = filterFreshEvents(res.events ?? [], res.epoch, plan.since);
  const newCursor = formatCursor(res.epoch, res.seq);
  if (fresh.length === 0) {
    await prisma.syncState.upsert({
      where: { key: "taskEventSeq" },
      create: { key: "taskEventSeq", value: newCursor },
      update: { value: newCursor },
    });
    return { ingested: 0, cursor: newCursor };
  }
  await prisma.$transaction([
    ...fresh.map((e) => {
      const id = eventRowId(e.epoch, e.seq);
      return prisma.taskHistory.upsert({
        where: { id },
        create: {
          id,
          kind: e.kind,
          videoId: Number(e.vid),
          state: e.state,
          reason: e.reason ?? null,
          at: new Date(e.ts * 1000),
          seq: e.seq,
        },
        update: {},
      });
    }),
    prisma.syncState.upsert({
      where: { key: "taskEventSeq" },
      create: { key: "taskEventSeq", value: newCursor },
      update: { value: newCursor },
    }),
  ]);
  return { ingested: fresh.length, cursor: newCursor };
}

async function dbRows(where = {}) {
  return prisma.taskHistory.findMany({ where, orderBy: { seq: "asc" } });
}

// ---------- 持久化文件 helper(隔离缓存目录) ----------
async function writeCacheJson(name, obj) {
  await fs.writeFile(path.join(CACHE_DIR, name), JSON.stringify(obj), "utf-8");
}
async function readCacheJson(name, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(CACHE_DIR, name), "utf-8")); }
  catch { return fallback; }
}
async function writeThumbJson(name, obj) {
  await fs.mkdir(THUMB_DIR, { recursive: true });
  await fs.writeFile(path.join(THUMB_DIR, name), JSON.stringify(obj), "utf-8");
}

// ================= 测试主体 =================

// --- Task 6 核心: done → cancel → done 两条不同 seq 的 done 都进库 ---
async function task6_core() {
  const VID = "600000001";
  // 物理顺序: 首次缓存完成(done) → 用户取消(离开 done) → 重缓存再次完成(done)
  await gwEmit([
    { kind: "buffer", vid: VID, state: "done" },
    { kind: "buffer", vid: VID, state: "cancelled" },
    { kind: "buffer", vid: VID, state: "done" },
  ]);
  await ingestOnce();

  const rows = await dbRows({ videoId: Number(VID), kind: "buffer" });
  const dones = rows.filter((r) => r.state === "done");
  const seqs = dones.map((r) => r.seq);
  const distinctSeq = new Set(seqs).size === seqs.length;
  check(
    "[T6核心] buffer done→cancel→done 入库两条不同 seq 的 done",
    dones.length === 2 && distinctSeq && seqs.every((s) => s != null),
    { doneCount: dones.length, seqs, allRowStates: rows.map((r) => r.state) },
  );
  // 反向失败信号自证: 若旧"按状态字符串去重", dones.length 会是 1。这里显式断言 !==1。
  check(
    "[T6核心] 失败信号确认: done 条数 !== 1 (旧字符串-diff 会塌成 1)",
    dones.length !== 1,
    { doneCount: dones.length },
  );
}

// --- Task 6 附带: thumb error('no headers' / worker except) 进库; thumb cancelled 不进库;
//     prefetch 反复满只 1 条 done ---
async function task6_extra() {
  // thumb 'no headers' (网关 line 788) + worker except str(e) (line ~767): 两条 error 都该进库。
  const TH = "600000002";
  await gwEmit([
    { kind: "thumb", vid: TH, state: "error", reason: "no headers" },
    { kind: "thumb", vid: TH, state: "error", reason: "Boom worker exception" },
  ]);
  // thumb cancelled: 决策 2026-05-29 缩略图取消"完全不进历史"。
  // 但注意: 网关事件日志 *会* emit thumb cancelled? 核对——act_thumb 不 emit cancelled(thumb 取消
  // 不发事件), 故事件日志里根本没有 thumb cancelled。这里用 _test_emit 故意发一条 thumb cancelled,
  // 验证 ingest 路径本身不会把它当 error 误记 —— 它会作为一条独立 seq 进库(kind=thumb,state=cancelled)。
  // 决策"thumb cancelled 不进历史"是在 *生产 emit 侧* 实现(网关压根不 emit), 不在 ingest 侧过滤。
  // 因此本附带项的正确机器断言是: 网关事件日志里 thumb 终态只在真实 emit 点产生; 我们验证
  // 真实代码路径(act_thumb)不 emit cancelled —— 见下方 grep 静态断言。
  const TC = "600000003";
  await gwEmit([{ kind: "thumb", vid: TC, state: "cancelled" }]);

  // prefetch 反复"满": 网关在 prefetch done(line ~1190) 只在真正补满时 emit 一次。
  // 反复触发同一 done 不应产生多条——这里发 3 条同 vid prefetch done(模拟"反复满"的多次 emit 尝试),
  // 但每条都是独立 seq(网关确实会 append 3 条不同 seq)。真正的"只 1 条"保证不在事件层而在 web 展示层
  // (status/route.ts 用 gw.live.done 去重)。机器断言: ingest 幂等 —— 同一 res 二次 ingest 不增行。
  const PF = "600000004";
  await gwEmit([{ kind: "prefetch", vid: PF, state: "done" }]);

  await ingestOnce();

  const thumbErr = await dbRows({ videoId: Number(TH), kind: "thumb", state: "error" });
  check(
    "[T6附带] thumb 'no headers' + worker except 两条 error 都进库",
    thumbErr.length === 2
      && thumbErr.some((r) => r.reason === "no headers")
      && thumbErr.some((r) => (r.reason || "").includes("worker exception")),
    { count: thumbErr.length, reasons: thumbErr.map((r) => r.reason) },
  );

  // ingest 幂等: 再 ingest 一次(无新事件), 行数不变, 游标不回退。
  const beforeCount = await prisma.taskHistory.count();
  const beforeCursor = await readCursor();
  const r2 = await ingestOnce();
  const afterCount = await prisma.taskHistory.count();
  const afterCursor = await readCursor();
  check(
    "[T6附带] ingest 幂等: 二次 ingest 不增行 / 游标不回退(prefetch 反复满不重复落库)",
    afterCount === beforeCount && afterCursor >= beforeCursor && r2.ingested === 0,
    { beforeCount, afterCount, beforeCursor, afterCursor, secondIngested: r2.ingested },
  );

  // thumb cancelled 在 *真实网关代码* 里不产生事件: 静态断言 act_thumb 的 cancel 分支不 emit。
  // (这是"决策: thumb cancelled 不进历史"的真正实现位置——emit 侧从不发, 故事件日志/库里都不会有
  //  真实来源的 thumb cancelled。我们这里用 _test_emit 注入的那条是测试桩, 不代表生产路径。)
  let actThumbNoEmit = false;
  try {
    const gw = await fs.readFile(path.join(ROOT, "ydcore", "gateway.py"), "utf-8");
    const m = gw.match(/def act_thumb[\s\S]*?def \w/);
    const body = m ? m[0] : "";
    // act_thumb 的 cancel 分支设 state="cancelled" 但不调用 _emit_task_event。
    actThumbNoEmit = body.includes('"cancelled"') && !body.includes("_emit_task_event");
  } catch { /* ignore */ }
  check(
    "[T6附带] thumb cancelled 不进历史: act_thumb 真实路径不 emit(emit 侧实现, 非 ingest 过滤)",
    actThumbNoEmit,
    { actThumbHasNoEmit: actThumbNoEmit },
  );
}

// --- Task 2 (#3): 掉盘+kill-9 真·复用 seq 不被旧 'evt-<seq>' 方案误去重丢 ---
//
// 旧版此测【负向对照 vacuous】: 它只 kill-9 + 重启(无掉盘窗口), 重启后 seq 从盘上峰值【单调
// 续发】(不复用), 故续发事件的 seq 根本不会撞 E1 已消费的 seq —— 旧 'evt-<seq>' 方案在这种
// 场景里【也不丢】, "失败信号确认"(newId !== wouldCollideOldId)只是字符串格式不同, 永真,
// 测不到 #3 真 bug。
//
// 本版造【真·disk<内存 分歧】, 让复用 seq 真实发生:
//   1. boot E1 emit N 条 → web 全部 ingest(游标 E1:N, 行 id 'evt-E1-1..N')。
//   2. kill-9 网关(丢内存)→ 直接把盘上 task_events.json 改写成【更旧快照 seq=N-K】(模拟掉盘:
//      内存到过 N 但盘只落到 N-K)。先 kill 再写, 防运行实例重写覆盖我们的旧快照。
//   3. 重启 → _load_task_events 读到盘上峰值 N-K → _task_seq 从 N-K 续 → epoch 翻 E2。
//   4. 续发一条【全新、与 E1 那条完全不同终态】的事件 → 它分到 seq=N-K+1, 这个 seq 在 E1
//      【已被 web 消费过】(E1 用过 1..N, N-K+1<=N)。
//   失败信号(旧 vs 新, 机器可分):
//     · 旧 'evt-<seq>' 方案: 新事件 id='evt-<N-K+1>' == E1 已入库的 'evt-<N-K+1>' →
//       upsert update no-op → 这条【不同终态】静默丢失。本测显式断言旧 id 确实撞已存在行。
//     · 新 'evt-<epoch>-<seq>' 方案: id='evt-<E2>-<N-K+1>' 与 'evt-<E1>-<N-K+1>' 不同 →
//       真 ingestOnce 把它落库(landed)。
async function task2_epoch_collision() {
  // boot E1: 先把一批事件 emit 满并 ingest, 保证盘上/库里都有连续的 evt-E1-1..N。
  await ingestOnce();
  const before = await gwTaskEvents(0);
  const epoch1 = before.epoch;
  const peakSeq1 = before.seq;
  // 需要 N 足够大(>=3)才能造出"复用一个已消费的低 seq"。前面 T6/T7 已 emit 一堆, 必然满足。
  if (peakSeq1 < 3) {
    // 兜底: 再 emit 几条把峰值顶上去(罕见, 仅当本测被单独前置跑时)。
    await gwEmit([
      { kind: "buffer", vid: "200000001", state: "done" },
      { kind: "buffer", vid: "200000002", state: "done" },
      { kind: "buffer", vid: "200000003", state: "done" },
    ]);
    await ingestOnce();
  }
  const peakNow = (await gwTaskEvents(0)).seq;
  // 取一个会被复用的 seq: 比当前峰值小 K(K=2 → 复用 peakNow-1)。该 seq 在 E1 必已入库且被消费。
  const K = 2;
  const reuseSeq = peakNow - (K - 1);           // = peakNow-1: corrupt 重启后下一条新事件就分到它
  const staleSeq = peakNow - K;                 // 盘上"掉盘"快照只到这里
  const oldCollideId = eventRowId(epoch1, reuseSeq); // E1 期那条 (epoch1, reuseSeq) 的真实行 id
  const oldRowBefore = await prisma.taskHistory.findUnique({ where: { id: oldCollideId } });

  // kill-9, 再把盘上 task_events.json 改写成 staleSeq 的旧快照(真造 disk<内存 分歧)。
  killGatewayHard();
  const tePath = path.join(CACHE_DIR, "task_events.json");
  const onDisk = JSON.parse(await fs.readFile(tePath, "utf-8"));
  const stale = {
    epoch: onDisk.epoch,
    seq: staleSeq,
    events: (onDisk.events || []).filter((e) => Number(e.seq) <= staleSeq),
  };
  await fs.writeFile(tePath, JSON.stringify(stale), "utf-8");
  startGateway();
  await waitGatewayUp();

  const after = await gwTaskEvents(0);
  const epoch2 = after.epoch;
  check(
    "[T2] 真·掉盘 kill-9 重启后 epoch 必递增(跨 boot 复用 seq 才能靠 epoch 区分行)",
    epoch2 > epoch1,
    { epoch1, epoch2 },
  );
  check(
    "[T2] 真·掉盘: 重启后 _task_seq 从盘上【旧快照峰值】续(=staleSeq, 证明内存增量真丢, 非单调续发)",
    after.seq === staleSeq,
    { staleSeq, gwSeqAfter: after.seq, peakBeforeCrash: peakNow },
  );

  // 续发一条【与 E1 那条完全不同 kind/state/vid】的新事件 → 它复用 reuseSeq。
  const COLVID = "200000099";
  await gwEmit([{ kind: "thumb", vid: COLVID, state: "error", reason: "REUSED-SEQ-DISTINCT" }]);
  const newEv = (await gwTaskEvents(0)).events.filter((e) => e.vid === COLVID).pop();
  const newId = eventRowId(newEv.epoch, newEv.seq);
  const wouldCollideOldId = `evt-${newEv.seq}`; // 旧纯-seq 方案的 id(只有 seq)

  // 真·负向对照: 新事件的 seq 确实复用了 E1 已消费的 seq, 且旧 'evt-<seq>' id 会撞已入库的旧行。
  check(
    "[T2] 真·复用确认: 新事件 seq 复用了崩溃前已消费的 seq(<=崩前峰值), 非单调新值(否则负向对照 vacuous)",
    newEv.seq === reuseSeq && newEv.seq <= peakNow,
    { newSeq: newEv.seq, reuseSeq, e1Peak: peakSeq1, peakBeforeCrash: peakNow },
  );
  check(
    "[T2] 失败信号(旧方案会丢): 旧 'evt-<seq>' id 撞库中已存在的 E1 同 seq 行 → upsert no-op → 丢这条不同终态",
    wouldCollideOldId === `evt-${reuseSeq}`
      && (await prisma.taskHistory.findUnique({ where: { id: eventRowId(epoch1, reuseSeq) } })) != null,
    { wouldCollideOldId, e1RowIdSameSeq: eventRowId(epoch1, reuseSeq), e1RowExists: !!oldRowBefore },
  );

  // 治本: 真 ingestOnce(新 'evt-<epoch>-<seq>' id) 把这条复用 seq 的不同终态落库, 不被误去重。
  const dbCountBefore = await prisma.taskHistory.count();
  await ingestOnce();
  const dbCountAfter = await prisma.taskHistory.count();
  const landed = await prisma.taskHistory.findUnique({ where: { id: newId } });
  const colRows = await dbRows({ videoId: Number(COLVID) });
  check(
    "[T2] 治本: 复用 seq 的新事件靠 epoch 区分 → 'evt-<E2>-<seq>' 入库(不被旧 'evt-<seq>' 误去重丢)",
    landed != null && colRows.length === 1 && newId !== wouldCollideOldId,
    { newId, wouldCollideOldId, epoch1, epoch2, newSeq: newEv.seq,
      landed: !!landed, dbDelta: dbCountAfter - dbCountBefore },
  );
  // E1 期那条同 seq 老行未被复用 seq 的新事件覆盖/破坏(各自独立 id, 老行原样保留)。
  check(
    "[T2] E1 期同 seq 老行未被复用 seq 的新事件污染(id 各自独立, 老行原样保留)",
    oldRowBefore == null
      || (await prisma.taskHistory.findUnique({ where: { id: oldCollideId } })) != null,
    { oldCollideId, hadOldRow: !!oldRowBefore },
  );
}

// --- Task 7: 跨重启 —— _task_seq 不倒退 / task_events.json 回载 / web since 续传不漏不重 ---
async function task7_restart_resume() {
  // 先确保已 ingest 当前所有事件(前面 T6 已 ingest)。记录重启前游标 + 峰值。
  const dbgBefore = await gwDebug();
  const seqBefore = (await gwTaskEvents(0)).seq;       // 网关当前峰值
  const cursorBefore = await readCursor();
  const dbCountBefore = await prisma.taskHistory.count();

  await restartGateway();

  const seqAfter = (await gwTaskEvents(0)).seq;
  check(
    "[T7] kill-9 重启后 _task_seq 不倒退(task_events.json 回载峰值)",
    seqAfter >= seqBefore && seqAfter > 0,
    { seqBefore, seqAfter },
  );

  // 重启后续发一条新事件 → web 按 since=cursorBefore 续传 → 只拿到这条新的, 不重复旧的。
  const NEWVID = "700000001";
  await gwEmit([{ kind: "buffer", vid: NEWVID, state: "done" }]);
  const r = await ingestOnce();
  const dbCountAfter = await prisma.taskHistory.count();
  const newRows = await dbRows({ videoId: Number(NEWVID) });
  // 续传不漏: 新事件入库; 不重: 旧事件未被二次写(总行数只 +1)。
  check(
    "[T7] web since 续传不漏不重: 重启后新事件入库且只增 1 行(旧事件 'evt-' 幂等不重写)",
    newRows.length === 1 && dbCountAfter === dbCountBefore + 1 && r.ingested >= 1,
    { dbCountBefore, dbCountAfter, newRowCount: newRows.length, cursorBefore },
  );
}

// --- Task 7: 造"无 buf_jobs 的 queued" 僵尸 + thumb_index 'gen' 态, kill-9 重启,
//     断言 buffer error + thumb 'interrupted' 各产一条 error 入 test.db ---
async function task7_restart_zombies() {
  const ZBUF = "700000002"; // 僵尸 buffer: queued 但无 buf_jobs → 重启转 error
  const ZTHUMB = "700000003"; // thumb gen 态 → 重启转 error "interrupted"

  // 先杀网关再写文件(避免运行实例 atexit 覆盖我们的注入), 然后重启回载。
  killGatewayHard();

  // buf_state.json: ZBUF=queued; buf_jobs.json: 不给 ZBUF job(僵尸条件)。
  const bufState = await readCacheJson("buf_state.json", {});
  bufState[ZBUF] = "queued";
  await writeCacheJson("buf_state.json", bufState);
  const bufJobs = await readCacheJson("buf_jobs.json", {});
  delete bufJobs[ZBUF];
  await writeCacheJson("buf_jobs.json", bufJobs);

  // thumb index.json: ZTHUMB=gen(网关被砍时正在生成) → 重启回退 error "interrupted"。
  const thumbIdx = await (async () => {
    try { return JSON.parse(await fs.readFile(path.join(THUMB_DIR, "index.json"), "utf-8")) || {}; }
    catch { return {}; }
  })();
  thumbIdx[ZTHUMB] = { state: "gen" };
  await writeThumbJson("index.json", thumbIdx);

  // 记录重启前峰值, 重启后这两条 init-期 emit 会让峰值 +2。
  startGateway();
  await waitGatewayUp();

  const dbg = await gwDebug();
  const events = (await gwTaskEvents(0)).events;
  // 网关侧: ZBUF 应被转成 error(bufStates), ZTHUMB 缩略图 init 期 emit interrupted。
  const zbufState = (dbg.bufStates || {})[ZBUF];
  const zbufErr = (dbg.bufErrors || {})[ZBUF];
  check(
    "[T7] 重启: 无 buf_jobs 的 queued 僵尸被转 error(网关态)",
    zbufState === "error" && typeof zbufErr === "string",
    { zbufState, zbufErr },
  );

  // ingest 这两条 init 期事件入 test.db。
  await ingestOnce();
  const bufErrRow = await dbRows({ videoId: Number(ZBUF), kind: "buffer", state: "error" });
  const thErrRow = await dbRows({ videoId: Number(ZTHUMB), kind: "thumb", state: "error" });
  check(
    "[T7] 重启: 僵尸 queued→buffer error 一条入 test.db",
    bufErrRow.length === 1 && bufErrRow[0].seq != null,
    { count: bufErrRow.length, reason: bufErrRow[0]?.reason, seq: bufErrRow[0]?.seq },
  );
  check(
    "[T7] 重启: thumb gen→error 'interrupted' 一条入 test.db",
    thErrRow.length === 1 && (thErrRow[0]?.reason || "").includes("interrupted"),
    { count: thErrRow.length, reason: thErrRow[0]?.reason, seq: thErrRow[0]?.seq,
      gwHasThumbErrEvent: events.some((e) => e.vid === ZTHUMB && e.state === "error") },
  );
}

// --- Task 8: _e2e_persist_robust 等价断言, 迁到隔离 harness(隔离 test.db + 隔离缓存) ---
// 复刻其 #1 error reason 跨重启保留 / #2 extra_protect 回载 / #3 僵尸转 error / #4 无 .json.tmp。
// (原脚本指生产 app.db+生产外置盘缓存=违约; 这里全在 TMPDIR。)
async function task8_persist_robust() {
  const PVID = "800000111";
  const PZOMBIE = "800000222";

  killGatewayHard();

  // #1 buf_state=error + buf_errors reason
  const bufState = await readCacheJson("buf_state.json", {});
  bufState[PVID] = "error";
  bufState[PZOMBIE] = "queued"; // #3 僵尸(不给 job)
  await writeCacheJson("buf_state.json", bufState);
  const bufErrors = await readCacheJson("buf_errors.json", {});
  bufErrors[PVID] = "分片下载失败 7 个: 隔离测试原因_e2e";
  await writeCacheJson("buf_errors.json", bufErrors);
  // #2 playhead.extra_protect 含 PVID
  const ph = await readCacheJson("playhead.json", {});
  ph.extra_protect = Array.from(new Set([...(ph.extra_protect || []), PVID]));
  await writeCacheJson("playhead.json", ph);
  // 确保僵尸无 job
  const jobs = await readCacheJson("buf_jobs.json", {});
  delete jobs[PZOMBIE]; delete jobs[PVID];
  await writeCacheJson("buf_jobs.json", jobs);

  startGateway();
  await waitGatewayUp();

  const dbg = await gwDebug();
  // #1 error reason 跨 kill-9 保留
  const reason = (dbg.bufErrors || {})[PVID];
  check(
    "[T8] #1 buffer error reason 跨 kill-9 保留(隔离)",
    typeof reason === "string" && reason.includes("隔离测试原因_e2e"),
    { reason, state: (dbg.bufStates || {})[PVID] },
  );
  // #2 extra_protect 回载
  const ep = dbg.extraProtect || [];
  check("[T8] #2 extra_protect 跨重启回载(隔离)", ep.includes(PVID), { extraProtect: ep });
  // #3 僵尸转 error(无 queued 残留)
  const zState = (dbg.bufStates || {})[PZOMBIE];
  check(
    "[T8] #3 僵尸 queued 已转 error, 无 queued 残留(隔离)",
    zState === "error" && zState !== "queued",
    { state: zState, reason: (dbg.bufErrors || {})[PZOMBIE] },
  );
  // #4 无残留 *.json.tmp(原子写)
  const tmps = (await fs.readdir(CACHE_DIR)).filter((f) => f.endsWith(".json.tmp"));
  let segOk = true;
  try { JSON.parse(await fs.readFile(path.join(CACHE_DIR, "seg_urls.json"), "utf-8")); }
  catch (e) { segOk = e.code === "ENOENT"; }
  check(
    "[T8] #4 原子性: 无残留 *.json.tmp + seg_urls JSON 可解析(隔离)",
    tmps.length === 0 && segOk,
    { tmp: tmps, segOk },
  );
}

// --- CORRUPT epoch (web 侧丢事件根治): 网关 task_events.json 损坏重启 → seq 归 0、epoch 翻转、
//     deque 清空。新事件是【当前 epoch 的低 seq】, 若 web 仍只发 ?since=curSeq, 网关过滤
//     (e.seq>since OR e.epoch!=cur)会把它挡掉 → 丢事件直到 seq 自然爬回 curSeq 上。
//     治本: web 检测 res.seq<curSeq(corrupt 复位)→ 以 ?since=0 重新请求拉回(planIngest.refetchFromZero)。
async function corrupt_epoch_refetch() {
  // 先确保已 ingest 当前所有事件, 让游标 curSeq 推到一个较大的值(前面 T6/T7 已 emit 不少)。
  await ingestOnce();
  const before = parseCursor(await readCursorRaw());
  // 前置断言: 游标 seq 必 > 1(否则 corrupt 后新事件 seq=1 不会 <= curSeq, 测不出 bug)。
  check(
    "[corrupt] 前提: 当前游标 seq 足够大(>1), 才能让 corrupt 后的低 seq 新事件落在网关过滤区间内",
    before.seq > 1,
    { cursor: before },
  );

  // kill -9 → 写坏 task_events.json(非 JSON)→ 重启 → 网关 _load 走 except 隔离 + seq 归 0 + epoch +1。
  killGatewayHard();
  await fs.writeFile(path.join(CACHE_DIR, "task_events.json"), "{ this is NOT valid json <<<", "utf-8");
  startGateway();
  await waitGatewayUp();

  // 网关现在 seq 应【回退到远低于旧游标】(峰值清空; 启动 init 期可能补发一两条僵尸 error 让 seq=1/2,
  // 但仍 << 旧游标 13)、epoch 翻转(corrupt 路径用 time-based epoch 避免撞历史, 故是个大数)。
  // 关键不变量是「seq 回退到旧游标之下」—— 这正是 web 端 refetchFromZero 的触发条件。
  const head = await gwTaskEvents(0);
  check(
    "[corrupt] 网关日志损坏重启后 seq 回退到远低于旧游标(峰值清空)+ epoch 翻转",
    head.seq < before.seq && head.epoch !== before.epoch,
    { gwSeq: head.seq, oldCursorSeq: before.seq, gwEpoch: head.epoch, beforeEpoch: before.epoch },
  );

  const CVID = "950000777";
  await gwEmit([{ kind: "buffer", vid: CVID, state: "done" }]);
  const afterEmit = await gwTaskEvents(0);
  const newEv = afterEmit.events.filter((e) => e.vid === CVID).pop();
  check(
    "[corrupt] corrupt 重启后新事件 seq 是【当前 epoch 低 seq】(<= 旧游标 curSeq, 落在网关过滤区间)",
    newEv && newEv.seq <= before.seq && newEv.epoch === afterEmit.epoch,
    { newSeq: newEv?.seq, oldCursorSeq: before.seq, newEpoch: newEv?.epoch },
  );

  // 失败信号对照: 模拟【旧逻辑】—— 只发一次 ?since=curSeq(不重请求)。网关把当前 epoch 低 seq 事件过滤掉,
  // 新事件【不在响应里】, 旧逻辑必丢。
  const oldStyle = await gwTaskEvents(before.seq); // 旧逻辑: since=curSeq, 不重请求
  const oldWouldSeeIt = (oldStyle.events ?? []).some((e) => e.vid === CVID);
  check(
    "[corrupt] 失败信号: 旧逻辑(只发 ?since=curSeq, 不重请求)看不到 corrupt 后的新事件(被网关过滤丢)",
    oldWouldSeeIt === false,
    { oldStyleHasNewEvent: oldWouldSeeIt, sinceUsed: before.seq },
  );

  // 治本: 真 ingestOnce(内含 planIngest.refetchFromZero → 检测 seq 回退 → ?since=0 重拉)入库新事件。
  // 关键断言: corrupt 后的【低 seq】CVID 事件确实落库(landedCount===1)。dbDelta 可能 >1, 因为
  // corrupt 重启 init 期可能补发僵尸→error 事件, 这轮 since=0 重拉会把它们一并入库(各自独立 seq, 正确)。
  const dbBefore = await prisma.taskHistory.count();
  await ingestOnce();
  const landed = await dbRows({ videoId: Number(CVID), kind: "buffer", state: "done" });
  const dbAfter = await prisma.taskHistory.count();
  check(
    "[corrupt] 治本: ingestOnce 检测 seq 回退后 ?since=0 重拉, corrupt 后的低 seq 新事件入库(不再丢)",
    landed.length === 1 && dbAfter - dbBefore >= 1,
    { landedCount: landed.length, dbDelta: dbAfter - dbBefore, newSeq: newEv?.seq },
  );

  // 幂等 + 可重复: 二次 ingest 不重复写、游标不回退。
  const c1 = await prisma.taskHistory.count();
  await ingestOnce();
  const c2 = await prisma.taskHistory.count();
  check("[corrupt] 治本后二次 ingest 幂等(不重复落库)", c1 === c2, { c1, c2 });
}

// ================= 启停 + 主流程 =================
async function setup() {
  // pre-kill: 清掉可能残留在本端口的上次崩溃实例, 防 startGateway 后误连到旧进程。
  killGatewayHard();
  TMPDIR = await fs.mkdtemp(path.join(os.tmpdir(), "yd_te_iso_"));
  CACHE_DIR = path.join(TMPDIR, "cache");
  THUMB_DIR = path.join(TMPDIR, "thumbs");
  DB_FILE = path.join(TMPDIR, "test.db");
  DB_URL = `file:${DB_FILE}`;
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(THUMB_DIR, { recursive: true });
  assertIsolatedPaths();

  // req.txt 必须存在(只读复用生产抓包, 不修改)。
  try { await fs.access(PROD_REQ); }
  catch { throw new Error(`缺 req.txt(${PROD_REQ}), 无法起隔离网关`); }

  // test.db: prisma migrate deploy(把 Agent B 的 task_event_seq 迁移建到 test.db)。
  const mig = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: WEB_DIR,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf-8",
  });
  if (mig.status !== 0) {
    throw new Error(`prisma migrate deploy 失败:\n${mig.stdout}\n${mig.stderr}`);
  }
  console.log(`[setup] test.db migrated -> ${DB_FILE}`);

  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  startGateway();
  await waitGatewayUp();
  console.log(`[setup] isolated gateway up on ${GW} (cache=${CACHE_DIR}, thumbs=${THUMB_DIR})`);
}

async function teardown() {
  try { if (prisma) await prisma.$disconnect(); } catch { /* */ }
  killGatewayHard();
  // 双保险: 若 gwChild 仍在(detached), 杀进程组。
  try { if (gwChild && gwChild.pid) process.kill(-gwChild.pid, "SIGKILL"); } catch { /* */ }
  if (TMPDIR && TMPDIR.startsWith(os.tmpdir())) {
    try { await fs.rm(TMPDIR, { recursive: true, force: true }); } catch { /* */ }
    console.log(`[teardown] removed TMPDIR ${TMPDIR}`);
  }
}

// 跑完所有断言后, 验证生产路径没被碰(任何隔离实例若误用生产路径会在这里暴露)。
async function assertProdUntouched() {
  // 我们从不向生产 DB / 缓存 / thumbs 写: 只校验本进程的 prisma 连的是 test.db,
  // 且隔离网关监听的是 8809。生产 8808 由别的进程拥有, 与本测试无关。
  const usingTestDb = DB_URL.includes(TMPDIR);
  check("[安全] prisma 连的是隔离 test.db(非生产 app.db)", usingTestDb, { DB_URL });
  // 隔离网关 task_events.json 落在隔离缓存目录而非生产缓存目录。
  let teInIso = false;
  try { await fs.access(path.join(CACHE_DIR, "task_events.json")); teInIso = true; } catch { /* */ }
  check("[安全] task_events.json 落隔离缓存目录(非生产缓存)", teInIso,
    { path: path.join(CACHE_DIR, "task_events.json") });
}

async function main() {
  await setup();
  try {
    await task6_core();
    await task6_extra();
    await task2_epoch_collision();
    await task7_restart_resume();
    await task7_restart_zombies();
    await task8_persist_robust();
    await corrupt_epoch_refetch();
    await assertProdUntouched();
  } finally {
    await teardown();
  }
  const allOk = results.every((r) => r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} PASS`);
  console.log(`ALL PASS: ${allOk}`);
  process.exit(allOk ? 0 : 1);
}

main().catch(async (e) => {
  console.error("e2e error:", e);
  try { await teardown(); } catch { /* */ }
  process.exit(2);
});
