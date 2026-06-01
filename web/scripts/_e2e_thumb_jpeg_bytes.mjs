#!/usr/bin/env node
// e2e: 缩略图 JPEG 字节计量 — thumb.jpegBytes 经 /api/status 暴露。
//
// 完全隔离: 自起一个网关进程(隔离端口 + 隔离 cache/thumb 目录),绝不碰生产 8808。
//
// 断言(每步都有明确 PASS/FAIL,失败 process.exit(1)):
//   1. 空 thumb dir → GET /api/status 的 thumb.jpegBytes === 0
//   2. 写入已知大小的 fake 999.jpg (4096 字节) → kill -9 → 重启 → thumb.jpegBytes >= 4096
//   3. 移除 jpg → kill -9 → 重启 → thumb.jpegBytes === 0  (失败信号验证)
//
// 可重复运行: 每次跑前清掉自己的临时目录。两连跑都该 PASS。

import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", ".."); // worktree root

// ---- 隔离参数 (端口不撞生产 8808 / 不撞其它 e2e 脚本) -------------------
const GW_PORT = 18843;
const TMP = path.join(os.tmpdir(), "yd_e2e_jpeg");
const CACHE_DIR = path.join(TMP, "cache");
const THUMB_DIR = path.join(TMP, "thumbs");
const REQ_FILE = path.join(TMP, "req.txt");

const FAKE_JPG = path.join(THUMB_DIR, "999.jpg");
const FAKE_BYTES = 4096;

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
  // 最小 req.txt: 网关 parse_request 只需请求行 + Host。不触发任何真实网络。
  fs.writeFileSync(
    REQ_FILE,
    "GET /test.m3u8 HTTP/1.1\nHost: 127.0.0.1:18853\nUrl: http://127.0.0.1:18853/test.m3u8\n\n",
  );
}

// ---- 启动隔离网关进程 -----------------------------------------------------
function startGateway() {
  const env = {
    ...process.env,
    YD_THUMB_DIR: THUMB_DIR, // 隔离缩略图目录(绝不写生产 ~/.youdao_course/thumbs)
    YD_THUMB_CACHE_BYTES: String(8 * 1024 * 1024),
  };
  const args = [
    "youdao_course.py", "serve",
    "-r", REQ_FILE,
    "--port", String(GW_PORT),
    "--cache-dir", CACHE_DIR,
    "--cache-mb", "64",
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
      const r = await getStatus();
      if (r.status === 200) return true;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

// ---- HTTP 助手 ------------------------------------------------------------
function getStatus() {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: GW_PORT, path: "/api/status", method: "GET" },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (_) {}
          resolve({ status: res.statusCode, json });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

// ---- 杀网关(按端口) -------------------------------------------------------
function killGwByPort() {
  // lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill -9
  // -sTCP:LISTEN 确保只匹配监听者,不匹配客户端连接
  try {
    const pids = spawnSync(
      "lsof", ["-ti", "tcp:" + GW_PORT, "-sTCP:LISTEN"],
      { encoding: "utf8" }
    ).stdout.trim();
    if (pids) {
      pids.split("\n").forEach((pid) => {
        pid = pid.trim();
        if (pid) {
          try { process.kill(Number(pid), "SIGKILL"); } catch (_) {}
        }
      });
    }
  } catch (_) {}
}

// ---- 主流程 ---------------------------------------------------------------
let gw = null;

async function main() {
  freshTmp();

  // ===== 启动网关(空 thumb dir) =====
  gw = startGateway();
  if (!(await waitGatewayUp())) {
    fail("网关未能在隔离端口 " + GW_PORT + " 起来");
    return finish();
  }
  pass("隔离网关已起 port=" + GW_PORT + " thumbDir=" + THUMB_DIR);

  // ===== 断言 1: 空 thumb dir → jpegBytes === 0 =====
  {
    const r = await getStatus();
    const jpegBytes = r.json && r.json.thumb && r.json.thumb.jpegBytes;
    ok(
      typeof jpegBytes === "number" && jpegBytes === 0,
      "空 thumb dir → thumb.jpegBytes === 0 (实际=" + jpegBytes + ")"
    );
    if (typeof jpegBytes !== "number") {
      fail("thumb.jpegBytes 字段不存在或非 number，响应: " + JSON.stringify(r.json && r.json.thumb));
    }
  }

  // ===== 断言 2: 写 fake 999.jpg (4096B) → kill -9 → 重启 → jpegBytes >= 4096 =====
  fs.writeFileSync(FAKE_JPG, Buffer.alloc(FAKE_BYTES, 0xab));
  ok(fs.existsSync(FAKE_JPG), "fake 999.jpg 已写入 thumb dir (4096B)");

  killGwByPort();
  await sleep(800); // 等进程完全消失

  gw = startGateway();
  if (!(await waitGatewayUp())) {
    fail("kill-9 后网关未能重启");
    return finish();
  }
  pass("kill -9 后网关重启成功");

  {
    const r = await getStatus();
    const jpegBytes = r.json && r.json.thumb && r.json.thumb.jpegBytes;
    ok(
      typeof jpegBytes === "number" && jpegBytes >= FAKE_BYTES,
      "写 fake 999.jpg + kill-9 + 重启 → thumb.jpegBytes >= " + FAKE_BYTES + " (实际=" + jpegBytes + ")"
    );
    // 失败信号: 如果 jpegBytes 仍 === 0 说明实现没起作用
    if (typeof jpegBytes === "number" && jpegBytes === 0) {
      fail("[失败信号] jpegBytes 仍为 0 — 实现未计算磁盘 JPEG 字节 (BROKEN)");
    }
  }

  // ===== 断言 3: 移除 jpg → kill -9 → 重启 → jpegBytes === 0 =====
  fs.rmSync(FAKE_JPG, { force: true });
  ok(!fs.existsSync(FAKE_JPG), "fake 999.jpg 已删除");

  killGwByPort();
  await sleep(800);

  gw = startGateway();
  if (!(await waitGatewayUp())) {
    fail("第二次 kill-9 后网关未能重启");
    return finish();
  }
  pass("第二次 kill -9 后网关重启成功");

  {
    const r = await getStatus();
    const jpegBytes = r.json && r.json.thumb && r.json.thumb.jpegBytes;
    ok(
      typeof jpegBytes === "number" && jpegBytes === 0,
      "移除 jpg + kill-9 + 重启 → thumb.jpegBytes === 0 (实际=" + jpegBytes + ")"
    );
    // 失败信号: 仍有残余意味着 scandir 有 bug
    if (typeof jpegBytes === "number" && jpegBytes > 0) {
      fail("[失败信号] jpegBytes=" + jpegBytes + " 应为 0 — scandir 未正确反映删除后状态 (BROKEN)");
    }
  }

  return finish();
}

function finish() {
  killGwByPort();
  // 清掉自己的临时目录(可重复运行)
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  if (failed > 0) {
    console.error("\n=== E2E FAILED: " + failed + " assertion(s) ===");
    process.exit(1);
  }
  console.log("\n=== E2E PASSED: all thumb.jpegBytes assertions green ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL: 未捕获异常 " + (e && e.stack || e));
  finish();
});
