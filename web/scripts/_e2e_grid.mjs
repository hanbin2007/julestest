// Phase 3 网格归一 e2e — 排版无 off-scale 字重(800),间距回 ×8 网格。
// 失败信号(改前必红):旧码 4 处 fontWeight:800;设置卡片 padding 18px(p:2.25)非 8 的倍数。
// 用法: node scripts/_e2e_grid.mjs [baseUrl]   默认 http://127.0.0.1:3001
import { chromium } from "playwright-core";

const BASE = (process.argv[2] || "http://127.0.0.1:3001").replace(/\/$/, "");
const fails = [];
const oks = [];
const browser = await chromium.launch({ channel: "chrome", headless: true });

async function open(path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("mui-mode", "dark"); } catch {} });
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(700);
  return { ctx, page };
}

try {
  // 1) 全站无 fontWeight:800(主题最大 700;800 是 off-scale 自造)
  for (const path of ["/", "/settings", "/settings/cache", "/notes", "/chats"]) {
    const { ctx, page } = await open(path);
    const n800 = await page.evaluate(() =>
      [...document.querySelectorAll("*")].filter((el) => getComputedStyle(el).fontWeight === "800").length,
    );
    (n800 === 0 ? oks : fails).push(`fontWeight 800 @ ${path}: ${n800} 处(需 0)`);
    await ctx.close();
  }

  // 2) 设置卡片 padding 落在 ×8 网格({8,16,24})
  {
    const { ctx, page } = await open("/settings");
    const pads = await page.evaluate(() =>
      [...document.querySelectorAll(".MuiCard-root")].slice(0, 4).map((el) => {
        const s = getComputedStyle(el);
        return [s.paddingTop, s.paddingLeft].map((v) => Math.round(parseFloat(v)));
      }),
    );
    const flat = pads.flat();
    const offGrid = flat.filter((px) => px > 0 && px % 8 !== 0);
    (offGrid.length === 0 ? oks : fails).push(`设置卡片 padding 上/左 ${JSON.stringify(flat)} — 脱网格(非8倍数): ${JSON.stringify(offGrid)}`);
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
