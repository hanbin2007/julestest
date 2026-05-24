// 套索选择 + 选区变换（移动/旋转/缩放）+ 复制粘贴的几何与组合。
// 关键：变换用「统一缩放」（sx=sy），这样把一次拖拽变换 D 叠加到对象已有变换 T 上时，
// 旋转·缩放·平移仍能落回同一种分解形式（见下 compose*），无需退化为通用矩阵。

import { type AnnObject, type InkObject, type InkSample, type Pt, type Transform, newId } from "./model";
import { forwardTransformPt, inverseTransformPt, distToSeg, localPolyline } from "./renderEngine";

const avgScale = (t: Transform) => (Math.abs(t.sx) + Math.abs(t.sy)) / 2 || 1;

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

// ---- 区域橡皮：用一段「橡皮胶囊」(e0→e1, 半径 rPx, 画布坐标) 切分 / 删除 ----

// 切分一个墨迹对象。橡皮端点逆变换到对象本地空间后逐样本判定；保留段（>=2 点）作为新片段，
// 继承原 transform。未触及返回 null；全擦返回 []。
function splitInk(o: InkObject, e0: Pt, e1: Pt, rPx: number, w: number, h: number): InkObject[] | null {
  const l0 = inverseTransformPt(e0, o.transform, w, h);
  const l1 = inverseTransformPt(e1, o.transform, w, h);
  const ax = l0.x * w;
  const ay = l0.y * h;
  const bx = l1.x * w;
  const by = l1.y * h;
  const effR = rPx / avgScale(o.transform); // 画布容差换算回未缩放的本地空间
  const keep = o.samples.map((s) => distToSeg(s.x * w, s.y * h, ax, ay, bx, by) > effR);
  if (keep.every((k) => k)) return null; // 未触及
  const frags: InkObject[] = [];
  let run: InkSample[] = [];
  const flush = () => {
    if (run.length >= 2) frags.push({ ...o, id: newId(), samples: run });
    run = [];
  };
  for (let i = 0; i < keep.length; i++) {
    if (keep[i]) run.push(o.samples[i]);
    else flush();
  }
  flush();
  return frags;
}

// 形状是否被橡皮胶囊触及（两端逆变换到本地后，shape 折线点对橡皮段、橡皮端点对 shape 段，双向取近）。
function shapeHit(o: AnnObject, e0: Pt, e1: Pt, rPx: number, w: number, h: number): boolean {
  const l0 = inverseTransformPt(e0, o.transform, w, h);
  const l1 = inverseTransformPt(e1, o.transform, w, h);
  const ax = l0.x * w;
  const ay = l0.y * h;
  const bx = l1.x * w;
  const by = l1.y * h;
  const effR = rPx / avgScale(o.transform);
  const poly = localPolyline(o, w, h);
  for (const [x, y] of poly) if (distToSeg(x, y, ax, ay, bx, by) <= effR) return true;
  for (let k = 1; k < poly.length; k++) {
    if (distToSeg(ax, ay, poly[k - 1][0], poly[k - 1][1], poly[k][0], poly[k][1]) <= effR) return true;
    if (distToSeg(bx, by, poly[k - 1][0], poly[k - 1][1], poly[k][0], poly[k][1]) <= effR) return true;
  }
  return false;
}

// 对整组对象施加一次区域橡皮：墨迹切分、形状整删。返回新列表 + 是否有改动。
export function applyAreaEraser(
  objects: AnnObject[],
  e0: Pt,
  e1: Pt,
  rPx: number,
  w: number,
  h: number
): { objects: AnnObject[]; changed: boolean } {
  const out: AnnObject[] = [];
  let changed = false;
  for (const o of objects) {
    if (o.kind === "shape") {
      if (shapeHit(o, e0, e1, rPx, w, h)) changed = true;
      else out.push(o);
      continue;
    }
    const frags = splitInk(o, e0, e1, rPx, w, h);
    if (frags === null) out.push(o);
    else {
      changed = true;
      out.push(...frags);
    }
  }
  return { objects: out, changed };
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
