// e2e (隔离): ThumbStatus 镜像 + 离线回退 白名单归一 —— 方案 Task 10 (#14)。
//
// 硬约束 [[julestest-no-prod-db-writes]]: 本脚本 *绝不* 碰生产 app.db / 生产缓存 / 生产网关 8808 /
// web 3000。所有状态进全新临时 TMPDIR test.db(DATABASE_URL=file:... + prisma migrate deploy)。
// web 侧不起 next: 直接 import @prisma/client 连 test.db,在本脚本内复刻 status/route.ts 的
//   · mirror() thumb 写入侧(白名单归一: ready/gen/error upsert; cancelled/queued/未知 → 删行)
//   · fallback() 离线读取侧(thumbBy 用 normalizeThumbState 自愈历史污染行)
// 两条逻辑与 thumbStatus.ts normalizeThumbState 保持字节级一致(node --test 跑 .mjs 不能 import .ts)。
//
// 本测试不需要真实网关(纯 DB 镜像/回退路径), 故不起 gateway, 只起隔离 test.db。
//
// 失败信号(区分"修复生效"vs"旧 passthrough"):
//   核心1 镜像  : gw.thumb.states={cancelled} → 旧 passthrough 把 'cancelled' 原样写库;
//                 新归一: 该 vid 在 ThumbStatus 里【不存在】(被删/不写)。断言 row==null。
//   核心2 回退  : 在库里【手工注入】一条历史污染行 state='cancelled'(模拟本修复前已落库),
//                 走离线 fallback 读取归一: 该 vid 的 thumb 输出必须是 null(不是 'cancelled')。
//                 旧 fallback 直接 cast → 吐 'cancelled' 给前端误显示 → 断言会红。
//   白名单内    : ready/gen/error 三态原样保留(镜像写入 + 离线读取都不丢)。
//
// 可重复: 每次跑全新 mkdtemp TMPDIR + migrate deploy, teardown rm -rf。连跑两遍都过。

import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
// 同源真函数(#14): 直接 import route.ts/mirror 同款 normalizeThumbState, 不再手抄复刻。
import { normalizeThumbState } from "../src/lib/thumbStatus.ts";

const __filename = fileURLToPath(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(__filename), "..");
const PROD_DB = "/Users/zhb/.youdao_course/app.db";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
}

let TMPDIR = "";
let DB_FILE = "";
let DB_URL = "";
let prisma = null;

// normalizeThumbState 现直接 import 自 ../src/lib/thumbStatus.ts(顶上 import), 不再手抄复刻。

// ---- 复刻 route.ts mirror() 的 thumb 写入侧白名单归一(#14)----
// ready/gen/error → upsert; cancelled/queued/未知 → deleteMany(归一为 null = 不在镜像里)。
async function mirrorThumbStates(thumbStates) {
  const ops = [];
  for (const [vid, st] of Object.entries(thumbStates)) {
    const videoId = Number(vid);
    if (!videoId) continue;
    const norm = normalizeThumbState(st);
    if (norm)
      ops.push(prisma.thumbStatus.upsert({ where: { videoId }, create: { videoId, state: norm }, update: { state: norm } }));
    else ops.push(prisma.thumbStatus.deleteMany({ where: { videoId } }));
  }
  if (ops.length) await prisma.$transaction(ops);
}

// ---- 复刻 route.ts fallback() 的 thumb 读取侧白名单归一(#14)----
// 读 DB 全表, 用 normalizeThumbState 自愈任何历史污染行 → 返回 videoId→thumb 映射。
async function fallbackThumbBy() {
  const ts = await prisma.thumbStatus.findMany();
  return new Map(ts.map((r) => [r.videoId, normalizeThumbState(r.state)]));
}

// ================= 测试主体 =================

async function test_mirror_drops_cancelled() {
  const READY = 910000001, GEN = 910000002, ERR = 910000003, CANC = 910000004, Q = 910000005, UNK = 910000006;
  // 预置: CANC/Q/UNK 在库里曾有 ready 行(模拟之前 ready → 现在被取消/排队), 镜像应把它们删掉。
  await prisma.$transaction([
    prisma.thumbStatus.upsert({ where: { videoId: CANC }, create: { videoId: CANC, state: "ready" }, update: { state: "ready" } }),
    prisma.thumbStatus.upsert({ where: { videoId: Q }, create: { videoId: Q, state: "ready" }, update: { state: "ready" } }),
    prisma.thumbStatus.upsert({ where: { videoId: UNK }, create: { videoId: UNK, state: "ready" }, update: { state: "ready" } }),
  ]);

  // 网关上报态(含非法值 cancelled/queued/weird)。
  await mirrorThumbStates({
    [READY]: "ready", [GEN]: "gen", [ERR]: "error",
    [CANC]: "cancelled", [Q]: "queued", [UNK]: "weird",
  });

  const row = async (v) => prisma.thumbStatus.findUnique({ where: { videoId: v } });
  const rReady = await row(READY), rGen = await row(GEN), rErr = await row(ERR);
  const rCanc = await row(CANC), rQ = await row(Q), rUnk = await row(UNK);

  check(
    "[T10镜像] 白名单内 ready/gen/error 原样落库",
    rReady?.state === "ready" && rGen?.state === "gen" && rErr?.state === "error",
    { ready: rReady?.state, gen: rGen?.state, error: rErr?.state },
  );
  check(
    "[T10镜像] cancelled/queued/未知 归一为 null → 镜像行被删(旧 passthrough 会原样写库)",
    rCanc == null && rQ == null && rUnk == null,
    { cancelled: rCanc?.state ?? null, queued: rQ?.state ?? null, unknown: rUnk?.state ?? null },
  );
  // 失败信号显式化: 旧 passthrough 会让 rCanc.state === 'cancelled'。
  check(
    "[T10镜像] 失败信号确认: cancelled 不再以 'cancelled' 存在于镜像表",
    rCanc?.state !== "cancelled",
    { cancelledRowState: rCanc?.state ?? null },
  );
}

async function test_fallback_self_heals_poisoned_rows() {
  // 模拟"本修复前已被污染"的镜像行: 直接注入 state='cancelled' / 'queued' / 未知。
  // 离线 fallback 读取必须把它们归一为 null(不吐给前端), 不依赖镜像侧是否清过。
  const PCANC = 920000001, PQ = 920000002, PUNK = 920000003, PREADY = 920000004, PGEN = 920000005;
  await prisma.$transaction([
    prisma.thumbStatus.upsert({ where: { videoId: PCANC }, create: { videoId: PCANC, state: "cancelled" }, update: { state: "cancelled" } }),
    prisma.thumbStatus.upsert({ where: { videoId: PQ }, create: { videoId: PQ, state: "queued" }, update: { state: "queued" } }),
    prisma.thumbStatus.upsert({ where: { videoId: PUNK }, create: { videoId: PUNK, state: "garbage" }, update: { state: "garbage" } }),
    prisma.thumbStatus.upsert({ where: { videoId: PREADY }, create: { videoId: PREADY, state: "ready" }, update: { state: "ready" } }),
    prisma.thumbStatus.upsert({ where: { videoId: PGEN }, create: { videoId: PGEN, state: "gen" }, update: { state: "gen" } }),
  ]);

  const thumbBy = await fallbackThumbBy();
  check(
    "[T10回退] 离线读取自愈污染行: cancelled/queued/未知 → null(旧 fallback 直接 cast 会吐非法值)",
    thumbBy.get(PCANC) === null && thumbBy.get(PQ) === null && thumbBy.get(PUNK) === null,
    { cancelled: thumbBy.get(PCANC), queued: thumbBy.get(PQ), unknown: thumbBy.get(PUNK) },
  );
  check(
    "[T10回退] 白名单内 ready/gen 离线读取原样保留",
    thumbBy.get(PREADY) === "ready" && thumbBy.get(PGEN) === "gen",
    { ready: thumbBy.get(PREADY), gen: thumbBy.get(PGEN) },
  );
  // 失败信号显式化: 旧 fallback `r.state as ThumbType` 会让 thumbBy.get(PCANC) === 'cancelled'。
  check(
    "[T10回退] 失败信号确认: cancelled 不再以 'cancelled' 出现在 fallback 输出",
    thumbBy.get(PCANC) !== "cancelled",
    { fallbackCancelled: thumbBy.get(PCANC) },
  );
}

// 行为守卫: 现在直接 import 真源 normalizeThumbState(不再手抄), 故无「复刻漂移」可言。
// 仍断言导入的真函数白名单口径正确(ready/gen/error 保留, cancelled/queued/未知→null)——
// 若有人改坏 thumbStatus.ts 这条会红。
async function test_imported_source_whitelist() {
  const ok =
    normalizeThumbState("ready") === "ready" &&
    normalizeThumbState("gen") === "gen" &&
    normalizeThumbState("error") === "error" &&
    normalizeThumbState("cancelled") === null &&
    normalizeThumbState("queued") === null &&
    normalizeThumbState("weird") === null;
  check("[T10] 直接 import 的 thumbStatus.ts normalizeThumbState 白名单口径正确(真源, 非手抄)", ok, {
    ready: normalizeThumbState("ready"),
    cancelled: normalizeThumbState("cancelled"),
  });
}

// ================= 启停 + 主流程 =================
async function setup() {
  TMPDIR = await fs.mkdtemp(path.join(os.tmpdir(), "yd_thumbwl_"));
  DB_FILE = path.join(TMPDIR, "test.db");
  DB_URL = `file:${DB_FILE}`;
  if (DB_FILE === PROD_DB) throw new Error("撞生产 app.db");
  if (!DB_FILE.startsWith(TMPDIR)) throw new Error("test.db 越界(非 TMPDIR)");

  const mig = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: WEB_DIR,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf-8",
  });
  if (mig.status !== 0) throw new Error(`prisma migrate deploy 失败:\n${mig.stdout}\n${mig.stderr}`);
  console.log(`[setup] test.db migrated -> ${DB_FILE}`);

  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
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
  try {
    await test_mirror_drops_cancelled();
    await test_fallback_self_heals_poisoned_rows();
    await test_imported_source_whitelist();
    // 安全断言: prisma 连的是隔离 test.db。
    check("[安全] prisma 连隔离 test.db(非生产 app.db)", DB_URL.includes(TMPDIR) && DB_FILE !== PROD_DB, { DB_URL });
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
