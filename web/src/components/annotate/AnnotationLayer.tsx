"use client";
import * as React from "react";
import { type AnnObject, type InkSample, type Pt, type Transform, identity, newId } from "./model";
import { clearAndRender, drawObject, hitTestTop } from "./renderEngine";
import {
  objectInLasso,
  selectionBoundsPx,
  composeMove,
  composeRotate,
  composeScale,
  applyAreaEraser,
  type RectPx,
} from "./selection";
import { extractSamples, isDrawingPointer, type RawSample } from "./inputPipeline";
import { StrokeFilter } from "./oneEuro";
import { tuning } from "./inkTuning";
import type { AnnotationApi } from "./useAnnotation";

// 覆盖在播放器画面上的批注画布。两层：
//  · committed（底，pointer-events:none）只在对象/选区/尺寸变化时重画（静止背景零开销）。
//  · live（顶，收指针）每 rAF 重画当前一笔；套索/选区框柄/变换预览也画在这。
// Goodnotes 级流畅：getCoalescedEvents 全速采样 + rAF 批处理 + Apple Pencil 压感 + 掌拒。
// 套索工具下：拖空白处=框选；拖选区内=移动；拖角柄=统一缩放；拖旋转柄=旋转。变换非破坏，
// 落点时把这次拖拽变换叠加进各对象的 transform（见 selection.ts）。

const ACCENT = "#4fc3f7";
const HANDLE_R = 6; // 柄绘制半径(px)
const HIT_R = 16; // 柄命中容差(px)
const ROT_OFFSET = 28; // 旋转柄在包围盒上方的距离(px)

type Drag =
  | { mode: "move"; snap: Map<string, Transform>; start: Pt }
  | { mode: "rotate"; snap: Map<string, Transform>; center: Pt; startAng: number }
  | { mode: "scale"; snap: Map<string, Transform>; center: Pt; startDist: number };

export default function AnnotationLayer({ api }: { api: AnnotationApi }) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const committedRef = React.useRef<HTMLCanvasElement>(null);
  const liveRef = React.useRef<HTMLCanvasElement>(null);
  const sizeRef = React.useRef({ w: 0, h: 0 }); // CSS 尺寸
  const drawingRef = React.useRef<AnnObject | null>(null); // 正在画的一笔
  const lassoRef = React.useRef<Pt[] | null>(null); // 套索轨迹
  const dragRef = React.useRef<Drag | null>(null); // 进行中的选区变换
  const previewRef = React.useRef<Map<string, Transform> | null>(null); // 变换预览
  const excludeRef = React.useRef<Set<string> | null>(null); // committed 重画时排除（变换中）
  const workRef = React.useRef<AnnObject[] | null>(null); // 区域橡皮进行中的工作副本
  const eraseChangedRef = React.useRef(false);
  const lastEraseRef = React.useRef<Pt | null>(null);
  const eraserCursorRef = React.useRef<{ x: number; y: number; r: number } | null>(null); // px
  const pendingRef = React.useRef<InkSample[]>([]);
  const lastSampleRef = React.useRef<Pt | null>(null); // 抽稀用：上一个被接受的采样
  const filterRef = React.useRef(new StrokeFilter()); // One Euro 去抖（位置/压感），每笔重置
  const rafRef = React.useRef<number | null>(null);
  const apiRef = React.useRef(api);
  apiRef.current = api;

  // 处理一批原始采样：① 对每个样本跑 One Euro 去抖（位置 x/y + 压感）——抖动主要在这里消除；
  // ② 再按最小间距抽稀（120Hz+240Hz 聚合会塞大量近重合点，抽稀后每帧 getStroke 成本与笔长解耦）。
  // 滤波对【每个】原始样本都跑（维持滤波器状态连续），抽稀只决定输出哪些。
  const acceptSamples = (raw: RawSample[]): InkSample[] => {
    const { w, h } = sizeRef.current;
    const f = filterRef.current;
    const out: InkSample[] = [];
    let last = lastSampleRef.current;
    for (const s of raw) {
      // 位置在【像素空间】滤波——One Euro 的 minCutoff(Hz)/beta(对 px/s) 才有物理意义；
      // 若在归一化 0–1 上滤，速度数值被画布尺寸缩小上千倍 → 误判为「慢」→ 过度平滑、笔迹严重滞后。
      const fx = f.x.filter(s.x * w, s.t) / w;
      const fy = f.y.filter(s.y * h, s.t) / h;
      const fp = s.p === undefined ? undefined : f.p.filter(s.p, s.t);
      if (!last || Math.hypot((fx - last.x) * w, (fy - last.y) * h) >= tuning.minSampleDist) {
        const samp: InkSample = fp === undefined ? { x: fx, y: fy } : { x: fx, y: fy, p: fp };
        out.push(samp);
        last = samp;
      }
    }
    lastSampleRef.current = last;
    return out;
  };

  const redrawCommitted = React.useCallback(() => {
    const ctx = committedRef.current?.getContext("2d");
    if (!ctx) return;
    const { w, h } = sizeRef.current;
    const objs = workRef.current ?? apiRef.current.objects; // 区域橡皮进行中用工作副本
    clearAndRender(ctx, objs, w, h, excludeRef.current ?? undefined);
  }, []);

  // 选区框 + 角柄 + 旋转柄
  const drawChrome = (ctx: CanvasRenderingContext2D, b: RectPx) => {
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    const cxTop = b.x + b.w / 2;
    const rotY = b.y - ROT_OFFSET;
    ctx.beginPath();
    ctx.moveTo(cxTop, b.y);
    ctx.lineTo(cxTop, rotY);
    ctx.stroke();
    const dot = (x: number, y: number) => {
      ctx.beginPath();
      ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = ACCENT;
      ctx.stroke();
    };
    dot(b.x, b.y);
    dot(b.x + b.w, b.y);
    dot(b.x + b.w, b.y + b.h);
    dot(b.x, b.y + b.h);
    dot(cxTop, rotY); // 旋转柄
    ctx.restore();
  };

  const drawLive = React.useCallback(() => {
    const ctx = liveRef.current?.getContext("2d");
    if (!ctx) return;
    const { w, h } = sizeRef.current;
    ctx.clearRect(0, 0, w, h);
    // 正在画的一笔
    const d = drawingRef.current;
    if (d) {
      drawObject(ctx, d, w, h, false);
      return;
    }
    // 套索轨迹
    const lasso = lassoRef.current;
    if (lasso && lasso.length > 1) {
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(lasso[0].x * w, lasso[0].y * h);
      for (let i = 1; i < lasso.length; i++) ctx.lineTo(lasso[i].x * w, lasso[i].y * h);
      ctx.stroke();
      ctx.restore();
      return;
    }
    // 区域橡皮光标
    const ec = eraserCursorRef.current;
    if (ec && apiRef.current.tool === "eraser-area") {
      ctx.save();
      ctx.beginPath();
      ctx.arc(ec.x, ec.y, ec.r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fill();
      ctx.restore();
    }
    // 选区框柄（含变换预览）
    const ids = apiRef.current.selectedIds;
    if (ids.size === 0) return;
    const preview = previewRef.current;
    const objects = apiRef.current.objects;
    let boundsList = objects;
    if (preview) {
      // 变换中：被排除出 committed，这里按预览 transform 画出来
      boundsList = objects.map((o) => (preview.has(o.id) ? { ...o, transform: preview.get(o.id)! } : o));
      for (const o of boundsList) if (ids.has(o.id)) drawObject(ctx, o, w, h);
    }
    const b = selectionBoundsPx(boundsList, ids, w, h);
    if (b) drawChrome(ctx, b);
  }, []);

  // 尺寸同步
  React.useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const c of [committedRef.current, liveRef.current]) {
        if (!c) continue;
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = w + "px";
        c.style.height = h + "px";
        const ctx = c.getContext("2d");
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      sizeRef.current = { w, h };
      redrawCommitted();
      drawLive();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redrawCommitted, drawLive]);

  // 对象/选区变化 → 重画底层 + 选区框。用 layout effect（绘制前同步重画），
  // 否则提交一笔后 committed 要等下一帧才更新，会闪一下「笔迹消失再出现」。
  React.useLayoutEffect(() => {
    redrawCommitted();
    drawLive();
  }, [api.objects, api.selectedIds, redrawCommitted, drawLive]);

  // 注：工具切换由用户在工具条点击触发，此时画布上没有进行中的指针手势（指针已被 setPointerCapture
  // 捕获到画布，无法中途点工具条），故无需在工具变化时强制清理手势 ref——onUp 各分支已各自收尾。

  // 键盘：复制/粘贴/删除/取消选择（编辑文字时不拦截）
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "c") apiRef.current.copy();
      else if (meta && e.key.toLowerCase() === "v") apiRef.current.paste();
      else if (e.key === "Delete" || e.key === "Backspace") {
        if (apiRef.current.selectedIds.size) {
          e.preventDefault();
          apiRef.current.deleteSelected();
        }
      } else if (e.key === "Escape") apiRef.current.clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rectOf = () => liveRef.current!.getBoundingClientRect();
  const ptFrom = (e: React.PointerEvent): Pt => {
    const r = rectOf();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  const pxFrom = (e: React.PointerEvent) => {
    const r = rectOf();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const scheduleRaf = React.useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const d = drawingRef.current;
      if (d && d.kind === "ink" && pendingRef.current.length) {
        d.samples.push(...pendingRef.current);
        pendingRef.current.length = 0;
      }
      drawLive();
      // 落笔期间持续按显示刷新率重画（ProMotion 120Hz），抬笔(drawingRef=null)即停，不空转。
      if (drawingRef.current) scheduleRaf();
    });
  }, [drawLive]);

  const eraseAt = (p: Pt) => {
    const { w, h } = sizeRef.current;
    const objects = apiRef.current.objects;
    const id = hitTestTop(objects, p, w, h, 8);
    if (id) apiRef.current.setObjects(objects.filter((o) => o.id !== id));
  };

  // 区域橡皮半径(px)：pen 随压感 12–30，鼠标定值。
  const eraserRadius = (e: React.PointerEvent): number =>
    e.pointerType === "pen" ? 12 + (e.pressure > 0 ? e.pressure : 0.5) * 18 : 18;

  const startAreaErase = (e: React.PointerEvent) => {
    const { w, h } = sizeRef.current;
    const p = ptFrom(e);
    const r = eraserRadius(e);
    const res = applyAreaEraser([...apiRef.current.objects], p, p, r, w, h);
    workRef.current = res.objects;
    eraseChangedRef.current = res.changed;
    lastEraseRef.current = p;
    eraserCursorRef.current = { x: p.x * w, y: p.y * h, r };
    redrawCommitted();
    drawLive();
  };

  // 套索工具按下：命中柄/选区内 → 起变换；否则起新套索（清掉旧选区）。
  const startLassoMode = (e: React.PointerEvent) => {
    const { w, h } = sizeRef.current;
    const ids = apiRef.current.selectedIds;
    const px = pxFrom(e);
    if (ids.size) {
      const b = selectionBoundsPx(apiRef.current.objects, ids, w, h);
      if (b) {
        const snap = new Map<string, Transform>();
        for (const o of apiRef.current.objects) if (ids.has(o.id)) snap.set(o.id, { ...o.transform });
        const center: Pt = { x: (b.x + b.w / 2) / w, y: (b.y + b.h / 2) / h };
        const cpx = { x: center.x * w, y: center.y * h };
        const corners = [
          [b.x, b.y],
          [b.x + b.w, b.y],
          [b.x + b.w, b.y + b.h],
          [b.x, b.y + b.h],
        ];
        const rot = { x: b.x + b.w / 2, y: b.y - ROT_OFFSET };
        if (Math.hypot(px.x - rot.x, px.y - rot.y) <= HIT_R) {
          dragRef.current = { mode: "rotate", snap, center, startAng: Math.atan2(px.y - cpx.y, px.x - cpx.x) };
          excludeRef.current = ids;
          redrawCommitted();
          return true;
        }
        for (const [cx, cy] of corners) {
          if (Math.hypot(px.x - cx, px.y - cy) <= HIT_R) {
            dragRef.current = { mode: "scale", snap, center, startDist: Math.hypot(px.x - cpx.x, px.y - cpx.y) || 1 };
            excludeRef.current = ids;
            redrawCommitted();
            return true;
          }
        }
        if (px.x >= b.x && px.x <= b.x + b.w && px.y >= b.y && px.y <= b.y + b.h) {
          dragRef.current = { mode: "move", snap, start: ptFrom(e) };
          excludeRef.current = ids;
          redrawCommitted();
          return true;
        }
      }
    }
    // 起新套索
    apiRef.current.clearSelection();
    lassoRef.current = [ptFrom(e)];
    drawLive();
    return true;
  };

  const onDown = (e: React.PointerEvent) => {
    if (!isDrawingPointer(e.pointerType)) return; // 掌拒
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const { tool, color, width } = apiRef.current;
    if (tool === "eraser") {
      eraseAt(ptFrom(e));
      return;
    }
    if (tool === "lasso") {
      startLassoMode(e);
      return;
    }
    if (tool === "eraser-area") {
      startAreaErase(e);
      return;
    }
    if (tool === "pen" || tool === "marker") {
      lastSampleRef.current = null; // 新一笔，重置抽稀基准（首点必被接受）
      filterRef.current.configure(
        tuning.posMinCutoff, tuning.posBeta, tuning.dCutoff, tuning.pressMinCutoff, tuning.pressBeta
      );
      filterRef.current.reset();
      const samples = acceptSamples(extractSamples(e.nativeEvent, rectOf()));
      drawingRef.current = { kind: "ink", id: newId(), tool, color, width, samples, transform: identity() };
    } else if (tool === "line" || tool === "rect" || tool === "ellipse" || tool === "arrow") {
      const p = ptFrom(e);
      drawingRef.current = { kind: "shape", id: newId(), tool, color, width, a: p, b: p, transform: identity() };
    }
    scheduleRaf();
  };

  // 计算变换预览（拖动选区时）
  const updateDrag = (e: React.PointerEvent) => {
    const { w, h } = sizeRef.current;
    const drag = dragRef.current!;
    const preview = new Map<string, Transform>();
    if (drag.mode === "move") {
      const cur = ptFrom(e);
      const dx = cur.x - drag.start.x;
      const dy = cur.y - drag.start.y;
      drag.snap.forEach((t, id) => preview.set(id, composeMove(t, dx, dy)));
    } else if (drag.mode === "rotate") {
      const px = pxFrom(e);
      const cpx = { x: drag.center.x * w, y: drag.center.y * h };
      const phi = Math.atan2(px.y - cpx.y, px.x - cpx.x) - drag.startAng;
      drag.snap.forEach((t, id) => preview.set(id, composeRotate(t, phi, drag.center.x, drag.center.y, w, h)));
    } else {
      const px = pxFrom(e);
      const cpx = { x: drag.center.x * w, y: drag.center.y * h };
      let k = Math.hypot(px.x - cpx.x, px.y - cpx.y) / drag.startDist;
      k = Math.max(0.1, Math.min(10, k));
      drag.snap.forEach((t, id) => preview.set(id, composeScale(t, k, drag.center.x, drag.center.y, w, h)));
    }
    previewRef.current = preview;
    drawLive();
  };

  const onMove = (e: React.PointerEvent) => {
    const tool = apiRef.current.tool;
    if (tool === "eraser") {
      if (e.buttons && isDrawingPointer(e.pointerType)) eraseAt(ptFrom(e));
      return;
    }
    if (tool === "lasso") {
      if (!e.buttons || !isDrawingPointer(e.pointerType)) return; // 掌拒：杂散触摸不参与框选/变换
      if (dragRef.current) updateDrag(e);
      else if (lassoRef.current) {
        lassoRef.current.push(ptFrom(e));
        drawLive();
      }
      return;
    }
    if (tool === "eraser-area") {
      if (!isDrawingPointer(e.pointerType)) return; // 掌拒：手指/手掌不擦、不动光标
      const { w, h } = sizeRef.current;
      const p = ptFrom(e);
      const r = eraserRadius(e);
      eraserCursorRef.current = { x: p.x * w, y: p.y * h, r };
      if (e.buttons && workRef.current && lastEraseRef.current) {
        const res = applyAreaEraser(workRef.current, lastEraseRef.current, p, r, w, h);
        workRef.current = res.objects;
        if (res.changed) {
          eraseChangedRef.current = true;
          redrawCommitted();
        }
        lastEraseRef.current = p;
      }
      drawLive();
      return;
    }
    const d = drawingRef.current;
    if (!d) return;
    if (!isDrawingPointer(e.pointerType)) return;
    if (d.kind === "ink") pendingRef.current.push(...acceptSamples(extractSamples(e.nativeEvent, rectOf())));
    else d.b = ptFrom(e);
    scheduleRaf();
  };

  const commitDrag = () => {
    const preview = previewRef.current;
    previewRef.current = null;
    dragRef.current = null;
    excludeRef.current = null;
    if (preview && preview.size) {
      const objects = apiRef.current.objects;
      apiRef.current.setObjects(
        objects.map((o) => (preview.has(o.id) ? { ...o, transform: preview.get(o.id)! } : o))
      );
      // 选区保持；setObjects 触发 committed+chrome 重画
    } else {
      redrawCommitted();
      drawLive();
    }
  };

  const finishLasso = () => {
    const { w, h } = sizeRef.current;
    const pts = lassoRef.current!;
    lassoRef.current = null;
    if (pts.length >= 3) {
      const poly = pts.map((p) => [p.x * w, p.y * h] as [number, number]);
      const ids = new Set<string>();
      for (const o of apiRef.current.objects) if (objectInLasso(o, poly, w, h)) ids.add(o.id);
      apiRef.current.select(ids); // 触发 chrome 重画
    }
    drawLive(); // 清掉套索轨迹
  };

  const onUp = () => {
    // 区域橡皮收尾：有改动就把工作副本作为一步撤销提交
    if (workRef.current) {
      const changed = eraseChangedRef.current;
      const work = workRef.current;
      workRef.current = null;
      lastEraseRef.current = null;
      eraseChangedRef.current = false;
      eraserCursorRef.current = null;
      if (changed) apiRef.current.setObjects(work); // 经 effect 重画 committed
      else redrawCommitted();
      drawLive();
      return;
    }
    // 套索工具收尾
    if (dragRef.current) {
      commitDrag();
      return;
    }
    if (lassoRef.current) {
      finishLasso();
      return;
    }
    // 画笔/形状收尾
    const d = drawingRef.current;
    drawingRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (d && d.kind === "ink" && pendingRef.current.length) d.samples.push(...pendingRef.current);
    pendingRef.current.length = 0;
    drawLive();
    if (!d) return;
    if (d.kind === "ink" && d.samples.length < 1) return;
    if (d.kind === "shape" && d.a.x === d.b.x && d.a.y === d.b.y) return;
    apiRef.current.push(d);
  };

  const cursor =
    api.tool === "eraser-area"
      ? "none" // 画自定义圆形光标
      : api.tool === "eraser"
        ? "cell"
        : api.tool === "lasso"
          ? "default"
          : "crosshair";

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0, zIndex: 30 }}>
      <canvas ref={committedRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
      <canvas
        ref={liveRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{ position: "absolute", inset: 0, touchAction: "none", cursor }}
      />
    </div>
  );
}
