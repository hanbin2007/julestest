#!/usr/bin/env node
// Lane A — fake Youdao origin for the ISOLATED UI e2e harness (zero internet).
//
// On startup, generates a tiny REAL unencrypted HLS into HLS_DIR (cfg) via ffmpeg:
//   hd/ (640x360) + ld/ (320x180), rate 10, duration 30, hls_time 2, libx264.
//   -> hd/index.m3u8 + hd/seg*.ts  and  ld/index.m3u8 + ld/seg*.ts
// Idempotent: if both index.m3u8 already exist, regeneration is skipped.
// Then serves HLS_DIR over plain HTTP on ORIGIN_PORT with correct content-types.
//
// The gateway accepts http://127.0.0.1:<ORIGIN_PORT>/... source URLs because the
// isolated gateway is launched with YD_EXTRA_ALLOWED_HOSTS=127.0.0.1 (gateway.py:85).
//
// Run standalone:  node web/scripts/_e2e_ui/fake-origin.mjs   (stays up until killed)
// Or import { ensureHls, startOrigin } for in-process orchestration.

import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ORIGIN_PORT, HLS_DIR, FFMPEG_HLS, ORIGIN_URL } from "./cfg.mjs";

const CTYPE = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
};

// Optional per-.ts latency so the buffer/prefetch lifecycle is observable in the
// UI e2e (time to screenshot pause/resume/cancel mid-download). Default 0 = instant
// (identical to the de-risk behavior). Set SEG_DELAY_MS=2500 for the UI run.
const SEG_DELAY_MS = Number(process.env.SEG_DELAY_MS || 0);

// ---- ffmpeg HLS generation (validated recipe) -----------------------------
function genVariant(name, spec) {
  const dir = path.join(HLS_DIR, name);
  const index = path.join(dir, "index.m3u8");
  if (fs.existsSync(index)) return { name, dir, regenerated: false };
  fs.mkdirSync(dir, { recursive: true });
  // testsrc gives moving content -> real H.264 frames so ffmpeg thumb extraction
  // produces a meaningful sprite. lavfi color/size + drawn frame counter.
  const args = [
    "-y",
    "-f", "lavfi",
    "-i", `testsrc=size=${spec.size}:rate=${spec.rate}:duration=${spec.duration}`,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-g", String(spec.rate * spec.hlsTime),  // keyframe per segment boundary
    "-f", "hls",
    "-hls_time", String(spec.hlsTime),
    "-hls_list_size", "0",
    "-hls_segment_filename", path.join(dir, "seg%d.ts"),
    "-hls_flags", "independent_segments",
    index,
  ];
  const r = spawnSync("ffmpeg", args, { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed for ${name}: ${r.stderr || r.error || "unknown"}`);
  }
  if (!fs.existsSync(index)) {
    throw new Error(`ffmpeg produced no index.m3u8 for ${name}`);
  }
  return { name, dir, regenerated: true };
}

export function ensureHls() {
  fs.mkdirSync(HLS_DIR, { recursive: true });
  const hd = genVariant("hd", FFMPEG_HLS.hd);
  const ld = genVariant("ld", FFMPEG_HLS.ld);
  // Count segs for a quick sanity line.
  const seg = (d) => fs.readdirSync(d).filter((f) => f.endsWith(".ts")).length;
  return {
    hd: { ...hd, segs: seg(hd.dir) },
    ld: { ...ld, segs: seg(ld.dir) },
  };
}

// ---- HTTP server over HLS_DIR ---------------------------------------------
export function startOrigin() {
  const srv = http.createServer((req, res) => {
    // Path-traversal guard: resolve under HLS_DIR only.
    const reqPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const abs = path.normalize(path.join(HLS_DIR, reqPath));
    if (!abs.startsWith(HLS_DIR)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      const ext = path.extname(abs).toLowerCase();
      const send = () => {
        res.writeHead(200, {
          "Content-Type": CTYPE[ext] || "application/octet-stream",
          "Content-Length": st.size,
          "Cache-Control": "no-store",
        });
        fs.createReadStream(abs).pipe(res);
      };
      if (ext === ".ts" && SEG_DELAY_MS > 0) setTimeout(send, SEG_DELAY_MS);
      else send();
    });
  });
  return new Promise((resolve) => {
    srv.listen(ORIGIN_PORT, "127.0.0.1", () => resolve(srv));
  });
}

// ---- standalone entrypoint ------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const info = ensureHls();
  startOrigin().then(() => {
    console.log(`[fake-origin] serving ${HLS_DIR} at ${ORIGIN_URL}`);
    console.log(`[fake-origin] hd: ${info.hd.segs} segs (regen=${info.hd.regenerated}), ld: ${info.ld.segs} segs (regen=${info.ld.regenerated})`);
    console.log(`[fake-origin] hd m3u8: ${ORIGIN_URL}/hd/index.m3u8`);
    console.log(`[fake-origin] ld m3u8: ${ORIGIN_URL}/ld/index.m3u8`);
  }).catch((e) => {
    console.error("[fake-origin] failed to start:", e);
    process.exit(1);
  });
  const bye = () => process.exit(0);
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
