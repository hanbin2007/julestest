// e2e (隔离): 存量 TaskHistory 上【增量 migrate deploy】回归 —— 任务事件日志方案的迁移安全。
//
// 治本背景: 任务事件日志在【已上线、TaskHistory 里已有存量行】的库上增量迁移:
//   · 20260529222612_task_event_seq            : ALTER TABLE ADD COLUMN "seq" + 建 UNIQUE 索引 + 建 SyncState + 种子游标。
//   · 20260530000000_task_event_epoch_drop_seq_unique : DROP 那个 seq UNIQUE 索引(epoch 方案改用主键 id 幂等)。
//   · 20260530010000_task_history_product_id   : ALTER TABLE ADD COLUMN "productId"(共享讲归属, 可空)。
// 风险: 这几步若写错(NOT NULL 无默认值 / 索引名错 / 撞存量行), 增量 deploy 会在【生产存量库】上炸,
//   或把存量历史行清空/锁死。本测在【隔离 test.db】上模拟"存量行 + 增量 deploy", 断言:
//   (a) 存量历史行【一行不丢】, 且新列在存量行上落 NULL(seq=NULL, productId=NULL) —— ADD COLUMN 可空。
//   (b) seq 的 UNIQUE 索引最终【被 DROP 掉】(否则 epoch 复用 seq 第二个 boot 同 seq 插入会 P2002 整批回滚, 正是 #3)。
//   (c) SyncState 游标单例被种子化(taskEventSeq=初值), 增量同步起步不回灌。
//   (d) 迁移后还能正常【插入带 seq+productId 的新行】(新 schema 真生效, 不是只改了 DDL 没通)。
//
// 失败信号(区分"迁移正确"vs"迁移写坏"):
//   · 若 ADD COLUMN 误写 NOT NULL 无默认: 增量 deploy 在存量行上直接报错 → 本测 setup 抛错(红)。
//   · 若漏 DROP seq UNIQUE: (b) 探测到 UNIQUE 索引仍在 → 红。
//   · 若存量行被迁移清掉: (a) 行数对不上 → 红。
//
// 硬约束 [[julestest-no-prod-db-writes]]: 绝不碰生产 app.db。全程隔离 test.db(全新 mkdtemp TMPDIR),
//   用 sqlite3 CLI 逐个套用 prisma/migrations 下的真 migration.sql(模拟 prisma migrate deploy 的 DDL),
//   再用 PrismaClient 连同一 test.db 做断言。不起网关、不连生产、不跑 npm build。
//
// 可重复: 每次全新 mkdtemp; teardown rm -rf。连跑两遍都过。

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __filename = fileURLToPath(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(__filename), "..");
const MIG_DIR = path.join(WEB_DIR, "prisma", "migrations");
const PROD_DB = "/Users/zhb/.youdao_course/app.db";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
}

let TMPDIR = "";
let DB_FILE = "";
let prisma = null;

// 迁移链(按目录名时间序)。存量基线 = 到 add_task_history 为止(此时 TaskHistory 无 seq/productId)。
const BASELINE = "20260527130827_add_task_history";
const INCREMENTAL = [
  "20260529222612_task_event_seq",
  "20260530000000_task_event_epoch_drop_seq_unique",
  "20260530010000_task_history_product_id",
];

async function migrationsInOrder() {
  const dirs = (await fs.readdir(MIG_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(); // 目录名带时间戳前缀, 字典序即时间序
  return dirs;
}

// 用 sqlite3 CLI 套用一个 migration.sql(等价 prisma migrate deploy 的 DDL 执行)。
function applyMigration(name) {
  const sqlPath = path.join(MIG_DIR, name, "migration.sql");
  execFileSync("sqlite3", [DB_FILE, `.read ${sqlPath}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function sqliteQuery(sql) {
  return execFileSync("sqlite3", [DB_FILE, sql], { encoding: "utf-8" }).trim();
}

async function setup() {
  TMPDIR = await fs.mkdtemp(path.join(os.tmpdir(), "yd_migte_"));
  DB_FILE = path.join(TMPDIR, "test.db");
  if (!TMPDIR.startsWith(os.tmpdir())) throw new Error(`隔离路径越界: ${TMPDIR}`);
  if (DB_FILE === PROD_DB) throw new Error("隔离 DB 撞生产 app.db");

  // 1) 套用基线: init … add_task_history(含建好 TaskHistory, 此刻无 seq/productId 列)。
  const all = await migrationsInOrder();
  const baselineIdx = all.indexOf(BASELINE);
  if (baselineIdx < 0) throw new Error(`找不到基线迁移 ${BASELINE}`);
  for (const m of all.slice(0, baselineIdx + 1)) applyMigration(m);
  console.log(`[setup] 基线迁移套用到 ${BASELINE} (TaskHistory 已建, 无 seq/productId)`);
}

async function run() {
  // 2) 灌入【存量历史行】(老 schema: 只有 id/kind/videoId/state/reason/at, 无 seq/productId)。
  //    用老式 id(纯描述, 非 evt-<epoch>-<seq>)模拟上线初期就存在的历史。
  const legacyIds = ["legacy-buffer-1", "legacy-thumb-2", "legacy-prefetch-3"];
  for (let i = 0; i < legacyIds.length; i++) {
    const id = legacyIds[i];
    sqliteQuery(
      `INSERT INTO "TaskHistory" ("id","kind","videoId","state","reason","at") ` +
      `VALUES ('${id}','buffer',${900000 + i},'done',NULL,'2026-05-27 10:0${i}:00');`,
    );
  }
  const cntBefore = Number(sqliteQuery(`SELECT COUNT(*) FROM "TaskHistory";`));
  check(
    "[迁移] 存量基线: 老 schema 下灌入 3 条历史行(无 seq/productId 列)",
    cntBefore === legacyIds.length,
    { cntBefore, legacyIds },
  );
  // 套用增量前确认 seq/productId 列还不存在(真"增量"而非一次性建全)。
  const colsBefore = sqliteQuery(`PRAGMA table_info("TaskHistory");`)
    .split("\n").map((l) => l.split("|")[1]);
  check(
    "[迁移] 增量前 TaskHistory 尚无 seq/productId 列(确属增量场景)",
    !colsBefore.includes("seq") && !colsBefore.includes("productId"),
    { cols: colsBefore },
  );

  // 3) 增量 deploy: 逐个套用 task_event_seq → drop_seq_unique → product_id。
  //    若任一步在存量行上炸(如 NOT NULL 无默认), execFileSync 会抛 → 本测直接红。
  for (const m of INCREMENTAL) applyMigration(m);
  console.log(`[run] 增量迁移套用完成: ${INCREMENTAL.join(" -> ")}`);

  // (a) 存量行一行不丢, 新列在存量行上落 NULL。
  const cntAfter = Number(sqliteQuery(`SELECT COUNT(*) FROM "TaskHistory";`));
  const nullSeq = Number(sqliteQuery(
    `SELECT COUNT(*) FROM "TaskHistory" WHERE "seq" IS NULL AND "id" LIKE 'legacy-%';`));
  const nullPid = Number(sqliteQuery(
    `SELECT COUNT(*) FROM "TaskHistory" WHERE "productId" IS NULL AND "id" LIKE 'legacy-%';`));
  check(
    "[迁移] (a) 增量 deploy 后存量历史行一行不丢, 且新列在存量行上落 NULL(ADD COLUMN 可空)",
    cntAfter === cntBefore && nullSeq === legacyIds.length && nullPid === legacyIds.length,
    { cntBefore, cntAfter, nullSeqLegacy: nullSeq, nullPidLegacy: nullPid },
  );

  // (b) seq 的 UNIQUE 索引最终被 DROP(否则 epoch 复用 seq 会 P2002 整批回滚, 正是 #3)。
  const idxList = sqliteQuery(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='TaskHistory';`)
    .split("\n").filter(Boolean);
  const hasSeqUnique = idxList.includes("TaskHistory_seq_key");
  check(
    "[迁移] (b) seq 的 UNIQUE 索引已被 DROP(epoch 方案改主键 id 幂等, 复用 seq 不再 P2002)",
    !hasSeqUnique,
    { indexes: idxList },
  );

  // (c) SyncState 游标单例被种子化。
  const syncSeed = sqliteQuery(`SELECT "value" FROM "SyncState" WHERE "key"='taskEventSeq';`);
  check(
    "[迁移] (c) SyncState 游标单例被种子化(taskEventSeq 存在, 增量同步起步不回灌)",
    syncSeed.length > 0,
    { taskEventSeq: syncSeed },
  );

  // (d) 迁移后新 schema 真生效: 用 Prisma(读 schema.prisma)插一条带 seq+productId 的新行并读回。
  prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_FILE}` } } });
  const newRow = await prisma.taskHistory.create({
    data: {
      id: "evt-7-42", kind: "buffer", videoId: 12345, state: "done",
      reason: null, at: new Date(), seq: 42, productId: 23279,
    },
  });
  const readBack = await prisma.taskHistory.findUnique({ where: { id: "evt-7-42" } });
  check(
    "[迁移] (d) 迁移后新 schema 真生效: 可插入并读回带 seq+productId 的新行(非只改 DDL 没通)",
    readBack != null && readBack.seq === 42 && readBack.productId === 23279,
    { id: newRow.id, seq: readBack?.seq, productId: readBack?.productId },
  );

  // (b 强化) 复用 seq 入库不被 UNIQUE 拦(同 seq 不同 id 应能共存 → 证明 DROP 真生效)。
  await prisma.taskHistory.create({
    data: {
      id: "evt-8-42", kind: "thumb", videoId: 12345, state: "error",
      reason: "reused seq across epoch", at: new Date(), seq: 42, productId: null,
    },
  });
  const sameSeqRows = await prisma.taskHistory.findMany({ where: { seq: 42 } });
  check(
    "[迁移] (b强化) 跨 epoch 复用 seq=42 的两条不同 id 行共存入库(UNIQUE 已去, 无 P2002)",
    sameSeqRows.length === 2,
    { sameSeqCount: sameSeqRows.length, ids: sameSeqRows.map((r) => r.id) },
  );
}

async function teardown() {
  try { if (prisma) await prisma.$disconnect(); } catch { /* */ }
  if (TMPDIR && TMPDIR.startsWith(os.tmpdir())) {
    try { await fs.rm(TMPDIR, { recursive: true, force: true }); } catch { /* */ }
    console.log(`[teardown] removed TMPDIR ${TMPDIR}`);
  }
}

async function main() {
  await setup();
  try { await run(); } finally { await teardown(); }
  const allOk = results.length > 0 && results.every((r) => r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} PASS`);
  console.log(`ALL PASS: ${allOk}`);
  process.exit(allOk ? 0 : 1);
}

main().catch(async (e) => {
  console.error("e2e error:", e);
  try { await teardown(); } catch { /* */ }
  process.exit(2);
});
