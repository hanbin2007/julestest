#!/usr/bin/env node
// Lane A — launches the ISOLATED gateway for the UI e2e harness.
//
// Recipe copied verbatim from web/scripts/_e2e_prefetch_control.mjs (the known-good
// launch): minimal req.txt (parse_request only needs request line + Host to derive
// the Url; triggers NO real network), then
//   python3 youdao_course.py serve -r <req> --port 18808 \
//           --cache-dir /tmp/yd_e2e_ui/cache --cache-mb 64
// with env YD_THUMB_DIR=/tmp/yd_e2e_ui/thumbs (isolated thumbs — never prod).
//
// ADDED for UI harness: env YD_EXTRA_ALLOWED_HOSTS=127.0.0.1 so the gateway accepts
// http://127.0.0.1:<ORIGIN_PORT>/... source URLs from the fake origin (gateway.py:85).
//
// Run standalone:  node web/scripts/_e2e_ui/gateway-up.mjs   (stays up until killed;
//   leaves cache/thumbs intact so a UI run can poke it). Or import { startGateway,
//   waitGatewayUp } for in-process orchestration.

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GW_PORT, ORIGIN_PORT, CACHE_DIR, THUMB_DIR, EXTRA_HOST, GATEWAY_ORIGIN,
} from "./cfg.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// web/scripts/_e2e_ui -> repo root is three levels up.
const REPO = path.resolve(__dirname, "..", "..", "..");
const REQ_FILE = path.join(path.dirname(CACHE_DIR), "gw_req.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal req.txt: parse_request derives the upstream url from the request line +
// Host header. Points at the fake origin; no real Youdao traffic.
export function writeReq() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REQ_FILE), { recursive: true });
  fs.writeFileSync(
    REQ_FILE,
    "GET /hd/index.m3u8 HTTP/1.1\nHost: 127.0.0.1:" + ORIGIN_PORT +
      "\nUrl: http://127.0.0.1:" + ORIGIN_PORT + "/hd/index.m3u8\n\n",
  );
  return REQ_FILE;
}

export function startGateway() {
  writeReq();
  const env = {
    ...process.env,
    YD_THUMB_DIR: THUMB_DIR,                  // isolated thumbs dir (never prod)
    YD_THUMB_CACHE_BYTES: String(8 * 1024 * 1024),
    YD_EXTRA_ALLOWED_HOSTS: EXTRA_HOST,       // accept http://127.0.0.1:... sources
  };
  const args = [
    "youdao_course.py", "serve",
    "-r", REQ_FILE,
    "--port", String(GW_PORT),
    "--cache-dir", CACHE_DIR,
    "--cache-mb", "64",
  ];
  const proc = spawn("python3", args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  return proc;
}

export function waitGatewayUp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const ok = await new Promise((resolve) => {
          const r = http.request(
            { host: "127.0.0.1", port: GW_PORT, path: "/api/status", method: "GET" },
            (res) => { res.resume(); resolve(res.statusCode === 200); },
          );
          r.on("error", () => resolve(false));
          r.end();
        });
        if (ok) return true;
      } catch (_) { /* not up yet */ }
      await sleep(250);
    }
    return false;
  })();
}

// ---- standalone entrypoint ------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const proc = startGateway();
  let buf = "";
  proc.stderr.on("data", (c) => { buf += c; });
  proc.stdout.on("data", (c) => { buf += c; });
  waitGatewayUp().then((up) => {
    if (!up) {
      console.error("[gateway-up] gateway did NOT come up on port " + GW_PORT);
      console.error(buf.slice(-2000));
      process.exit(1);
    }
    console.log(`[gateway-up] gateway up at ${GATEWAY_ORIGIN} (cacheDir=${CACHE_DIR}, thumbDir=${THUMB_DIR}, extraHost=${EXTRA_HOST})`);
  });
  const bye = () => { try { proc.kill("SIGKILL"); } catch (_) {} process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
