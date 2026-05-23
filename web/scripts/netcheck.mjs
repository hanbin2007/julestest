import { chromium } from "playwright-core";
const url = process.argv[2] || "http://127.0.0.1:3000/settings";
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await (await b.newContext()).newPage();
const fails = [];
p.on("response", (r) => {
  if (r.status() >= 400) fails.push(r.status() + " " + r.url());
});
await p.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2500);
console.log("FAILED REQUESTS:");
[...new Set(fails)].slice(0, 20).forEach((f) => console.log("  " + f.slice(0, 150)));
await b.close();
