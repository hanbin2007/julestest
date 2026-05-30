// e2e (隔离): ffmpeg 超时 watchdog —— 方案 Task 3 (#4, #7)。
//
// 验证: 一个挂死的 ffmpeg 不能永久占住 thumb worker / 卡死整条缩略图队列。修复后 proc.wait
// 有界(YD_THUMB_FFMPEG_TIMEOUT 秒)→ terminate/kill → 该 vid 落 thumb error(reason 含 timeout),
// 且第二个 vid 仍能被 worker 取出处理(队列没被卡死)。
//
// 硬约束 [[julestest-no-prod-db-writes]]: 本脚本 *绝不* 碰生产 app.db / 生产缓存 / 生产网关 8808 /
// web 3000。隔离网关跑在 8810 + 全新 TMPDIR(--cache-dir / YD_THUMB_DIR 全指 TMPDIR)。
//   · 假 ffmpeg: TMPDIR/bin/ffmpeg = `#!/bin/sh\nexec sleep <本测试唯一随机秒数>`(挂死), 注入 PATH
//     首位让网关挑到它; teardown 按该随机秒数精确 pkill, 绝不宽匹配误杀别的 sleep。
//   · YD_THUMB_FFMPEG_TIMEOUT=3 让超时快速触发(默认 120s 太长)。
//
// 失败信号(区分"修复生效"vs"旧 proc.wait() 无超时"):
//   旧代码: 假 ffmpeg 挂死 → _gen_thumbs_inner 永久卡住 worker → vid 永远停在 'gen',
//           第二个 vid 也排不上 → 断言在 (timeout+余量) 内拿不到 'error' = FAIL。
//   修复后: 超时 terminate → vid='error' reason 含 'timeout' → 第二个 vid 也能被处理。
//
// 前置: 需要真实网络 + 一门真实课程的低清 m3u8(从 /api/courses 自动挑第一讲), 因为 thumb gen
//   要先取 m3u8 学分片。无网络/无课程时本脚本会 SKIP(打印 SKIPPED + 退出码 3, 【不计入 ALL PASS】,
//   避免无网络时混进绿)——它是给
//   "整合阶段(起网关+web)"跑的端到端补强; Task 3 的机器化失败信号已由 ydcore/test_thumb_timeout.py
//   提供(纯单元, 假 ffmpeg, 无网络)。
//
// 可重复: 每次跑全新 mkdtemp TMPDIR, teardown 杀隔离进程(只杀 8810)+ rm -rf TMPDIR + 清假 ffmpeg 子进程。

import { promises as fs } from "node:fs";
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(__filename), "..");
const ROOT = path.resolve(WEB_DIR, "..");
const PROD_REQ = "/Users/zhb/Documents/julestest/req.txt";
const PORT = 8810; // 非生产端口(8808 生产 / 8809 被 task_events 隔离脚本用)
const GW = `http://127.0.0.1:${PORT}`;
const FFMPEG_TIMEOUT_S = 3;

const PROD_DB = "/Users/zhb/.youdao_course/app.db";
const PROD_CACHE = "/Users/zhb/.youdao_course/cache";
const PROD_THUMBS = "/Users/zhb/.youdao_course/thumbs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let skipped = null; // 非 null 则全程 SKIP(退出码 3, 不计入 ALL PASS)
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
}

let gwChild = null;
let TMPDIR = "";
let CACHE_DIR = "";
let THUMB_DIR = "";
let BIN_DIR = "";
// 假 ffmpeg 用一个【本测试唯一】的随机 sleep 秒数: teardown 按该数精确 pkill, 绝不宽匹配
// 'sleep 600' 误杀别的进程(全系统宽匹配会误伤无关 sleep)。99000~99999 远离常见值。
const FAKE_SLEEP_SECS = 99000 + Math.floor(Math.random() * 1000);

function assertIsolatedPaths() {
  for (const p of [TMPDIR, CACHE_DIR, THUMB_DIR, BIN_DIR]) {
    if (!p.startsWith(TMPDIR)) throw new Error(`隔离路径越界: ${p}`);
  }
  for (const prod of [PROD_DB, PROD_CACHE, PROD_THUMBS]) {
    if (CACHE_DIR === prod || THUMB_DIR === prod) throw new Error(`隔离路径撞生产: ${prod}`);
  }
  if (PORT === 8808) throw new Error("端口撞生产 8808");
}

async function installFakeFfmpeg() {
  BIN_DIR = path.join(TMPDIR, "bin");
  await fs.mkdir(BIN_DIR, { recursive: true });
  const script = path.join(BIN_DIR, "ffmpeg");
  // exec sleep: 让 sleep 替换 shell, terminate(proc) 直接命中 sleep, 不留孤儿。
  // sleep 秒数用本测试唯一随机数(FAKE_SLEEP_SECS), 便于 teardown 精确 pkill 不误杀。
  await fs.writeFile(script, `#!/bin/sh\nexec sleep ${FAKE_SLEEP_SECS}\n`, "utf-8");
  await fs.chmod(script, 0o755);
}

function startGateway() {
  // PATH 首位放假 ffmpeg; YD_THUMB_FFMPEG_TIMEOUT 调小; YD_THUMB_DIR 重定向缩略图到 TMPDIR。
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
        PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH || ""}`,
        YD_THUMB_DIR: THUMB_DIR,
        YD_THUMB_FFMPEG_TIMEOUT: String(FFMPEG_TIMEOUT_S),
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
      if (r.ok) {
        const d = await r.json();
        // 防误连外来网关(尤其生产): segCacheDir 必须落在本测试 TMPDIR 下, 否则硬失败。
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
  try { return execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null`).toString().trim(); }
  catch { return ""; }
}
function killGatewayHard() {
  const pid = gatewayPid();
  if (pid) for (const p of pid.split(/\s+/)) { try { execSync(`kill -9 ${p}`); } catch { /* */ } }
  for (let i = 0; i < 20; i++) { if (!gatewayPid()) return; try { execSync("sleep 0.3"); } catch { /* */ } }
}
function killOrphanFfmpegSleeps() {
  // 清理假 ffmpeg 的 sleep 子进程(若有残留)。只按【本测试唯一随机秒数】精确匹配, 绝不宽匹配
  // 'sleep 600' 全系统误杀无关进程(别的工具也可能 sleep 某常见值)。
  try { execSync(`pkill -9 -f 'sleep ${FAKE_SLEEP_SECS}' 2>/dev/null || true`); } catch { /* */ }
}

// 从生产 /api/courses 自动挑两讲(videoId/contentId/cardPackageId/productId/src), 给 thumb gen 用。
// 取【时长最短】的两讲: thumb gen 在 ffmpeg 前要先把低清源段整批预取下来(无法绕过), 时长越短
// 源段越少、预取越快, 才能在合理窗口内走到 ffmpeg → 触发超时 watchdog(本测的真正被测对象)。
async function pickTwoLessons() {
  let courses;
  try { courses = await (await fetch(`${GW}/api/courses`)).json(); }
  catch { return null; }
  const list = Array.isArray(courses) ? courses : (courses?.courses || courses?.list || []);
  const all = [];
  for (const c of list) {
    let detail;
    try {
      const pid = c.productId ?? c.id;
      detail = await (await fetch(`${GW}/api/course?productId=${pid}`)).json();
    } catch { continue; }
    for (const L of collectLessons(detail)) {
      if (L.videoId && L.src) all.push(L);
    }
    if (all.length >= 6) break; // 够挑了, 不必拉完所有课
  }
  if (all.length === 0) return null;
  all.sort((a, b) => (a.duration || 0) - (b.duration || 0)); // 最短优先
  return all.slice(0, 2);
}

// 从 clarity 数组取低清 m3u8(缩略图用最低清=type 最小; 缺省回退旧字段名)。/api/course 的
// videos[] 每条带 clarity:[{type,url}], 而非 lowSrc/src —— 旧版只看 lowSrc 会一讲都挑不到 → 永远 SKIP。
function lowSrcOf(node) {
  const cl = [...(node.clarity || [])].filter((c) => c && c.url).sort((a, b) => (a.type || 0) - (b.type || 0));
  if (cl.length) return cl[0].url; // 最低清
  return node.lowSrc || node.src || node.m3u8Low || node.m3u8 || null;
}
function collectLessons(detail) {
  // 课程结构可能嵌套(cards/lessons/videos); 宽松遍历, 凑齐 thumb 入参字段即可。
  const out = [];
  const walk = (node, ctx) => {
    if (!node || typeof node !== "object") return;
    const productId = node.productId ?? ctx.productId;
    const cardPackageId = node.cardPackageId ?? ctx.cardPackageId;
    const contentId = node.contentId ?? ctx.contentId;
    const videoId = node.videoId;
    const src = lowSrcOf(node);
    if (videoId && (productId != null) && (contentId != null) && (cardPackageId != null) && src) {
      out.push({ videoId, contentId, cardPackageId, productId, src, duration: node.duration || 600 });
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((x) => walk(x, { productId, cardPackageId, contentId }));
      else if (v && typeof v === "object") walk(v, { productId, cardPackageId, contentId });
    }
  };
  walk(detail, {});
  return out;
}

async function gwStatus() {
  try { return await (await fetch(`${GW}/api/status`)).json(); } catch { return {}; }
}
function thumbStateOf(status, vid) {
  // /api/status 的缩略图态在 thumb.states 下, 形如 {vid: "gen"/"ready"/"error"}(值是字符串)。
  const states = status?.thumb?.states || {};
  return states[String(vid)] ?? states[Number(vid)] ?? null;
}

async function run() {
  const lessons = await pickTwoLessons();
  if (!lessons) {
    skipped = "无网络/无可用课程, 跳过端到端 thumb 超时 e2e(机器化信号见 ydcore/test_thumb_timeout.py)";
    return;
  }
  const L1 = lessons[0];
  const L2 = lessons[1] || lessons[0];

  // 触发 vid1 的 thumb gen(假 ffmpeg 会挂死)。
  await fetch(`${GW}/api/thumbs/batch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: [{ ...L1 }] }),
  });
  // 稍后再触发 vid2(验证队列没被 vid1 卡死)。
  if (L2.videoId !== L1.videoId) {
    await fetch(`${GW}/api/thumbs/batch`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: [{ ...L2 }] }),
    });
  }

  // 等 vid1 走到 error。注意: thumb gen 在 ffmpeg 之前要先【整批预取低清源段】(无法绕过, 见
  // ydcore/_gen_thumbs_inner), 时长几分钟的一讲预取就要几十秒~150s, 之后 ffmpeg 才启动并在
  // FFMPEG_TIMEOUT_S 后被 watchdog 砍掉。故窗口给足(预取上限 + 超时 + terminate + 调度余量),
  // 否则会误判"没超时"(其实只是还没预取完, ffmpeg 没启动)。本测就是要确认 watchdog 真把
  // 挂死的 ffmpeg 砍掉、释放 worker —— 慢是真实代价, 机器化快信号见单元 test_thumb_timeout.py。
  const PREFETCH_BUDGET_MS = 180000; // 预取整批低清源段的上限预算(最短一讲也可能上百段)
  const deadline = Date.now() + PREFETCH_BUDGET_MS + (FFMPEG_TIMEOUT_S + 15) * 1000;
  let s1 = null;
  while (Date.now() < deadline) {
    s1 = thumbStateOf(await gwStatus(), L1.videoId);
    if (s1 === "error") break;
    await sleep(1000);
  }
  check(
    "[T3] 挂死 ffmpeg 超时后 vid1 落 thumb error(watchdog 砍掉挂死 ffmpeg, worker 被释放非永久 gen)",
    s1 === "error",
    { vid1: L1.videoId, state: s1, timeoutS: FFMPEG_TIMEOUT_S },
  );

  // 队列未被卡死: vid1 的 worker 被释放后, vid2 必被取出处理 → 进入 'gen'(开始预取/生成)。
  // 只需断言"被取出"(gen), 不必再等 vid2 跑完整条预取+超时(那会再耗一两分钟): 它若饿死会停在
  // queued / null。worker 被卡死的旧 bug 下 vid2 永远排不上 → 此断言变红。
  let s2 = null;
  if (L2.videoId !== L1.videoId) {
    const d2 = Date.now() + 20000; // vid1 已 error 释放 worker, vid2 应很快被取出转 gen
    while (Date.now() < d2) {
      s2 = thumbStateOf(await gwStatus(), L2.videoId);
      if (s2 === "gen" || s2 === "error" || s2 === "ready") break;
      await sleep(800);
    }
    check(
      "[T3] 队列未被卡死: vid1 释放 worker 后第二个 vid 被取出处理(gen/终态), 非饿死在 queued/null",
      s2 === "gen" || s2 === "error" || s2 === "ready",
      { vid2: L2.videoId, state: s2 },
    );
  } else {
    check("[T3] 仅一讲可用, 跳过队列不卡死断言", true, { onlyOne: true });
  }
}

async function setup() {
  // pre-kill: 清掉可能残留在本端口的上次崩溃实例, 防 startGateway 后误连到旧进程。
  killGatewayHard();
  TMPDIR = await fs.mkdtemp(path.join(os.tmpdir(), "yd_thumbto_"));
  CACHE_DIR = path.join(TMPDIR, "cache");
  THUMB_DIR = path.join(TMPDIR, "thumbs");
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(THUMB_DIR, { recursive: true });
  await installFakeFfmpeg();
  assertIsolatedPaths();
  try { await fs.access(PROD_REQ); }
  catch { throw new Error(`缺 req.txt(${PROD_REQ})`); }
  startGateway();
  await waitGatewayUp();
  console.log(`[setup] isolated gateway up ${GW} (cache=${CACHE_DIR}, fakeffmpeg=${BIN_DIR})`);
}

async function teardown() {
  killGatewayHard();
  try { if (gwChild && gwChild.pid) process.kill(-gwChild.pid, "SIGKILL"); } catch { /* */ }
  killOrphanFfmpegSleeps();
  if (TMPDIR && TMPDIR.startsWith(os.tmpdir())) {
    try { await fs.rm(TMPDIR, { recursive: true, force: true }); } catch { /* */ }
    console.log(`[teardown] removed TMPDIR ${TMPDIR}`);
  }
}

async function main() {
  await setup();
  try { await run(); } finally { await teardown(); }
  if (skipped) {
    console.log(`\nSKIPPED: ${skipped}`);
    console.log("ALL PASS: false (SKIP 不计入 PASS)");
    process.exit(3); // 非 0 退出码: SKIP 绝不混进 ALL PASS 绿
  }
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
