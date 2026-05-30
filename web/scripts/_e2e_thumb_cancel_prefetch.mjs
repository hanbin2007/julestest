// e2e (隔离): 缩略图源段预取可取消 —— 方案 Task 5 (#6, #9)。
//
// 验证: thumb gen 的 `for u in urls` 源段预取循环每轮复查 thumb_meta[vid].state。预取进行中
// 调 /api/tasks/action {verb:cancel,kind:thumb,vid} 后, 预取必须立即停下载剩余低清源段, 而不是
// 把整批拉完才"看起来取消"。失败信号: 修复前取消后 thumb 桶源段计数继续增长到整批; 修复后停增。
// 注意: 缩略图源段物理隔离后落【独立 thumb 桶】(不进 CACHE_DIR), 故用 /api/_debug 的 thumbSegItems
// 量"已下载源段数"(thumb 桶段计数的单一真相源), 不再数 CACHE_DIR 直下文件(那恒 0 会令本测永远 SKIP)。
//
// 硬约束 [[julestest-no-prod-db-writes]]: 本脚本 *绝不* 碰生产 app.db / 生产缓存 / 生产网关 8808 /
// web 3000。隔离网关跑在 8811 + 全新 TMPDIR(--cache-dir / YD_THUMB_DIR 全指 TMPDIR)。
//   · 假 ffmpeg: TMPDIR/bin/ffmpeg = `#!/bin/sh\nexec sleep <本测试唯一随机秒数>`(挂死), 注入 PATH
//     首位; teardown 按该随机秒数精确 pkill, 绝不宽匹配误杀别的 sleep。让 gen 阶段
//     的 ffmpeg 不会瞬间结束——但本测重点在 ffmpeg 之*前*的预取期取消, 假 ffmpeg 只为防止
//     gen 提前进终态干扰观察。
//   · 用一门真实课程里源段较多的一讲, 让预取有可观察时长; 触发后立刻 cancel。
//
// 失败信号(区分"修复生效"vs"旧预取不复查 cancelled"):
//   旧代码: for u in urls 不复查 → 取消后整批源段继续下载 → thumb 桶段计数在 cancel 后仍涨。
//   修复后: 取消瞬间 return → cancel 后 settle 期内 thumb 桶段计数 *不再增长*。
//
// 前置: 需真实网络 + 一门真实课程低清 m3u8(从 /api/courses 自动挑)。无网络/无课程 → SKIP
//   (打印 SKIPPED + 退出码 3, 【不计入 ALL PASS】)。Task 5 的机器化失败信号已由
//   ydcore/test_thumb_cancel_prefetch.py 提供(纯单元,
//   桩 pri_fetch, 无网络)。本脚本是整合阶段(起网关)的端到端补强。
//
// 可重复: 每次跑全新 mkdtemp TMPDIR, teardown 杀隔离进程(只杀 8811)+ rm -rf TMPDIR + 清假 ffmpeg。

import { promises as fs } from "node:fs";
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(__filename), "..");
const ROOT = path.resolve(WEB_DIR, "..");
const PROD_REQ = "/Users/zhb/Documents/julestest/req.txt";
const PORT = 8811; // 非生产端口(8808 生产 / 8809 task_events / 8810 thumb_timeout)
const GW = `http://127.0.0.1:${PORT}`;

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
// 'sleep 600' 误杀别的进程。98000~98999 远离常见值, 也与 thumb_timeout(99xxx)区分。
const FAKE_SLEEP_SECS = 98000 + Math.floor(Math.random() * 1000);

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
  // sleep 秒数用本测试唯一随机数(FAKE_SLEEP_SECS), 便于 teardown 精确 pkill 不误杀。
  await fs.writeFile(script, `#!/bin/sh\nexec sleep ${FAKE_SLEEP_SECS}\n`, "utf-8");
  await fs.chmod(script, 0o755);
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
        PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH || ""}`,
        YD_THUMB_DIR: THUMB_DIR,
        // ffmpeg 挂死即可, 不需要超时触发(本测在 ffmpeg 之前的预取期取消)。给个大值避免干扰。
        YD_THUMB_FFMPEG_TIMEOUT: "600",
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
  // 只按【本测试唯一随机秒数】精确匹配, 绝不宽匹配 'sleep 600' 全系统误杀无关进程。
  try { execSync(`pkill -9 -f 'sleep ${FAKE_SLEEP_SECS}' 2>/dev/null || true`); } catch { /* */ }
}

// 统计【已下载的缩略图源段】数。物理隔离后(#1,#8)缩略图源段进【独立 thumb 桶】, 落盘在
// THUMB_DIR/segcache, 【绝不进 CACHE_DIR】—— 旧版数 CACHE_DIR 直下文件恒得 0, 会让本测试
// 永远 SKIP(测不到预取/取消)。改用 /api/_debug 的 thumbSegItems(thumb 桶段计数的单一真相源),
// 它是预取期源段落桶的权威计数: 预取下载源段 → 涨; 取消后预取 return → 停增。
async function thumbSrcSegCount() {
  try { return (await (await fetch(`${GW}/api/_debug`)).json()).thumbSegItems ?? 0; }
  catch { return 0; }
}

async function pickFatLesson() {
  // 挑一讲源段尽量多的(让预取有可观察时长)。结构宽松遍历同 thumb_timeout 脚本。
  let courses;
  try { courses = await (await fetch(`${GW}/api/courses`)).json(); }
  catch { return null; }
  const list = Array.isArray(courses) ? courses : (courses?.courses || courses?.list || []);
  let best = null;
  for (const c of list) {
    let detail;
    try {
      const pid = c.productId ?? c.id;
      detail = await (await fetch(`${GW}/api/course?productId=${pid}`)).json();
    } catch { continue; }
    for (const L of collectLessons(detail)) {
      if (L.videoId && L.src) {
        // 时长越长源段越多 → 预取越久越好观察。取 duration 最大的一讲。
        if (!best || (L.duration || 0) > (best.duration || 0)) best = L;
      }
    }
    if (best && (best.duration || 0) >= 1800) break; // 够长就早停
  }
  return best;
}

// 从 clarity 数组取低清 m3u8(缩略图用最低清=type 最小; 缺省回退旧字段名)。/api/course 的
// videos[] 每条带 clarity:[{type,url}], 而非 lowSrc/src —— 旧版只看 lowSrc 会一讲都挑不到 → 永远 SKIP。
function lowSrcOf(node) {
  const cl = [...(node.clarity || [])].filter((c) => c && c.url).sort((a, b) => (a.type || 0) - (b.type || 0));
  if (cl.length) return cl[0].url; // 最低清
  return node.lowSrc || node.src || node.m3u8Low || node.m3u8 || null;
}
function collectLessons(detail) {
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
  // /api/status 的缩略图态在 thumb.states 下, 形如 {vid: "gen"/"cancelled"/...}(值是字符串)。
  const states = status?.thumb?.states || {};
  return states[String(vid)] ?? states[Number(vid)] ?? null;
}

async function run() {
  const L = await pickFatLesson();
  if (!L) {
    skipped = "无网络/无可用课程, 跳过端到端 thumb 取消预取 e2e(机器化信号见 ydcore/test_thumb_cancel_prefetch.py)";
    return;
  }

  // 触发 thumb gen → 预取低清源段(同步在 worker 里跑, 落独立 thumb 桶)。
  await fetch(`${GW}/api/thumbs/batch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: [{ ...L }] }),
  });

  // 等预取真的开始下载(thumb 桶段计数 >0)再取消, 确保"取消发生在预取进行中"。
  let started = false;
  const startDeadline = Date.now() + 15000;
  while (Date.now() < startDeadline) {
    if ((await thumbSrcSegCount()) > 0) { started = true; break; }
    await sleep(200);
  }
  if (!started) {
    skipped = "预取未观察到任何源段下载(可能网络太慢/源不可达), 跳过";
    return;
  }

  const countAtCancel = await thumbSrcSegCount();
  // 取消!
  const resp = await fetch(`${GW}/api/tasks/action`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb: "cancel", kind: "thumb", vid: String(L.videoId) }),
  });
  const actRes = await resp.json().catch(() => ({}));

  // settle: 修复后取消瞬间 return, thumb 桶段计数应基本停增(给少量在途容差: 取消那刻可能有 1~2
  // 个 put 已在路上)。修复前会继续涨到整批(几十~上百段)再被 drop_vid 一次性清空——故"停增"
  // 要在【drop 之前的窗口】量: 取消后立刻多采几拍取峰值, 比"整批拉完才 drop"的旧行为低得多。
  let peakAfter = countAtCancel;
  const settleDeadline = Date.now() + 2500;
  while (Date.now() < settleDeadline) {
    peakAfter = Math.max(peakAfter, await thumbSrcSegCount());
    await sleep(250);
  }
  const grew = peakAfter - countAtCancel;

  const st = thumbStateOf(await gwStatus(), L.videoId);
  check(
    "[T5] 取消后 thumb 状态落 cancelled(网关接受取消)",
    st === "cancelled",
    { vid: L.videoId, state: st, actRes },
  );
  check(
    "[T5] 取消后源段预取停增(预取循环复查 cancelled 并 return, 不把整批拉完)",
    grew <= 2, // 容差: 取消瞬间至多 1~2 个在途 put 落地; 修复前会 +几十
    { vid: L.videoId, atCancel: countAtCancel, peakAfter, grew },
  );
}

async function setup() {
  // pre-kill: 清掉可能残留在本端口的上次崩溃实例, 防 startGateway 后误连到旧进程。
  killGatewayHard();
  TMPDIR = await fs.mkdtemp(path.join(os.tmpdir(), "yd_thumbcancel_"));
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
