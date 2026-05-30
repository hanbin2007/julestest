# 墨迹调参回放台 (`/ink-tune`) 设计

日期:2026-05-29
状态:已通过 brainstorming,待 spec 评审 → 转实现计划

## 1. 目标

提供一个调参台,让用户**录制原始手写笔画数据**,然后**调整任意手感参数时,之前录制的所有笔画即时按新参数重新渲染**,从而反复 A/B 对比、把手感调到满意,再把"赢的值"手贴回 `inkTuning.ts` 默认。

用户当前用的参数(可用但想继续调):

```json
{ "posMinCutoff": 0.9, "posBeta": 0.95, "dCutoff": 1, "pressMinCutoff": 4, "pressBeta": 0.3,
  "cornerStrength": 0.05,
  "pen": { "thinning": 0.6, "smoothing": 0.5, "streamline": 0.58, "taperStart": 0.1, "taperEnd": 1.3 },
  "marker": { "thinning": 0, "smoothing": 0.5, "streamline": 0.25, "taperStart": 0, "taperEnd": 0 },
  "minSampleDist": 0.5 }
```

## 2. 根本约束:两阶段管线 + 输入阶段是破坏性的

墨迹参数按**处理时机**分两类(见 `inkTuning.ts` / `oneEuro.ts` / `renderEngine.ts`):

| 阶段 | 参数 | 在哪生效 | 对已存笔画 |
|---|---|---|---|
| **输入阶段** | `posMinCutoff` `posBeta` `dCutoff` `pressMinCutoff` `pressBeta` `cornerStrength` `minSampleDist` | 落笔时 `AnnotationLayer.acceptSamples`:One Euro 去抖 + 保角 + 抽稀 | **无效** —— 已"烤进" `InkObject.samples`,原始点丢失 |
| **渲染阶段** | `pen/marker.{thinning,smoothing,streamline,taperStart,taperEnd}` | 渲染时 `renderEngine.inkOutlinePath` 调 perfect-freehand | **可随时重算** |

证据:`acceptSamples`(`AnnotationLayer.tsx:61`)对每个原始样本跑 `StrokeSmoother.point/pressure`,只把滤波+抽稀后的结果存进 `InkObject.samples`;原始未滤波样本不保留。

**结论**:要让输入阶段参数也能作用于"之前的笔画",必须录制带时间戳的原始样本 `RawSample[]`(`inputPipeline.ts:7`,已含 `t`),并在改参数时把**两个阶段都重跑一遍**。这就是"录制原始数据"的必要性,不是可选项。

## 3. 关键约束:保真(回放 == 生产)

调参台只有在它的重算**与生产逐位一致**时才有价值。否则会调出"台子上好看、真实播放器两样"的数。两条硬规定:

### 3.1 抽公共函数,绝不重写输入阶段

把 `AnnotationLayer.acceptSamples` 的输入阶段逻辑抽成一个有状态处理器,生产与调参台**共用同一份代码**:

```ts
// 新文件 web/src/components/annotate/inkProcessor.ts
import { StrokeSmoother } from "./oneEuro";
import type { InkTuning } from "./inkTuning";
import type { RawSample } from "./inputPipeline";
import type { InkSample, Pt } from "./model";

// 一笔的输入阶段处理器:One Euro 去抖+保角(StrokeSmoother) + minSampleDist 抽稀。
// 状态(滤波器、上一采样)跨批次保持,故流式 push() 与一次性 processAll() 数学等价
// —— 只要喂入的原始样本顺序与时间戳一致,分批 vs 整段结果完全相同。
export class InkStrokeProcessor {
  private sm = new StrokeSmoother();
  private last: Pt | null = null;
  constructor(private cfg: InkTuning, private w: number, private h: number) {
    this.sm.configure(cfg.posMinCutoff, cfg.posBeta, cfg.dCutoff,
                      cfg.pressMinCutoff, cfg.pressBeta, cfg.cornerStrength);
    this.sm.reset();
  }
  // 流式:喂一批原始样本(归一化 0–1),返回本批新接受的样本。生产 AnnotationLayer 每 rAF 调。
  push(raw: RawSample[]): InkSample[] {
    const out: InkSample[] = [];
    for (const s of raw) {
      const pt = this.sm.point(s.x * this.w, s.y * this.h, s.t);
      const fx = pt.x / this.w, fy = pt.y / this.h;
      const fp = s.p === undefined ? undefined : this.sm.pressure(s.p, s.t);
      if (!this.last || Math.hypot((fx - this.last.x) * this.w, (fy - this.last.y) * this.h) >= this.cfg.minSampleDist) {
        const samp: InkSample = fp === undefined ? { x: fx, y: fy } : { x: fx, y: fy, p: fp };
        out.push(samp); this.last = samp;
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

`AnnotationLayer` 改造:`smootherRef`+`lastSampleRef`+内联 `acceptSamples` → `processorRef.current = new InkStrokeProcessor(tuning, w, h)`(落笔时建),`onMove`/`onDown` 调 `processorRef.current.push(...)`。**渲染阶段直接复用 `inkOutlinePath`**(它读全局 `tuning`),调参台就地改全局 `tuning` 后强制重画即可,跟已删除的老 `/ink-tune` 页同套路。

### 3.2 在录制时的参考系里回放

One Euro 滤波是**像素空间**的(`AnnotationLayer.tsx:67-69` 与注释:cutoff(Hz)/beta(对 px/s)只有在像素空间才有物理意义;在归一化 0–1 上滤会把速度缩小上千倍 → 误判为"慢" → 过度平滑+严重滞后)。因此:

- 每条录制笔画存下**录制当时的 `(w,h)`**。
- 回放 `processAll(raw, cfg, recordedW, recordedH)` 用录制的 `(w,h)`,得到归一化(0–1,分辨率无关)样本。
- 再用**当前页面尺寸**通过 `inkOutlinePath(o, curW, curH)` 渲染(渲染阶段本就随显示尺寸缩放,与生产一致)。
- 时间戳 `t` 一律用录制的,**绝不重造**(否则 dt 变化 → 滤波结果变)。

## 4. 组件与数据流

### 4.1 `InkStrokeProcessor`(新)
见 §3.1。纯数学(只依赖 `StrokeSmoother`,无 DOM),可在 node 里直接单测。

### 4.2 `AnnotationLayer` 改造
1. 用 `InkStrokeProcessor` 替换内部的 `smootherRef`/`lastSampleRef`/`acceptSamples`(行为不变,只是抽函数)。
2. 新增可选 prop:
   ```ts
   onCommitStroke?: (raw: RawSample[], frame: { w: number; h: number },
                     meta: { tool: "pen" | "marker"; color: string; width: number }) => void;
   ```
   - 落笔提交墨迹(`onUp`,ink,`samples ≥ 1`)时:**若提供** `onCommitStroke` 则调它发出原始数据、**且不再 `api.push(d)`**(让调参台独占对象真源,撤销历史干净);**若未提供**则维持现状 `api.push(d)` —— **生产零行为变化**。
   - 形状工具不受影响(调参台只画 pen/marker,这里维持原 push)。
3. 内部累积原始样本:新增 `rawStrokeRef = useRef<RawSample[]>([])`。`onDown`(pen/marker)重置为首批原始样本;`onMove` 追加每批;`onUp` 提交后用于 `onCommitStroke`;`onCancel`/卸载清空。原始样本即 `extractSamples` 的返回(归一化 0–1 + `t`)。

> 注意:`extractSamples` 用 `getCoalescedEvents()` 在 iPad Safari 上一帧聚合多达 ~240 点(`inputPipeline.ts:1-5`)。录制的原始数据天然带这些高密度点 —— 这正是真实手感的来源,必须完整录下。

### 4.3 `/ink-tune` 页(新 `web/src/app/ink-tune/page.tsx`)
布局沿用已删除的老页:左画布舞台,右可滚动控制面板(约 320px)。

**职责拆分(关键架构决策)**:`AnnotationLayer` 在本页**只当输入面**(采集 coalesced 原始点 / 掌拒 / 落笔期 live 预览),**不**承担已录笔画的渲染。已录笔画的渲染由页面**自己的 stage canvas** 负责,直接调 `renderEngine` 的 `drawObject`。这样:① A/B 双份渲染只是页面在自己 canvas 上多跑一遍,无需与 AnnotationLayer 的双 canvas 协调;② 渲染仍走共享的 `inkOutlinePath`,保真。

层次(同一矩形、无 video 故铺满舞台盒):页面 stage canvas(底,画全部已录笔画)→ AnnotationLayer 的 committed canvas(空)→ AnnotationLayer 的 live canvas(顶,收指针 + 落笔期预览)。因 `onCommitStroke` 抑制了 `api.push`,`api.objects` 恒空,committed 层不画东西,只露出底下 stage canvas。坐标对齐:无 video 时 `videoContentRect` 返回整盒,AnnotationLayer wrap 与 stage canvas 同为整舞台盒,归一化 0–1 自然对齐(实现阶段需验证无 video 时 `videoContentRect(boxW,boxH,0,0)` 确返回整盒)。

页面状态(唯一真源):
```ts
interface RecordedStroke {
  id: string;
  raw: RawSample[];          // 归一化 0–1 + t,从 onCommitStroke 收
  w: number; h: number;      // 录制时的画布像素尺寸
  tool: "pen" | "marker";
  color: string; width: number;
}
```

数据流:
- **画新笔画** → AnnotationLayer 落笔期用全局 `tuning`(候选)做 live 预览(`onCommitStroke` 抑制了 `api.push`,故不进 committed 层)→ 提交时 `onCommitStroke(raw, frame, meta)` → 追加 `RecordedStroke` → `renderStage()`。
- **拖任意滑条** → 就地改全局 `tuning.<path>` → `renderStage()` → **所有之前的笔画即时变形**。

`renderStage()`(页面在 stage canvas 上重画全部已录笔画;`drawObject` 经 `inkOutlinePath` 读全局 `tuning`):
```ts
function deriveObject(rs: RecordedStroke): InkObject {
  return {
    kind: "ink", id: rs.id, tool: rs.tool, color: rs.color, width: rs.width,
    samples: InkStrokeProcessor.processAll(rs.raw, tuning, rs.w, rs.h),  // 输入阶段用录制 (w,h)
    transform: identity(),
  };
}
function renderStage() {
  const { w, h } = stageSize;                    // 当前 stage canvas 像素尺寸
  ctx.clearRect(0, 0, w, h);
  if (abEnabled) {                               // §4.5:先画出厂基线幽灵层
    withGlobalTuning(BASELINE_TUNING, () => {
      ctx.save(); ctx.globalAlpha = 0.28;
      for (const rs of recordedStrokes) drawObject(ctx, ghostColored(deriveBaseline(rs)), w, h);
      ctx.restore();
    });
  }
  for (const rs of recordedStrokes) drawObject(ctx, deriveObject(rs), w, h);  // 候选实色
}
```

### 4.4 控制面板
- 工具(笔/荧光)、线宽 4 档(`WIDTHS`)、颜色(`COLORS` 子集)。
- **全部参数滑条,按 main 当前的 `InkTuning`/`PenTuning` 接口生成**(不抄已删除 worktree 老页的 `despikeRatio/resampleSpacing/despikeBase`,main 无这些字段、会编译失败)。pen/marker 各自的渲染参数随当前选中工具切换显示(`tuning.pen` vs `tuning.marker`);One Euro 7 个参数为两工具共用。
- 录制管理:录制开关(默认开;关掉可随便涂不污染笔画集)、笔画计数、删最后一笔、清空全部。
- 导出/导入 JSON:打包 `{ v:1, tuning, strokes }`,可跨设备共享整套调参现场;导入替换当前。
- 复制参数(当前 `tuning` JSON,供手贴回 `inkTuning.ts`)、重置为出厂默认。

### 4.5 A/B 基线对比(已确认要做)
开关"对比基线":开启时,`renderStage()` 在画候选实色之前,先用**出厂默认参数**把同一组录制笔画重算并以低透明度幽灵层垫在下面(见 §4.3 `renderStage()` 伪码的 `abEnabled` 分支),直观看出"调参后差在哪"。

- `BASELINE_TUNING`:页面模块顶部对 `inkTuning.ts` 导出默认值的**深拷贝快照**,不受调参页就地修改全局 `tuning` 影响。
- `deriveBaseline(rs)` = `processAll(rs.raw, BASELINE_TUNING, rs.w, rs.h)` 组成的 `InkObject`(输入阶段也用基线参数,才是完整 A/B)。
- `withGlobalTuning(BASELINE_TUNING, fn)`:临时把全局 `tuning` 各字段设为基线、跑 `fn`(此时 `inkOutlinePath` 读到基线渲染参数)、`finally` 还原候选。因 `inkOutlinePath` 读模块级全局 `tuning`,这是让基线与候选用不同渲染参数的唯一途径 —— 两遍渲染、之间 swap 全局 `tuning`。
- `ghostColored(o)`:基线对象渲染前可改 `color` 为统一对比色(如灰),与候选实色区分;或仅靠 `globalAlpha=0.28` 区分(实现阶段定,二选一即可)。
- 基线渲染同样走 `inkOutlinePath`,保真。

### 4.6 持久化(用户已选:持久化 + 导出导入)
- `localStorage`:
  - `inktune.strokes.v1` ← `RecordedStroke[]`(刷新不丢、重开续上)。
  - `inktune.tuning.v1` ← 候选 `tuning` 快照(重开续上在调的参数)。
- 挂载时:读两个 key;有 tuning 就把值灌进全局 `tuning`;有 strokes 就 `rederiveAll()`。
- 变更时:debounce 写回 localStorage。
- **卸载时:把全局 `tuning` 还原成挂载时快照的出厂默认** —— 防止调参页在同一 SPA 会话里污染真实播放器的手感(老页有这个坑)。localStorage 的候选只服务调参页,**不**流入生产;生产永远用 `inkTuning.ts` 默认,除非手贴。

## 5. 验收(CLAUDE.md 硬要求)

### 5.1 node 单测 `web/scripts/_e2e_ink_processor.mjs`(纯数学,无浏览器)
- **确定性**:同一组合成原始样本 + 同 cfg,跑两次 → 输出逐位相同。
- **参数真生效(失败信号)**:两组明显不同的 cfg(如 `minSampleDist` 0.1 vs 3,或 `posMinCutoff` 0.5 vs 4)→ 输出样本数/坐标明显不同。若"不同 cfg 输出相同"则判定失败(证明输入阶段重算没生效 / 参数没接上)。
- **流式==一次性(保真)**:把同一原始流分批 `push` vs 一次 `processAll` → 结果相同(证明生产流式路径与调参台一次性路径等价)。

### 5.2 smoke e2e `web/scripts/_e2e_ink_tune.mjs`(沿用 `smoke.mjs` 的无头浏览器,不用 Playwright MCP)
1. 打开 `/ink-tune`。
2. **导入**一组已知原始笔画 JSON(经导入路径,顺带验证导入)→ 截图留证,断言 canvas 非空白。
3. 抓 canvas 像素 hash/采样基线,然后分别验证两阶段都作用于**已录笔画**(这正是"看到之前笔画变化"的核心):
   - **渲染阶段**:`pen.thinning` 0→0.9(或 `taperEnd` 0→4)→ 像素**必须变化**。
   - **输入阶段**:`minSampleDist` 0.1→3(或 `posMinCutoff` 0.5→4)→ 像素**必须变化**(证明 `processAll` 对已录原始数据重跑了输入阶段,不是只换了渲染)。
   - 任一不变 = 重算没作用于已存笔画 = **失败**。
4. **reload** 页面 → 断言笔画集 + 候选参数仍在(localStorage 持久化的"跨重启"等价验证)。
5. (A/B)开"对比基线" → 断言渲染像素较关闭时变化(基线幽灵层出现)。
6. 同脚本**连跑两次都通过**(警惕 localStorage 残留导致的 stateful 副作用;脚本开头清相关 key 或用独立断言)。

### 5.3 真机口径
台子部署到 `:3000` 后,iPad Apple Pencil 实写若干代表性笔画(写字/画圈/快速甩笔/轻重压感)→ 调参 → 观察之前笔画即时变化 → 导出留存 → 重开续上。

## 6. 不做(YAGNI)
- 不把候选参数自动写回 `inkTuning.ts`(脆弱);维持复制 JSON → 手贴的既有交接方式。
- 不做形状/套索/橡皮的调参(只针对手写墨迹手感)。
- 不做参数预设库(老页的 `PRESETS` 已随老页删除,且与 main 字段不符);需要时手动导入 JSON 即可。

## 7. 涉及文件
- 新增:`web/src/components/annotate/inkProcessor.ts`、`web/src/app/ink-tune/page.tsx`、`web/scripts/_e2e_ink_processor.mjs`、`web/scripts/_e2e_ink_tune.mjs`。
- 改造:`web/src/components/annotate/AnnotationLayer.tsx`(抽 `InkStrokeProcessor` + 加 `onCommitStroke` prop + 累积原始样本)。
- 只读复用:`inkTuning.ts`、`oneEuro.ts`、`inputPipeline.ts`、`renderEngine.ts`、`model.ts`、`useAnnotation.ts`。
