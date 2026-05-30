// e2e (隔离, 真实路径): 缩略图源段物理隔离 (#1,#8) —— Task 6。
//
// 治本主张: 缩略图源段(低清流, t_<vid> 键)从此进【独立小桶 thumb_seg_cache】, 不再和
// 256MB 播放桶 seg_cache 抢容量。物理隔离是唯一能真正限界"生成 D 缩略图把已缓存(但当前没
// 在看)的 A/B/C 播放段挤出"的手段(保护窗口覆盖不到任意已缓存段)。生成完即 drop_vid 释放。
//
// === 旧脚本为何失效, 本次治本 ===
// 旧版只对【空网关】做 /api/_debug 结构断言(thumbSegDir 存在/不等于 segCacheDir)。这是 vacuous
// 失败信号: 把 _seg_cache_for 改成恒返 seg_cache(路由退化成单桶)后, /api/_debug 的两个目录
// 字段仍齐全、仍不相等 → 旧断言照样全绿, 根本测不到"缩略图段会不会挤出播放段"。
// 本次改成走【真实路径】(借 _e2e_thumb_cancel_prefetch 同款隔离网关 + 真课程 + /api/thumbs/batch
// 真驱动生成), 让失败信号机器可分:
//   (a) buffer A(/B/C 串行排队)拿到盘上播放段 → 生成 D 缩略图 → 源段必须落【thumb 桶】
//       (thumbSegItems 涨), 而播放桶【一片不增】(cacheItems 不涨)、A/B/C 的 cached【一片不掉】。
//       失败信号: 路由退化成单桶时, 缩略图源段灌进 seg_cache → cacheItems 暴涨 + thumbSegItems
//       恒 0, 且小播放桶被源段挤爆把 A/B/C 逐出 → vidReal 掉 → 本断言变红。
//   (b) 生成(此处用 cancel 触发 _gen_thumbs 的 finally→drop_vid 终态路径, 与"生成完"同一释放点)
//       后 thumb 源段被 drop_vid 释放 → thumbSegItems 回 0。失败信号: 不 drop 则源段常驻 → 红。
//
// 段级"挤出"不变量另由 ydcore/test_thumb_isolation.py(纯单元, 含 negative control: 把 thumb 段
// 塞回 seg_cache 会把 A 播放段从 10 挤到 0)精确机器断言; 本 e2e 是整合阶段(真起网关)的端到端补强。
//
// 硬约束 [[julestest-no-prod-db-writes]]: 绝不碰生产 app.db / 生产缓存 / 生产 8808 / 生产 thumbs。
//   全部状态进全新 TMPDIR; 网关端口 8812(非 8808/8809/8810/8811); thumbs 经 YD_THUMB_DIR 重定向。
//   播放桶 --cache-mb 与缩略图桶 YD_THUMB_CACHE_BYTES 都调小, 让"单桶退化会挤爆"成立(失败信号)。
//   setup 先 pre-kill 残留 8812; waitGatewayUp 校验 /api/_debug 的 segCacheDir 落在本 TMPDIR(防误连)。
//
// 前置: 需真实网络 + 一门真实课程(从 /api/courses 自动挑) + 本机有 ffmpeg。任一缺失 → SKIP,
//   SKIP 走【退出码 3 + 显式 SKIPPED 打印】, *不计入 ALL PASS*(避免无网络时混进绿)。
//
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
const PORT = 8812; // 非生产 8808 / 8809(task_events) / 8810(thumb_timeout) / 8811(thumb_cancel)
const GW = `http://127.0.0.1:${PORT}`;
const THUMB_CACHE_BYTES = 64 * 1024 * 1024; // 缩略图桶: 够放完整一讲低清源段(顺序读), 生成完 drop。
const PLAY_CACHE_MB = 16; // 播放桶调小: 单桶退化时缩略图源段会把 A/B/C 挤爆(失败信号)。

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
      "--cache-dir", CACHE_DIR, "--no-prefetch", "--cache-mb", String(PLAY_CACHE_MB),
      "--log-level", "WARNING"],
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
      if (r.ok) {
        const d = await r.json();
        // 防误连外来网关: segCacheDir 必须落在本 TMPDIR 下, 否则我们连到了别的(可能生产)实例。
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

// ---- 课程发现: 挑一门有 >=4 讲(各有 clarity m3u8)的课, A/B/C 缓冲 + D 生成缩略图 ----
function srcOf(v, highest) {
  const cl = [...(v.clarity || [])].filter((c) => c && c.url).sort((a, b) => (a.type || 0) - (b.type || 0));
  if (!cl.length) return null;
  return (highest ? cl[cl.length - 1] : cl[0]).url; // highest=播放档; lowest=缩略图档
}
function mkVideo(v, highest) {
  const src = srcOf(v, highest);
  if (!src || v.videoId == null || v.contentId == null || v.cardPackageId == null || v.productId == null) {
    return null;
  }
  return {
    videoId: v.videoId, contentId: v.contentId, cardPackageId: v.cardPackageId,
    productId: v.productId, src, duration: v.duration || 600,
  };
}
async function pickCourse() {
  let courses;
  try { courses = await (await fetch(`${GW}/api/courses`)).json(); }
  catch { return null; }
  const list = Array.isArray(courses) ? courses : (courses?.courses || courses?.list || []);
  for (const c of list) {
    const pid = c.productId ?? c.id;
    let detail;
    try { detail = await (await fetch(`${GW}/api/course?productId=${pid}`)).json(); }
    catch { continue; }
    const vids = (detail?.videos || []).filter((v) => srcOf(v, true) && srcOf(v, false));
    if (vids.length >= 4) {
      const abc = vids.slice(0, 3).map((v) => mkVideo(v, true)).filter(Boolean);
      const d = mkVideo(vids[3], false);
      if (abc.length === 3 && d) return { abc, d };
    }
  }
  return null;
}

// 按 vid 取盘上播放段真相(磁盘真相, 单一真相源)。
function vidRealOf(d) { return d.vidReal || {}; }
function thumbStateOf(st, vid) {
  return (st?.thumb?.states || {})[String(vid)] ?? null;
}

async function run() {
  // 前置 1: ffmpeg(start_thumbs 无 ffmpeg 直接 error, 测不到源段路由)。
  const st0 = await status();
  if (!st0.ffmpeg) {
    skipped = "本机无 ffmpeg, 跳过真实路径缩略图隔离 e2e(段级不变量见 ydcore/test_thumb_isolation.py)";
    return;
  }
  // 前置 2: 网络 + 课程。
  const picked = await pickCourse();
  if (!picked) {
    skipped = "无网络/无可用课程(需 >=4 讲带 clarity), 跳过(段级不变量见 ydcore/test_thumb_isolation.py)";
    return;
  }
  const { abc, d: D } = picked;

  // --- 缓冲 A/B/C(串行 worker: A 先 working, B/C queued)。让 A 累积盘上播放段。 ---
  await fetch(`${GW}/api/buffer/batch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: abc }),
  });
  // 等到至少有一讲拿到 >=3 段盘上(确保有"已缓存播放段"可被挤出, 否则失败信号无意义)。
  let cachedSnap = {};
  const bufDeadline = Date.now() + 30000;
  while (Date.now() < bufDeadline) {
    const real = vidRealOf(await dbg());
    const withSegs = Object.entries(real).filter(([, n]) => (n || 0) >= 3);
    if (withSegs.length >= 1) { cachedSnap = Object.fromEntries(withSegs); break; }
    await sleep(1000);
  }
  if (Object.keys(cachedSnap).length === 0) {
    skipped = "缓冲未观察到任何盘上播放段(网络太慢/源不可达), 跳过";
    return;
  }
  // 取消 A/B/C 缓冲(停掉 worker churn, 让 vidReal 稳定, 排除"缓冲自身 LRU 抖动"噪声)。
  // 取消后段不再受 protect, 单桶退化时正好能被缩略图源段挤出(这正是要测的失败信号)。
  for (const v of abc) {
    await fetch(`${GW}/api/tasks/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verb: "cancel", kind: "buffer", vid: String(v.videoId) }),
    });
  }
  await sleep(1500);
  const beforeDbg = await dbg();
  const beforeReal = vidRealOf(beforeDbg);
  // 快照: 缓冲到盘上的播放段集合(取消后稳定值)。
  cachedSnap = {};
  for (const [vid, n] of Object.entries(beforeReal)) if ((n || 0) > 0) cachedSnap[vid] = n;
  const cacheItemsBefore = beforeDbg.cacheItems;
  const thumbSegBefore = beforeDbg.thumbSegItems;

  // --- 触发 D 缩略图生成 → 源段预取(进 thumb 桶, 经 _seg_cache_for 路由)。 ---
  await fetch(`${GW}/api/thumbs/batch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: [D] }),
  });
  // 等缩略图源段真的开始落桶(thumbSegItems 涨), 期间持续观察播放桶/A-B-C 有没有被动。
  let routed = false;
  let peakThumbSeg = thumbSegBefore;
  let maxCacheItems = cacheItemsBefore;
  let minRealDuringGen = { ...cachedSnap };
  const genDeadline = Date.now() + 30000;
  while (Date.now() < genDeadline) {
    const d2 = await dbg();
    peakThumbSeg = Math.max(peakThumbSeg, d2.thumbSegItems);
    maxCacheItems = Math.max(maxCacheItems, d2.cacheItems);
    const real2 = vidRealOf(d2);
    for (const vid of Object.keys(minRealDuringGen)) {
      minRealDuringGen[vid] = Math.min(minRealDuringGen[vid], real2[vid] || 0);
    }
    if (d2.thumbSegItems >= 3) { routed = true; }
    if (routed && d2.thumbSegItems >= 5) break; // 已稳稳证明源段进 thumb 桶
    await sleep(1000);
  }

  // 断言 (a1): 缩略图源段进【独立 thumb 桶】(thumbSegItems 涨), 播放桶【一片不增】(cacheItems 不涨)。
  //   失败信号: 单桶退化时源段灌进 seg_cache → cacheItems 暴涨 + thumbSegItems 恒 0。
  check(
    "[T6真实] 缩略图源段落独立 thumb 桶(thumbSegItems 涨), 播放桶 cacheItems 一片不增",
    routed && peakThumbSeg >= 3 && maxCacheItems <= cacheItemsBefore,
    { thumbSegBefore, peakThumbSeg, cacheItemsBefore, maxCacheItemsDuringGen: maxCacheItems },
  );

  // 断言 (a2): A/B/C 已缓存的播放段【一片不掉】(单桶退化会把小播放桶挤爆逐出 → vidReal 掉)。
  const dropped = Object.entries(minRealDuringGen).filter(([vid, n]) => n < cachedSnap[vid]);
  check(
    "[T6真实] 生成缩略图期间 A/B/C 已缓存播放段一片不掉(物理隔离, 缩略图不挤播放桶)",
    dropped.length === 0,
    { cachedSnap, minRealDuringGen, dropped: dropped.map(([v, n]) => ({ vid: v, was: cachedSnap[v], min: n })) },
  );

  // --- 断言 (b): 生成结束(此处 cancel 触发 _gen_thumbs finally→drop_vid)后源段被释放。 ---
  await fetch(`${GW}/api/tasks/action`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb: "cancel", kind: "thumb", vid: String(D.videoId) }),
  });
  let dropOk = false;
  let finalState = null;
  let finalThumbSeg = peakThumbSeg;
  const dropDeadline = Date.now() + 25000;
  while (Date.now() < dropDeadline) {
    const d3 = await dbg();
    finalThumbSeg = d3.thumbSegItems;
    finalState = thumbStateOf(await status(), D.videoId);
    if (d3.thumbSegItems === 0 && (finalState === "cancelled" || finalState === "error" || finalState === "ready")) {
      dropOk = true; break;
    }
    await sleep(1000);
  }
  check(
    "[T6真实] 生成终态后 thumb 源段被 drop_vid 释放(thumbSegItems 回 0, 不留尾巴)",
    dropOk && finalThumbSeg === 0,
    { finalThumbSeg, finalState, peakThumbSeg },
  );

  // 收尾断言: 释放源段不该回头碰播放桶 —— cacheItems 全程没动, A/B/C 仍在。
  const afterDbg = await dbg();
  const afterReal = vidRealOf(afterDbg);
  const stillThere = Object.keys(cachedSnap).every((vid) => (afterReal[vid] || 0) >= cachedSnap[vid]);
  check(
    "[T6真实] 全程播放桶未被缩略图触碰(cacheItems 不增 + A/B/C 段仍在), 双桶物理解耦",
    afterDbg.cacheItems <= cacheItemsBefore && stillThere,
    { cacheItemsBefore, cacheItemsAfter: afterDbg.cacheItems, cachedSnap, afterReal },
  );
}

async function setup() {
  // pre-kill: 杀掉可能残留的本端口网关(上次崩溃没清干净), 防误连到旧实例。
  killGatewayHard();
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
    await run();
  } finally {
    await teardown();
  }
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
