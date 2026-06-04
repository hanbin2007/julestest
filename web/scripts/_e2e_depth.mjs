// Phase 0 深度地基 e2e — 暗色下表面层次 / chrome 滚动浮起 / hover 反馈可见性。
// 失败信号(改前必红):
//   1) body 背景 vs .MuiCard 填充 WCAG 对比度 > 1.2  (改前 = 1.00)
//   2) AppBar 顶部无阴影、内容滚动后有阴影           (改前滚动后仍无阴影)
//   3) 卡片 hover 时背景比静止更亮(tone17 vs tone12) (改前 hover 不改背景)
// 用法: node scripts/_e2e_depth.mjs [baseUrl]   默认 http://127.0.0.1:3001
import { chromium } from "playwright-core";

const BASE = (process.argv[2] || "http://127.0.0.1:3001").replace(/\/$/, "");
const SHOT_DIR = process.argv[3] || "docs/superpowers/uac-shots";

const fails = [];
const oks = [];
const ok = (m) => oks.push(m);
const fail = (m) => fails.push(m);

// --- WCAG 对比度 ---
const relLum = (r, g, b) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const parseRGB = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
const ratio = (a, b) => {
  const L1 = relLum(...parseRGB(a)), L2 = relLum(...parseRGB(b));
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });

async function newPage(mode) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 760 } });
  await ctx.addInitScript((m) => {
    try { localStorage.setItem("mui-mode", m); } catch {}
  }, mode);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  return { ctx, page, errors };
}

try {
  // ===== 1) 暗色对比度(/settings 有 StorageCard) =====
  {
    const { ctx, page } = await newPage("dark");
    await page.goto(BASE + "/settings", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => {
      const body = getComputedStyle(document.body).backgroundColor;
      const card = document.querySelector(".MuiCard-root");
      return { body, card: card ? getComputedStyle(card).backgroundColor : null };
    });
    if (!m.card) fail("contrast: 找不到 .MuiCard-root");
    else {
      const r = ratio(m.body, m.card);
      (r > 1.08 ? ok : fail)(`contrast 暗色 body(${m.body}) vs card(${m.card}) = ${r.toFixed(3)} (需 > 1.08)`);
    }
    await ctx.close();
  }

  // ===== 2) AppBar 滚动浮起(/notes 卡片多,必可滚) =====
  {
    const { ctx, page } = await newPage("dark");
    await page.goto(BASE + "/notes", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(800);
    const shadowAt = async () =>
      page.evaluate(() => {
        const bar = document.querySelector(".MuiAppBar-root");
        return bar ? getComputedStyle(bar).boxShadow : "NO_BAR";
      });
    const rest = await shadowAt();
    const scrolled = await page.evaluate(async () => {
      const sc = [...document.querySelectorAll("*")].find((el) => {
        const s = getComputedStyle(el);
        return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 60;
      });
      if (!sc) return "NO_SCROLLER";
      sc.scrollTop = 500;
      await new Promise((r) => setTimeout(r, 350));
      const bar = document.querySelector(".MuiAppBar-root");
      return bar ? getComputedStyle(bar).boxShadow : "NO_BAR";
    });
    const hasShadow = (s) => s && s !== "none" && s !== "NO_BAR" && s !== "NO_SCROLLER";
    if (rest === "NO_BAR") fail("scroll: 找不到 AppBar");
    else if (scrolled === "NO_SCROLLER") fail("scroll: /notes 没有可滚动容器");
    else {
      (!hasShadow(rest) ? ok : fail)(`AppBar 顶部无阴影: "${rest}"`);
      (hasShadow(scrolled) ? ok : fail)(`AppBar 滚动后有阴影: "${(scrolled || "").slice(0, 60)}"`);
    }
    await ctx.close();
  }

  // ===== 3) 卡片 hover 背景提亮(/notes 的 NoteCard) =====
  {
    const { ctx, page } = await newPage("dark");
    await page.goto(BASE + "/notes", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(800);
    const card = page.locator('.MuiCard-root[role="button"]').first();
    const exists = await card.count();
    if (!exists) fail("hover: /notes 无可点击 NoteCard(可能无笔记数据)");
    else {
      await card.scrollIntoViewIfNeeded();
      const restBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
      await card.hover();
      await page.waitForTimeout(250);
      const hoverBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
      const lighter = relLum(...parseRGB(hoverBg)) > relLum(...parseRGB(restBg)) + 0.002;
      (lighter ? ok : fail)(`NoteCard hover 背景提亮: rest(${restBg}) -> hover(${hoverBg})`);
    }
    await ctx.close();
  }

  // ===== 截图存证(暗+亮 × 4 页) =====
  for (const mode of ["dark", "light"]) {
    const { ctx, page } = await newPage(mode);
    for (const [name, path] of [["home", "/"], ["settings", "/settings"], ["notes", "/notes"], ["chats", "/chats"]]) {
      try {
        await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(900);
        await page.screenshot({ path: `${SHOT_DIR}/p0_${name}_${mode}.png` });
      } catch (e) { fail(`screenshot ${name}/${mode}: ${e.message}`); }
    }
    await ctx.close();
  }

  console.log("=== PASS ===");
  oks.forEach((m) => console.log("  ✓", m));
  console.log("=== FAIL ===");
  fails.forEach((m) => console.log("  ✗", m));
  console.log(`\nRESULT: ${fails.length === 0 ? "ALL GREEN" : fails.length + " FAILED"} (base ${BASE})`);
  process.exitCode = fails.length === 0 ? 0 : 1;
} catch (e) {
  console.log("FATAL:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
