// Phase 4 AppShell e2e — 统一内容脊 + 顶栏返回键左移。
// 失败信号(改前必红):旧码 notes/chats(1240)、settings(920 左对齐)各异、无 [data-page-container];
//   返回键在右上图标簇(x 偏右)。
// 用法: node scripts/_e2e_shell.mjs [baseUrl]   默认 http://127.0.0.1:3001
// 视口取 1600 宽,让三页内容都能命中 1200 maxWidth(settings 有 234 rail 也够)。
import { chromium } from "playwright-core";

const BASE = (process.argv[2] || "http://127.0.0.1:3001").replace(/\/$/, "");
const VW = 1600;
const fails = [];
const oks = [];
const browser = await chromium.launch({ channel: "chrome", headless: true });

async function open(path) {
  const ctx = await browser.newContext({ viewport: { width: VW, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("mui-mode", "dark"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(700);
  return { ctx, page };
}

try {
  // 1) 三个内容页共用 [data-page-container],宽度统一≈1200
  const widths = {};
  for (const path of ["/notes", "/chats", "/settings"]) {
    const { ctx, page } = await open(path);
    const rect = await page.evaluate(() => {
      const el = document.querySelector("[data-page-container]");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), left: Math.round(r.left) };
    });
    if (!rect) { fails.push(`${path}: 无 [data-page-container](未应用统一内容脊)`); }
    else {
      widths[path] = rect;
      (Math.abs(rect.w - 1200) <= 4 ? oks : fails).push(`${path}: 内容容器宽 ${rect.w}(需≈1200) left=${rect.left}`);
    }
    await ctx.close();
  }
  // notes 与 chats 都无 rail → 左边缘应一致
  if (widths["/notes"] && widths["/chats"]) {
    const d = Math.abs(widths["/notes"].left - widths["/chats"].left);
    (d <= 2 ? oks : fails).push(`notes/chats 左边缘一致: 差 ${d}px(需≤2)`);
  }

  // 2) 返回键在左半(非首页,如 /notes)
  {
    const { ctx, page } = await open("/notes");
    const backX = await page.evaluate(() => {
      const btn = document.querySelector('[aria-label="返回播放"]');
      if (!btn) return -1;
      const r = btn.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    if (backX < 0) fails.push("返回键: 找不到(aria-label 返回播放)");
    else (backX < VW / 2 ? oks : fails).push(`返回键在左半: x=${Math.round(backX)}(需 < ${VW / 2})`);
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
