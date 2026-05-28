// e2e: 设置页 UX 改版验证（Plan 4）。驱动本机 Chrome（无头），截图留证 + 硬失败信号。
// 失败信号：断言「修复后才有」的值出现、「修复前的坏值」消失——能区分 修复生效 vs 未生效。
// 可重复运行：只读页面，不写任何持久状态；连跑两次都应通过。
import { chromium } from "playwright-core";

const HOST = "http://127.0.0.1:3000";
const SHOT = "/tmp/settings-ux.png";

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
const page = await ctx.newPage();
const results = [];
const check = (name, ok, extra = {}) => {
  results.push({ name, ok, ...extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""));
};

try {
  // API 真相：失败任务数 + 是否有 prefetch 任务，用来交叉验证 UI。
  const status = await fetchJSON(`${HOST}/api/courses/status`);
  const failedN = (status.failedTasks || []).length;
  const hasPrefetch = (status.tasks || []).some((t) => t.kind === "prefetch");

  await page.goto(`${HOST}/settings`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2500);
  const body = (await page.textContent("body")) || "";
  await page.screenshot({ path: SHOT, fullPage: true });

  // 1) 分区标题：系统状态 / 缓存管理 必须可见（失败信号：旧版无分区标题 → 找不到）。
  check("section 系统状态 present", body.includes("系统状态"));
  check("section 缓存管理 present", body.includes("缓存管理"));

  // 2) 任务标签：恰好 进行中 + 操作历史；旧四标签（已完成/失败/全部）不得作为 tab 出现。
  //    收集所有 role=tab 文本（含主网格的 按课程/全部讲次 与 任务面板 tab）。
  const tabTexts = await page.$$eval('[role="tab"]', (els) => els.map((e) => (e.textContent || "").trim()));
  const taskTabs = tabTexts.filter((t) => /进行中|操作历史|已完成|失败|全部讲次|按课程/.test(t) === false ? false : true);
  const hasInProgress = tabTexts.some((t) => /进行中/.test(t));
  const hasHistory = tabTexts.some((t) => /操作历史/.test(t));
  // 旧标签信号：作为「任务面板 tab」的「已完成」「全部」必须消失。注意主网格 tab 是「全部讲次」，
  // 这里只禁「已完成」与单独的「失败」tab（失败横幅是 Alert，不是 role=tab）。
  const hasOldCompleted = tabTexts.some((t) => /^已完成\b|已完成 \d/.test(t));
  const hasOldFailedTab = tabTexts.some((t) => /^失败 \d/.test(t));
  check("task tabs 进行中 present", hasInProgress, { tabTexts });
  check("task tabs 操作历史 present", hasHistory);
  check("old 已完成 tab absent", !hasOldCompleted);
  check("old 失败 tab absent (banner instead)", !hasOldFailedTab);

  // 3) 失败横幅 iff failedTasks>0（与 API 真相交叉验证 → 硬信号）。
  const bannerPresent = /\d+\s*个任务失败/.test(body);
  check("failure banner matches API", bannerPresent === failedN > 0, { failedN, bannerPresent });

  // 4) prefetch 行的「自动」只读标识（仅当确有 prefetch 任务时强校验；否则跳过）。
  if (hasPrefetch) {
    check("prefetch 自动 label present", body.includes("自动") && body.includes("由播放自动触发"));
  } else {
    check("prefetch 自动 label (skipped, no prefetch task)", true, { skipped: true });
  }

  // 5) 「总数未知」band-aid 彻底消失（失败信号：未删除 CacheBar 旧路径 → 字符串仍在 DOM）。
  check("总数未知 absent from DOM", !body.includes("总数未知"));

  // 6) 缓存术语：网格列头改为「缓存状态」（切到「全部讲次」tab 后校验）。
  const lectureTab = page.getByRole("tab", { name: /全部讲次/ });
  if (await lectureTab.count()) {
    await lectureTab.first().click();
    await page.waitForTimeout(1500);
    const body2 = (await page.textContent("body")) || "";
    await page.screenshot({ path: "/tmp/settings-ux-lectures.png", fullPage: true });
    check("缓存状态 column header present", body2.includes("缓存状态"));
  } else {
    check("缓存状态 column header (skipped, no lecture tab)", true, { skipped: true });
  }

  console.log("SHOT:", SHOT);
} catch (e) {
  check("FATAL", false, { error: e.message });
} finally {
  await browser.close();
}

const ok = results.every((r) => r.ok === true);
console.log(`\nALL PASS: ${ok}`);
process.exit(ok ? 0 : 1);
