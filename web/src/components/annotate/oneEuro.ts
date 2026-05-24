// One Euro Filter（Casiez/Roussel/Vogel 2012）：速度自适应低通。
// 慢速时重平滑（去手抖），快速时放开截止（低延迟跟手）——正好满足「要顺滑又不要延迟」。
// 用于对 Apple Pencil 的位置(x,y)与压感分别滤波，消除「过程中抖动」与「粗细忽粗忽细」。

export class OneEuro {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null; // ms

  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  setParams(minCutoff: number, beta: number, dCutoff: number) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset() {
    this.xPrev = null;
    this.tPrev = null;
    this.dxPrev = 0;
  }

  // 一阶低通系数：cutoff 越高 alpha 越接近 1（越跟手），dt 为秒。
  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  // x：当前样本值；t：时间戳(ms，来自 event.timeStamp)。返回滤波后的值。
  filter(x: number, t: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      this.dxPrev = 0;
      return x;
    }
    let dt = (t - this.tPrev) / 1000; // ms → s
    if (!(dt > 0)) dt = 1 / 120; // 时间戳异常时兜底为一帧
    this.tPrev = t;

    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  }
}

const smoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

// 一笔的平滑器：位置 x/y + 压感各一个 One Euro，外加「保角」——
// 在【真实大拐角】处把输出拉回原始点，避免低通滞后把拐角抹圆/出轨；直线与抖动处仍用滤波值。
// 「真实拐角」判定 = 转角够大(loRad→hiRad) 且 该步位移够长(>minLen，排除小抖动误判为拐角)。
export class StrokeSmoother {
  private fx = new OneEuro();
  private fy = new OneEuro();
  private fp = new OneEuro();
  private prevX: number | null = null; // 上一原始点(px)
  private prevY: number | null = null;
  private dirX = 0;
  private dirY = 0;
  private hasDir = false;
  private cornerStrength = 0.7; // 0=纯滤波(会抹圆拐角)，1=拐角处完全用原始点(最尖)
  private minLen = 4; // px：位移小于此视为抖动、不当拐角
  private loRad = (35 * Math.PI) / 180;
  private hiRad = (100 * Math.PI) / 180;

  configure(
    posMinCutoff: number,
    posBeta: number,
    dCutoff: number,
    pressMinCutoff: number,
    pressBeta: number,
    cornerStrength: number
  ) {
    this.fx.setParams(posMinCutoff, posBeta, dCutoff);
    this.fy.setParams(posMinCutoff, posBeta, dCutoff);
    this.fp.setParams(pressMinCutoff, pressBeta, dCutoff);
    this.cornerStrength = cornerStrength;
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
    this.fp.reset();
    this.prevX = null;
    this.prevY = null;
    this.hasDir = false;
    this.dirX = 0;
    this.dirY = 0;
  }

  // 输入原始像素坐标 + 时间戳(ms) → 去抖且保角后的像素坐标。
  point(rx: number, ry: number, t: number): { x: number; y: number } {
    const fx = this.fx.filter(rx, t);
    const fy = this.fy.filter(ry, t);
    let cw = 0;
    if (this.prevX !== null && this.prevY !== null) {
      const sx = rx - this.prevX;
      const sy = ry - this.prevY;
      const len = Math.hypot(sx, sy);
      if (len > this.minLen) {
        const dx = sx / len;
        const dy = sy / len;
        if (this.hasDir) {
          const dot = Math.max(-1, Math.min(1, dx * this.dirX + dy * this.dirY));
          const turn = Math.acos(dot); // 与上一段方向的夹角
          cw = smoothstep(this.loRad, this.hiRad, turn) * this.cornerStrength;
        }
        this.dirX = dx;
        this.dirY = dy;
        this.hasDir = true;
      }
    }
    this.prevX = rx;
    this.prevY = ry;
    return { x: fx * (1 - cw) + rx * cw, y: fy * (1 - cw) + ry * cw };
  }

  pressure(p: number, t: number): number {
    return this.fp.filter(p, t);
  }
}
