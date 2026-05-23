// 用本机 Google Chrome 跑无头冒烟测试（绕开 MCP）。
// 用法: node scripts/smoke.mjs [url] [screenshot] [waitText]
import { chromium } from "playwright-core";

const url = process.argv[2] || "http://127.0.0.1:3000/";
const shot = process.argv[3] || "/tmp/smoke.png";
const waitText = process.argv[4] || "";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  if (waitText) {
    await page.getByText(new RegExp(waitText)).first().waitFor({ timeout: 15000 }).catch(() => {});
  }
  await page.waitForTimeout(1200);
  const body = (await page.textContent("body")) || "";
  await page.screenshot({ path: shot });
  console.log("TITLE:", await page.title());
  console.log("HAS_COURSE:", /高三家长成长计划|高考数学|公益讲座/.test(body));
  console.log("BODY_LEN:", body.length);
  console.log("CONSOLE_ERRORS:", errors.length);
  errors.slice(0, 12).forEach((e) => console.log("  ERR:", e.slice(0, 200)));
  console.log("SHOT:", shot);
} catch (e) {
  console.log("FATAL:", e.message);
  errors.slice(0, 12).forEach((er) => console.log("  ERR:", er.slice(0, 200)));
  process.exitCode = 1;
} finally {
  await browser.close();
}
