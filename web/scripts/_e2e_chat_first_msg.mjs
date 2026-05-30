// e2e: AI 助教「新建对话发送第一条消息会被吞掉」回归。
//
// 复现的是 *懒建* 路径(不是点「新建本讲对话」按钮):
//   在一个「零对话」的讲上打开 AI 助教面板 → activeChatId 保持 null(空白态)→
//   直接往输入框打第一条消息发送 → ChatBody.doSend 先 createLessonChat 再 send。
//   修复前:send 闭包里的 chatId 仍是 null → if(!chatId) return → 第一条被吞(无 POST /api/chat)。
//   修复后:doSend 把刚建好的 id 透传给 send → POST /api/chat 正常发出。
//
// 硬失败信号(能区分 修复生效 vs 没生效):
//   1) 出现一条 body.text === PROBE 的 POST /api/chat(第一条消息真的发了)。
//      —— 修复前第一条被吞,没有这条 POST;但「第二条」能发(闭包此时已有 chatId)。
//      所以必须按 *探针文本* 匹配,不能只看 POST 数量,否则会被第二条 POST 误判为通过。
//   2) 第一条消息的用户气泡(pendingUser)带着 PROBE 文本渲染出来。
//   3) 回归:停掉第一条的流后,在同一 chat 再发第二条 → 出现 body.text===PROBE2 的 POST,
//      且 chatId 与第一条相同(已存在 chat 的发送路径未被改坏 / 复现「只有第一条被吞」)。
//
// 可重复:不破坏用户数据 —— 动态挑一个「当前零对话」的讲;结束时只删除本次跑出来的 chat
//   (before/after 差集),把该讲还原成零对话,下次仍能 RED。
import { chromium } from "playwright-core";

const HOST = "http://127.0.0.1:3000";
const SHOT = "/tmp/chat-first-msg.png";
const PROBE = "__E2E_FIRST_MSG_PROBE__";
const PROBE2 = "__E2E_SECOND_MSG_PROBE__";

const results = [];
const check = (name, ok, extra = {}) => {
  results.push({ name, ok, ...extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""));
};

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}
async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}
const lessonKey = (p, v) => `${p}:${v}`;

// ---- 1) 发现一个「零对话」的解锁讲 ----
const allChats = await getJSON(`${HOST}/api/chats`);
const hasChat = new Set(
  allChats.chats.filter((c) => c.kind === "lesson").map((c) => lessonKey(c.productId, c.videoId)),
);
const { courses } = await getJSON(`${HOST}/api/courses`);
let target = null;
for (const c of courses) {
  let vs;
  try {
    vs = (await getJSON(`${HOST}/api/course?productId=${c.id}`)).videos || [];
  } catch {
    continue;
  }
  const v = vs.find((vid) => !vid.locked && !hasChat.has(lessonKey(c.id, vid.videoId)));
  if (v) {
    target = { productId: c.id, videoId: v.videoId, title: v.title ?? "" };
    break;
  }
}
if (!target) {
  console.log("FATAL  无法找到「零对话」的解锁讲(无法复现懒建路径)");
  process.exit(1);
}
console.log(`target lesson: productId=${target.productId} videoId=${target.videoId} «${target.title}»`);

// 前置快照:该讲对话应为空(差集兜底)。
const beforeChats = (await getJSON(
  `${HOST}/api/chats?scope=lesson&productId=${target.productId}&videoId=${target.videoId}`,
)).chats;
const beforeIds = new Set(beforeChats.map((c) => c.id));
check("precondition: 目标讲零对话", beforeIds.size === 0, { existing: beforeIds.size });

// ---- 2) 浏览器驱动真实路径 ----
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
const page = await ctx.newPage();

// 抓 POST /api/chat(精确路径,排除 /api/chat/new、/api/chat/delete、GET ?chatId=)。
const chatPosts = [];
page.on("request", (req) => {
  if (req.method() !== "POST") return;
  let path;
  try {
    path = new URL(req.url()).pathname;
  } catch {
    return;
  }
  if (path !== "/api/chat") return;
  let body = null;
  try {
    body = JSON.parse(req.postData() || "null");
  } catch {
    /* ignore */
  }
  chatPosts.push({ text: body?.text ?? null, chatId: body?.chatId ?? null });
});
const postsWithText = (t) => chatPosts.filter((p) => p.text === t);
async function waitForPost(text, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (postsWithText(text).length > 0) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

try {
  await page.goto(`${HOST}/?productId=${target.productId}&videoId=${target.videoId}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // 「AI 助教」按钮出现 == video+course 就绪(cur 可用)。
  const chatBtn = page.getByRole("button", { name: "AI 助教" });
  await chatBtn.waitFor({ state: "visible", timeout: 30000 });
  await chatBtn.click();

  // 空白对话输入框(启用态 placeholder「问点什么…」)。
  const input = page.getByPlaceholder(/问点什么/);
  await input.waitFor({ state: "visible", timeout: 15000 });
  // 给默认聊天解析 effect(getChats→空)时间落定:零对话 → activeChatId 保持 null(懒建)。
  await page.waitForTimeout(1500);
  const disabled = await input.isDisabled();
  check("空白输入框启用(cur 已就绪、处于懒建态)", !disabled, { disabled });

  // ---- 第一条消息(被吞的那条)----
  await input.click();
  await input.fill(PROBE);
  const sendBtn = page.getByRole("button", { name: "send" });
  await sendBtn.click();

  const firstPosted = await waitForPost(PROBE, 8000);
  check("第一条消息触发 POST /api/chat(未被吞)", firstPosted, {
    posts: chatPosts.map((p) => p.text),
  });

  // 用户气泡渲染出 PROBE 文本(到达流层、非仅发了个请求)。
  let bubbleVisible = false;
  try {
    await page.getByText(PROBE, { exact: false }).first().waitFor({ state: "visible", timeout: 5000 });
    bubbleVisible = true;
  } catch {
    /* ignore */
  }
  check("第一条用户气泡渲染(PROBE 文本可见)", bubbleVisible);

  const firstChatId = postsWithText(PROBE)[0]?.chatId ?? null;
  await page.screenshot({ path: SHOT, fullPage: false });

  // ---- 回归:停掉流,在同一 chat 发第二条 ----
  // 修复前这里也能发(复现「只有第一条被吞」);修复后同样能发(已存在 chat 路径未改坏)。
  const stopBtn = page.getByRole("button", { name: "stop streaming" });
  try {
    if (await stopBtn.count()) {
      await stopBtn.first().click();
      await stopBtn.first().waitFor({ state: "hidden", timeout: 8000 });
    }
  } catch {
    /* RED 态可能根本没有流/停止按钮 — 忽略 */
  }
  await page.waitForTimeout(500);

  await input.click();
  await input.fill(PROBE2);
  // send 按钮在非流态下重新启用。
  await page.getByRole("button", { name: "send" }).click();
  const secondPosted = await waitForPost(PROBE2, 8000);
  const secondChatId = postsWithText(PROBE2)[0]?.chatId ?? null;
  check("第二条消息触发 POST /api/chat(已存在 chat 路径未回归)", secondPosted, {
    secondChatId,
  });
  if (firstPosted && secondPosted) {
    check("两条消息同一 chatId", firstChatId && secondChatId === firstChatId, {
      firstChatId,
      secondChatId,
    });
  }

  // 收尾:尽量停掉第二条的流,省 token。
  try {
    const s2 = page.getByRole("button", { name: "stop streaming" });
    if (await s2.count()) await s2.first().click();
  } catch {
    /* ignore */
  }
} catch (e) {
  check("FATAL", false, { error: e.message });
} finally {
  await browser.close();
  // 清理:删除本次跑出来的 chat(before/after 差集),还原零对话 → 可重复 RED。
  try {
    const after = (await getJSON(
      `${HOST}/api/chats?scope=lesson&productId=${target.productId}&videoId=${target.videoId}`,
    )).chats;
    const created = after.filter((c) => !beforeIds.has(c.id));
    for (const c of created) {
      try {
        await postJSON(`${HOST}/api/chat/delete`, { chatId: c.id });
      } catch {
        /* ignore */
      }
    }
    console.log(`cleanup: deleted ${created.length} test chat(s)`);
  } catch (e) {
    console.log("cleanup failed:", e.message);
  }
}

console.log("SHOT:", SHOT);
const ok = results.every((r) => r.ok === true);
console.log(`\nALL PASS: ${ok}`);
process.exit(ok ? 0 : 1);
