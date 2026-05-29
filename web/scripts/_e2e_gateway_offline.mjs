// e2e: M4 网关掉线韧性 — 杀网关后 web 不再随之下线,应用内可感知「网关离线」,且网关自动恢复。
// 用法: cd web && node scripts/_e2e_gateway_offline.mjs
// 失败信号: 修复前(run.sh EXIT trap 连带杀 web)杀网关 → :3000 连接被拒 → A1 FAIL。
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";

const APP = "http://127.0.0.1:3000";
const SHOTS = "/Users/zhb/Documents/julestest/docs/superpowers/uac-shots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = true;
const check = (n, ok, d) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) pass = false; };
execSync(`mkdir -p "${SHOTS}"`);

// 读 /api/courses/status: 返回 {reachable(web是否可达), httpOk, online(网关在线?)}
async function status() {
  try {
    const r = await fetch(`${APP}/api/courses/status`);
    if (!r.ok) return { reachable: true, httpOk: false, online: null };
    const d = await r.json();
    return { reachable: true, httpOk: true, online: !!(d.health && d.health.gatewayOnline) };
  } catch {
    return { reachable: false, httpOk: false, online: null }; // fetch 抛错 = web :3000 也下线了
  }
}

const pre = await status();
check("前置: web 在线 + 网关在线", pre.reachable && pre.httpOk && pre.online === true, JSON.stringify(pre));

// 硬杀网关
try { execSync(`pkill -9 -f 'youdao_course.py serve'`, { stdio: "ignore" }); } catch { /* none */ }

let webStayedUp = true, sawOffline = false, recovered = false;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  const s = await status();
  if (!s.reachable) webStayedUp = false;                 // 连接被拒 = web 随网关一起下线(修复前行为)
  if (s.reachable && s.httpOk && s.online === false) sawOffline = true;
  if (s.reachable && s.httpOk && s.online === true && sawOffline) { recovered = true; break; }
  await sleep(300);
}

check("A1: 杀网关后 web 仍在线(连接不被拒)", webStayedUp,
  webStayedUp ? "web :3000 全程可达" : "web 也下线了(ERR_CONNECTION_REFUSED) — run.sh 仍连带杀 web");
check("A2: 停机窗口内应用内可感知网关离线(health.gatewayOnline=false)", sawOffline, `sawOffline=${sawOffline}`);
check("A3: 网关无需手动干预自动恢复(gatewayOnline 回到 true)", recovered, `recovered=${recovered}`);

try {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.goto(`${APP}/settings`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/M4_gateway_recovered.png`, fullPage: true });
  const body = (await page.textContent("body")) || "";
  check("A4: 恢复后设置页显示「网关在线」", /网关在线/.test(body), body.includes("网关在线") ? "" : "未见 网关在线 文案");
  await browser.close();
} catch (e) { check("A4 screenshot", false, e.message); }

console.log(`\n=== GATEWAY-OFFLINE e2e: ${pass ? "ALL PASS" : "FAIL"} ===`);
process.exit(pass ? 0 : 1);
