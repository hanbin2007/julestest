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
