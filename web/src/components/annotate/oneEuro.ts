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

// 一笔用的滤波组：位置 x/y 共享参数，压感单独一组。每笔开始 reset()。
export class StrokeFilter {
  readonly x = new OneEuro();
  readonly y = new OneEuro();
  readonly p = new OneEuro();

  configure(posMinCutoff: number, posBeta: number, dCutoff: number, pressMinCutoff: number, pressBeta: number) {
    this.x.setParams(posMinCutoff, posBeta, dCutoff);
    this.y.setParams(posMinCutoff, posBeta, dCutoff);
    this.p.setParams(pressMinCutoff, pressBeta, dCutoff);
  }

  reset() {
    this.x.reset();
    this.y.reset();
    this.p.reset();
  }
}
