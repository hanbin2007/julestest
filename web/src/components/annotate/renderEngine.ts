// 批注渲染与几何。手写墨迹用 perfect-freehand 生成「随压感变宽」的填充轮廓（tldraw/
// excalidraw 同款），形状仍用解析画法。每个对象的仿射变换在【像素空间绕轴心】应用，
// 这样非方形画布上旋转也不会被拉斜。命中/套索/区域橡皮都先把点逆变换回对象本地坐标。

import getStroke from "perfect-freehand";
import { tuning } from "./inkTuning";
import {
  type AnnObject,
  type InkObject,
  type ShapeObject,
  type Pt,
  type Transform,
  hasRealPressure,
} from "./model";

// ---- 变换 ----

// 把对象变换叠加到 ctx（调用方负责 save/restore）。
function applyTransform(ctx: CanvasRenderingContext2D, t: Transform, w: number, h: number) {
  const px = t.px * w; // 轴心（像素）
  const py = t.py * h;
  ctx.translate(px + t.tx * w, py + t.ty * h);
  ctx.rotate(t.angle);
  ctx.scale(t.sx, t.sy);
  ctx.translate(-px, -py);
}

// 把画布上的归一化点逆变换回对象本地归一化坐标（命中测试用）。
// 正向：C = R(angle)·S·(L - pivot) + pivot + transOffset
// 逆向：L = S⁻¹·R(-angle)·(C - pivot - transOffset) + pivot
export function inverseTransformPt(pt: Pt, t: Transform, w: number, h: number): Pt {
  const pvx = t.px * w;
  const pvy = t.py * h;
  const dx = pt.x * w - pvx - t.tx * w;
  const dy = pt.y * h - pvy - t.ty * h;
  const cos = Math.cos(t.angle);
  const sin = Math.sin(t.angle);
  // R(-angle) = [[cos, sin], [-sin, cos]]
  const rx = dx * cos + dy * sin;
  const ry = -dx * sin + dy * cos;
  const lx = rx / (t.sx || 1) + pvx;
  const ly = ry / (t.sy || 1) + pvy;
  return { x: lx / w, y: ly / h };
}

// 对象本地点 → 画布归一化坐标（inverseTransformPt 的正变换）。套索包含/包围盒用。
export function forwardTransformPt(local: Pt, t: Transform, w: number, h: number): Pt {
  const pvx = t.px * w;
  const pvy = t.py * h;
  const lx = (local.x * w - pvx) * t.sx;
  const ly = (local.y * h - pvy) * t.sy;
  const cos = Math.cos(t.angle);
  const sin = Math.sin(t.angle);
  const rx = lx * cos - ly * sin;
  const ry = lx * sin + ly * cos;
  return { x: (rx + pvx + t.tx * w) / w, y: (ry + pvy + t.ty * h) / h };
}

// ---- 手写墨迹（perfect-freehand）----

// 手感参数全部来自 inkTuning（可被 /ink-tune 调优页实时改）。streamline 越高笔尖越「追不上笔」，
// 去抖主要交给输入端的 One Euro 滤波（见 AnnotationLayer）；taper 给起笔/收笔自然出锋。
function inkOutlinePath(o: InkObject, w: number, h: number, last: boolean): Path2D | null {
  if (o.samples.length === 0) return null;
  const base = Math.max(2, o.width * h * (o.tool === "marker" ? 3 : 1));
  const input = o.samples.map((s) => [s.x * w, s.y * h, s.p ?? 0.5] as [number, number, number]);
  const cfg = o.tool === "marker" ? tuning.marker : tuning.pen;
  const outline = getStroke(input, {
    size: base,
    thinning: cfg.thinning,
    smoothing: cfg.smoothing,
    streamline: cfg.streamline,
    simulatePressure: !hasRealPressure(o),
    start: { taper: base * cfg.taperStart, cap: true }, // taper=0 → 圆头；>0 → 收尖
    end: { taper: base * cfg.taperEnd, cap: true },
    last,
  });
  const n = outline.length;
  if (n < 2) return null;
  // 用「过相邻轮廓点中点的二次曲线」连接（perfect-freehand 官方画法），而非直线段——
  // 否则填充轮廓是多边形，曲线处看得见折面=锯齿。二次曲线在中点处相切→C1 连续→silhouette 平滑。
  const path = new Path2D();
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % n];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

function drawInk(ctx: CanvasRenderingContext2D, o: InkObject, w: number, h: number, last = true) {
  const path = inkOutlinePath(o, w, h, last);
  if (!path) return;
  ctx.save();
  applyTransform(ctx, o.transform, w, h);
  ctx.fillStyle = o.color;
  if (o.tool === "marker") ctx.globalAlpha = 0.32;
  ctx.fill(path);
  ctx.restore();
}

// ---- 形状 ----

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  lw: number
) {
  const ang = Math.atan2(by - ay, bx - ax);
  const len = Math.max(10, lw * 3.5);
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - len * Math.cos(ang - spread), by - len * Math.sin(ang - spread));
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - len * Math.cos(ang + spread), by - len * Math.sin(ang + spread));
  ctx.stroke();
}

function drawShape(ctx: CanvasRenderingContext2D, o: ShapeObject, w: number, h: number) {
  ctx.save();
  applyTransform(ctx, o.transform, w, h);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = o.color;
  const lw = Math.max(1, o.width * h);
  ctx.lineWidth = lw;
  const ax = o.a.x * w;
  const ay = o.a.y * h;
  const bx = o.b.x * w;
  const by = o.b.y * h;
  if (o.tool === "line" || o.tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    if (o.tool === "arrow") drawArrowHead(ctx, ax, ay, bx, by, lw);
  } else if (o.tool === "rect") {
    ctx.strokeRect(ax, ay, bx - ax, by - ay);
  } else if (o.tool === "ellipse") {
    const cx = (ax + bx) / 2;
    const cy = (ay + by) / 2;
    const rx = Math.abs(bx - ax) / 2;
    const ry = Math.abs(by - ay) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawObject(ctx: CanvasRenderingContext2D, o: AnnObject, w: number, h: number, last = true) {
  if (o.kind === "ink") drawInk(ctx, o, w, h, last);
  else drawShape(ctx, o, w, h);
}

// 只画对象，不清画布（合成「画面帧 + 笔迹」时用，否则会擦掉帧）。
export function renderObjects(
  ctx: CanvasRenderingContext2D,
  objects: AnnObject[],
  w: number,
  h: number,
  exclude?: Set<string>
) {
  for (const o of objects) {
    if (exclude && exclude.has(o.id)) continue;
    drawObject(ctx, o, w, h);
  }
}

// 清空后重画（实时叠加画布用）。
export function clearAndRender(
  ctx: CanvasRenderingContext2D,
  objects: AnnObject[],
  w: number,
  h: number,
  exclude?: Set<string>
) {
  ctx.clearRect(0, 0, w, h);
  renderObjects(ctx, objects, w, h, exclude);
}

// ---- 几何 / 命中 ----

export function distToSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// 对象在【本地坐标】下的折线近似（像素），用于命中/包含测试。
export function localPolyline(o: AnnObject, w: number, h: number): Array<[number, number]> {
  if (o.kind === "ink") return o.samples.map((s) => [s.x * w, s.y * h]);
  const ax = o.a.x * w;
  const ay = o.a.y * h;
  const bx = o.b.x * w;
  const by = o.b.y * h;
  if (o.tool === "rect") return [[ax, ay], [bx, ay], [bx, by], [ax, by], [ax, ay]];
  if (o.tool === "ellipse") {
    const cx = (ax + bx) / 2;
    const cy = (ay + by) / 2;
    const rx = Math.abs(bx - ax) / 2;
    const ry = Math.abs(by - ay) / 2;
    const poly: Array<[number, number]> = [];
    for (let k = 0; k <= 24; k++) {
      const ang = (k / 24) * Math.PI * 2;
      poly.push([cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]);
    }
    return poly;
  }
  return [[ax, ay], [bx, by]];
}

export const avgScale = (t: Transform) => (Math.abs(t.sx) + Math.abs(t.sy)) / 2 || 1;

// 返回最靠近 pt（归一化画布坐标）且在容差内的【最上层】对象 id，无则 null。整笔橡皮用。
export function hitTestTop(
  objects: AnnObject[],
  pt: Pt,
  w: number,
  h: number,
  tolPx: number
): string | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    const local = inverseTransformPt(pt, o.transform, w, h); // 命中在对象本地坐标比较
    const X = local.x * w;
    const Y = local.y * h;
    const poly = localPolyline(o, w, h);
    const lw = o.width * h * (o.kind === "ink" && o.tool === "marker" ? 3 : 1);
    // 本地空间没有缩放，画布容差换算回本地需除以缩放系数。
    const tol = Math.max(tolPx, lw / 2 + 6) / avgScale(o.transform);
    if (poly.length === 1) {
      if (Math.hypot(X - poly[0][0], Y - poly[0][1]) <= tol) return o.id;
      continue;
    }
    for (let k = 1; k < poly.length; k++) {
      if (distToSeg(X, Y, poly[k - 1][0], poly[k - 1][1], poly[k][0], poly[k][1]) <= tol) return o.id;
    }
  }
  return null;
}
