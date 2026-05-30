// e2e (隔离): Task 8 (#15) 共享讲归属 —— productId 端到端验证。
//
// 硬约束 [[julestest-no-prod-db-writes]]: 绝不碰生产 app.db / 生产缓存 / 网关 8808 / web 3000。
// 全部进全新临时 TMPDIR(test.db / 隔离缓存 / 隔离 thumbs / 网关端口 8810,非生产)。web 侧不起
// next: 直接 import @prisma/client 连 test.db,在本脚本内复刻 status/route.ts 的 ingest + 课程名
// 解析(byCourseVid 优先 (productId,videoId),回退 byVid)逻辑。
//
// 验证根因(#15): 同一 videoId 被打进两门课(共享讲),仅按 videoId 取课程名会被「后写覆盖」
// (byVid)归到错的那门课。事件带 productId 后,按 (productId,videoId) 取课才归属正确。
//
// 失败信号(区分修复生效 vs 旧方案):
//   · 在课程 X(productId=PX)下 buffer done 一条共享讲 SHARED_VID。
//   · TaskHistory 该行 productId === PX(旧方案: productId 列不存在/为 NULL = FAIL)。
//   · 按 (PX, SHARED_VID) 解析课程名 = "课程X"; 而纯 byVid 解析(被后写课程 Y 覆盖) = "课程Y"。
//     断言「带 productId 解析 === 课程X」且「!== byVid 误解析的 课程Y」—— 显式负向对照。
//
// 可重复: 每次全新 mkdtemp TMPDIR; teardown 杀隔离进程 + rm -rf。连跑两遍都过。

import { promises as fs } from "node:fs";
import { spawn, execSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
// 同源真函数(#14/#15): 不再手抄复刻 route.ts 的 ingest/课程名解析逻辑。Node 22 原生 import .ts。
import {
  parseCursor,
  formatCursor,
  planIngest,
  filterFreshEvents,
  eventRowId,
  normalizeEventProductId,
  resolveTaskCourse,
} from "../src/lib/taskEvents.ts";

const __filename = fileURLToPath(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(__filename), "..");
const ROOT = path.resolve(WEB_DIR, "..");
const PROD_REQ = "/Users/zhb/Documents/julestest/req.txt";
const PORT = 8810; // 非生产端口(且与并行 8809 e2e 错开)
const GW = `http://127.0.0.1:${PORT}`;

const PROD_DB = "/Users/zhb/.youdao_course/app.db";
const PROD_CACHE = "/Users/zhb/.youdao_course/cache";
const PROD_THUMBS = "/Users/zhb/.youdao_course/thumbs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
}

let gwChild = null;
let TMPDIR = "";
let CACHE_DIR = "";
let THUMB_DIR = "";
let DB_FILE = "";
let DB_URL = "";
let prisma = null;

// 共享讲场景常量: 同一 videoId 属两门课。
const SHARED_VID = 815000001;
const PX = 815001; // 课程X(事件实际归属:在 X 下触发了缓冲)
const PY = 815002; // 课程Y(目录里最后写,byVid 会被它覆盖 -> 误归属对照)

function assertIsolatedPaths() {
  for (const p of [TMPDIR, CACHE_DIR, THUMB_DIR, DB_FILE]) {
    if (!p.startsWith(TMPDIR)) throw new Error(`隔离路径越界: ${p}`);
  }
  for (const prod of [PROD_DB, PROD_CACHE, PROD_THUMBS]) {
    if (CACHE_DIR === prod || THUMB_DIR === prod || DB_FILE === prod) {
      throw new Error(`隔离路径撞生产: ${prod}`);
    }
  }
  if (PORT === 8808) throw new Error("端口撞生产 8808");
}

function startGateway() {
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
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("隔离网关未就绪(8810)");
}

function gatewayPid() {
  try {
    return execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null`).toString().trim();
  } catch { return ""; }
}

function killGatewayHard() {
  const pid = gatewayPid();
  if (pid) {
    for (const p of pid.split(/\s+/)) {
      try { execSync(`kill -9 ${p}`); } catch { /* gone */ }
    }
  }
  for (let i = 0; i < 20; i++) {
    if (!gatewayPid()) return;
    try { execSync("sleep 0.3"); } catch { /* */ }
  }
}

// ---- 网关 API ----
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

// ---- web 侧 ingest(直接用 route.ts 同源 lib: parseCursor/planIngest/filterFreshEvents/...)----
// 与生产 ingestTaskEvents 走同一份纯逻辑, 不再手抄复刻(改 .ts 即改这里, 杜绝漂移)。
async function ingestOnce() {
  const curRaw = (await prisma.syncState.findUnique({ where: { key: "taskEventSeq" } }))?.value ?? "0:0";
  const cur = parseCursor(curRaw);
  let res = await gwTaskEvents(cur.seq);
  let plan = planIngest(cur, res.epoch, res.seq);
  if (plan.refetchFromZero) {
    res = await gwTaskEvents(0); // corrupt 复位 → since=0 重拉(治本)
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
    return { ingested: 0 };
  }
  await prisma.$transaction([
    ...fresh.map((e) => {
      const id = eventRowId(e.epoch, e.seq);
      const pid = normalizeEventProductId(e.productId);
      return prisma.taskHistory.upsert({
        where: { id },
        create: {
          id,
          kind: e.kind,
          videoId: Number(e.vid),
          productId: pid,
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
  return { ingested: fresh.length };
}

// 测试用的 key 索引(与 catalogRollup.buildKeyMaps 同形, 仅取本测试需要的最小字段)。
function buildKeyMaps(courses) {
  const byVid = new Map();
  const byCourseVid = new Map();
  for (const c of courses) {
    for (const v of c.vids) {
      const meta = { courseId: c.productId, courseName: c.name, title: null };
      byVid.set(v.videoId, meta); // 后写覆盖
      byCourseVid.set(`${c.productId}:${v.videoId}`, meta);
    }
  }
  return { byVid, byCourseVid };
}
// 课程名解析走 route.ts 同源 resolveTaskCourse(#15): byCourseVid 命中→正确课; 未命中按 productId
// 查 Course.name(courseNameByPid)而非回退 byVid; 课也删了才最后回退 byVid。
function resolveCourseName(h, byVid, byCourseVid, courseNameByPid = new Map()) {
  return resolveTaskCourse(h, byCourseVid, byVid, courseNameByPid).courseName;
}

// ================= 测试主体 =================
async function task8_shared_lesson_attribution() {
  // 目录: 课程X(PX) 与 课程Y(PY) 都含 SHARED_VID(共享讲)。Y 排在后 -> byVid 被 Y 覆盖。
  const courses = [
    { productId: PX, name: "课程X", vids: [{ videoId: SHARED_VID }] },
    { productId: PY, name: "课程Y", vids: [{ videoId: SHARED_VID }] },
  ];
  const { byVid, byCourseVid } = buildKeyMaps(courses);

  // 负向对照前提: byVid 解析必为「课程Y」(后写覆盖), 证明纯 videoId 会归错课。
  const byVidName = byVid.get(SHARED_VID)?.courseName;
  check(
    "[T8] 前提: byVid(纯 videoId) 把共享讲归到后写课程 Y(正是 #15 的 bug 根因)",
    byVidName === "课程Y",
    { byVidName },
  );

  // 在「课程X」下对共享讲触发一次 buffer done; 事件带 productId=PX(网关从 video_meta 盖上)。
  await gwEmit([{ kind: "buffer", vid: String(SHARED_VID), state: "done", productId: PX }]);

  // 网关事件确实带 productId=PX
  const evs = (await gwTaskEvents(0)).events.filter((e) => e.vid === String(SHARED_VID));
  const lastEv = evs[evs.length - 1];
  check(
    "[T8] 网关事件携带 productId(从 video_meta 盖上)",
    lastEv && lastEv.productId === PX,
    { eventProductId: lastEv?.productId, want: PX },
  );

  await ingestOnce();

  // TaskHistory 行写入了 productId
  const rows = await prisma.taskHistory.findMany({
    where: { videoId: SHARED_VID, kind: "buffer", state: "done" },
  });
  check(
    "[T8] TaskHistory 行带 productId === PX(旧方案无此列/为 NULL = FAIL)",
    rows.length === 1 && rows[0].productId === PX,
    { count: rows.length, productId: rows[0]?.productId, want: PX },
  );

  // 课程名解析: 带 productId -> 课程X; 显式与「byVid 误解析的 课程Y」对照。
  const h = rows[0];
  const resolved = resolveCourseName(h, byVid, byCourseVid);
  check(
    "[T8] 按 (productId,videoId) 解析课程名 = 课程X(归属正确)",
    resolved === "课程X",
    { resolved, want: "课程X" },
  );
  check(
    "[T8] 失败信号确认: 带 productId 的解析 !== byVid 误解析的 课程Y",
    resolved !== byVidName,
    { resolved, byVidWrong: byVidName },
  );

  // 回退路径: productId 为 NULL 的存量行仍走 byVid(不崩, 解析到课程Y)。
  const legacy = { videoId: SHARED_VID, productId: null };
  const legacyResolved = resolveCourseName(legacy, byVid, byCourseVid);
  check(
    "[T8] 回退: productId=NULL 的存量行走 byVid(不崩, 解析到后写课程)",
    legacyResolved === "课程Y",
    { legacyResolved },
  );

  // #15 回退边界: 讲已从课X移除(byCourseVid 无 "PX:vid")但课X仍在 → 按 productId 查 Course.name
  // 归到课X, 不回退 byVid 误归课Y。courseNameByPid 模拟 prisma 查 Course.name。
  const byCourseVidMissingX = new Map([[`${PY}:${SHARED_VID}`, { courseId: PY, courseName: "课程Y", title: null }]]);
  const courseNameByPid = new Map([[PX, "课程X"], [PY, "课程Y"]]);
  const boundaryResolved = resolveCourseName(h, byVid, byCourseVidMissingX, courseNameByPid);
  check(
    "[T8 #15回退边界] 讲从课X移除(byCourseVid miss)但课X仍在 → 按 productId 归课X(不回退 byVid 误归课Y)",
    boundaryResolved === "课程X" && boundaryResolved !== "课程Y",
    { boundaryResolved, want: "课程X", byVidWrong: byVidName },
  );
  // 课X也删了(courseNameByPid 无 PX) → 才最后回退 byVid 到课Y(best-effort 不崩)。
  const courseNameByPidNoX = new Map([[PY, "课程Y"]]);
  const lastResort = resolveCourseName(h, byVid, byCourseVidMissingX, courseNameByPidNoX);
  check(
    "[T8 #15回退边界] 课X也删了(Course.name 也无) → 最后回退 byVid 到课Y(best-effort)",
    lastResort === "课程Y",
    { lastResort },
  );
}

// ================= 启停 + 主流程 =================
async function setup() {
  TMPDIR = await fs.mkdtemp(path.join(os.tmpdir(), "yd_t8_iso_"));
  CACHE_DIR = path.join(TMPDIR, "cache");
  THUMB_DIR = path.join(TMPDIR, "thumbs");
  DB_FILE = path.join(TMPDIR, "test.db");
  DB_URL = `file:${DB_FILE}`;
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(THUMB_DIR, { recursive: true });
  assertIsolatedPaths();

  try { await fs.access(PROD_REQ); }
  catch { throw new Error(`缺 req.txt(${PROD_REQ}), 无法起隔离网关`); }

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
  console.log(`[setup] isolated gateway up on ${GW}`);
}

async function teardown() {
  try { if (prisma) await prisma.$disconnect(); } catch { /* */ }
  killGatewayHard();
  try { if (gwChild && gwChild.pid) process.kill(-gwChild.pid, "SIGKILL"); } catch { /* */ }
  if (TMPDIR && TMPDIR.startsWith(os.tmpdir())) {
    try { await fs.rm(TMPDIR, { recursive: true, force: true }); } catch { /* */ }
    console.log(`[teardown] removed TMPDIR ${TMPDIR}`);
  }
}

async function assertProdUntouched() {
  const usingTestDb = DB_URL.includes(TMPDIR);
  check("[安全] prisma 连的是隔离 test.db(非生产 app.db)", usingTestDb, { DB_URL });
}

async function main() {
  await setup();
  try {
    await task8_shared_lesson_attribution();
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
