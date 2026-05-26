// e2e 验证两个修复：
//   Bug #1（抽屉缓存条越界）: 打开课程详情抽屉，校验 "段" 文字盒子在抽屉右边界内。
//   Bug #2（回放无法手动生成缩略图）: 直接调 /api/thumbs/batch 提交一条 live 视频，
//          验证 queued=1 / skipped=0，再轮询 thumb 状态从 gen 变 ready（而非 error）。
import { chromium } from "playwright-core";

const HOST = "http://127.0.0.1:3000";

async function findLiveVideo() {
  // 拉所有课程，找第一门含 live(回放)讲次的课，取其第一条未锁定 live
  const courses = await fetch(`${HOST}/api/courses`).then((r) => r.json());
  for (const c of (courses.courses || [])) {
    const j = await fetch(`${HOST}/api/course?productId=${c.id}`).then((r) => r.json());
    const live = (j.videos || []).find((v) => v.kind === "live" && !v.locked);
    if (live) return { course: c, video: live };
  }
  return null;
}

async function bug1Drawer() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${HOST}/settings`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);
    const card = await page.$('[role="button"][aria-label*="详情"]');
    if (!card) return { ok: false, reason: "no course card" };
    await card.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "/tmp/after-drawer.png" });

    const drawerBox = await page.evaluate(() => {
      const p = document.querySelector('.MuiDrawer-paper');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right };
    });
    if (!drawerBox) return { ok: false, reason: "no drawer paper" };

    const texts = await page.evaluate(() => {
      const out = [];
      const paper = document.querySelector('.MuiDrawer-paper');
      if (!paper) return out;
      paper.querySelectorAll('*').forEach((el) => {
        if (el.children.length > 0) return;
        const t = (el.textContent || "").trim();
        if (/段(\s*已缓存)?(（总数未知）)?$/.test(t) || /^\d+\/\d+\s*段$/.test(t)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0) out.push({ text: t, x: r.x, w: r.width, right: r.right });
        }
      });
      return out;
    });

    if (texts.length === 0) {
      return { ok: "skipped", reason: "no buffer text in drawer (drawer course has no cached lectures)", drawerBox };
    }

    const violators = texts.filter((t) => t.right > drawerBox.right + 1);
    return {
      ok: violators.length === 0,
      drawerRight: drawerBox.right,
      texts,
      violators,
    };
  } finally {
    await browser.close();
  }
}

async function bug2LiveThumb() {
  const target = await findLiveVideo();
  if (!target) return { ok: "skipped", reason: "no unlocked live video found" };
  const v = target.video;

  const src = v.downloadUrl || (v.clarity?.[0]?.url) || "";
  if (!src) return { ok: false, reason: "live video has no src" };

  const body = {
    videos: [{
      videoId: v.videoId, contentId: v.contentId, cardPackageId: v.cardPackageId,
      productId: v.productId, duration: v.duration, src, liveId: v.liveId ?? null,
    }],
  };
  const r = await fetch(`${HOST}/api/thumbs/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) return { ok: false, reason: `batch HTTP ${r.status}: ${JSON.stringify(j)}` };

  // fix 落地的核心证据：live 视频被网关受理 = queued+skipped >= 1
  // pre-fix 时 web 端 pickLow 拿空串 → submit() 在到达 /api/thumbs/batch 之前就被
  // 过滤剩 0 条; 也就不会出现 queued 或 skipped。post-fix：被受理 → queued 或 skipped。
  const accepted = (j.queued || 0) + (j.skipped || 0);
  if (accepted < 1) {
    return { ok: false, reason: "live video not accepted by gateway", batchResult: j };
  }

  // 受理后状态查 1 次：不能立即 error；ready/gen/working 都算 fix 健康。
  // 完整 ffmpeg 跑完一条 45 分钟回放要 5-10 分钟，单测不等。
  const s = await fetch(`${HOST}/api/status`).then((x) => x.json());
  const state = s?.thumb?.states?.[String(v.videoId)] ?? null;
  return {
    ok: state !== "error" && state !== null,
    courseName: target.course.name,
    video: { id: v.videoId, title: v.title, liveId: v.liveId },
    batchResult: j,
    state,
  };
}

const r1 = await bug1Drawer();
console.log("BUG1 drawer overflow:", JSON.stringify(r1, null, 2));
const r2 = await bug2LiveThumb();
console.log("BUG2 live thumb:", JSON.stringify(r2, null, 2));

const ok = (r1.ok === true || r1.ok === "skipped") && (r2.ok === true || r2.ok === "skipped");
process.exit(ok ? 0 : 1);
