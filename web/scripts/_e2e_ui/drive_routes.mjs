#!/usr/bin/env node
// Settings 四子路由走查 — ISOLATED, zero-bandwidth, prod-safe.
//
// Brings up the SAME isolated stack as drive.mjs (fake-origin :18851, gateway
// :18808, seeded web :3001), then drives a headless Chrome through the 4 nested
// settings routes:
//   /settings        概览
//   /settings/cache  缓存管理
//   /settings/tasks  任务 · 历史
//   /settings/system 系统配置
// For each: goto -> networkidle -> wait (1s poll + entrance anim) -> assert a
// route-specific heading sentinel -> screenshot -> record console/page errors.
// Then clicks the left sidebar nav 概览→缓存管理→任务·历史→系统配置 and asserts
// client-side nav follows (URL + active-pill background).
//
// FAILURE SIGNAL: a route FAILS if (a) any console error / pageerror fired while
// it was active (React render error, "useSettingsData must be used within
// provider", MUI error, etc.) OR (b) its heading sentinel is missing. Any FAIL
// -> non-zero exit.
//
// Isolation: NEVER touches prod :3000 / :8808 / ~/.youdao_course/app.db / prod
// cache. This script OWNS the whole isolated stack — it starts every piece and
// tears it all down (kill by LISTEN port only). Idempotent: connected twice in a
// row both pass (fresh ROOT + fresh gateway cache each run).
//
// Run from repo (worktree) root:  node web/scripts/_e2e_ui/drive_routes.mjs
// Screenshots -> docs/superpowers/uac-shots/route_*.png

import { chromium } from "playwright-core";
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import {
  WEB_URL, WEB_PORT, GATEWAY_ORIGIN, GW_PORT, ORIGIN_PORT, ORIGIN_URL,
  SHOTS_DIR, ROOT, CACHE_DIR, THUMB_DIR, DATABASE_URL,
} from "./cfg.mjs";
import { ensureHls, startOrigin } from "./fake-origin.mjs";
import { startGateway, waitGatewayUp } from "./gateway-up.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 4 routes under test (heading text matched against the route's <h6>). ──────
// NOTE: the tasks heading renders with spaces around the middle dot ("任务 · 历史"),
// matched via a tolerant regex so a spacing tweak doesn't false-fail.
const ROUTES = [
  { name: "overview", path: "/settings",        heading: "概览",     navLabel: "概览" },
  { name: "cache",    path: "/settings/cache",  heading: "缓存管理", navLabel: "缓存管理" },
  { name: "tasks",    path: "/settings/tasks",  heading: /任务\s*·\s*历史/, navLabel: /任务\s*·\s*历史/ },
  { name: "system",   path: "/settings/system", heading: "系统配置", navLabel: "系统配置" },
];

// ── per-route result accounting ───────────────────────────────────────────────
const routeResults = new Map(); // name -> { pass, reasons:[] }
function markRoute(name, ok, reason) {
  const r = routeResults.get(name) ?? { pass: true, reasons: [] };
  if (!ok) { r.pass = false; if (reason) r.reasons.push(reason); }
  routeResults.set(name, r);
}
// global (non-route) checks, e.g. sidebar nav
const checks = [];
const check = (pass, msg) => { checks.push({ pass, msg }); console.log((pass ? "PASS" : "FAIL") + ": " + msg); };

// kill anything LISTENing on a port (safe: -sTCP:LISTEN never matches our own
// outbound client sockets, only the server listeners we own).
function killPort(port) {
  try { execSync(`lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch { /* none */ }
}

let originSrv = null;
let gwProc = null;

function teardown() {
  try { if (gwProc && !gwProc.killed) process.kill(gwProc.pid, "SIGKILL"); } catch { /* */ }
  try { if (originSrv) originSrv.close(); } catch { /* */ }
  // isolated listeners only — kill by port, never by name pattern that could hit prod.
  killPort(WEB_PORT);
  killPort(GW_PORT);
  killPort(ORIGIN_PORT);
  // also catch a stray detached gateway-up child from a prior interrupted run.
  try { execSync(`pkill -f "_e2e_ui/gateway-up.mjs"`, { stdio: "ignore" }); } catch { /* */ }
}

async function waitWebUp(timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(WEB_URL + "/settings", { redirect: "manual" });
      if (res.status > 0 && res.status < 500) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

async function bringUpStack() {
  // 0) clean slate: kill any leftover isolated listeners, wipe the isolated ROOT.
  teardown();
  await sleep(800);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(THUMB_DIR, { recursive: true });

  // 1) fake origin (ffmpeg HLS, instant segments — route walk doesn't need delay).
  const hls = ensureHls();
  originSrv = await startOrigin();
  console.log(`[stack] fake-origin :${ORIGIN_PORT} (hd=${hls.hd.segs} ld=${hls.ld.segs} segs)`);

  // 2) seed the isolated DB (prisma migrate deploy + seed rows). Synchronous,
  //    isolated DATABASE_URL — NEVER prod. Inherits stdio so failures are visible.
  console.log("[stack] seeding isolated DB …");
  const seed = spawnSync("node", ["web/scripts/_e2e_ui/seed.mjs"], {
    stdio: "inherit", env: { ...process.env, DATABASE_URL },
  });
  if (seed.status !== 0) throw new Error("seed.mjs failed (status " + seed.status + ")");

  // 3) isolated gateway (clean cache; YD_EXTRA_ALLOWED_HOSTS=127.0.0.1 baked into
  //    gateway-up.mjs). Capture its log tail for diagnostics.
  let gwLog = "";
  gwProc = startGateway();
  gwProc.stderr.on("data", (c) => { gwLog += c; });
  gwProc.stdout.on("data", (c) => { gwLog += c; });
  if (!(await waitGatewayUp(40000))) {
    console.error(gwLog.slice(-2000));
    throw new Error("gateway failed to come up on " + GW_PORT);
  }
  console.log(`[stack] gateway up ${GATEWAY_ORIGIN}`);

  // 4) isolated web on :3001, pointed at the isolated gateway + isolated DB.
  //    web-up.sh execs `npm start` (serves the worktree's existing .next build).
  //    Launched DETACHED via perl setsid so this bg-runnable script doesn't reap
  //    it (macOS has no `setsid`; perl POSIX::setsid reparents to launchd).
  if (!existsSync("web/.next/BUILD_ID")) {
    throw new Error("web/.next/BUILD_ID missing — run `npm run build` in web/ first");
  }
  console.log("[stack] launching isolated web :" + WEB_PORT + " (detached)…");
  const web = spawn(
    "perl",
    ["-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV", "bash", "web/scripts/_e2e_ui/web-up.sh"],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PORT: String(WEB_PORT),
        GATEWAY_ORIGIN,                 // point isolated web at isolated gateway
        DATABASE_URL,                   // isolated sqlite (seeded above)
      },
    },
  );
  web.unref();
  if (!(await waitWebUp())) throw new Error("isolated web failed to come up on " + WEB_PORT);
  console.log(`[stack] web up ${WEB_URL}`);
}

async function main() {
  await bringUpStack();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  const page = await ctx.newPage();

  // Console / page-error collection. `currentRoute` lets us attribute an error to
  // whichever route was active when it fired.
  let currentRoute = "(boot)";
  const errorsByRoute = new Map(); // name -> [text]
  const recordErr = (text) => {
    const arr = errorsByRoute.get(currentRoute) ?? [];
    arr.push(text);
    errorsByRoute.set(currentRoute, arr);
  };
  page.on("console", (m) => { if (m.type() === "error") recordErr("console.error: " + m.text()); });
  page.on("pageerror", (e) => recordErr("pageerror: " + (e?.message ?? String(e))));

  mkdirSync(SHOTS_DIR, { recursive: true });
  const shot = async (name) => {
    const f = `${SHOTS_DIR}/route_${name}.png`;
    await page.screenshot({ path: f });
    console.log("SHOT " + f);
  };

  // ── Pass 1: direct goto each of the 4 routes ────────────────────────────────
  for (const r of ROUTES) {
    currentRoute = r.name;
    routeResults.set(r.name, { pass: true, reasons: [] });
    try {
      await page.goto(WEB_URL + r.path, { waitUntil: "networkidle", timeout: 30000 });
    } catch (e) {
      markRoute(r.name, false, "goto failed: " + (e?.message ?? e));
    }
    // settings layout polls /api/courses/status every ~1s; give it one cycle +
    // the entrance animation room to settle before asserting + screenshotting.
    await page.waitForTimeout(800);

    // sentinel: the route's content heading (MUI variant="h6" -> <h6>). Heading,
    // not nav, because both contain the same label — h6 disambiguates to content.
    const headingLoc = page.locator("h6", { hasText: r.heading }).first();
    let sentinelOk = false;
    try {
      await headingLoc.waitFor({ state: "visible", timeout: 8000 });
      sentinelOk = true;
    } catch { sentinelOk = false; }
    markRoute(r.name, sentinelOk, sentinelOk ? null : `heading sentinel "${r.heading}" missing`);
    check(sentinelOk, `route ${r.name} (${r.path}): heading sentinel present`);

    await shot(r.name);

    const errs = errorsByRoute.get(r.name) ?? [];
    markRoute(r.name, errs.length === 0, errs.length ? `${errs.length} console/page error(s)` : null);
    check(errs.length === 0, `route ${r.name}: no console/page errors (${errs.length})`);
    errs.slice(0, 5).forEach((e) => console.log("    ERR[" + r.name + "]: " + e.slice(0, 200)));
  }

  // ── Pass 2: client-side sidebar nav (Next <Link>) follows the active item ───
  // Start at overview, then click each nav label in order; assert URL + that the
  // clicked nav item carries the active pill background (md3.primaryContainer).
  currentRoute = "nav";
  errorsByRoute.set("nav", errorsByRoute.get("nav") ?? []);
  try {
    await page.goto(WEB_URL + "/settings", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(500);
    for (const r of ROUTES) {
      // nav items are <a> (Next Link). Match the nav link by its visible label
      // inside the <nav> region (avoids matching a heading / button).
      const navLink = page.locator("nav a").filter({ hasText: r.navLabel }).first();
      await navLink.click();
      await page.waitForURL("**" + r.path, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);

      const urlOk = new URL(page.url()).pathname === r.path;
      // active pill: SettingsNav paints the active item bgcolor md3.primaryContainer
      // (a non-transparent rgb). Read the rendered background of the clicked link.
      const bg = await navLink.evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => "");
      const activeHighlight = !!bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";

      check(urlOk, `nav -> ${r.name}: URL is ${r.path} (got ${new URL(page.url()).pathname})`);
      check(activeHighlight, `nav -> ${r.name}: active pill highlighted (bg=${bg || "<none>"})`);
      // attribute any error fired during this click to the route we navigated to.
      currentRoute = r.name;
    }
  } catch (e) {
    check(false, "sidebar nav walk threw: " + (e?.message ?? e));
  }

  await browser.close();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n=== ROUTE SUMMARY ===");
  let anyFail = false;
  for (const r of ROUTES) {
    const res = routeResults.get(r.name) ?? { pass: false, reasons: ["not visited"] };
    if (!res.pass) anyFail = true;
    console.log(`  ${res.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(9)} ${r.path}` +
      (res.reasons.length ? "  — " + res.reasons.join("; ") : ""));
  }
  const navFails = checks.filter((c) => !c.pass);
  if (navFails.length) anyFail = true;
  console.log(`=== NAV/CHECKS: ${checks.length - navFails.length}/${checks.length} passed ===`);
  if (navFails.length) navFails.forEach((c) => console.log("  FAIL: " + c.msg));

  if (anyFail) { console.log("\n=== ROUTE DRIVE FAILED ==="); process.exitCode = 1; }
  else console.log("\n=== ROUTE DRIVE PASSED (4/4 routes render, nav follows, no console errors) ===");
}

main()
  .catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; })
  .finally(() => { teardown(); });
