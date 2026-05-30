// e2e: AI 助教「新建对话发送第一条消息会被吞掉」回归 —— 隔离 DB 版。
//
// 复现的是 *懒建* 路径(不是点「新建本讲对话」按钮):
//   在一个「零对话」的讲上打开 AI 助教面板 → activeChatId 保持 null(空白态)→
//   直接往输入框打第一条消息发送 → ChatBody.doSend 先 createLessonChat 再 send。
//   修复前:send 闭包里的 chatId 仍是 null → if(!chatId) return → 第一条被吞(无 POST /api/chat)。
//   修复后:doSend 把刚建好的 id 透传给 send → POST /api/chat 正常发出。
//
// 【为什么是隔离 DB】生产库(web/.env DATABASE_URL=~/.youdao_course/app.db)装着用户真实
//   课程/笔记/对话,且真实发送会烧 Claude 订阅 token。本脚本绝不碰它:
//     1) 自建一个 throwaway SQLite(os.tmpdir),prisma db push 出 schema,seed 一门课+一讲;
//     2) 自起一个【独立 next dev 实例】(独立端口 + DATABASE_URL 指向 throwaway),所有
//        服务端写入(POST /api/chat/new 建 chat)只落 throwaway,跑完整库删除;
//     3) POST /api/chat(真正会调模型的发送)在【浏览器侧拦截】,回一个 stub SSE —— 既抓到
//        「首条确实发出」的证据,又不触达服务端 → 零模型调用、零 token、零库写。
//   注:本脚本【不】使用 web/.env 里的 DATABASE_URL(worktree .env 里也故意没有它);
//   DATABASE_URL 全程由本脚本用 throwaway 覆盖。一旦覆盖缺失,Prisma 会因「未设 DATABASE_URL」
//   直接报错而非误写生产 —— 失败是响亮的,不是悄悄写错库。
//
// 硬失败信号(能区分 修复生效 vs 没生效):
//   1) 出现一条 body.text === PROBE 的 POST /api/chat(第一条消息真的发了)。
//      —— 修复前 send 早退,根本没有这次 fetch,拦截器收不到 PROBE;按 *探针文本* 匹配,
//      不被「第二条」POST 误判。
//   2) 第一条消息的用户气泡(pendingUser)带着 PROBE 文本渲染出来。
//   3) 回归:再发第二条 → 出现 body.text===PROBE2 的 POST,且 chatId 与第一条相同
//      (已存在 chat 的发送路径未被改坏)。
//
// 可重复:throwaway DB + 独立端口每次新建、跑完销毁;不依赖任何外部状态。
import { chromium } from "playwright-core";
import { PrismaClient } from "@prisma/client";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_PORT || 4137);
const HOST = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `e2e-chat-first-msg-${process.pid}.db`);
const DB_URL = `file:${DB_FILE}`;
const SHOT = path.join(os.tmpdir(), "chat-first-msg.png");
const PROBE = "__E2E_FIRST_MSG_PROBE__";
const PROBE2 = "__E2E_SECOND_MSG_PROBE__";

// seed 用的已知身份(无需动态发现真实课程)
const PRODUCT_ID = 999000001;
const VIDEO_ID = 999000002;

const results = [];
const check = (name, ok, extra = {}) => {
  results.push({ name, ok, ...extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""));
};

let server = null;
let browser = null;

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} || true`, { encoding: "utf8" }).trim();
    if (pids) execSync(`kill -9 ${pids.split("\n").join(" ")} 2>/dev/null || true`);
  } catch {
    /* ignore */
  }
}

function rmDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

async function waitForServer(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${HOST}/api/courses`);
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.courses) && j.courses.some((c) => c.id === PRODUCT_ID)) return true;
      }
    } catch {
      /* server not up yet */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

async function main() {
  // ---- 0) 干净起点:清端口、删残留 DB ----
  killPort(PORT);
  rmDb();

  // ---- 1) throwaway DB: 建 schema ----
  console.log(`throwaway DB: ${DB_FILE}`);
  execSync(`npx prisma db push --schema=prisma/schema.prisma --skip-generate --accept-data-loss`, {
    cwd: WEB_DIR,
    env: { ...process.env, DATABASE_URL: DB_URL },
    stdio: "ignore",
  });

  // ---- 2) seed 一门课 + 一讲(未锁、可播放) ----
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  await prisma.course.create({
    data: {
      productId: PRODUCT_ID,
      name: "E2E 测试课程",
      raw: JSON.stringify({ id: PRODUCT_ID, name: "E2E 测试课程", cardType: null, authors: [] }),
    },
  });
  await prisma.video.create({
    data: {
      videoId: VIDEO_ID,
      productId: PRODUCT_ID,
      title: "第一讲",
      idx: 0,
      raw: JSON.stringify({
        videoId: VIDEO_ID,
        productId: PRODUCT_ID,
        contentId: 1,
        cardPackageId: 1,
        title: "第一讲",
        duration: 600,
        locked: false,
        clarity: [{ type: 1, url: "http://127.0.0.1:9/fake.m3u8" }],
        downloadUrl: "http://127.0.0.1:9/fake.mp4",
      }),
    },
  });
  // 关键:打上「视频已按当前结构版本入库」标记。否则 getCourseVideos(catalog.ts) 见版本不符,
  // 会回退去打网关重拉(deleteMany 把 seed 的视频删掉 → /api/course 返回空 → 播放器不渲染)。
  // 值必须与 catalog.ts 的 VIDEOS_SCHEMA 常量一致。
  await prisma.syncMeta.create({ data: { key: `videosSchema:${PRODUCT_ID}`, value: "v2-live" } });
  await prisma.$disconnect();
  check("seed: 1 课 + 1 未锁讲 (+版本标记) 写入 throwaway DB", true, { productId: PRODUCT_ID, videoId: VIDEO_ID });

  // ---- 3) 起独立 next dev(独立端口 + throwaway DATABASE_URL) ----
  server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: WEB_DIR,
    env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(PORT), NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let serverLog = "";
  server.stdout.on("data", (d) => { serverLog += d.toString(); });
  server.stderr.on("data", (d) => { serverLog += d.toString(); });

  const up = await waitForServer(120000);
  check("独立 next dev 就绪(隔离端口+throwaway DB)", up, up ? {} : { tail: serverLog.slice(-600) });
  if (!up) throw new Error("isolated server failed to start");

  // ---- 4) 浏览器驱动真实路径 ----
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  const page = await ctx.newPage();

  // 抓 + 桩 POST /api/chat(用 pathname 精确匹配,排除 /api/chat/new 等;GET 历史放行)。
  const chatPosts = [];
  await page.route(
    (url) => {
      try { return new URL(url).pathname === "/api/chat"; } catch { return false; }
    },
    async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.continue();
      let body = null;
      try { body = JSON.parse(req.postData() || "null"); } catch { /* ignore */ }
      chatPosts.push({ text: body?.text ?? null, chatId: body?.chatId ?? null });
      // 先抓到 body(上面),再延迟一会儿才 fulfill:请求在飞期间客户端处于 streaming 态,
      // pendingUser(用户气泡)稳定可见 → 给气泡断言一个不闪退的窗口。fulfill 一旦完结/关闭,
      // chatStreams 会清 pendingUser 并 revalidate 历史(服务端没落库 → 空)→ 气泡消失。
      await new Promise((res) => setTimeout(res, 2000));
      // stub SSE:立即 done,绝不触达服务端 askStream → 零模型调用、零 token。
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
        body: 'data: {"delta":"（e2e 测试桩，无模型调用）"}\n\ndata: {"done":true}\n\n',
      });
    },
  );
  const postsWithText = (t) => chatPosts.filter((p) => p.text === t);
  async function waitForPost(text, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (postsWithText(text).length > 0) return true;
      await page.waitForTimeout(150);
    }
    return false;
  }

  await page.goto(`${HOST}/?productId=${PRODUCT_ID}&videoId=${VIDEO_ID}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // 「AI 助教」按钮出现 == video+course 就绪(cur 可用)。
  const chatBtn = page.getByRole("button", { name: "AI 助教" });
  await chatBtn.waitFor({ state: "visible", timeout: 60000 });
  await chatBtn.click();

  // 空白对话输入框(启用态 placeholder「问点什么…」)。
  const input = page.getByPlaceholder(/问点什么/);
  await input.waitFor({ state: "visible", timeout: 20000 });
  // 给默认聊天解析 effect(getChats→空)时间落定:零对话 → activeChatId 保持 null(懒建)。
  await page.waitForTimeout(1500);
  const disabled = await input.isDisabled();
  check("空白输入框启用(cur 已就绪、处于懒建态)", !disabled, { disabled });

  // ---- 第一条消息(被吞的那条)----
  await input.click();
  await input.fill(PROBE);
  const sendBtn = page.getByRole("button", { name: "send" });
  await sendBtn.click();

  const firstPosted = await waitForPost(PROBE, 10000);
  check("第一条消息触发 POST /api/chat(未被吞)", firstPosted, {
    posts: chatPosts.map((p) => p.text),
  });

  // 用户气泡渲染出 PROBE 文本(到达流层、非仅发了个请求)。
  let bubbleVisible = false;
  try {
    await page.getByText(PROBE, { exact: false }).first().waitFor({ state: "visible", timeout: 6000 });
    bubbleVisible = true;
  } catch { /* ignore */ }
  check("第一条用户气泡渲染(PROBE 文本可见)", bubbleVisible);

  const firstChatId = postsWithText(PROBE)[0]?.chatId ?? null;
  await page.screenshot({ path: SHOT, fullPage: false });

  // ---- 回归:在同一 chat 发第二条 ----
  // stub SSE 立即 done,流态应已回 idle,send 按钮重新启用;保险起见若仍有「停止」按钮先点掉。
  try {
    const stopBtn = page.getByRole("button", { name: "stop streaming" });
    if (await stopBtn.count()) {
      await stopBtn.first().click();
      await stopBtn.first().waitFor({ state: "hidden", timeout: 8000 });
    }
  } catch { /* ignore */ }
  await page.waitForTimeout(500);

  await input.click();
  await input.fill(PROBE2);
  await page.getByRole("button", { name: "send" }).click();
  const secondPosted = await waitForPost(PROBE2, 10000);
  const secondChatId = postsWithText(PROBE2)[0]?.chatId ?? null;
  check("第二条消息触发 POST /api/chat(已存在 chat 路径未回归)", secondPosted, { secondChatId });
  if (firstPosted && secondPosted) {
    check("两条消息同一 chatId", !!firstChatId && secondChatId === firstChatId, { firstChatId, secondChatId });
  }
}

const watchdog = setTimeout(() => {
  console.log("FATAL  watchdog 触发(>200s),强制退出");
  try { if (server?.pid) process.kill(-server.pid, "SIGKILL"); } catch { /* ignore */ }
  process.exit(1);
}, 200000);

try {
  await main();
} catch (e) {
  check("FATAL", false, { error: e.message });
} finally {
  clearTimeout(watchdog);
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  // 杀掉整个 next dev 进程组(它会派生编译 worker)。
  try { if (server?.pid) process.kill(-server.pid, "SIGKILL"); } catch { /* ignore */ }
  killPort(PORT);
  rmDb();
  console.log(`SHOT: ${SHOT}`);
}

const ok = results.length > 0 && results.every((r) => r.ok === true);
console.log(`\nALL PASS: ${ok}`);
process.exit(ok ? 0 : 1);
