// 批注对象模型。坐标一律归一化到 0–1（相对画布宽/高），width 归一化为「画布高度比例」
// —— 与播放器尺寸/全屏无关，显示、再编辑、合成大图都按当前尺寸还原。
//
// 与旧 strokes.ts 的关键升级：
//  ① 每个对象有稳定 id（套索选中/复制/粘贴需要）。
//  ② 手写墨迹按「样本点」存，带可选压感 p（Apple Pencil）。
//  ③ 每个对象带一个仿射变换 transform（平移/旋转/缩放），非破坏式 —— 旋转缩放只改
//     transform，渲染与命中时再应用（见 renderEngine.ts）。变换在像素空间绕轴心进行，
//     避免非方形画布上旋转被拉斜。
//  ④ 序列化为 v2 信封 { v:2, objects:[...] }；parseDoc 兼容旧版「裸 Stroke[] 数组」。

// 工具：手写(pen/marker) + 形状(line/rect/ellipse/arrow) + 橡皮(整笔/区域) + 套索。
export type DrawTool = "pen" | "marker" | "line" | "rect" | "ellipse" | "arrow";
export type ActiveTool = DrawTool | "eraser" | "eraser-area" | "lasso";

export interface Pt {
  x: number; // 0–1
  y: number; // 0–1
}

export interface InkSample {
  x: number; // 0–1
  y: number; // 0–1
  p?: number; // 压感 0–1；缺省 = 无压感数据（旧数据/鼠标）→ 渲染走 simulatePressure，更自然
}

// 每对象仿射变换。恒等：{tx:0,ty:0,angle:0,sx:1,sy:1,px:0,py:0}。
// tx/ty/px/py 归一化；angle 弧度；sx/sy 缩放系数。px/py 为轴心（建对象时取包围盒中心）。
export interface Transform {
  tx: number;
  ty: number;
  angle: number;
  sx: number;
  sy: number;
  px: number;
  py: number;
}

export const IDENTITY: Transform = { tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, px: 0, py: 0 };

export function identity(): Transform {
  return { ...IDENTITY };
}

export function isIdentity(t: Transform): boolean {
  // px/py 只在有旋转/缩放时起作用，不影响「是否恒等」。
  return t.tx === 0 && t.ty === 0 && t.angle === 0 && t.sx === 1 && t.sy === 1;
}

interface BaseObject {
  id: string;
  color: string; // CSS 颜色（marker 渲染时降透明度）
  width: number; // 画布高度比例（如 0.007）；渲染时基准尺寸 = width * h
  transform: Transform;
}

export interface InkObject extends BaseObject {
  kind: "ink";
  tool: "pen" | "marker";
  samples: InkSample[];
}

export interface ShapeObject extends BaseObject {
  kind: "shape";
  tool: "line" | "rect" | "ellipse" | "arrow";
  a: Pt; // 起点
  b: Pt; // 终点
}

export type AnnObject = InkObject | ShapeObject;

// 工具条提供的 6 色 / 4 档线宽。
export const COLORS = ["#ff5252", "#ffd54f", "#4fc3f7", "#69f0ae", "#ffffff", "#212121"];
export const WIDTHS = [0.004, 0.007, 0.012, 0.02] as const;

// 该墨迹是否含真实压感（任一样本带 p）。决定 perfect-freehand 是否模拟压感。
export function hasRealPressure(o: InkObject): boolean {
  return o.samples.some((s) => s.p !== undefined);
}

// 短 id：crypto.randomUUID 在 Safari 15.4+ / 现代浏览器均有，取前 8 位足够本地唯一。
export function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

// ---- 序列化（v2 信封 + 紧凑编码）----
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const r2 = (n: number) => Math.round(n * 1e2) / 1e2;
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

function tfToWire(t: Transform): number[] | undefined {
  if (isIdentity(t)) return undefined; // 恒等不写，省体积
  return [r4(t.tx), r4(t.ty), r5(t.angle), r4(t.sx), r4(t.sy), r4(t.px), r4(t.py)];
}

function tfFromWire(a: unknown): Transform {
  if (!Array.isArray(a) || a.length < 7) return identity();
  return { tx: +a[0], ty: +a[1], angle: +a[2], sx: +a[3], sy: +a[4], px: +a[5], py: +a[6] };
}

interface WireDoc {
  v: 2;
  objects: unknown[];
}

export function serializeDoc(objects: AnnObject[]): string {
  const doc: WireDoc = {
    v: 2,
    objects: objects.map((o) => {
      const tf = tfToWire(o.transform);
      if (o.kind === "ink") {
        return {
          k: "ink",
          id: o.id,
          tool: o.tool,
          color: o.color,
          width: r4(o.width),
          // 样本紧凑成 [x,y] 或 [x,y,p]（有压感才带第三位）。
          pts: o.samples.map((s) =>
            s.p === undefined ? [r4(s.x), r4(s.y)] : [r4(s.x), r4(s.y), r2(s.p)]
          ),
          ...(tf ? { tf } : {}),
        };
      }
      return {
        k: "shape",
        id: o.id,
        tool: o.tool,
        color: o.color,
        width: r4(o.width),
        a: [r4(o.a.x), r4(o.a.y)],
        b: [r4(o.b.x), r4(o.b.y)],
        ...(tf ? { tf } : {}),
      };
    }),
  };
  return JSON.stringify(doc);
}

// 解析 + 向后兼容。返回内存模型（扁平 AnnObject[]）；v 信封只在序列化边界出现。
export function parseDoc(json: string | null | undefined): AnnObject[] {
  if (!json) return [];
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return [];
  }
  if (Array.isArray(root)) return upgradeV1(root); // 旧版：裸 Stroke[]
  if (root && typeof root === "object" && (root as WireDoc).v === 2) {
    const objs = (root as WireDoc).objects;
    if (Array.isArray(objs)) return parseV2(objs);
  }
  return [];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseV2(arr: unknown[]): AnnObject[] {
  const out: AnnObject[] = [];
  for (const raw of arr) {
    const o = raw as any;
    if (!o || typeof o !== "object") continue;
    const id = typeof o.id === "string" ? o.id : newId();
    const color = typeof o.color === "string" ? o.color : COLORS[0];
    const width = typeof o.width === "number" ? o.width : WIDTHS[1];
    const transform = tfFromWire(o.tf);
    if (o.k === "ink" && Array.isArray(o.pts)) {
      const samples: InkSample[] = o.pts
        .filter((p: any) => Array.isArray(p) && p.length >= 2)
        .map((p: any) => (p.length >= 3 ? { x: +p[0], y: +p[1], p: +p[2] } : { x: +p[0], y: +p[1] }));
      if (samples.length === 0) continue;
      out.push({
        kind: "ink",
        id,
        tool: o.tool === "marker" ? "marker" : "pen",
        color,
        width,
        samples,
        transform,
      });
    } else if (o.k === "shape" && Array.isArray(o.a) && Array.isArray(o.b)) {
      const tool: ShapeObject["tool"] = ["line", "rect", "ellipse", "arrow"].includes(o.tool)
        ? o.tool
        : "line";
      out.push({
        kind: "shape",
        id,
        tool,
        color,
        width,
        a: { x: +o.a[0], y: +o.a[1] },
        b: { x: +o.b[0], y: +o.b[1] },
        transform,
      });
    }
  }
  return out;
}

// 旧版「裸 Stroke[]」升级：pen/marker→InkObject（无压感→不带 p，渲染模拟压感），
// 形状→ShapeObject（取首尾点为 a/b）。全部恒等变换 + 新 id。
function upgradeV1(arr: unknown[]): AnnObject[] {
  const out: AnnObject[] = [];
  for (const raw of arr) {
    const s = raw as any;
    if (!s || !Array.isArray(s.points) || s.points.length === 0) continue;
    const color = typeof s.color === "string" ? s.color : COLORS[0];
    const width = typeof s.width === "number" ? s.width : WIDTHS[1];
    if (s.tool === "pen" || s.tool === "marker") {
      const samples: InkSample[] = s.points
        .filter((p: any) => p && typeof p.x === "number" && typeof p.y === "number")
        .map((p: any) => ({ x: p.x, y: p.y })); // 不带 p → simulatePressure
      if (samples.length === 0) continue;
      out.push({ kind: "ink", id: newId(), tool: s.tool, color, width, samples, transform: identity() });
    } else if (["line", "rect", "ellipse", "arrow"].includes(s.tool)) {
      const a = s.points[0];
      const b = s.points[s.points.length - 1];
      if (!a || !b) continue;
      out.push({
        kind: "shape",
        id: newId(),
        tool: s.tool,
        color,
        width,
        a: { x: a.x, y: a.y },
        b: { x: b.x, y: b.y },
        transform: identity(),
      });
    }
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
