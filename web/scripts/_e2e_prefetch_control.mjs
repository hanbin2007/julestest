#!/usr/bin/env node
// e2e: 预缓存(prefetch / 自动)控制 — pause/resume/cancel + 全局后台开关 + kill-9 跨重启持久化。
//
// 完全隔离: 自起一个本地 origin HTTP 服务(假 m3u8 + 假 .ts 段),自起一个网关进程
// (隔离端口 + 隔离 cache 目录 + 隔离 THUMB_DIR),从不碰生产 8808/3000 或生产缓存目录。
//
// 断言(每步都有明确 PASS/FAIL,失败 process.exit(1)):
//   1. /api/play 触发 prefetch -> 缓存段数增长。
//   2. pause prefetch  -> 段数稳定不再涨(worker idle 不前进、也不退出)。
//   3. resume prefetch -> 段数继续涨(无需重新 /api/play)。
//   4. cancel prefetch -> 段数停。
//   5. 全局 /api/bg/pause {paused:true} -> 一个新讲的 prefetch 不前进; /api/status.bgPaused=true。
//      取消全局暂停后段数恢复增长。
//   6. kill -9(暂停态)-> 重启 -> pf_control 仍为 paused(act_prefetch resume 才能ok=true 证明)。
//
// 可重复运行: 每次跑前清掉自己的临时目录。两连跑都该 PASS。

import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", ".."); // worktree 根

// ---- 隔离参数 -------------------------------------------------------------
const GW_PORT = 18841; // 隔离网关端口(绝不是生产 8808)
const ORIGIN_PORT = 18851; // 本地假 origin 端口
const TMP = path.join(os.tmpdir(), "yd_e2e_prefetch_control");
const CACHE_DIR = path.join(TMP, "cache");
const THUMB_DIR = path.join(TMP, "thumbs");
const REQ_FILE = path.join(TMP, "req.txt");

const N_SEGS = 40; // 假整集分片数;给 pause 留出"还没下完"的窗口
const SEG_BYTES = 4096;

let failed = 0;
function pass(msg) { console.log("PASS: " + msg); }
function fail(msg) { console.error("FAIL: " + msg); failed += 1; }
function ok(cond, msg) { cond ? pass(msg) : fail(msg); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 清理 + 准备隔离目录 --------------------------------------------------
function freshTmp() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  // 最小 req.txt: parse_request 只需要请求行 + Host(派生 url)。不触发任何真实网络。
  fs.writeFileSync(
    REQ_FILE,
    "GET /test.m3u8 HTTP/1.1\nHost: 127.0.0.1:" + ORIGIN_PORT + "\nUrl: http://127.0.0.1:" +
      ORIGIN_PORT + "/test.m3u8\n\n",
  );
}

// ---- 本地假 origin: m3u8 + 假 .ts 段(每段下载前小睡, 让 pause 有可观测窗口) ----
function startOrigin() {
  const segLine = (i) => "seg" + i + ".ts";
  const m3u8 = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:10",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ]
    .concat(
      Array.from({ length: N_SEGS }, (_, i) => "#EXTINF:10.0,\n" + segLine(i)),
    )
    .concat(["#EXT-X-ENDLIST"])
    .join("\n");
  const srv = http.createServer(async (req, res) => {
    const u = req.url || "";
    if (u.startsWith("/test.m3u8")) {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(m3u8);
      return;
    }
    if (/\/seg\d+\.ts/.test(u)) {
      // 每个段下载有意小睡, 让预缓存推进可观测、pause 窗口稳定。
      await sleep(120);
      res.writeHead(200, { "Content-Type": "video/mp2t" });
      res.end(Buffer.alloc(SEG_BYTES, 1));
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  return new Promise((resolve) => srv.listen(ORIGIN_PORT, "127.0.0.1", () => resolve(srv)));
}

// ---- 启动隔离网关进程 -----------------------------------------------------
function startGateway() {
  const env = {
    ...process.env,
    YD_THUMB_DIR: THUMB_DIR, // 隔离缩略图目录(绝不写生产 ~/.youdao_course/thumbs)
    YD_THUMB_CACHE_BYTES: String(8 * 1024 * 1024),
  };
  const args = [
    "youdao_course.py",
    "serve",
    "-r",
    REQ_FILE,
    "--port",
    String(GW_PORT),
    "--cache-dir",
    CACHE_DIR,
    "--cache-mb",
    "64",
  ];
  const proc = spawn("python3", args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  return proc;
}

async function waitGatewayUp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await get("/api/status");
      if (r.status === 200) return true;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

// ---- HTTP 助手 ------------------------------------------------------------
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      { host: "127.0.0.1", port: GW_PORT, path: p, method, headers: data
          ? { "Content-Type": "application/json", "Content-Length": data.length }
          : {} },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (_) { /* non-json */ }
          resolve({ status: res.statusCode, json, raw: buf });
        });
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p) => req("GET", p, null);
const post = (p, body) => req("POST", p, body);

const PLAY_COMMON = "contentId=1&cardPackageId=1&productId=1";
function playUrl(vid) {
  const m = encodeURIComponent("http://127.0.0.1:" + ORIGIN_PORT + "/test.m3u8");
  return `/api/play?videoId=${vid}&${PLAY_COMMON}&m3u8=${m}`;
}

async function cachedCount(vid) {
  const r = await get("/api/_debug");
  const vr = (r.json && r.json.vidReal) || {};
  return vr[String(vid)] || 0;
}

// 在 maxMs 内等待 cachedCount 至少达到 want; 返回最终值。
async function waitGrow(vid, want, maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await cachedCount(vid);
    if (last >= want) return last;
    await sleep(150);
  }
  return last;
}

// 采样一段时间内是否"稳定不再增长"(预缓存被暂停的标志)。
async function isStable(vid, windowMs = 1800) {
  const start = await cachedCount(vid);
  await sleep(windowMs);
  const end = await cachedCount(vid);
  return { stable: end === start, start, end };
}

let originSrv = null;
let gw = null;

function killGw(signal) {
  if (gw && !gw.killed) {
    try { process.kill(gw.pid, signal); } catch (_) { /* already gone */ }
  }
}

async function main() {
  freshTmp();
  originSrv = await startOrigin();

  // ===== 启动网关 =====
  gw = startGateway();
  if (!(await waitGatewayUp())) {
    fail("网关未能在隔离端口 " + GW_PORT + " 起来");
    return finish();
  }
  pass("隔离网关已起 port=" + GW_PORT + " cacheDir=" + CACHE_DIR);

  const VID = 700001;

  // ===== 1. play 触发 prefetch -> 段数增长 =====
  await get(playUrl(VID));
  const grew = await waitGrow(VID, 3, 8000);
  ok(grew >= 3, "play 触发预缓存, 段数增长到 " + grew + " (>=3)");

  // ===== 2. pause -> 段数稳定 =====
  const pauseRes = await post("/api/tasks/action", { kind: "prefetch", verb: "pause", vid: VID });
  ok(pauseRes.status === 200 && pauseRes.json && pauseRes.json.ok === true &&
       pauseRes.json.state === "paused" && pauseRes.json.kind === "prefetch",
     "pause prefetch 返回 ok+state=paused: " + JSON.stringify(pauseRes.json));
  await sleep(400); // 让 worker 复查到 paused 收手(下载中那一片可能还落 1 个)
  const s2 = await isStable(VID, 1800);
  ok(s2.stable, "pause 后段数稳定不再涨 (start=" + s2.start + " end=" + s2.end + ")");
  const pausedAt = s2.end;

  // ===== 3. resume -> 段数继续涨(无需重新 /api/play) =====
  const resumeRes = await post("/api/tasks/action", { kind: "prefetch", verb: "resume", vid: VID });
  ok(resumeRes.status === 200 && resumeRes.json && resumeRes.json.ok === true &&
       resumeRes.json.state === "running",
     "resume prefetch 返回 ok+state=running: " + JSON.stringify(resumeRes.json));
  const after = await waitGrow(VID, pausedAt + 2, 8000);
  ok(after >= pausedAt + 2, "resume 后段数继续增长 " + pausedAt + " -> " + after + " (无需重新 play)");

  // ===== 4. cancel -> 段数停 =====
  const cancelRes = await post("/api/tasks/action", { kind: "prefetch", verb: "cancel", vid: VID });
  ok(cancelRes.status === 200 && cancelRes.json && cancelRes.json.ok === true &&
       cancelRes.json.state === "cancelled",
     "cancel prefetch 返回 ok+state=cancelled: " + JSON.stringify(cancelRes.json));
  await sleep(500);
  const s4 = await isStable(VID, 1800);
  ok(s4.stable, "cancel 后段数停 (start=" + s4.start + " end=" + s4.end + ")");

  // ===== 5. 全局后台开关 =====
  const VID2 = 700002;
  const bgOn = await post("/api/bg/pause", { paused: true });
  ok(bgOn.status === 200 && bgOn.json && bgOn.json.ok === true && bgOn.json.paused === true,
     "POST /api/bg/pause {paused:true} -> {ok,paused:true}: " + JSON.stringify(bgOn.json));
  const st = await get("/api/status");
  ok(st.json && st.json.bgPaused === true, "/api/status.bgPaused=true");
  await get(playUrl(VID2)); // 全局暂停下触发新讲 prefetch
  const s5 = await isStable(VID2, 2200); // 全局暂停: 不应推进
  ok(s5.stable && s5.end === 0,
     "全局暂停下新讲预缓存不前进 (cached=" + s5.end + ")");
  const bgOff = await post("/api/bg/pause", { paused: false });
  ok(bgOff.status === 200 && bgOff.json && bgOff.json.paused === false,
     "POST /api/bg/pause {paused:false} 关闭全局暂停");
  const g5 = await waitGrow(VID2, 3, 8000);
  ok(g5 >= 3, "取消全局暂停后该讲预缓存恢复增长到 " + g5);
  const st2 = await get("/api/status");
  ok(st2.json && st2.json.bgPaused === false, "/api/status.bgPaused=false (恢复后)");

  // ===== 6. kill -9 (暂停态) -> 重启 -> pf_control 仍 paused =====
  const VID3 = 700003;
  await get(playUrl(VID3));
  await waitGrow(VID3, 2, 8000);
  const p6 = await post("/api/tasks/action", { kind: "prefetch", verb: "pause", vid: VID3 });
  ok(p6.json && p6.json.ok === true && p6.json.state === "paused", "暂停 VID3 prefetch 以便 kill 测持久化");
  await sleep(500);

  // 硬杀(SIGKILL): 模拟崩溃, 不走优雅退出落盘路径。pf_control.json 必须在 act 时已落盘。
  killGw("SIGKILL");
  await sleep(1000);

  // pf_control.json 应已落在隔离 cache 目录
  const pfPath = path.join(CACHE_DIR, "pf_control.json");
  ok(fs.existsSync(pfPath), "pf_control.json 已落盘到隔离 cache 目录");
  if (fs.existsSync(pfPath)) {
    const disk = JSON.parse(fs.readFileSync(pfPath, "utf-8"));
    ok(disk[String(VID3)] === "paused",
       "kill -9 前 pf_control.json 磁盘内容 VID3=paused: " + JSON.stringify(disk));
  }

  // 重启网关(同隔离端口 + 同 cache 目录)
  gw = startGateway();
  if (!(await waitGatewayUp())) {
    fail("重启后网关未能起来");
    return finish();
  }
  pass("kill -9 后网关重启成功");

  // 验证: 重启后 pf_control 仍为 paused。判据: resume 能成功(ok=true,state=running)
  // 说明回载到的状态正是 paused(running 态 resume 会 ok=false / 是 no-op)。
  // 直接再 pause 一个 running 的会 ok=true; 所以用 resume 区分。
  const resumeAfter = await post("/api/tasks/action", { kind: "prefetch", verb: "resume", vid: VID3 });
  ok(resumeAfter.json && resumeAfter.json.ok === true && resumeAfter.json.state === "running",
     "重启后 resume VID3 ok (证明回载状态=paused): " + JSON.stringify(resumeAfter.json));

  // 反向信号: 重启后对一个从未暂停过的讲 resume 应 ok=false(它本就 running/缺省)。
  const resumeNever = await post("/api/tasks/action", { kind: "prefetch", verb: "resume", vid: 999999 });
  ok(resumeNever.json && resumeNever.json.ok === false,
     "对从未暂停的讲 resume 返回 ok=false(失败信号正常): " + JSON.stringify(resumeNever.json));

  return finish();
}

function finish() {
  killGw("SIGKILL");
  if (originSrv) { try { originSrv.close(); } catch (_) {} }
  // 清掉自己的临时目录(可重复运行)
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  if (failed > 0) {
    console.error("\n=== E2E FAILED: " + failed + " assertion(s) ===");
    process.exit(1);
  }
  console.log("\n=== E2E PASSED: all prefetch-control assertions green ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL: 未捕获异常 " + (e && e.stack || e));
  finish();
});
