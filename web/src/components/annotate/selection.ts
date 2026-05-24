// 套索选择 + 选区变换（移动/旋转/缩放）+ 复制粘贴的几何与组合。
// 关键：变换用「统一缩放」（sx=sy），这样把一次拖拽变换 D 叠加到对象已有变换 T 上时，
// 旋转·缩放·平移仍能落回同一种分解形式（见下 compose*），无需退化为通用矩阵。

import { type AnnObject, type Pt, type Transform } from "./model";
import { forwardTransformPt, localPolyline } from "./renderEngine";

// 对象在【画布】坐标下的折线近似（像素），= 本地折线经各自 transform 正变换。
export function objectCanvasPolylinePx(o: AnnObject, w: number, h: number): Array<[number, number]> {
  return localPolyline(o, w, h).map(([lx, ly]) => {
    const c = forwardTransformPt({ x: lx / w, y: ly / h }, o.transform, w, h);
    return [c.x * w, c.y * h] as [number, number];
  });
}

// 点是否在多边形内（奇偶/射线法）。poly 为像素点。
export function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// 套索命中：墨迹要求【全部样本】落在套索内（Goodnotes 式「完整框住」）；
// 形状要求其包围盒中心落在套索内（两点形状很难整条被手画套索框住）。
export function objectInLasso(o: AnnObject, lassoPx: Array<[number, number]>, w: number, h: number): boolean {
  if (lassoPx.length < 3) return false;
  const poly = objectCanvasPolylinePx(o, w, h);
  if (o.kind === "ink") {
    return poly.length > 0 && poly.every(([x, y]) => pointInPolygon(x, y, lassoPx));
  }
  let cx = 0;
  let cy = 0;
  for (const [x, y] of poly) {
    cx += x;
    cy += y;
  }
  return pointInPolygon(cx / poly.length, cy / poly.length, lassoPx);
}

export interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 选中对象的合并包围盒（画布像素）。空选返回 null。
export function selectionBoundsPx(
  objects: AnnObject[],
  ids: Set<string>,
  w: number,
  h: number
): RectPx | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const o of objects) {
    if (!ids.has(o.id)) continue;
    for (const [x, y] of objectCanvasPolylinePx(o, w, h)) {
      any = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!any) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---- 变换组合（在已有 transform 上叠加一次拖拽变换；保持 sx=sy 统一缩放）----

// 平移（dx/dy 归一化）。
export function composeMove(t: Transform, dx: number, dy: number): Transform {
  return { ...t, tx: t.tx + dx, ty: t.ty + dy };
}

// 绕中心 C（归一化）旋转 phi（弧度）。
export function composeRotate(t: Transform, phi: number, cx: number, cy: number, w: number, h: number): Transform {
  const cpx = cx * w;
  const cpy = cy * h;
  const fx = (t.px + t.tx) * w; // 对象固定点（像素）
  const fy = (t.py + t.ty) * h;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const nx = cos * (fx - cpx) - sin * (fy - cpy) + cpx;
  const ny = sin * (fx - cpx) + cos * (fy - cpy) + cpy;
  return { ...t, angle: t.angle + phi, tx: nx / w - t.px, ty: ny / h - t.py };
}

// 绕中心 C（归一化）统一缩放 k。
export function composeScale(t: Transform, k: number, cx: number, cy: number, w: number, h: number): Transform {
  const cpx = cx * w;
  const cpy = cy * h;
  const fx = (t.px + t.tx) * w;
  const fy = (t.py + t.ty) * h;
  const nx = k * (fx - cpx) + cpx;
  const ny = k * (fy - cpy) + cpy;
  return { ...t, sx: t.sx * k, sy: t.sy * k, tx: nx / w - t.px, ty: ny / h - t.py };
}

// 复制粘贴：深拷贝选中对象，生成新 id，整体平移 (dx,dy) 归一化。
export function cloneForPaste(objects: AnnObject[], ids: Set<string>, dx: number, dy: number, mkId: () => string): AnnObject[] {
  const out: AnnObject[] = [];
  for (const o of objects) {
    if (!ids.has(o.id)) continue;
    const t: Transform = { ...o.transform, tx: o.transform.tx + dx, ty: o.transform.ty + dy };
    if (o.kind === "ink") {
      out.push({ ...o, id: mkId(), samples: o.samples.map((s) => ({ ...s })), transform: t });
    } else {
      out.push({ ...o, id: mkId(), a: { ...o.a }, b: { ...o.b }, transform: t });
    }
  }
  return out;
}
