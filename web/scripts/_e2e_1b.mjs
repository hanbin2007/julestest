// e2e-1b: 两处「假态/卡死」回归 —— 播放器取流失败的死循环 & 设置页首帧假红。
//
// 用法: node scripts/_e2e_1b.mjs [baseUrl]   (默认 http://127.0.0.1:3001)
//   需要一个已在 baseUrl 跑着的 web 实例(本脚本不自起 server、不碰 DB)。
//
// 驱动本机 Chrome(无头),localStorage 预置 mui-mode=dark(深色为主)。两条断言,
// 每条带失败信号、打印 PASS/FAIL;任一 FAIL → exitCode=1。
//
// 为什么旧码上这两条是红:
//  (1) 播放器:app/page.tsx 的取流 effect 在 play() 抛错时只 setStreamError + toast,
//      渲染回退却仍是 `src ? <ArtPlayer> : "加载中…"` —— streamError 没进渲染分支。
//      于是 route.abort 掉 /api/play 后,UI 永久停在「加载中…」,既无「重试取流」按钮、
//      也无从恢复。修复后应渲染错误态:出现「重试取流」按钮、不再停留「加载中…」。
//  (2) 设置页:SettingsChrome/HealthCard 用 `online = !!data?.gatewayOnline`,首帧 data
//      尚未到达(undefined)→ online=false → 直接渲染红字「网关离线」/缓存目录「丢失」。
//      这是「首帧假红」:数据没回来不代表网关真离线。修复后首帧应显示中性「检测中…」,
//      待 /api/courses/status 落定再判真实在线/离线。本脚本用 delay 把首帧无数据窗口拉长,
//      在数据到达前断言**不出现**红字、而出现「检测中…」。
//
// 可重复:只读页面 + 拦截网络,不写任何持久状态;连跑两次都应同样结论。
import { chromium } from "playwright-core";

const BASE = (process.argv[2] || "http://127.0.0.1:3001").replace(/\/$/, "");
const ELLIPSIS = "…"; // … (U+2026),与 UI 文案精确匹配,勿用三个点
const LOADING = `加载中${ELLIPSIS}`;
const DETECTING = `检测中${ELLIPSIS}`;
const RETRY_STREAM = "重试取流";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 在 baseUrl 上重置 mui-mode=dark(addInitScript 在每个文档创建前注入)。
async function newDarkPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("mui-mode", "dark");
    } catch {
      /* storage 不可用时忽略 */
    }
  });
  return ctx.newPage();
}

// 发现一讲可播放的(productId, videoId):镜像 useAllCourseVideos 的过滤
// (!locked && pickM3u8 有值),否则 app/page.tsx 的 play() 根本不发起 → /api/play 不被命中。
async function discoverPlayable() {
  const cr = await fetch(`${BASE}/api/courses`);
  if (!cr.ok) throw new Error(`/api/courses HTTP ${cr.status}`);
  const { courses = [] } = await cr.json();
  for (const c of courses) {
    let vr;
    try {
      vr = await fetch(`${BASE}/api/course?productId=${c.id}`);
    } catch {
      continue;
    }
    if (!vr.ok) continue;
    const { videos = [] } = await vr.json();
    for (const v of videos) {
      if (v.locked) continue;
      const m3u8 =
        ((v.clarity ?? []).find((x) => x && x.url)?.url) || v.downloadUrl || null;
      if (m3u8) return { productId: c.id, videoId: v.videoId };
    }
  }
  return null;
}

// 等某段(可见)文本出现,返回 true;超时返回 false(不抛,便于把「没出现」作为失败信号)。
async function waitForText(page, text, ms) {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: ms });
    return true;
  } catch {
    return false;
  }
}

let browser = null;

async function assertPlayerRetry() {
  const target = await discoverPlayable();
  if (!target) {
    check("A1 播放器重试: 出现「重试取流」、不停留「加载中…」", false, "未发现任何可播放讲(无法触发取流)");
    return;
  }
  const page = await newDarkPage(browser);
  try {
    // 拦截取流端点 → abort,模拟取流失败。pathname 精确匹配,避免误伤其它 /api/*。
    let aborted = 0;
    await page.route(
      (url) => {
        try {
          return new URL(url).pathname === "/api/play";
        } catch {
          return false;
        }
      },
      async (route) => {
        aborted++;
        await route.abort();
      },
    );

    // 深链直达该讲 → 触发 play() → /api/play 被 abort → streamError。
    await page.goto(`${BASE}/?productId=${target.productId}&videoId=${target.videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // 修复后:错误态出现「重试取流」按钮(load-bearing 信号:旧码无此文案)。
    const sawRetry = await waitForText(page, RETRY_STREAM, 15000);
    // 旧码症状:永久停在「加载中…」。给页面一点时间后采样 body。
    await page.waitForTimeout(500);
    const body = (await page.textContent("body")) || "";
    const stuckLoading = body.includes(LOADING);

    check(
      "A1 播放器重试: 出现「重试取流」、不停留「加载中…」",
      sawRetry && !stuckLoading,
      `aborted=${aborted} sawRetry=${sawRetry} stuckLoading=${stuckLoading} target=${target.productId}/${target.videoId}`,
    );
  } finally {
    await page.close().catch(() => {});
  }
}

async function assertSettingsDetecting() {
  const page = await newDarkPage(browser);
  try {
    // 拦截设置页数据端点 → 先 await delay 再 continue(返回真实数据,不伪造庞大 shape)。
    // delay(4s) 远大于下面 waitFor(2s),保证「首帧无数据」窗口可靠存在。
    const DELAY_MS = 4000;
    await page.route(
      (url) => {
        try {
          return new URL(url).pathname === "/api/courses/status";
        } catch {
          return false;
        }
      },
      async (route) => {
        await sleep(DELAY_MS);
        try {
          await route.continue();
        } catch {
          /* 页面可能已关闭 */
        }
      },
    );

    // domcontentloaded(非 networkidle):networkidle 会一直等被我们 hold 住的 status 请求,
    // 那样只能看到「数据已到达」的帧,断言失去意义。
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 在数据到达前:应出现中性「检测中…」(load-bearing:旧码无此文案,永远红)。
    const sawDetecting = await waitForText(page, DETECTING, 2000);
    const body = (await page.textContent("body")) || "";
    // 旧码首帧假红:SettingsChrome 渲染字面量「网关离线」。修复后此刻不该出现。
    const sawGatewayOffline = body.includes("网关离线");
    // 缓存目录「丢失」是独立 Chip(非「缓存目录丢失」连续串),按行内 chip 文案 scope 检查。
    // 仅作旁证,不作 load-bearing(防 HealthCard 结构变动导致 vacuous)。
    let sawCacheLost = false;
    try {
      sawCacheLost = (await page.getByText("丢失", { exact: true }).count()) > 0;
    } catch {
      /* ignore */
    }

    check(
      "A2 设置假态: 首帧显示「检测中…」、不出现假红「网关离线」",
      sawDetecting && !sawGatewayOffline,
      `sawDetecting=${sawDetecting} sawGatewayOffline=${sawGatewayOffline} sawCacheLost=${sawCacheLost}`,
    );
  } finally {
    await page.close().catch(() => {});
  }
}

const watchdog = setTimeout(() => {
  console.log("FATAL  watchdog 触发(>120s),强制退出");
  process.exitCode = 1;
  process.exit(1);
}, 120000);

try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  await assertPlayerRetry();
  await assertSettingsDetecting();
} catch (e) {
  check("FATAL", false, e?.message || String(e));
} finally {
  clearTimeout(watchdog);
  try {
    if (browser) await browser.close();
  } catch {
    /* ignore */
  }
}

const ok = results.length > 0 && results.every((r) => r.ok === true);
console.log(`\n=== e2e-1b: ${ok ? "ALL PASS" : "FAIL"} ===`);
process.exitCode = ok ? 0 : 1;
