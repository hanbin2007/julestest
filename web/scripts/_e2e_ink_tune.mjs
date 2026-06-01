// e2e: /ink-tune 调参台。硬失败信号(非零退出)+ 截图留证。打【打包后】模块,不跑 node 纯数学拷贝。
// 用法: BASE=http://127.0.0.1:3000 node scripts/_e2e_ink_tune.mjs
// 段: §5.1 处理器数学 (Task 1) → 生产回归 (Task 2) → §5.2 页面像素/持久化/卸载还原 (Task 4)
import { chromium } from "playwright-core";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
// OUT 相对脚本自身定位(<repo>/web/scripts → <repo>/docs/...),与运行 cwd 无关,避免截图落到 web/docs。
const OUT = process.env.OUT || resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/superpowers/uac-shots");
let failed = 0;
const fail = (m) => {
  console.error("FAIL:", m);
  failed++;
};
const ok = (m) => console.log("OK:", m);

// 合成原始笔画:够长、够抖、够密——使 minSampleDist(抽稀)与 posMinCutoff(平滑)都明显改变输出。
// 固定时间戳,保证确定性与"流式==一次性"逐位相等。
function synthRaw() {
  const raw = [];
  for (let i = 0; i < 600; i++) {
    const t = i * 4; // ms 固定
    const jx = i % 2 ? 0.0025 : -0.0025; // 高频锯齿(像素级抖动,供平滑器消)
    const jy = i % 2 ? 0.0025 : -0.0025;
    const x = 0.3 + 0.2 * Math.sin(i * 0.05) + jx; // 密集小步(供抽稀)
    const y = 0.5 + 0.15 * Math.cos(i * 0.07) + jy;
    raw.push({ x, y, p: 0.5 + 0.3 * Math.sin(i * 0.02), t });
  }
  return raw;
}
// 完整 InkTuning(按 main 接口,不抄已删老页的 despike* 字段)。
function baseCfg() {
  return {
    posMinCutoff: 0.5, posBeta: 0.95, dCutoff: 1, pressMinCutoff: 1.5, pressBeta: 0.3,
    cornerStrength: 0.7,
    pen: { thinning: 0.6, smoothing: 0.5, streamline: 0.58, taperStart: 0, taperEnd: 2.5 },
    marker: { thinning: 0, smoothing: 0.5, streamline: 0.25, taperStart: 0, taperEnd: 0 },
    minSampleDist: 0.1,
  };
}

let browser;
(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  try {
    // ---------- §5.1 处理器数学 ----------
    await page.goto(`${BASE}/ink-tune`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => !!window.__inktune?.InkStrokeProcessor, null, { timeout: 15000 });

    const r = await page.evaluate(
      ({ raw, cfg }) => {
        const { InkStrokeProcessor: P } = window.__inktune;
        const W = 1000, H = 600;
        const a1 = P.processAll(raw, cfg, W, H);
        const a2 = P.processAll(raw, cfg, W, H);
        const det = JSON.stringify(a1) === JSON.stringify(a2);
        // 抽稀生效:只改 minSampleDist 0.1→3 → 样本数明显减少。
        const cDec = { ...cfg, minSampleDist: 3 };
        const dec = P.processAll(raw, cDec, W, H);
        const decimates = dec.length < a1.length;
        // 平滑生效:只改 posMinCutoff 0.5→4 → 坐标明显不同(数同则比内容)。
        const cSm = { ...cfg, posMinCutoff: 4 };
        const sm = P.processAll(raw, cSm, W, H);
        const smooths = JSON.stringify(sm) !== JSON.stringify(a1);
        // 流式==一次性:分批 push vs 一次 processAll。
        const p = new P(cfg, W, H);
        let streamed = [];
        for (let i = 0; i < raw.length; i += 7) streamed = streamed.concat(p.push(raw.slice(i, i + 7)));
        const streamEqOnce = JSON.stringify(streamed) === JSON.stringify(a1);
        return { det, decimates, smooths, streamEqOnce, nA: a1.length, nDec: dec.length };
      },
      { raw: synthRaw(), cfg: baseCfg() }
    );

    if (!r.det) fail("处理器非确定性(同输入两次结果不同)");
    else ok("确定性");
    if (!r.decimates) fail(`抽稀未生效:minSampleDist 0.1(n=${r.nA}) vs 3(n=${r.nDec}) 样本数未减少`);
    else ok(`抽稀生效 ${r.nA}→${r.nDec}`);
    if (!r.smooths) fail("平滑未生效:posMinCutoff 0.5 vs 4 输出相同");
    else ok("平滑生效");
    if (!r.streamEqOnce) fail("流式≠一次性(生产 push 路径与调参台 processAll 不一致)");
    else ok("流式==一次性");

    // ---------- 生产回归:裸 AnnotationLayer 仍 push + 渲染 ----------
    // 用真实鼠标事件(pointerType=mouse,非掌拒;有效指针捕获,避免合成 PointerEvent 的 InvalidPointerId)。
    await page.goto(`${BASE}/ink-tune/regress`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => !!window.__regress, null, { timeout: 15000 });
    const live = page.locator("canvas").last(); // 顶层 live canvas 收指针
    const box = await live.boundingBox();
    if (!box) fail("回归:找不到 live canvas");
    else {
      const X = (nx) => box.x + nx * box.width;
      const Y = (ny) => box.y + ny * box.height;
      await page.mouse.move(X(0.1), Y(0.5));
      await page.mouse.down();
      for (let i = 1; i <= 40; i++) await page.mouse.move(X(0.1 + i * 0.02), Y(0.5 + Math.sin(i * 0.3) * 0.12));
      await page.mouse.up();
      await page.waitForTimeout(200);
      const reg = await page.evaluate(() => ({
        n: window.__regress.objectCount(),
        url: window.__regress.committedDataURL(),
      }));
      // 空白 800x500 透明 canvas 的 dataURL 很短;画了一笔后明显变长。阈值取保守值。
      if (reg.n !== 1) fail(`生产回归:画一笔后 api.objects=${reg.n}(应为 1)——push 路径坏了`);
      else ok("生产回归:api.push 正常");
      if (!reg.url || reg.url.length < 3000) fail(`生产回归:committed canvas 像素疑似空白(len=${reg.url?.length})——渲染坏了`);
      else ok("生产回归:committed 渲染正常");
      await page.screenshot({ path: `${OUT}/inktune_regress.png` });
    }
    // ---------- §5.2 页面像素 / 持久化 / A/B / 卸载还原 ----------
    await page.goto(`${BASE}/ink-tune`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => !!window.__inktune?.importBundle, null, { timeout: 15000 });
    // 干净起点:清两个 key 再导入已知笔画(同 context 内做 reload 持久化断言;跨进程调用天然新 context)。
    await page.evaluate(() => {
      localStorage.removeItem("inktune.strokes.v1");
      localStorage.removeItem("inktune.tuning.v1");
    });

    // 导入一组合成笔画(够长够抖够密,使两阶段都改像素)。bundle.tuning 用出厂基线起点。
    await page.evaluate(
      ({ raw }) => {
        const strokes = [
          { id: "s1", raw, w: 800, h: 500, tool: "pen", color: "#ff5252", width: 0.012 },
          { id: "s2", raw: raw.map((s) => ({ ...s, x: s.x + 0.1, y: s.y - 0.1 })), w: 800, h: 500, tool: "pen", color: "#4fc3f7", width: 0.012 },
        ];
        window.__inktune.importBundle(JSON.stringify({ v: 1, tuning: window.__inktune.getTuning(), strokes }));
      },
      { raw: synthRaw() }
    );
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/inktune_imported.png` });

    const blankish = (u) => !u || u.length < 3000;
    const base = await page.evaluate(() => window.__inktune.stageDataURL());
    if (blankish(base)) fail(`§5.2:导入后 stage 疑似空白(len=${base?.length})`);
    else ok("§5.2:导入后 stage 非空");
    const cnt0 = await page.evaluate(() => window.__inktune.getStrokeCount());
    if (cnt0 !== 2) fail(`§5.2:导入笔画数=${cnt0}(应 2)`);
    else ok("§5.2:导入笔画数 2");

    // 渲染阶段:pen.thinning → 0.95,像素必须变。
    await page.evaluate(() => window.__inktune.setParam("pen.thinning", 0.95));
    await page.waitForTimeout(100);
    const afterRender = await page.evaluate(() => window.__inktune.stageDataURL());
    if (afterRender === base) fail("§5.2:改 pen.thinning 后 stage 像素未变(渲染阶段重算没作用于已录笔画)");
    else ok("§5.2:渲染阶段参数作用于已录笔画");

    // 输入阶段:minSampleDist 0.1 → 4,像素必须变(证明 processAll 对已录【原始数据】重跑了输入阶段)。
    const beforeInput = await page.evaluate(() => window.__inktune.stageDataURL());
    await page.evaluate(() => window.__inktune.setParam("minSampleDist", 4));
    await page.waitForTimeout(100);
    const afterInput = await page.evaluate(() => window.__inktune.stageDataURL());
    if (afterInput === beforeInput) fail("§5.2:改 minSampleDist 后 stage 像素未变(输入阶段没对已录原始数据重跑)");
    else ok("§5.2:输入阶段参数作用于已录笔画");

    // A/B:开"对比基线",像素较关闭时变(基线幽灵层出现)。
    const beforeAB = await page.evaluate(() => window.__inktune.stageDataURL());
    await page.evaluate(() => window.__inktune.setAB(true));
    await page.waitForTimeout(120);
    const afterAB = await page.evaluate(() => window.__inktune.stageDataURL());
    if (afterAB === beforeAB) fail("§5.2:开 A/B 后 stage 像素未变(基线幽灵层没出现)");
    else ok("§5.2:A/B 基线幽灵层生效");
    await page.screenshot({ path: `${OUT}/inktune_ab.png` });

    // reload 持久化:同 context 刷新 → 笔画数 + 候选参数(pen.thinning=0.95)仍在。
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.__inktune?.getStrokeCount, null, { timeout: 15000 });
    const cntR = await page.evaluate(() => window.__inktune.getStrokeCount());
    const tR = await page.evaluate(() => window.__inktune.getTuning());
    if (cntR !== 2) fail(`§5.2:reload 后笔画数=${cntR}(应 2,持久化丢了)`);
    else ok("§5.2:reload 笔画持久化");
    if (Math.abs(tR.pen.thinning - 0.95) > 1e-6) fail(`§5.2:reload 后 pen.thinning=${tR.pen.thinning}(应 0.95,候选参数没续上)`);
    else ok("§5.2:reload 候选参数续上");

    // 卸载还原(安全攸关):改参数后客户端导航离开 → 全局 tuning 还原出厂,候选不泄漏进真实播放器。
    await page.evaluate(() => window.__inktune.setParam("pen.thinning", 0.02));
    await page.click("text=返回"); // Next 客户端导航(非整页刷新),触发 ink-tune 卸载→cleanup 还原
    // 条件式等待:轮询 URL 真正离开 /ink-tune(=导航提交、页面卸载),而非定值 sleep。
    // 若页面有忙循环霸占主线程,startTransition 跳转无法提交,这里会超时暴露问题。
    let navAway = false;
    for (let i = 0; i < 30; i++) {
      const u = await page.evaluate(() => location.pathname);
      if (u !== "/ink-tune") { navAway = true; break; }
      await page.waitForTimeout(300);
    }
    if (!navAway) fail("§5.2:点返回后 9s 内仍未离开 /ink-tune(客户端导航没提交,页面未卸载——疑似忙循环霸占主线程)");
    else {
      await page.waitForTimeout(150); // 让 unmount cleanup 跑完
      const probe = await page.evaluate(() => window.__inkTuningProbe?.()); // 模块级探针,survive 卸载
      const FACTORY_THINNING = 0.37; // inkTuning.ts pen.thinning 出厂默认(2026-05-30 定稿);改默认须同步此值
      if (!probe) fail("§5.2:__inkTuningProbe 不存在(无法验证卸载还原)");
      else if (Math.abs(probe.pen.thinning - FACTORY_THINNING) > 1e-6)
        fail(`§5.2:卸载后全局 tuning.pen.thinning=${probe.pen.thinning}(应还原出厂 ${FACTORY_THINNING})——候选泄漏进生产!`);
      else ok("§5.2:卸载还原全局 tuning 出厂(候选不泄漏)");
    }

    await page.screenshot({ path: `${OUT}/inktune_done.png` });
  } catch (e) {
    console.error("FATAL:", e.message);
    failed++;
  } finally {
    if (errors.length) errors.slice(0, 12).forEach((er) => console.log("  ERR:", er.slice(0, 200)));
    await browser.close();
    if (failed) {
      console.error(`\n${failed} 项失败`);
      process.exitCode = 1;
    } else console.log("\n全部通过");
  }
})();
