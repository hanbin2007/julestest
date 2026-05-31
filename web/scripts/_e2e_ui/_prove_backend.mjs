#!/usr/bin/env node
// Lane A proof: start fake origin + isolated gateway, then exercise the THREE
// risky backend paths against the LOCAL origin (zero internet) and assert:
//   a. buffer/batch  -> cached segments for 900101 climb to ~15 (uses src directly).
//   b. thumbs/batch  -> thumb state for 900101 reaches "ready" (ffmpeg sprite).
//   c. /api/play?m3u8=... -> prefetch caches segments for 900102.
// Then KILL gateway + origin. Prints PASS/FAIL lines + raw evidence; exit 0/1.

import http from "node:http";
import fs from "node:fs";
import {
  GW_PORT, ORIGIN_PORT, HD_URL, LD_URL, CACHE_DIR, THUMB_DIR, HLS_DIR, ROOT,
} from "./cfg.mjs";
import { ensureHls, startOrigin } from "./fake-origin.mjs";
import { startGateway, waitGatewayUp } from "./gateway-up.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const pass = (m) => console.log("PASS: " + m);
const fail = (m) => { console.error("FAIL: " + m); failed++; };

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      { host: "127.0.0.1", port: GW_PORT, path: p, method,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (_) {}
          resolve({ status: res.statusCode, json, raw: buf });
        });
      });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p) => req("GET", p, null);
const post = (p, b) => req("POST", p, b);

async function status() { return (await get("/api/status")).json; }
function cachedOf(st, vid) {
  const v = st && st.buffer && st.buffer.perVid && st.buffer.perVid[String(vid)];
  return v ? v.cached : 0;
}
function thumbStateOf(st, vid) {
  return st && st.thumb && st.thumb.states ? st.thumb.states[String(vid)] : undefined;
}

async function waitFor(fn, maxMs, stepMs = 250) {
  const deadline = Date.now() + maxMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last.done) return last;
    await sleep(stepMs);
  }
  return last;
}

const V_BUF = 900101, V_PF = 900102;
const bufBody = { videos: [{ videoId: V_BUF, contentId: 950101, cardPackageId: 960101, productId: 900001, src: HD_URL, liveId: null }] };
const thumbBody = { videos: [{ videoId: V_BUF, contentId: 950101, cardPackageId: 960101, productId: 900001, duration: 30, src: LD_URL, liveId: null }] };

let origin = null, gw = null, gwLog = "";

async function main() {
  // fresh isolated workspace
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });

  const hls = ensureHls();
  console.log(`[prove] HLS hd=${hls.hd.segs}segs ld=${hls.ld.segs}segs at ${HLS_DIR}`);
  origin = await startOrigin();
  console.log(`[prove] fake origin listening on ${ORIGIN_PORT}`);

  gw = startGateway();
  gw.stderr.on("data", (c) => { gwLog += c; });
  gw.stdout.on("data", (c) => { gwLog += c; });
  if (!(await waitGatewayUp())) {
    fail("gateway did not come up on " + GW_PORT);
    console.error(gwLog.slice(-3000));
    return finish();
  }
  pass("isolated gateway up on " + GW_PORT);
  const st0 = await status();
  console.log(`[prove] ffmpeg available in gateway: ${st0.ffmpeg}, thumbDir=${st0.thumbDir}`);

  // ===== a. buffer/batch via fake origin =====
  const br = await post("/api/buffer/batch", bufBody);
  console.log(`[prove] POST /api/buffer/batch -> ${br.status} ${br.raw}`);
  const ba = await waitFor(async () => {
    const st = await status();
    const c = cachedOf(st, V_BUF);
    return { done: c >= 15, c, st };
  }, 30000);
  if (ba.c >= 15) pass(`buffer cached segments for ${V_BUF} reached ${ba.c} (>=15)`);
  else fail(`buffer cached only ${ba.c} segs for ${V_BUF} (expected ~15). bufState=${JSON.stringify(ba.st.buffer.perVid[String(V_BUF)])}`);
  // BLOCKER probe: did the gateway try to re-resolve via Youdao?
  if (/stream\.youdao\.com|resolve_m3u8|no m3u8/.test(gwLog)) {
    fail("gateway log mentions Youdao re-resolution: " + (gwLog.match(/.*(stream\.youdao\.com|resolve_m3u8|no m3u8).*/) || [])[0]);
  }
  const errAfterBuf = ba.st.buffer.perVid[String(V_BUF)] && ba.st.buffer.perVid[String(V_BUF)].reason;
  if (errAfterBuf) fail("buffer error reason surfaced: " + errAfterBuf);

  // ===== b. thumbs/batch via fake origin =====
  const tr = await post("/api/thumbs/batch", thumbBody);
  console.log(`[prove] POST /api/thumbs/batch -> ${tr.status} ${tr.raw}`);
  const ta = await waitFor(async () => {
    const st = await status();
    const s = thumbStateOf(st, V_BUF);
    return { done: s === "ready" || s === "error", s, st };
  }, 40000);
  if (ta.s === "ready") pass(`thumb state for ${V_BUF} reached "ready"`);
  else fail(`thumb state for ${V_BUF} = ${JSON.stringify(ta.s)} (states=${JSON.stringify(ta.st.thumb.states)})`);
  // confirm the sprite jpg actually exists on disk
  const jpg = `${THUMB_DIR}/${V_BUF}.jpg`;
  if (fs.existsSync(jpg)) pass(`thumb sprite written to disk: ${jpg} (${fs.statSync(jpg).size} bytes)`);
  else fail(`thumb sprite NOT on disk at ${jpg}`);

  // ===== c. prefetch via /api/play?m3u8= =====
  const playPath = `/api/play?videoId=${V_PF}&contentId=950102&cardPackageId=960102&productId=900001&m3u8=${encodeURIComponent(LD_URL)}`;
  const pr = await get(playPath);
  console.log(`[prove] GET ${playPath} -> ${pr.status} ${pr.raw}`);
  const pa = await waitFor(async () => {
    const st = await status();
    const c = cachedOf(st, V_PF);
    return { done: c >= 3, c, st };
  }, 30000);
  if (pa.c >= 3) pass(`prefetch cached segments for ${V_PF} reached ${pa.c} (>=3)`);
  else fail(`prefetch cached only ${pa.c} segs for ${V_PF}. perVid=${JSON.stringify(pa.st.buffer.perVid[String(V_PF)])}`);

  // dump a debug snapshot for the record
  const dbg = await get("/api/_debug");
  console.log(`[prove] /api/_debug vidReal=${JSON.stringify(dbg.json.vidReal)} vidTotal=${JSON.stringify(dbg.json.vidTotal)}`);

  return finish();
}

function finish() {
  try { if (gw && !gw.killed) process.kill(gw.pid, "SIGKILL"); } catch (_) {}
  try { if (origin) origin.close(); } catch (_) {}
  if (gwLog.trim()) console.log("\n[prove] ===== gateway log tail =====\n" + gwLog.slice(-2500));
  if (failed > 0) { console.error(`\n=== PROVE FAILED: ${failed} assertion(s) ===`); process.exit(1); }
  console.log("\n=== PROVE PASSED: buffer + thumb + prefetch all work via fake origin ===");
  process.exit(0);
}

main().catch((e) => { console.error("FAIL: uncaught " + (e && e.stack || e)); finish(); });
