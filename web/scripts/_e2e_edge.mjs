// Phase 1 边缘态 e2e — 请求失败时显示"重试"面板,而非把失败伪装成空态("数据没了"错觉)。
// 失败信号(改前必红):旧码 fetch 失败 → notes/chats=[] → 渲染"还没有任何笔记/对话",无重试。
// 用拦截 route.abort() 强制 fetch 拒绝(必触发 SWR error,不依赖 fetcher 对状态码的处理)。
// 用法: node scripts/_e2e_edge.mjs [baseUrl]   默认 http://127.0.0.1:3001
import { chromium } from "playwright-core";

const BASE = (process.argv[2] || "http://127.0.0.1:3001").replace(/\/$/, "");
const fails = [];
const oks = [];

const browser = await chromium.launch({ channel: "chrome", headless: true });

async function checkErrorState({ label, listPath, abortPathname, emptyText }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("mui-mode", "dark"); } catch {} });
  const page = await ctx.newPage();
  // 拦截该列表数据请求 → 失败
  await page.route(
    (u) => new URL(u).pathname === abortPathname,
    (route) => route.abort("failed"),
  );
  await page.goto(BASE + listPath, { waitUntil: "domcontentloaded", timeout: 30000 });
  // 等到出现「重试」或空态文案之一(最多 ~6s)
  const retry = page.getByRole("button", { name: "重试" });
  await retry.first().waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  const hasRetry = await retry.first().isVisible().catch(() => false);
  const emptyVisible = await page.getByText(emptyText).first().isVisible().catch(() => false);

  if (hasRetry && !emptyVisible) oks.push(`${label}: 失败→显示「重试」面板(非空态)`);
  else fails.push(`${label}: hasRetry=${hasRetry} emptyVisible=${emptyVisible}(期望 hasRetry=true & 空态隐藏)`);
  await ctx.close();
}

try {
  await checkErrorState({
    label: "notes 列表",
    listPath: "/notes",
    abortPathname: "/api/notes/all",
    emptyText: "还没有任何笔记。",
  });
  await checkErrorState({
    label: "chats 列表",
    listPath: "/chats",
    abortPathname: "/api/chats",
    emptyText: "还没有任何对话。",
  });

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
