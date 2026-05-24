// 指针输入采样。两个关键点（Goodnotes 级流畅的基础）：
//  ① getCoalescedEvents()：iPad Safari 上 Apple Pencil 一帧内会聚合多达 ~240 个采样，
//     不取就只剩每帧 1 个点 → 笔迹有棱角。注意 getPredictedEvents() 仅 Chromium 有，不用。
//  ② 压感：仅 pen 取真实 e.pressure；mouse/touch 不带 p（缺省）→ 渲染层走 simulatePressure，
//     比恒定宽度更自然。

export interface RawSample {
  x: number; // 0–1
  y: number; // 0–1
  p?: number; // 压感 0–1（仅 pen）
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

// 从一个 PointerEvent 取出本帧所有采样（含聚合的历史点），归一化到画布矩形。
export function extractSamples(e: PointerEvent, rect: DOMRect): RawSample[] {
  const isPen = e.pointerType === "pen";
  const coalesced = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
  const list = coalesced.length ? coalesced : [e];
  return list.map((ce) => ({
    x: clamp01((ce.clientX - rect.left) / rect.width),
    y: clamp01((ce.clientY - rect.top) / rect.height),
    p: isPen && ce.pressure > 0 ? ce.pressure : undefined,
  }));
}

// 掌拒：手指/手掌（touch）不画，只接受 Apple Pencil(pen) 与鼠标(mouse)。
export function isDrawingPointer(pointerType: string): boolean {
  return pointerType !== "touch";
}
