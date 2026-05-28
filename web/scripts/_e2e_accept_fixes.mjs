// e2e: 验收回归修复 — (A) 操作历史/全屏对话框遇到缩略图 gen 瞬态不再白屏;
//                      (B) 整集缓冲 payload 必带 liveId 键(直播回放 AES 解密)。
// 用法: cd web && node scripts/_e2e_accept_fixes.mjs
// 失败信号: 修复缺失时 A 会因 CHIP["gen"].color 抛错使整页 unmount(白屏)→ tabs 消失/body 空;
//           B 在修复前 MK_BUF 不带 liveId → 拦截到的 payload.videos[] 无 liveId 键。
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";

const APP = "http://127.0.0.1:3000";
const DB = "/Users/zhb/.youdao_course/app.db";
const SHOTS = "/Users/zhb/Documents/julestest/docs/superpowers/uac-shots";
const sql = (q) =>
  execSync(`sqlite3 "${DB}" "PRAGMA busy_timeout=8000; ${q.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();

const GEN_ID = `e2e-genrow-${Date.now()}`;
const GEN_VID = 999111; // 假 vid,不会与真实数据冲突;byVid 解析不到 → 标题"视频 999111"
let pass = true;
const log = (...a) => console.log(...a);
const check = (name, ok, detail) => {
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) pass = false;
};

execSync(`mkdir -p "${SHOTS}"`);
// 注入"地雷": 一条缩略图 gen 瞬态历史行(最近 → 排在 操作历史 顶部,必被渲染)
sql(`INSERT INTO TaskHistory (id,kind,videoId,state,reason,at) VALUES ('${GEN_ID}','thumb',${GEN_VID},'gen',NULL,${Date.now()});`);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !/_next\/webpack-hmr/.test(m.text())) pageErrors.push("console: " + m.text());
});

// CHECK B 准备: 拦截整集缓冲 POST,捕获 payload 并用桩响应(避免真起缓冲任务的副作用)
let bufBody = null;
await page.route("**/api/buffer/batch", (route) => {
  try { bufBody = JSON.parse(route.request().postData() || "{}"); } catch { /* ignore */ }
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, intercepted: true }) });
});

try {
  await page.goto(`${APP}/settings`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1500);

  // ---------- CHECK A: 操作历史 + 全屏 渲染含 gen 行不白屏 ----------
  const histTab = page.getByText(/操作历史/).first();
  const hasTab = await histTab.count().then((c) => c > 0).catch(() => false);
  if (hasTab) { await histTab.click().catch(() => {}); await page.waitForTimeout(1000); }
  // 全屏对话框渲染全部历史行(无 20 行截断),最严苛
  const fsBtn = page.getByRole("button", { name: /全屏|展开/ }).first();
  if (await fsBtn.count().then((c) => c > 0).catch(() => false)) {
    await fsBtn.click().catch(() => {});
    await page.waitForTimeout(1200);
  }
  await page.screenshot({ path: `${SHOTS}/fix_A_history_with_gen_row.png`, fullPage: true }).catch(() => {});
  const bodyA = (await page.textContent("body")) || "";
  const tabsStillThere = await page.getByText(/进行中/).count().then((c) => c > 0).catch(() => false);
  const genRowShown = bodyA.includes(String(GEN_VID));
  const crashErrs = pageErrors.filter((e) => /reading '?color'?|undefined|Minified React error|Cannot read/i.test(e));
  const noCrash = crashErrs.length === 0 && bodyA.length > 500;
  check(
    "A: 操作历史/全屏 含 thumb 'gen' 行不白屏",
    hasTab && tabsStillThere && noCrash,
    `tabFound=${hasTab} tabsStillThere=${tabsStillThere} bodyLen=${bodyA.length} genRowShown=${genRowShown} crashErrs=${crashErrs.length}${crashErrs[0] ? ` [${crashErrs[0].slice(0, 120)}]` : ""}`,
  );

  // ---------- CHECK B: 整集缓冲 payload 必带 liveId 键 ----------
  await page.keyboard.press("Escape").catch(() => {}); // 关掉可能打开的全屏对话框
  await page.waitForTimeout(400);
  // 切到「全部讲次」用每行的缓冲图标按钮(aria-label=缓冲整集): rowBuf → submit([v],"buffer") 直接 POST,
  // 避开工具栏批量按钮(需先勾选→空)与课程卡按钮(还要先 getCourseVideos 异步拉取慢)。
  const gridTab = page.getByText(/全部讲次/).first();
  if (await gridTab.count().then((c) => c > 0).catch(() => false)) {
    await gridTab.click().catch(() => {});
    await page.waitForTimeout(1200);
  }
  let triggered = false;
  const bufBtn = page.getByLabel("缓冲整集").first(); // getByLabel 只匹配带 aria-label 的图标按钮,不匹配工具栏文字按钮
  if (await bufBtn.count().then((c) => c > 0).catch(() => false)) {
    await bufBtn.scrollIntoViewIfNeeded().catch(() => {});
    await bufBtn.click().catch(() => {});
    triggered = true;
    for (let i = 0; i < 30 && !bufBody; i++) await page.waitForTimeout(200); // 最多等 6s(POST 可能在异步后)
  }
  await page.screenshot({ path: `${SHOTS}/fix_B_after_buffer_click.png` }).catch(() => {});
  if (bufBody && Array.isArray(bufBody.videos) && bufBody.videos.length) {
    const allHaveKey = bufBody.videos.every((v) => Object.prototype.hasOwnProperty.call(v, "liveId"));
    check(
      "B: /api/buffer/batch payload 每个 video 带 liveId 键",
      allHaveKey,
      `videos=${bufBody.videos.length} sample=${JSON.stringify(bufBody.videos[0])}`,
    );
  } else {
    pass = false;
    log(`FAIL B: 未能触发整集缓冲 POST(triggered=${triggered}, bufBody=${JSON.stringify(bufBody)}). 无法验证 liveId — 视为失败而非跳过。`);
  }
} catch (e) {
  check("fatal", false, e.message);
} finally {
  try { sql(`DELETE FROM TaskHistory WHERE id='${GEN_ID}';`); } catch { /* ignore */ }
  await browser.close();
}

log(`\n=== ACCEPT-FIXES e2e: ${pass ? "ALL PASS" : "FAIL"} ===`);
process.exit(pass ? 0 : 1);
