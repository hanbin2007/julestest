// e2e (隔离): 缩略图源段物理隔离 (#1,#8) —— Task 6。
//
// 治本主张: 缩略图源段(低清流, t_<vid> 键)从此进【独立小桶 thumb_seg_cache】, 不再和
// 256MB 播放桶 seg_cache 抢容量。物理隔离是唯一能真正限界"生成 D 缩略图把已缓存(但当前没
// 在看)的 A/B/C 播放段挤出"的手段(保护窗口覆盖不到任意已缓存段)。生成完即 drop_vid 释放。
//
// 本脚本验证(对真实隔离网关进程, 不碰生产):
//   1. 第二个 DiskLRU 真的存在且与 seg_cache 物理分离: 不同目录 + 独立硬上限 + 上限 < 播放桶。
//   2. /api/status 的 thumb.bytes 从独立桶读(空时为 0), 与 buffer.bytes(播放桶 seg_cache.size)
//      物理分开 —— 消除 #8 的 thumbBytes 双计混淆。
//   3. 段级隔离的"挤出"不变量由 ydcore/test_thumb_isolation.py(单元, 含 negative control:
//      把 thumb 段塞回 seg_cache 会把 A 播放段从 10 挤到 0)精确机器断言; 本 e2e 验证真实
//      __init__ 把两桶接好(真进程层)。
//
// 失败信号(区分"修复生效"vs"未修复"):
//   未修复(单桶)时 /api/_debug 没有 thumbSegDir / thumbSegMax 字段, 或 thumbSegDir===segCacheDir,
//   断言全红。修复后两桶分离, 字段齐全。
//
// 硬约束 [[julestest-no-prod-db-writes]]: 绝不碰生产 app.db / 生产缓存 / 生产 8808 / 生产 thumbs。
//   全部状态进全新 TMPDIR; 网关端口 8810(非 8808/8809); thumbs 经 YD_THUMB_DIR 重定向到 TMPDIR;
//   缩略图源桶上限经 YD_THUMB_CACHE_BYTES 调小到 8MB(默认 64MB), 加快/明确 e2e。
// 可重复: 每次跑全新 mkdtemp TMPDIR; teardown 杀隔离进程 + rm -rf。连跑两遍都过。

import { promises as fs } from "node:fs";
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(__filename), "..");
const ROOT = path.resolve(WEB_DIR, "..");
const PROD_REQ = "/Users/zhb/Documents/julestest/req.txt";
const PORT = 8810; // 非生产 8808, 也避开 task_events e2e 的 8809
const GW = `http://127.0.0.1:${PORT}`;
const THUMB_CACHE_BYTES = 8 * 1024 * 1024; // 隔离调小: 8MB(默认 64MB)

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

function assertIsolatedPaths() {
  for (const p of [TMPDIR, CACHE_DIR, THUMB_DIR]) {
    if (!p.startsWith(TMPDIR)) throw new Error(`隔离路径越界: ${p}`);
  }
  for (const prod of [PROD_DB, PROD_CACHE, PROD_THUMBS]) {
    if (CACHE_DIR === prod || THUMB_DIR === prod) throw new Error(`隔离路径撞生产: ${prod}`);
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
      env: {
        ...process.env,
        YD_THUMB_DIR: THUMB_DIR,
        YD_THUMB_CACHE_BYTES: String(THUMB_CACHE_BYTES),
      },
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
    } catch { /* not up */ }
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
  if (pid) for (const p of pid.split(/\s+/)) { try { execSync(`kill -9 ${p}`); } catch { /* */ } }
  for (let i = 0; i < 20; i++) { if (!gatewayPid()) return; try { execSync("sleep 0.3"); } catch { /* */ } }
}

async function dbg() { return (await fetch(`${GW}/api/_debug`)).json(); }
async function status() { return (await fetch(`${GW}/api/status`)).json(); }

// ---- 断言 1: 第二个桶存在且物理分离 ----
async function test_separate_physical_bucket() {
  const d = await dbg();
  const hasFields = typeof d.thumbSegDir === "string" && typeof d.thumbSegMax === "number"
    && typeof d.thumbSegBytes === "number" && typeof d.segCacheDir === "string";
  check(
    "[T6] /api/_debug 暴露独立缩略图桶字段(thumbSegDir/thumbSegMax/thumbSegBytes)",
    hasFields,
    { thumbSegDir: d.thumbSegDir, thumbSegMax: d.thumbSegMax, segCacheDir: d.segCacheDir },
  );
  check(
    "[T6] 缩略图源段桶与播放桶物理分离(不同目录)",
    hasFields && d.thumbSegDir !== d.segCacheDir && d.thumbSegDir.length > 0,
    { thumbSegDir: d.thumbSegDir, segCacheDir: d.segCacheDir },
  );
  // 缩略图桶落在隔离 THUMB_DIR/segcache 下(不在播放缓存目录里)。
  check(
    "[T6] 缩略图桶落在 thumb_dir/segcache(隔离, 非播放缓存目录, 非生产)",
    hasFields && d.thumbSegDir.startsWith(THUMB_DIR) && !d.thumbSegDir.startsWith(PROD_THUMBS),
    { thumbSegDir: d.thumbSegDir, THUMB_DIR },
  );
  // 小硬上限 = 我们经 env 调小的值, 且明显小于播放桶上限。
  const st = await status();
  const playMax = st.buffer?.limit;
  check(
    "[T6] 缩略图桶有独立小硬上限 (= YD_THUMB_CACHE_BYTES) 且 < 播放桶上限",
    d.thumbSegMax === THUMB_CACHE_BYTES && d.thumbSegMax < playMax,
    { thumbSegMax: d.thumbSegMax, expected: THUMB_CACHE_BYTES, playMax },
  );
}

// ---- 断言 2: thumb.bytes 从独立桶读, 与 buffer.bytes 物理分开 ----
async function test_thumbbytes_decoupled() {
  const st = await status();
  const d = await dbg();
  const thumbBytes = st.thumb?.bytes;
  const bufBytes = st.buffer?.bytes;
  // 空状态: 两者都从各自桶 size 读。thumb.bytes === thumbSegBytes(独立桶 size),
  // buffer.bytes === cacheBytes(播放桶 size)。证明 thumbBytes 不再寄生在 seg_cache.size 里(#8)。
  check(
    "[T6] /api/status thumb.bytes 来自独立缩略图桶 (=thumbSegBytes), 不再混入播放桶",
    thumbBytes === d.thumbSegBytes,
    { thumbBytes, thumbSegBytes: d.thumbSegBytes },
  );
  check(
    "[T6] /api/status buffer.bytes 来自播放桶 seg_cache.size (=cacheBytes), 与 thumb 解耦",
    bufBytes === d.cacheBytes,
    { bufBytes, cacheBytes: d.cacheBytes },
  );
  // 空桶健康检查: 两个 size 都 >= 0(刚启动, 无段, 应为 0)。
  check(
    "[T6] 刚启动两桶皆空 (thumbSegBytes===0, cacheBytes===0)",
    d.thumbSegBytes === 0 && d.cacheBytes === 0,
    { thumbSegBytes: d.thumbSegBytes, cacheBytes: d.cacheBytes },
  );
}

// ---- 断言 3: 缩略图桶 segcache 目录真在盘上(物理桶, 非内存幻觉) ----
async function test_segcache_dir_on_disk() {
  const segDir = path.join(THUMB_DIR, "segcache");
  let exists = false;
  try { const s = await fs.stat(segDir); exists = s.isDirectory(); } catch { /* */ }
  check(
    "[T6] thumb_dir/segcache 目录真实建在盘上(物理桶可写)",
    exists,
    { segDir },
  );
}

async function setup() {
  TMPDIR = await fs.mkdtemp(path.join(os.tmpdir(), "yd_thumbiso_"));
  CACHE_DIR = path.join(TMPDIR, "cache");
  THUMB_DIR = path.join(TMPDIR, "thumbs");
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(THUMB_DIR, { recursive: true });
  assertIsolatedPaths();
  try { await fs.access(PROD_REQ); }
  catch { throw new Error(`缺 req.txt(${PROD_REQ}), 无法起隔离网关`); }
  startGateway();
  await waitGatewayUp();
  console.log(`[setup] isolated gateway up ${GW} (cache=${CACHE_DIR}, thumbs=${THUMB_DIR})`);
}

async function teardown() {
  killGatewayHard();
  try { if (gwChild && gwChild.pid) process.kill(-gwChild.pid, "SIGKILL"); } catch { /* */ }
  if (TMPDIR && TMPDIR.startsWith(os.tmpdir())) {
    try { await fs.rm(TMPDIR, { recursive: true, force: true }); } catch { /* */ }
    console.log(`[teardown] removed TMPDIR ${TMPDIR}`);
  }
}

async function main() {
  await setup();
  try {
    await test_separate_physical_bucket();
    await test_thumbbytes_decoupled();
    await test_segcache_dir_on_disk();
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
