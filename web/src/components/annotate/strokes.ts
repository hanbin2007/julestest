// 批注矢量模型与渲染。坐标一律归一化到 0–1（相对画布宽/高），线宽 width 也归一化为
// 「画布高度的比例」——与播放器尺寸/全屏无关，显示、再编辑、合成大图都按当前尺寸还原，
// 无需任何缩放参数。

export type Tool = "pen" | "marker" | "line" | "rect" | "ellipse" | "arrow" | "eraser";

export interface Pt {
  x: number; // 0–1
  y: number; // 0–1
}

export interface Stroke {
  tool: Exclude<Tool, "eraser">;
  color: string; // CSS 颜色（marker 由渲染时改透明度）
  width: number; // 画布高度的比例（如 0.006）；渲染时 lw = width * h
  points: Pt[]; // pen/marker: 折线；line/rect/ellipse/arrow: [起点, 终点]
}

// 工具条提供的 4 档线宽（占画布高度的比例）。
export const WIDTHS = [0.004, 0.007, 0.012, 0.02] as const;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** 序列化为体积较小的 JSON（坐标保留 3 位）。 */
export function serializeStrokes(strokes: Stroke[]): string {
  return JSON.stringify(
    strokes.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ x: round(p.x), y: round(p.y) })),
    }))
  );
}

export function parseStrokes(json: string | null | undefined): Stroke[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => s && Array.isArray(s.points) && s.points.length > 0) as Stroke[];
  } catch {
    return [];
  }
}

function drawArrowHead(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, w: number, h: number, lw: number) {
  const x1 = from.x * w, y1 = from.y * h, x2 = to.x * w, y2 = to.y * h;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(10, lw * 3.5);
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(ang - spread), y2 - len * Math.sin(ang - spread));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(ang + spread), y2 - len * Math.sin(ang + spread));
  ctx.stroke();
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, w: number, h: number) {
  if (s.points.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = Math.max(1, s.width * h);
  if (s.tool === "marker") {
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = Math.max(1, s.width * h * 3);
  }
  const p = s.points;
  const px = (i: number) => p[i].x * w;
  const py = (i: number) => p[i].y * h;
  if (s.tool === "pen" || s.tool === "marker") {
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    for (let i = 1; i < p.length; i++) ctx.lineTo(px(i), py(i));
    if (p.length === 1) ctx.lineTo(px(0) + 0.01, py(0)); // 单点也画出一个圆点
    ctx.stroke();
  } else if (p.length >= 2) {
    const a = p[0], b = p[p.length - 1];
    if (s.tool === "line" || s.tool === "arrow") {
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
      ctx.stroke();
      if (s.tool === "arrow") drawArrowHead(ctx, a, b, w, h, ctx.lineWidth);
    } else if (s.tool === "rect") {
      ctx.strokeRect(a.x * w, a.y * h, (b.x - a.x) * w, (b.y - a.y) * h);
    } else if (s.tool === "ellipse") {
      const cx = ((a.x + b.x) / 2) * w, cy = ((a.y + b.y) / 2) * h;
      const rx = Math.abs(b.x - a.x) * w / 2, ry = Math.abs(b.y - a.y) * h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// 只画笔迹，不清画布——合成「画面帧 + 笔迹」时用（否则会把帧擦掉）。
export function renderStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number) {
  for (const s of strokes) drawStroke(ctx, s, w, h);
}

// 清空后重画全部笔迹——给实时叠加画布（AnnotationLayer）用。
export function drawAll(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  renderStrokes(ctx, strokes, w, h);
}

// ---- 橡皮：命中测试（归一化点到笔画的距离，单位回到 px 比较）----
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 返回最靠近 pt（归一化）且在 tolPx 内的笔画下标（从顶到底找），无则 -1。 */
export function hitTest(strokes: Stroke[], pt: Pt, w: number, h: number, tolPx: number): number {
  const X = pt.x * w, Y = pt.y * h;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    const poly: Array<[number, number]> = [];
    if (s.tool === "pen" || s.tool === "marker") {
      for (const p of s.points) poly.push([p.x * w, p.y * h]);
    } else if (s.points.length >= 2) {
      const a = s.points[0], b = s.points[s.points.length - 1];
      if (s.tool === "rect") {
        const x0 = a.x * w, y0 = a.y * h, x1 = b.x * w, y1 = b.y * h;
        poly.push([x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]);
      } else if (s.tool === "ellipse") {
        const cx = ((a.x + b.x) / 2) * w, cy = ((a.y + b.y) / 2) * h;
        const rx = Math.abs(b.x - a.x) * w / 2, ry = Math.abs(b.y - a.y) * h / 2;
        for (let k = 0; k <= 24; k++) {
          const ang = (k / 24) * Math.PI * 2;
          poly.push([cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]);
        }
      } else {
        poly.push([a.x * w, a.y * h], [b.x * w, b.y * h]);
      }
    }
    const lw = s.width * h * (s.tool === "marker" ? 3 : 1);
    const tol = Math.max(tolPx, lw / 2 + 6);
    if (poly.length === 1) {
      if (Math.hypot(X - poly[0][0], Y - poly[0][1]) <= tol) return i;
    }
    for (let k = 1; k < poly.length; k++) {
      if (distToSeg(X, Y, poly[k - 1][0], poly[k - 1][1], poly[k][0], poly[k][1]) <= tol) return i;
    }
  }
  return -1;
}
