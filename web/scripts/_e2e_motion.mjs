// Phase 2 动效 e2e — 卡片悬停不再"跳":无位移 + 背景进过渡;导航底色变化有过渡。
// 失败信号(改前必红):旧码卡片 hover 有 translateY(transform≠none)且 bgcolor 不在 transition;
//   SettingsNav 项无任何过渡。
// 用法: node scripts/_e2e_motion.mjs [baseUrl]   默认 http://127.0.0.1:3001
import { chromium } from "playwright-core";

const BASE = (process.argv[2] || "http://127.0.0.1:3001").replace(/\/$/, "");
const fails = [];
const oks = [];
const browser = await chromium.launch({ channel: "chrome", headless: true });

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("mui-mode", "dark"); } catch {} });
  return { ctx, page: await ctx.newPage() };
}

// 卡片:hover 后 transform 应为 none(不上移),且 transition-property 含 background-color。
async function checkCardNoJump({ label, path }) {
  const { ctx, page } = await newPage();
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(700);
  const card = page.locator('.MuiCard-root[role="button"]').first();
  if (!(await card.count())) { fails.push(`${label}: 无可点击卡片(数据缺?)`); await ctx.close(); return; }
  await card.scrollIntoViewIfNeeded();
  const transProp = await card.evaluate((el) => getComputedStyle(el).transitionProperty);
  await card.hover();
  await page.waitForTimeout(300);
  const transform = await card.evaluate((el) => getComputedStyle(el).transform);
  const noLift = transform === "none";
  const bgAnimated = /background-color/.test(transProp);
  (noLift ? oks : fails).push(`${label}: hover 无位移(transform=${transform})`);
  (bgAnimated ? oks : fails).push(`${label}: 背景进过渡(transition-property=${transProp})`);
  await ctx.close();
}

try {
  // 三个独立卡片面都验证"不跳"(同一 hoverElevate 原语);SettingsNav 等由 workflow 静态评审覆盖。
  await checkCardNoJump({ label: "NoteCard", path: "/notes" });
  await checkCardNoJump({ label: "CourseStatusCard", path: "/settings/cache" });
  await checkCardNoJump({ label: "ChatCard", path: "/chats" });

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
