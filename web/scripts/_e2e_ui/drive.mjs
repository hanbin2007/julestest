#!/usr/bin/env node
// Human-like UI e2e for Theme A cache controls. Drives the ISOLATED web (:3001)
// with a headless Chrome, exercising every control and screenshotting each step.
// Asserts BOTH the UI state and the gateway's ground truth (/api/status). Zero
// internet: all data flows through the local fake origin (2.5s/seg delay so the
// buffer/prefetch lifecycle is observable).
//
// Prereqs (started by the orchestrator): fake-origin :18851 (SEG_DELAY_MS=2500),
// isolated gateway :18808 (clean cache), seeded web :3001.
// Run from repo root:  node web/scripts/_e2e_ui/drive.mjs
//
// Exit 0 iff every assertion passes. Screenshots -> docs/superpowers/uac-shots/uictl_*.png

import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { WEB_URL, GATEWAY_ORIGIN, SHOTS_DIR, ORIGIN_URL, LESSONS, GW_PORT, CACHE_DIR, THUMB_DIR } from "./cfg.mjs";

const L1 = LESSONS[0].videoId; // 900101 buffer
const L2 = LESSONS[1].videoId; // 900102 prefetch
const L3 = LESSONS[2].videoId; // 900103 thumb / failure

let n = 0;
const results = [];
const log = (pass, msg) => { results.push({ pass, msg }); console.log((pass ? "PASS" : "FAIL") + ": " + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gw(path) { return (await fetch(GATEWAY_ORIGIN + path)).json(); }
async function cached(vid) { const s = await gw("/api/status"); return s.buffer?.perVid?.[String(vid)]?.cached ?? 0; }
async function prefetchControl(vid) { const s = await gw("/api/status"); return s.live?.control?.[String(vid)] ?? "running"; }

async function waitGatewayUp(timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { if ((await fetch(GATEWAY_ORIGIN + "/api/status")).ok) return true; } catch {} await sleep(1000); }
  return false;
}

// Wipe the isolated gateway's persisted cache state + relaunch, so this script is
// deterministic and repeatable standalone (no reliance on external pre-clean).
// Safe: at this point no connection to the gateway is open, so -sTCP:LISTEN only
// matches the gateway listener (not this process).
async function resetGateway() {
  try { execSync(`lsof -ti tcp:${GW_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch {}
  try { execSync(`pkill -f "_e2e_ui/gateway-up.mjs"`, { stdio: "ignore" }); } catch {}
  await sleep(1000);
  execSync(`rm -rf ${CACHE_DIR} ${THUMB_DIR}`);
  spawn("node", ["web/scripts/_e2e_ui/gateway-up.mjs"], { detached: true, stdio: "ignore" }).unref();
  if (!(await waitGatewayUp())) throw new Error("gateway failed to come up after reset");
  console.log("[reset] clean gateway up");
}

async function main() {
  await resetGateway();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  const shot = async (name) => {
    n += 1;
    const f = `${SHOTS_DIR}/uictl_${String(n).padStart(2, "0")}_${name}.png`;
    await page.screenshot({ path: f });
    console.log("SHOT " + f);
  };
  const grabToast = async (timeout = 3000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const t = (await page.getByRole("alert").allTextContents()).join(" | ").trim();
      if (t) { console.log("  TOAST: " + t); return t; }
      await sleep(120);
    }
    return "";
  };
  const btn = (name) => page.getByRole("button", { name, exact: true });
  const waitBtn = (name, timeout = 25000) => btn(name).first().waitFor({ state: "visible", timeout });
  const has = async (name) => (await btn(name).count()) > 0;
  const openDrawer = async () => { await btn("打开 缓存控制验收测试课 详情").click(); await page.getByText("共 3 讲").waitFor({ timeout: 8000 }); };
  const closeDrawer = async () => { await btn("关闭").click(); await page.waitForTimeout(400); };

  await page.goto(WEB_URL + "/settings", { waitUntil: "networkidle", timeout: 30000 });
  await page.getByText("缓存控制验收测试课").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  await shot("baseline");
  log(await page.getByText("网关在线").count() > 0, "baseline: 网关在线 shown (gateway connected)");

  // ── A. Global background-pause toggle ────────────────────────────────────
  {
    const sw = page.getByRole("switch").first();
    await sw.click();
    const t1 = await grabToast();
    await page.waitForTimeout(500);
    await shot("bgpause_on");
    log((await gw("/api/status")).bgPaused === true, `bg-pause ON: gateway bgPaused=true (toast "${t1}")`);
    await sw.click();
    await grabToast();
    await page.waitForTimeout(500);
    await shot("bgpause_off");
    log((await gw("/api/status")).bgPaused === false, "bg-pause OFF: gateway bgPaused=false");
  }

  // ── B. Buffer lifecycle + batch-skip reason (第1讲 / 900101) ──────────────
  {
    await openDrawer();
    await page.getByRole("row", { name: /第1讲/ }).getByRole("button", { name: "缓冲整集" }).click();
    log(/已加入队列/.test(await grabToast()), "buffer: submit queued");
    await closeDrawer();
    await waitBtn("暂停");
    await shot("buffer_working");
    log(await has("暂停"), "buffer: working row shows 暂停 control");

    // batch-skip: re-submit the SAME lesson now that it is CONFIRMED working -> skip reason
    await openDrawer();
    await page.getByRole("row", { name: /第1讲/ }).getByRole("button", { name: "缓冲整集" }).click();
    const tSkip = await grabToast();
    await shot("buffer_batch_skip");
    log(/跳过|缓存中|已在/.test(tSkip), `buffer: re-submit surfaces skip reason ("${tSkip}")`);
    await closeDrawer();

    // pause -> let the in-flight segment settle, then assert the count FREEZES
    await btn("暂停").click();
    const tPause = await grabToast();
    await waitBtn("继续");
    await shot("buffer_paused");
    log(await has("继续"), `buffer: paused row shows 继续 control (toast "${tPause}")`);
    await sleep(4000);                 // allow the one in-flight segment to land (≤1-seg latency by design)
    const c1 = await cached(L1);
    await sleep(5500);                 // spans ~2 segment intervals
    const c2 = await cached(L1);
    log(c2 === c1, `buffer: paused FREEZES growth (steady ${c1} -> ${c2} over 5.5s)`);

    // resume -> advances again
    await btn("继续").click();
    log(/已继续/.test(await grabToast()), "buffer: resume toast 已继续");
    await waitBtn("暂停");
    await shot("buffer_resumed");
    const c3 = await cached(L1); await sleep(5500); const c4 = await cached(L1);
    log(c4 > c3, `buffer: resumed advances (${c3} -> ${c4})`);

    // cancel -> active row gone
    await btn("取消").click();
    log(/已取消/.test(await grabToast()), "buffer: cancel toast 已取消");
    await page.waitForTimeout(1500);
    await shot("buffer_cancelled");
    log(!(await has("暂停")) && !(await has("继续")), "buffer: cancelled removes the active row");
  }

  // ── C. Prefetch lifecycle (第2讲 / 900102) ────────────────────────────────
  const playL2 = () => fetch(`${GATEWAY_ORIGIN}/api/play?videoId=${L2}&contentId=${LESSONS[1].contentId}&cardPackageId=${LESSONS[1].cardPackageId}&productId=900001&m3u8=${encodeURIComponent(ORIGIN_URL + "/ld/index.m3u8")}`);
  {
    await playL2(); // prefetch is playback-driven (no UI start button)
    await page.getByText("自动·随播放").first().waitFor({ timeout: 15000 });
    await waitBtn("暂停");
    await shot("prefetch_working");
    log(await page.getByText("自动·随播放").count() > 0, "prefetch: row labeled 自动·随播放 (auto-but-controllable)");
    log(await has("暂停"), "prefetch: now shows 暂停 control (was previously read-only)");

    await btn("暂停").click(); await grabToast();
    await waitBtn("继续");
    await shot("prefetch_paused");
    log((await prefetchControl(L2)) === "paused", "prefetch: gateway control=paused");

    await btn("继续").click(); await grabToast();
    await waitBtn("暂停");
    await shot("prefetch_resumed");
    log((await prefetchControl(L2)) === "running", "prefetch: gateway control back to running");

    await btn("取消").click(); await grabToast();
    await page.waitForTimeout(1500);
    await shot("prefetch_cancelled");
    log((await prefetchControl(L2)) === "cancelled" || !(await has("暂停")), "prefetch: cancelled");
  }

  // ── D. Thumbnail cancel (第3讲 / 900103) ──────────────────────────────────
  {
    await openDrawer();
    await page.getByRole("row", { name: /第3讲/ }).getByRole("button", { name: "生成缩略图" }).click();
    await grabToast();
    await closeDrawer();
    await waitBtn("终止", 15000).catch(() => {});
    await shot("thumb_working");
    log(await page.getByText("缩略图", { exact: false }).count() > 0, "thumb: 缩略图 task row present");
    if (await has("终止")) {
      await btn("终止").click();
      log(/已取消|已终止/.test(await grabToast()), "thumb: 终止(cancel) works");
      await page.waitForTimeout(1200);
      await shot("thumb_cancelled");
    } else log(false, "thumb: 终止 control did not appear");
  }

  // ── E. Failed-task reachable Retry (A4) ───────────────────────────────────
  {
    await fetch(`${GATEWAY_ORIGIN}/api/buffer/batch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ videos: [{ videoId: L3, contentId: LESSONS[2].contentId, cardPackageId: LESSONS[2].cardPackageId, productId: 900001, src: ORIGIN_URL + "/ld/MISSING.m3u8", liveId: null }] }),
    });
    await waitBtn("重试", 20000).catch(() => {});
    await shot("failed_retry_available");
    log(await has("重试"), "failed-task: 重试 reachable inline (A4 — not buried in read-only history)");
    if (await has("重试")) { await btn("重试").click(); await grabToast(); await page.waitForTimeout(1000); await shot("failed_retried"); log(true, "failed-task: 重试 clicked"); }
  }

  // ── F. kill -9 persistence through the UI (CLAUDE.md cross-restart) ────────
  {
    await playL2();
    await page.getByText("自动·随播放").first().waitFor({ timeout: 15000 });
    await waitBtn("暂停");
    await btn("暂停").click(); await grabToast();
    await waitBtn("继续");
    await shot("persist_before_paused");
    log((await prefetchControl(L2)) === "paused", "persist: prefetch paused before kill");

    console.log("  [kill -9 isolated gateway + relaunch clean process, same cache dir]");
    try { execSync(`lsof -ti tcp:${GW_PORT} -sTCP:LISTEN | xargs kill -9`); } catch {}
    await sleep(1000);
    spawn("node", ["web/scripts/_e2e_ui/gateway-up.mjs"], { detached: true, stdio: "ignore" }).unref();
    // wait for gateway back up
    for (let i = 0; i < 40; i++) { try { if ((await fetch(GATEWAY_ORIGIN + "/api/status")).ok) break; } catch {} await sleep(1000); }
    log((await prefetchControl(L2)) === "paused", "persist: gateway reloaded pf_control=paused after kill -9");

    await page.reload({ waitUntil: "networkidle", timeout: 30000 });
    await page.getByText("缓存控制验收测试课").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    await shot("persist_after_restart");
    const paused = (await page.getByText("自动·随播放").count() > 0) && (await has("继续"));
    log(paused, "persist: UI still shows the paused 自动·随播放 prefetch row after restart (resumable)");
  }

  log(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
  consoleErrors.slice(0, 8).forEach((e) => console.log("  ERR: " + e.slice(0, 160)));
  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== UI DRIVE: ${results.length - failed.length}/${results.length} assertions passed, ${n} screenshots ===`);
  if (failed.length) { console.log("FAILED:"); failed.forEach((r) => console.log("  - " + r.msg)); process.exit(1); }
  console.log("=== UI DRIVE PASSED ===");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
