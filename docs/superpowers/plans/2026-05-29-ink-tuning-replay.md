# 墨迹调参回放台 (`/ink-tune`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个 `/ink-tune` 调参台:录制原始手写笔画(带时间戳的 `RawSample[]`),拖任意手感参数时之前录的笔画即时按新参数两阶段重算重绘,A/B 对出厂基线,持久化+导入导出,最后把"赢的值"手贴回 `inkTuning.ts`。

**Architecture:** 把生产输入阶段(`AnnotationLayer.acceptSamples` 的 One Euro 去抖+保角+抽稀)抽成共享类 `InkStrokeProcessor`,生产与调参台共用同一份代码(保真)。调参台页面自管 `RecordedStroke[]` 真源:用 `AnnotationLayer`(传新 `onCommitStroke` prop,抑制 `api.push`)只当输入面,已录笔画由页面自己的 stage canvas 经 `drawObject`(读模块级全局 `tuning`)渲染。改参数=就地改全局 `tuning` 字段 → 重画。

**Tech Stack:** Next.js App Router (client component) + Canvas 2D + perfect-freehand(经现有 `renderEngine`)。测试:`playwright-core` + 本机 Chrome 无头(沿用 `smoke.mjs` 惯例),所有断言打**实际打包后的模块**(经 `window.__inktune` / `window.__regress` 钩子)。无 `tsx`/`ts-node`,不写 node 纯数学拷贝(会漂移)。

**关键约束(来自 spec `docs/superpowers/specs/2026-05-29-ink-tuning-replay-design.md`,已核对 main 源码):**
- `tuning` 是 **`export const`(不可重新赋值)**——所有改参/还原必须**就地改字段**。还原用 `Object.assign(tuning, structuredClone(BASELINE_TUNING))`(连 `pen`/`marker` 嵌套对象一起换;`renderEngine` 每次绘制都重读 `tuning.pen`,安全)。任何 `tuning = {...}` 都编译失败。
- `inkOutlinePath` **未导出**;stage 渲染走**已导出的 `drawObject`**(内部读全局 `tuning`)。
- One Euro 在**像素空间**滤波:每条录制笔画存录制当时 `(w,h)`;回放 `processAll(raw, cfg, recordedW, recordedH)`;时间戳 `t` 一律用录制的,绝不重造。
- `videoContentRect(box,box,0,0)` 返回整盒(已核对 `videoFit.ts:14`)——无 video 时 AnnotationLayer 与 stage canvas 同为整舞台盒,归一化 0–1 自然对齐。
- **生产回归是最大盲点**:本计划重写了每节课批注都走的生产输入路径。CLAUDE.md 禁止"数学上应该等价"当 done——必须 e2e 验证生产绘制仍工作(Task 2)。
- **卸载还原是唯一安全攸关不变量**:候选参数绝不能在同一 SPA 会话里泄漏进真实播放器(spec §4.6)。必须 e2e 验证(Task 4)。

**部署口径 `<REDEPLOY>`(每个改 `web/src/` 的 Task 跑 e2e 前必做;`run.sh` 是监督模式——单杀网关会被秒级重启,必须 `kill -TERM` 整个 run.sh 才停栈;见 `julestest-deploy-restart` memory):**
```bash
# 1) 构建(=typecheck/build gate;run.sh 仅在缺 BUILD_ID 时才自动构建,故手动构建)
cd /Users/zhb/Documents/julestest/web && npm run build
# 2) 停旧栈:kill -TERM run.sh 进程(trap 级联杀两子进程),poll 端口空
pkill -TERM -f "bash ./run.sh" || true
until [ -z "$(lsof -nP -iTCP:3000,8808 -sTCP:LISTEN -t 2>/dev/null)" ]; do sleep 1; done
# 3) durable 重启(macOS 无 setsid → perl;reparent 到 launchd,survive agent job 结束)
cd /Users/zhb/Documents/julestest && nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' ./run.sh > "$HOME/.youdao_course/run.log" 2>&1 </dev/null & disown
# 4) 等新 build 起来
until curl -sf http://127.0.0.1:3000/ >/dev/null; do sleep 1; done
```

**分支:** `ink-tune-replay`(已在此分支;spec 已提交 `af7fe64`)。

---

## File Structure

| 文件 | 责任 | Task |
|---|---|---|
| `web/src/components/annotate/inkProcessor.ts`(新) | 输入阶段处理器 `InkStrokeProcessor`:One Euro 去抖+保角(`StrokeSmoother`)+ `minSampleDist` 抽稀。纯数学、无 DOM。生产流式 `push()` 与调参台一次性 `processAll()` 数学等价。 | 1 |
| `web/src/app/ink-tune/page.tsx`(新) | 调参台:输入面(`AnnotationLayer`+`onCommitStroke`)+ stage canvas 渲染已录笔画 + 控制面板 + A/B 基线 + 持久化 + `window.__inktune` 钩子。Task 1 先建**骨架**(只暴露处理器),Task 3 替换为完整页。 | 1, 3 |
| `web/src/app/ink-tune/regress/page.tsx`(新) | 生产回归测试夹具:挂裸 `AnnotationLayer`(**不传** `onCommitStroke` = 生产路径),暴露 `window.__regress` 读 `api.objects` 数 + committed canvas 像素。 | 2 |
| `web/src/components/annotate/AnnotationLayer.tsx`(改) | 输入阶段抽到 `InkStrokeProcessor`(行为不变);加可选 `onCommitStroke` prop;累积每笔原始样本 `rawStrokeRef`。 | 2 |
| `web/scripts/_e2e_ink_tune.mjs`(新) | 单一 Playwright 脚本:§5.1 处理器数学 + 生产回归 + §5.2 页面像素/持久化/卸载还原。硬失败信号 + 截图。 | 1, 2, 4 |
| 只读复用 | `inkTuning.ts`(`tuning`/`InkTuning`/`PenTuning`)、`oneEuro.ts`(`StrokeSmoother`)、`inputPipeline.ts`(`RawSample`/`extractSamples`)、`renderEngine.ts`(`drawObject`)、`model.ts`(`InkObject`/`InkSample`/`Pt`/`identity`/`COLORS`/`WIDTHS`/`newId`)、`useAnnotation.ts`(`useAnnotation`)、`videoFit.ts`。 | — |

---

## Task 1: 走通骨架(`InkStrokeProcessor` + 骨架页 + §5.1 处理器数学 e2e)

目标:第一个 green 在一个 Task 内可达——证明①处理器数学正确(确定性/参数生效/流式==一次性)②Playwright 打打包模块的测试夹具能跑。

**Files:**
- Create: `web/src/components/annotate/inkProcessor.ts`
- Create: `web/src/app/ink-tune/page.tsx`(骨架,Task 3 替换)
- Create: `web/scripts/_e2e_ink_tune.mjs`(§5.1 段,Task 2/4 续加)

- [ ] **Step 1: 写 `InkStrokeProcessor`**

Create `web/src/components/annotate/inkProcessor.ts`:

```ts
// 一笔的输入阶段处理器——从 AnnotationLayer.acceptSamples 抽出,生产与 /ink-tune 调参台共用同一份代码(保真)。
// One Euro 去抖+保角(StrokeSmoother)在【像素空间】跑;再按 minSampleDist 抽稀。
// 状态(滤波器、上一采样)跨批次保持,故流式 push() 与一次性 processAll() 数学等价
// —— 只要喂入的原始样本顺序与时间戳一致,分批 vs 整段结果完全相同。
import { StrokeSmoother } from "./oneEuro";
import type { InkTuning } from "./inkTuning";
import type { RawSample } from "./inputPipeline";
import type { InkSample, Pt } from "./model";

export class InkStrokeProcessor {
  private sm = new StrokeSmoother();
  private last: Pt | null = null;
  // cfg 按引用持有:生产传入的是模块级全局 `tuning`,故 cfg.minSampleDist 与原 acceptSamples
  // 一样每样本读"活值"。OneEuro 7 参数在构造时 configure() 快照(对应原 onDown 时的快照)。
  constructor(private cfg: InkTuning, private w: number, private h: number) {
    this.sm.configure(
      cfg.posMinCutoff, cfg.posBeta, cfg.dCutoff,
      cfg.pressMinCutoff, cfg.pressBeta, cfg.cornerStrength
    );
    this.sm.reset();
  }

  // 流式:喂一批原始样本(归一化 0–1 + t),返回本批新接受(去抖+抽稀后)的样本。生产 AnnotationLayer 每 rAF 调。
  push(raw: RawSample[]): InkSample[] {
    const out: InkSample[] = [];
    for (const s of raw) {
      // 像素空间去抖+保角——One Euro 的 cutoff(Hz)/beta(对 px/s) 只有在像素空间才有物理意义。
      const pt = this.sm.point(s.x * this.w, s.y * this.h, s.t);
      const fx = pt.x / this.w;
      const fy = pt.y / this.h;
      const fp = s.p === undefined ? undefined : this.sm.pressure(s.p, s.t);
      if (
        !this.last ||
        Math.hypot((fx - this.last.x) * this.w, (fy - this.last.y) * this.h) >= this.cfg.minSampleDist
      ) {
        const samp: InkSample = fp === undefined ? { x: fx, y: fy } : { x: fx, y: fy, p: fp };
        out.push(samp);
        this.last = samp;
      }
    }
    return out;
  }

  // 一次性:整条原始笔画 → 全部样本。调参台重算时用。等价于 new + 一次 push 全部。
  static processAll(raw: RawSample[], cfg: InkTuning, w: number, h: number): InkSample[] {
    return new InkStrokeProcessor(cfg, w, h).push(raw);
  }
}
```

- [ ] **Step 2: 写骨架页(只暴露处理器)**

Create `web/src/app/ink-tune/page.tsx`(Task 3 会整文件替换):

```tsx
"use client";
import * as React from "react";
import { InkStrokeProcessor } from "@/components/annotate/inkProcessor";

// 骨架:仅把打包后的 InkStrokeProcessor 暴露给 e2e 验证 §5.1 处理器数学。Task 3 替换为完整调参台。
export default function InkTunePage() {
  React.useEffect(() => {
    (window as typeof window & { __inktune?: unknown }).__inktune = { InkStrokeProcessor };
    return () => {
      delete (window as typeof window & { __inktune?: unknown }).__inktune;
    };
  });
  return <div data-testid="ink-tune-skeleton" style={{ padding: 24 }}>ink-tune skeleton</div>;
}
```

- [ ] **Step 3: 写 §5.1 e2e(处理器数学,先红)**

Create `web/scripts/_e2e_ink_tune.mjs`:

```js
// e2e: /ink-tune 调参台。硬失败信号(非零退出)+ 截图留证。打【打包后】模块,不跑 node 纯数学拷贝。
// 用法: BASE=http://127.0.0.1:3000 node scripts/_e2e_ink_tune.mjs
// 段: §5.1 处理器数学 (Task 1) → 生产回归 (Task 2) → §5.2 页面像素/持久化/卸载还原 (Task 4)
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const OUT = process.env.OUT || "docs/superpowers/uac-shots";
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
    await page.goto(`${BASE}/ink-tune`, { waitUntil: "networkidle", timeout: 30000 });
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

    // (Task 2 在此插入"生产回归"段)
    // (Task 4 在此插入 §5.2 页面像素/持久化/卸载还原段)

    await page.screenshot({ path: `${OUT}/inktune_skeleton.png` });
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
```

- [ ] **Step 4: 构建 + 重启 + 跑 e2e(看红→绿)**

```bash
# 先执行顶部 <REDEPLOY> 全部 4 步(build + 停栈 + durable 重启 + 等 :3000),然后跑 e2e:
cd /Users/zhb/Documents/julestest/web && node scripts/_e2e_ink_tune.mjs
```

Expected: `OK: 确定性` / `OK: 抽稀生效 600→NN` / `OK: 平滑生效` / `OK: 流式==一次性` / `全部通过`,退出码 0。
(若 `npm run build` 失败:`tuning`/类型导入名核对 `inkTuning.ts` 实际导出。)

- [ ] **Step 5: 提交**

```bash
cd /Users/zhb/Documents/julestest
git add web/src/components/annotate/inkProcessor.ts web/src/app/ink-tune/page.tsx web/scripts/_e2e_ink_tune.mjs docs/superpowers/uac-shots/inktune_skeleton.png
git commit -m "ink-tune Task1: InkStrokeProcessor + 骨架页 + §5.1 处理器数学 e2e(确定性/抽稀/平滑/流式==一次性)"
```

---

## Task 2: 生产路径重构(`AnnotationLayer` 抽 `InkStrokeProcessor` + `onCommitStroke`)+ 生产回归 e2e

目标:把生产输入阶段抽到共享处理器(行为不变),加调参台需要的 `onCommitStroke`/原始样本累积,**并 e2e 证明每节课的批注绘制仍正常**(CLAUDE.md 禁止"应该等价"当 done)。

**Files:**
- Modify: `web/src/components/annotate/AnnotationLayer.tsx`
- Create: `web/src/app/ink-tune/regress/page.tsx`
- Modify: `web/scripts/_e2e_ink_tune.mjs`(插入"生产回归"段)

- [ ] **Step 1: 改 import(去 `StrokeSmoother`,加 `InkStrokeProcessor`)**

In `web/src/components/annotate/AnnotationLayer.tsx`,把:
```ts
import { extractSamples, isDrawingPointer, type RawSample } from "./inputPipeline";
import { StrokeSmoother } from "./oneEuro";
```
改为:
```ts
import { extractSamples, isDrawingPointer, type RawSample } from "./inputPipeline";
import { InkStrokeProcessor } from "./inkProcessor";
```

- [ ] **Step 2: 加 `onCommitStroke` prop**

把组件签名:
```ts
export default function AnnotationLayer({ api, video }: { api: AnnotationApi; video?: HTMLVideoElement | null }) {
```
改为:
```ts
export default function AnnotationLayer({
  api,
  video,
  onCommitStroke,
}: {
  api: AnnotationApi;
  video?: HTMLVideoElement | null;
  // 提供时:落笔提交墨迹改为发出原始数据(供 /ink-tune 录制),且【不再 api.push】(让调参台独占对象真源)。
  // 不提供时:维持现状 api.push —— 生产零行为变化。仅作用于 pen/marker;形状不受影响。
  onCommitStroke?: (
    raw: RawSample[],
    frame: { w: number; h: number },
    meta: { tool: "pen" | "marker"; color: string; width: number }
  ) => void;
}) {
```

- [ ] **Step 3: 换 refs(去 `smootherRef`/`lastSampleRef`,加 `processorRef`/`rawStrokeRef`)**

把:
```ts
  const pendingRef = React.useRef<InkSample[]>([]);
  const lastSampleRef = React.useRef<Pt | null>(null); // 抽稀用：上一个被接受的采样
  const smootherRef = React.useRef(new StrokeSmoother()); // One Euro 去抖 + 保角，每笔重置
```
改为:
```ts
  const pendingRef = React.useRef<InkSample[]>([]);
  const processorRef = React.useRef<InkStrokeProcessor | null>(null); // 当前一笔的输入阶段处理器,onDown 建、onUp/onCancel 清
  const rawStrokeRef = React.useRef<RawSample[]>([]); // 当前一笔的原始样本累积(供 onCommitStroke 录制)
```

- [ ] **Step 4: 删 `acceptSamples`**

删除整个 `acceptSamples` 函数(`AnnotationLayer.tsx` 原 61–81 行,即从 `// 处理一批原始采样` 注释块到 `const acceptSamples = (raw) => { ... };` 结束)。其逻辑已搬进 `InkStrokeProcessor.push`。

- [ ] **Step 5: resize effect 改用 processor**

把 resize 处理器里:
```ts
      smootherRef.current.reset();
      lastSampleRef.current = null;
```
改为:
```ts
      // 进行中的一笔:尺寸变了重建处理器(像素空间基准变),等价于原来的 reset + 清抽稀基准。空闲(null)时无操作。
      if (processorRef.current) processorRef.current = new InkStrokeProcessor(tuning, w, h);
```

- [ ] **Step 6: `onDown` 的 pen/marker 分支改用 processor + 起原始累积**

把:
```ts
    if (tool === "pen" || tool === "marker") {
      lastSampleRef.current = null; // 新一笔，重置抽稀基准（首点必被接受）
      smootherRef.current.configure(
        tuning.posMinCutoff, tuning.posBeta, tuning.dCutoff,
        tuning.pressMinCutoff, tuning.pressBeta, tuning.cornerStrength
      );
      smootherRef.current.reset();
      const samples = acceptSamples(extractSamples(e.nativeEvent, rectOf()));
      drawingRef.current = { kind: "ink", id: newId(), tool, color, width, samples, transform: identity() };
    } else if (tool === "line" || tool === "rect" || tool === "ellipse" || tool === "arrow") {
```
改为:
```ts
    if (tool === "pen" || tool === "marker") {
      const { w, h } = sizeRef.current;
      const raw = extractSamples(e.nativeEvent, rectOf());
      rawStrokeRef.current = [...raw]; // 新一笔:原始样本从首批开始累积
      processorRef.current = new InkStrokeProcessor(tuning, w, h); // 构造即 configure+reset(读当前 tuning)
      const samples = processorRef.current.push(raw);
      drawingRef.current = { kind: "ink", id: newId(), tool, color, width, samples, transform: identity() };
    } else if (tool === "line" || tool === "rect" || tool === "ellipse" || tool === "arrow") {
```

- [ ] **Step 7: `onMove` 的 ink 分支改用 processor + 追加原始**

把:
```ts
    if (d.kind === "ink") pendingRef.current.push(...acceptSamples(extractSamples(e.nativeEvent, rectOf())));
    else d.b = ptFrom(e);
```
改为:
```ts
    if (d.kind === "ink") {
      const raw = extractSamples(e.nativeEvent, rectOf());
      rawStrokeRef.current.push(...raw);
      pendingRef.current.push(...(processorRef.current?.push(raw) ?? []));
    } else d.b = ptFrom(e);
```

- [ ] **Step 8: `onUp` 收尾——`onCommitStroke` 抑制 push,清原始累积**

把 `onUp` 末尾:
```ts
    if (!d) return;
    if (d.kind === "ink" && d.samples.length < 1) return;
    if (d.kind === "shape" && d.a.x === d.b.x && d.a.y === d.b.y) return;
    apiRef.current.push(d);
  };
```
改为:
```ts
    const finishInk = () => {
      rawStrokeRef.current = [];
      processorRef.current = null;
    };
    if (!d) {
      finishInk();
      return;
    }
    if (d.kind === "ink" && d.samples.length < 1) {
      finishInk();
      return;
    }
    if (d.kind === "shape" && d.a.x === d.b.x && d.a.y === d.b.y) return; // 形状不涉及原始累积
    if (d.kind === "ink" && onCommitStroke) {
      // 调参台模式:发原始数据给页面,不进 api(让调参台独占真源、撤销历史干净)
      onCommitStroke(rawStrokeRef.current, { ...sizeRef.current }, { tool: d.tool, color: d.color, width: d.width });
      finishInk();
      return;
    }
    finishInk();
    apiRef.current.push(d); // 生产:照旧 push
  };
```

- [ ] **Step 9: `onCancel` 的画笔分支清原始累积**

把 `onCancel` 末尾画笔/形状分支:
```ts
    // 画笔/形状笔画：丢弃未提交的笔画，不调 apiRef.current.push()
    drawingRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingRef.current.length = 0;
    drawLive();
  };
```
改为:
```ts
    // 画笔/形状笔画：丢弃未提交的笔画，不调 apiRef.current.push()
    drawingRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingRef.current.length = 0;
    rawStrokeRef.current = [];
    processorRef.current = null;
    drawLive();
  };
```

- [ ] **Step 10: 建生产回归夹具页**

Create `web/src/app/ink-tune/regress/page.tsx`:

```tsx
"use client";
import * as React from "react";
import { useAnnotation } from "@/components/annotate/useAnnotation";
import AnnotationLayer from "@/components/annotate/AnnotationLayer";

// 生产回归夹具:挂【裸】AnnotationLayer(不传 onCommitStroke = 生产路径,落笔 api.push)。
// 重构后若 push 路径或渲染坏了,这里能抓到。默认工具就是 pen(useAnnotation 初值)。
export default function InkTuneRegress() {
  const api = useAnnotation();
  const apiRef = React.useRef(api);
  apiRef.current = api;
  const hostRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    (window as typeof window & { __regress?: unknown }).__regress = {
      objectCount: () => apiRef.current.objects.length,
      // committed 是 wrap 里的第一个 canvas(见 AnnotationLayer 渲染顺序)
      committedDataURL: () =>
        (hostRef.current?.querySelector("canvas") as HTMLCanvasElement | null)?.toDataURL() ?? "",
    };
    return () => {
      delete (window as typeof window & { __regress?: unknown }).__regress;
    };
  });
  return (
    <div ref={hostRef} style={{ position: "relative", width: 800, height: 500, background: "#000" }}>
      <AnnotationLayer api={api} />
    </div>
  );
}
```

- [ ] **Step 11: e2e 插入"生产回归"段**

In `web/scripts/_e2e_ink_tune.mjs`,把这一行:
```js
    // (Task 2 在此插入"生产回归"段)
```
替换为:
```js
    // ---------- 生产回归:裸 AnnotationLayer 仍 push + 渲染 ----------
    // 用真实鼠标事件(pointerType=mouse,非掌拒;有效指针捕获,避免合成 PointerEvent 的 InvalidPointerId)。
    await page.goto(`${BASE}/ink-tune/regress`, { waitUntil: "networkidle", timeout: 30000 });
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
```

- [ ] **Step 12: 构建 + 重启 + 跑 e2e(回归段 green)**

```bash
# 先执行顶部 <REDEPLOY> 全部 4 步(build + 停栈 + durable 重启 + 等 :3000),然后跑 e2e:
cd /Users/zhb/Documents/julestest/web && node scripts/_e2e_ink_tune.mjs
```

Expected: Task1 四项 + `OK: 生产回归:api.push 正常` + `OK: 生产回归:committed 渲染正常` + `全部通过`,退出码 0。

- [ ] **Step 13: 提交**

```bash
cd /Users/zhb/Documents/julestest
git add web/src/components/annotate/AnnotationLayer.tsx web/src/app/ink-tune/regress/page.tsx web/scripts/_e2e_ink_tune.mjs docs/superpowers/uac-shots/inktune_regress.png
git commit -m "ink-tune Task2: AnnotationLayer 抽 InkStrokeProcessor + onCommitStroke(抑制push) + 生产回归 e2e(裸层仍 push+渲染)"
```

---

## Task 3: 完整调参台页(输入面 + stage + 控制面板 + A/B + 持久化 + 钩子)

目标:用完整页替换 Task 1 骨架。改任意参数,之前的笔画即时两阶段重算重绘;A/B 对出厂基线;localStorage 持久化;卸载还原全局 `tuning`;暴露 e2e 钩子。

**Files:**
- Modify (整文件替换): `web/src/app/ink-tune/page.tsx`

- [ ] **Step 1: 整文件替换 `web/src/app/ink-tune/page.tsx`**

```tsx
"use client";
import * as React from "react";
import Link from "next/link";
import { useAnnotation } from "@/components/annotate/useAnnotation";
import AnnotationLayer from "@/components/annotate/AnnotationLayer";
import { InkStrokeProcessor } from "@/components/annotate/inkProcessor";
import { drawObject } from "@/components/annotate/renderEngine";
import { tuning, type InkTuning } from "@/components/annotate/inkTuning";
import { identity, COLORS, WIDTHS, newId, type InkObject } from "@/components/annotate/model";
import type { RawSample } from "@/components/annotate/inputPipeline";

// 出厂基线快照:模块导入时深拷贝(先于任何挂载/localStorage 改写 tuning)。A/B 与卸载还原都用它。
const BASELINE_TUNING: InkTuning = structuredClone(tuning);

// 模块级探针(survive 页面卸载):e2e 验证"卸载后全局 tuning 已还原出厂"(候选不泄漏进真实播放器)。
if (typeof window !== "undefined") {
  (window as typeof window & { __inkTuningProbe?: () => InkTuning }).__inkTuningProbe = () =>
    structuredClone(tuning);
}

interface RecordedStroke {
  id: string;
  raw: RawSample[]; // 归一化 0–1 + t
  w: number;
  h: number; // 录制时画布像素尺寸
  tool: "pen" | "marker";
  color: string;
  width: number;
}

const LS_STROKES = "inktune.strokes.v1";
const LS_TUNING = "inktune.tuning.v1";
const dpr = () => Math.min((typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1, 2);

// 临时把全局 tuning 设为某套参数跑 fn 再还原(inkOutlinePath 读模块级全局 tuning,这是让基线与候选
// 用不同渲染参数的唯一途径)。就地改字段——tuning 是 const 不可重赋值。
function withGlobalTuning(cfg: InkTuning, fn: () => void) {
  const snap = structuredClone(tuning);
  Object.assign(tuning, structuredClone(cfg));
  try {
    fn();
  } finally {
    Object.assign(tuning, snap);
  }
}

export default function InkTunePage() {
  const api = useAnnotation();
  const stageRef = React.useRef<HTMLCanvasElement>(null);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const stageSizeRef = React.useRef({ w: 0, h: 0 });
  const strokesRef = React.useRef<RecordedStroke[]>([]);
  const [strokeCount, setStrokeCount] = React.useState(0);
  const [tool, setTool] = React.useState<"pen" | "marker">("pen");
  const [color, setColor] = React.useState<string>(COLORS[0]);
  const [width, setWidth] = React.useState<number>(WIDTHS[1]);
  const [abEnabled, setAbEnabled] = React.useState(false);
  const abRef = React.useRef(false);
  abRef.current = abEnabled;
  const [recording, setRecording] = React.useState(true);
  const recordingRef = React.useRef(true);
  recordingRef.current = recording;
  const [, force] = React.useReducer((x) => x + 1, 0); // 改 tuning 后驱动控制面板回显

  // 把工具/颜色/线宽同步进 api(AnnotationLayer 从 api 读)。
  React.useEffect(() => {
    api.setTool(tool);
    api.setColor(color);
    api.setWidth(width);
  }, [api, tool, color, width]);

  const deriveObject = React.useCallback(
    (rs: RecordedStroke, cfg: InkTuning): InkObject => ({
      kind: "ink",
      id: rs.id,
      tool: rs.tool,
      color: rs.color,
      width: rs.width,
      samples: InkStrokeProcessor.processAll(rs.raw, cfg, rs.w, rs.h), // 输入阶段用录制 (w,h)
      transform: identity(),
    }),
    []
  );

  const renderStage = React.useCallback(() => {
    const cv = stageRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const { w, h } = stageSizeRef.current;
    ctx.clearRect(0, 0, w, h);
    const list = strokesRef.current;
    if (abRef.current) {
      // 先画出厂基线幽灵层(输入阶段也用基线,才是完整 A/B);灰 + 低透明区分候选实色。
      withGlobalTuning(BASELINE_TUNING, () => {
        ctx.save();
        ctx.globalAlpha = 0.28;
        for (const rs of list) {
          const o = deriveObject(rs, BASELINE_TUNING);
          drawObject(ctx, { ...o, color: "#9e9e9e" }, w, h);
        }
        ctx.restore();
      });
    }
    for (const rs of list) drawObject(ctx, deriveObject(rs, tuning), w, h); // 候选实色(渲染读全局 tuning)
  }, [deriveObject]);

  // ---- 持久化(debounce) ----
  const persistTimer = React.useRef<number | null>(null);
  const persist = React.useCallback(() => {
    if (persistTimer.current != null) clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(LS_STROKES, JSON.stringify(strokesRef.current));
        localStorage.setItem(LS_TUNING, JSON.stringify(tuning));
      } catch {
        /* 配额/隐私模式忽略 */
      }
    }, 250);
  }, []);

  // ---- stage canvas 尺寸同步(与 AnnotationLayer 同盒) ----
  React.useEffect(() => {
    const host = hostRef.current;
    const cv = stageRef.current;
    if (!host || !cv) return;
    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      const d = dpr();
      cv.width = Math.round(w * d);
      cv.height = Math.round(h * d);
      cv.style.width = w + "px";
      cv.style.height = h + "px";
      const ctx = cv.getContext("2d");
      if (ctx) ctx.setTransform(d, 0, 0, d, 0, 0);
      stageSizeRef.current = { w, h };
      renderStage();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    return () => ro.disconnect();
  }, [renderStage]);

  // ---- 提交一笔(来自 AnnotationLayer onCommitStroke) ----
  const onCommitStroke = React.useCallback(
    (
      raw: RawSample[],
      frame: { w: number; h: number },
      meta: { tool: "pen" | "marker"; color: string; width: number }
    ) => {
      if (!recordingRef.current) return; // 录制关:随便涂不污染笔画集
      const rs: RecordedStroke = {
        id: newId(),
        raw,
        w: frame.w,
        h: frame.h,
        tool: meta.tool,
        color: meta.color,
        width: meta.width,
      };
      strokesRef.current = [...strokesRef.current, rs];
      setStrokeCount(strokesRef.current.length);
      persist();
      renderStage();
    },
    [persist, renderStage]
  );

  // ---- 挂载:读 localStorage(灌候选 tuning + 笔画);卸载:还原 tuning 出厂 ----
  React.useEffect(() => {
    try {
      const t = localStorage.getItem(LS_TUNING);
      if (t) Object.assign(tuning, JSON.parse(t)); // 就地灌候选
      const s = localStorage.getItem(LS_STROKES);
      if (s) {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) {
          strokesRef.current = arr;
          setStrokeCount(arr.length);
        }
      }
    } catch {
      /* 损坏数据忽略 */
    }
    renderStage();
    force();
    return () => {
      // 安全攸关:还原全局 tuning 为出厂默认,防候选在同一 SPA 会话泄漏进真实播放器。
      Object.assign(tuning, structuredClone(BASELINE_TUNING));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 改参数:就地改全局 tuning → 重画 + 回显 + 持久化 ----
  const setParam = React.useCallback(
    (path: string, val: number) => {
      const parts = path.split(".");
      // 仅 InkTuning/PenTuning 的已知数值字段;path 形如 "posMinCutoff" | "pen.thinning"
      const t = tuning as unknown as Record<string, number | Record<string, number>>;
      if (parts.length === 1) t[parts[0]] = val;
      else (t[parts[0]] as Record<string, number>)[parts[1]] = val;
      renderStage();
      force();
      persist();
    },
    [persist, renderStage]
  );

  const clearAll = () => {
    strokesRef.current = [];
    setStrokeCount(0);
    persist();
    renderStage();
  };
  const deleteLast = () => {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    persist();
    renderStage();
  };
  const resetTuning = () => {
    Object.assign(tuning, structuredClone(BASELINE_TUNING));
    renderStage();
    force();
    persist();
  };
  const exportBundle = React.useCallback(
    () => JSON.stringify({ v: 1, tuning, strokes: strokesRef.current }),
    []
  );
  const importBundle = React.useCallback(
    (json: string) => {
      const o = JSON.parse(json);
      if (o && o.tuning) Object.assign(tuning, o.tuning);
      if (o && Array.isArray(o.strokes)) {
        strokesRef.current = o.strokes as RecordedStroke[];
        setStrokeCount(o.strokes.length);
      }
      renderStage();
      force();
      persist();
    },
    [persist, renderStage]
  );
  const copyParams = () => {
    navigator.clipboard?.writeText(JSON.stringify(tuning, null, 2)).catch(() => {});
  };

  // ---- e2e 钩子 ----
  React.useEffect(() => {
    (window as typeof window & { __inktune?: unknown }).__inktune = {
      InkStrokeProcessor,
      importBundle,
      exportBundle,
      getStrokeCount: () => strokesRef.current.length,
      getTuning: () => structuredClone(tuning),
      setParam,
      setAB: (on: boolean) => setAbEnabled(on),
      stageDataURL: () => stageRef.current?.toDataURL() ?? "",
    };
    return () => {
      delete (window as typeof window & { __inktune?: unknown }).__inktune;
    };
  });

  // ---- 控制面板 ----
  const penCfg = tuning[tool]; // pen / marker 各自渲染参数
  const slider = (label: string, path: string, val: number, min: number, max: number, step: number) => (
    <label key={path} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <span style={{ width: 110, color: "#bbb" }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={val}
        onChange={(e) => setParam(path, parseFloat(e.target.value))}
        style={{ flex: 1 }}
      />
      <span style={{ width: 44, textAlign: "right" }}>{val}</span>
    </label>
  );

  return (
    <div style={{ display: "flex", height: "100dvh", minHeight: 0, background: "#111", color: "#eee" }}>
      {/* 左:画布舞台。host 为整盒,无 video → AnnotationLayer 与 stage canvas 同盒对齐 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "8px 12px", display: "flex", gap: 12, alignItems: "center" }}>
          <Link href="/" style={{ color: "#4fc3f7" }}>
            ← 返回
          </Link>
          <strong>墨迹调参回放台</strong>
          <span style={{ color: "#888", fontSize: 13 }}>笔画 {strokeCount}</span>
        </div>
        <div ref={hostRef} style={{ position: "relative", flex: 1, minHeight: 0, background: "#1b1b1f" }}>
          <canvas ref={stageRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
          <AnnotationLayer api={api} onCommitStroke={onCommitStroke} />
        </div>
      </div>

      {/* 右:控制面板 */}
      <div style={{ width: 320, overflowY: "auto", padding: 12, borderLeft: "1px solid #333", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {(["pen", "marker"] as const).map((t) => (
            <button key={t} onClick={() => setTool(t)} style={{ flex: 1, padding: 6, background: tool === t ? "#4fc3f7" : "#222", color: tool === t ? "#000" : "#eee", border: 0, borderRadius: 6 }}>
              {t === "pen" ? "笔" : "荧光"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {WIDTHS.map((w) => (
            <button key={w} onClick={() => setWidth(w)} style={{ flex: 1, padding: 6, background: width === w ? "#4fc3f7" : "#222", color: width === w ? "#000" : "#eee", border: 0, borderRadius: 6 }}>
              {w}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {COLORS.map((c) => (
            <button key={c} onClick={() => setColor(c)} style={{ width: 28, height: 28, background: c, border: color === c ? "2px solid #fff" : "1px solid #555", borderRadius: 6 }} />
          ))}
        </div>

        <fieldset style={{ border: "1px solid #333", borderRadius: 6, padding: 8 }}>
          <legend style={{ fontSize: 12, color: "#888" }}>One Euro(两工具共用)</legend>
          {slider("posMinCutoff", "posMinCutoff", tuning.posMinCutoff, 0.1, 10, 0.1)}
          {slider("posBeta", "posBeta", tuning.posBeta, 0, 3, 0.01)}
          {slider("dCutoff", "dCutoff", tuning.dCutoff, 0.1, 5, 0.1)}
          {slider("pressMinCutoff", "pressMinCutoff", tuning.pressMinCutoff, 0.1, 10, 0.1)}
          {slider("pressBeta", "pressBeta", tuning.pressBeta, 0, 3, 0.01)}
          {slider("cornerStrength", "cornerStrength", tuning.cornerStrength, 0, 1, 0.01)}
          {slider("minSampleDist", "minSampleDist", tuning.minSampleDist, 0, 5, 0.05)}
        </fieldset>

        <fieldset style={{ border: "1px solid #333", borderRadius: 6, padding: 8 }}>
          <legend style={{ fontSize: 12, color: "#888" }}>渲染:{tool === "pen" ? "笔" : "荧光"}</legend>
          {slider("thinning", `${tool}.thinning`, penCfg.thinning, -1, 1, 0.01)}
          {slider("smoothing", `${tool}.smoothing`, penCfg.smoothing, 0, 1, 0.01)}
          {slider("streamline", `${tool}.streamline`, penCfg.streamline, 0, 1, 0.01)}
          {slider("taperStart", `${tool}.taperStart`, penCfg.taperStart, 0, 4, 0.1)}
          {slider("taperEnd", `${tool}.taperEnd`, penCfg.taperEnd, 0, 4, 0.1)}
        </fieldset>

        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={abEnabled} onChange={(e) => setAbEnabled(e.target.checked)} /> 对比基线(A/B 幽灵层)
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={recording} onChange={(e) => setRecording(e.target.checked)} /> 录制(关掉可随便涂)
        </label>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={deleteLast} style={{ flex: 1, padding: 6 }}>删最后一笔</button>
          <button onClick={clearAll} style={{ flex: 1, padding: 6 }}>清空全部</button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={resetTuning} style={{ flex: 1, padding: 6 }}>重置出厂</button>
          <button onClick={copyParams} style={{ flex: 1, padding: 6 }}>复制参数</button>
        </div>
        <button
          onClick={() => {
            const blob = new Blob([exportBundle()], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "inktune.json";
            a.click();
            URL.revokeObjectURL(a.href);
          }}
          style={{ padding: 6 }}
        >
          导出 JSON
        </button>
        <label style={{ padding: 6, background: "#222", borderRadius: 6, textAlign: "center", cursor: "pointer", fontSize: 13 }}>
          导入 JSON
          <input
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) importBundle(await f.text());
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 构建 + 重启 + 跑既有 e2e(确保 §5.1 + 回归仍 green,且新页编译/挂载无报错)**

```bash
# 先执行顶部 <REDEPLOY> 全部 4 步(build + 停栈 + durable 重启 + 等 :3000),然后跑 e2e:
cd /Users/zhb/Documents/julestest/web && node scripts/_e2e_ink_tune.mjs
```

Expected: Task1 四项 + 回归两项仍 `全部通过`(完整页仍暴露 `window.__inktune.InkStrokeProcessor`,§5.1 不受影响;`ERR:` 行应为空——页面挂载无 console 报错)。

- [ ] **Step 3: 提交**

```bash
cd /Users/zhb/Documents/julestest
git add web/src/app/ink-tune/page.tsx
git commit -m "ink-tune Task3: 完整调参台页(输入面+stage重算重绘+全参数面板+A/B基线+localStorage持久化+卸载还原+e2e钩子)"
```

---

## Task 4: §5.2 全量验收 e2e(像素 / 持久化 / A/B / 卸载还原 / 幂等)

目标:证明"改参数 → 之前的笔画变化"这条核心价值,以及持久化与安全攸关的卸载还原。

**Files:**
- Modify: `web/scripts/_e2e_ink_tune.mjs`(插入 §5.2 段)

- [ ] **Step 1: e2e 插入 §5.2 段**

In `web/scripts/_e2e_ink_tune.mjs`,把这一行:
```js
    // (Task 4 在此插入 §5.2 页面像素/持久化/卸载还原段)
```
替换为:
```js
    // ---------- §5.2 页面像素 / 持久化 / A/B / 卸载还原 ----------
    await page.goto(`${BASE}/ink-tune`, { waitUntil: "networkidle", timeout: 30000 });
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
    await page.reload({ waitUntil: "networkidle" });
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
    await page.waitForTimeout(400);
    const probe = await page.evaluate(() => window.__inkTuningProbe?.()); // 模块级探针,survive 卸载
    if (!probe) fail("§5.2:__inkTuningProbe 不存在(无法验证卸载还原)");
    else if (Math.abs(probe.pen.thinning - 0.6) > 1e-6)
      fail(`§5.2:卸载后全局 tuning.pen.thinning=${probe.pen.thinning}(应还原出厂 0.6)——候选泄漏进生产!`);
    else ok("§5.2:卸载还原全局 tuning 出厂(候选不泄漏)");
```

> 注:`text=返回` 依赖 Task 3 页里的 `<Link href="/">← 返回</Link>`。出厂 `pen.thinning=0.6` 来自 `inkTuning.ts:36`——若日后改了默认,同步改此断言期望值。

- [ ] **Step 2: 构建已无需(只改了 .mjs)。重启也无需。直接跑两遍验幂等**

```bash
cd /Users/zhb/Documents/julestest/web
node scripts/_e2e_ink_tune.mjs && echo "=== 第二遍 ===" && node scripts/_e2e_ink_tune.mjs
```

Expected: 两遍都 `全部通过`、退出码 0。(第二遍验"同脚本连跑两次都通过"——每次新 context,localStorage 天然干净;脚本开头又显式清 key。)

- [ ] **Step 3: 提交**

```bash
cd /Users/zhb/Documents/julestest
git add web/scripts/_e2e_ink_tune.mjs docs/superpowers/uac-shots/inktune_imported.png docs/superpowers/uac-shots/inktune_ab.png
git commit -m "ink-tune Task4: §5.2 全量验收 e2e(导入非空/渲染阶段像素变/输入阶段像素变/A-B/reload持久化/卸载还原防泄漏/幂等)"
```

---

## Task 5: 部署 + 真机口径 + 收尾

目标:部署到 :3000;§5.3 iPad 真机走查;按 finishing-a-development-branch 收口。

**Files:** 无代码改动(部署 + 文档/合并决策)。

- [ ] **Step 1: 全量重新部署并跑完整 e2e**

```bash
# 先执行顶部 <REDEPLOY> 全部 4 步(build + 停栈 + durable 重启 + 等 :3000),然后跑 e2e:
cd /Users/zhb/Documents/julestest/web && node scripts/_e2e_ink_tune.mjs
```

Expected: 全部通过。

- [ ] **Step 2: §5.3 iPad Apple Pencil 真机走查(手动,留主观结论)**

在 iPad Safari 打开 `http://<本机局域网IP>:3000/ink-tune`:
1. 实写若干代表性笔画:写字、画圈、快速甩笔、轻重压感各来一组。
2. 拖渲染参数(thinning/taperEnd)→ 之前笔画即时变形。
3. 拖输入参数(minSampleDist/posMinCutoff/posBeta)→ 之前笔画即时变形(去抖/抽稀肉眼可见)。
4. 开"对比基线"→ 灰幽灵层垫底,看出调参后差异。
5. 导出 JSON → 刷新页面 → 笔画与候选参数续上(持久化)。
6. 返回首页再进一节真实课批注 → 手感是 `inkTuning.ts` 出厂值(候选未泄漏)。

记录:手感是否符合预期、定稿候选值。

- [ ] **Step 3: 把"赢的值"手贴回 `inkTuning.ts`(若已定稿)**

调参台「复制参数」→ 手动粘进 `web/src/components/annotate/inkTuning.ts` 的 `export const tuning` 默认值。重新构建+重启,真实播放器即用新手感。(YAGNI:不做自动写回,见 spec §6。)

- [ ] **Step 4: 收尾**

REQUIRED SUB-SKILL: 用 superpowers:finishing-a-development-branch 决定合并/PR/清理。
注意:本仓库不 push origin(见 `julestest-deploy-restart` memory);通常做法是合进本地 `main` 并部署。合并前确认工作区那批**与 ink-tune 无关**的未提交改动(ChatBody/useChat/TaskQueuePanel/gateway 等)不要混入本分支提交。

---

## Self-Review(spec 覆盖核对)

| spec 章节 | 计划落点 |
|---|---|
| §2 两阶段管线 / 录原始数据必要性 | `InkStrokeProcessor`(输入阶段)+ `RecordedStroke.raw`(Task 1/3) |
| §3.1 抽公共函数不重写输入阶段 | `InkStrokeProcessor` 生产与调参台共用;Task 2 把 `acceptSamples` 换成 `processorRef.push`;§5.1 流式==一次性断言保真 |
| §3.2 录制参考系回放 | `RecordedStroke{w,h}` + `processAll(raw,cfg,recW,recH)` + 时间戳用录制的(Task 1/3) |
| §4.1 `InkStrokeProcessor`(纯数学) | Task 1 |
| §4.2 `AnnotationLayer` 改造(抽函数+`onCommitStroke`+原始累积) | Task 2 全部 step |
| §4.3 页面职责拆分(输入面 vs stage canvas)、层次、坐标对齐 | Task 3 page.tsx;`videoContentRect(box,box,0,0)=整盒` 已核对 |
| §4.4 控制面板(全参数滑条按 main 接口/工具切换/录制管理/导入导出/复制/重置) | Task 3 panel |
| §4.5 A/B 基线(`BASELINE_TUNING`/`deriveBaseline`/`withGlobalTuning`/幽灵层) | Task 3 + Task 4 A/B 断言 |
| §4.6 持久化(两 LS key/挂载灌入/debounce/卸载还原) | Task 3 + Task 4 reload & 卸载还原断言 |
| §5.1 处理器数学(确定性/参数生效/流式==一次性) | Task 1 e2e |
| §5.2 页面像素/持久化(导入非空/两阶段像素变/reload/A-B/幂等) | Task 4 e2e |
| §5.3 真机口径 | Task 5 Step 2 |
| §6 YAGNI(不自动写回/不调形状/不做预设库) | 计划未引入这些;Task 5 Step 3 维持手贴 |
| §7 涉及文件 | File Structure 表一致 |
| **补:生产回归(spec 未覆盖,advisor 提出)** | Task 2 regress 夹具 + e2e |
| **补:卸载还原防泄漏验证(spec §4.6 要求但 §5 未测)** | Task 4 `__inkTuningProbe` 断言 |
