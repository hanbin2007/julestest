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
import { InkStrokeProcessor } from "./inkProcessor";
import { tuning } from "./inkTuning";
import { videoContentRect } from "./videoFit";
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

export default function AnnotationLayer({
  api,
  video,
  onCommitStroke,
}: {
  api: AnnotationApi;
  video?: HTMLVideoElement | null;
  // 提供时:落笔提交墨迹改为发出原始数据(供 /ink-tune 录制),且【不再 api.push】(让调参台独占对象真源)。
  // 不提供时:维持现状 api.push —— 生产零行为变化。仅作用于 pen/marker;形状不受影响。
  onCommitStroke?: (
    raw: RawSample[],
    frame: { w: number; h: number },
    meta: { tool: "pen" | "marker"; color: string; width: number }
  ) => void;
}) {
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
  const processorRef = React.useRef<InkStrokeProcessor | null>(null); // 当前一笔的输入阶段处理器,onDown 建、onUp/onCancel 清
  const rawStrokeRef = React.useRef<RawSample[]>([]); // 当前一笔的原始样本累积(供 onCommitStroke 录制)
  const rafRef = React.useRef<number | null>(null);
  const apiRef = React.useRef(api);
  apiRef.current = api;

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

  // 尺寸同步：把批注画布定位/缩放到「视频实际显示矩形」(object-fit:contain 的内容区)，
  // 让笔迹坐标锚定到视频帧而非播放器盒——否则非 16:9 视频被 letterbox 后，以盒归一化存的
  // 笔迹合成回原始帧会整体平移/缩放错位(转 AI 助教时看到的「定位跑偏」)。
  React.useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const host = wrap.parentElement; // 批注宿主层 inset:0 铺满 $player，其尺寸=播放器盒
    const resize = () => {
      const boxW = host?.clientWidth ?? 0;
      const boxH = host?.clientHeight ?? 0;
      if (!boxW || !boxH) return;
      const rect = videoContentRect(boxW, boxH, video?.videoWidth ?? 0, video?.videoHeight ?? 0);
      const w = rect.width;
      const h = rect.height;
      if (!w || !h) return;
      // 尺寸未变就跳过：ResizeObserver 会重复触发，重设 canvas.width/height 会清空 GPU
      // 缓冲并触发整页重描笔迹，纯属浪费。
      if (sizeRef.current.w === w && sizeRef.current.h === h) return;
      wrap.style.left = rect.left + "px";
      wrap.style.top = rect.top + "px";
      wrap.style.width = w + "px";
      wrap.style.height = h + "px";
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
      // 平滑器在像素空间工作（基于 sizeRef），样本却按 rectOf() 归一化；中途改尺寸会让
      // 滤波基准与采样基准错位。尺寸真正变化时重置进行中的平滑器，避免混入旧基准的历史。
      // 进行中的一笔:尺寸变了重建处理器(像素空间基准变),等价于原来的 reset + 清抽稀基准。空闲(null)时无操作。
      if (processorRef.current) processorRef.current = new InkStrokeProcessor(tuning, w, h);
      redrawCommitted();
      drawLive();
    };
    resize();
    // 观察播放器盒尺寸变化(全屏/分屏/旋转/窗口)；wrap 自身尺寸由我们设定，故观察 host 而非 wrap。
    const ro = new ResizeObserver(resize);
    if (host) ro.observe(host);
    // 视频元数据就绪或换源(内在尺寸变化)时重算 letterbox 矩形。
    video?.addEventListener("loadedmetadata", resize);
    video?.addEventListener("resize", resize);
    return () => {
      ro.disconnect();
      video?.removeEventListener("loadedmetadata", resize);
      video?.removeEventListener("resize", resize);
    };
  }, [redrawCommitted, drawLive, video]);

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

  // 卸载清理：取消挂起的 rAF 并清空 drawingRef。drawingRef 置空是关键——它切断
  // scheduleRaf 里 `if (drawingRef.current) scheduleRaf()` 的自我续命，否则中途关闭
  // 批注层时若一笔仍在进行，rAF 回调会无限重排（内存/CPU 泄漏）。
  React.useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    drawingRef.current = null;
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
      const { w, h } = sizeRef.current;
      const raw = extractSamples(e.nativeEvent, rectOf());
      rawStrokeRef.current = [...raw]; // 新一笔:原始样本从首批开始累积
      processorRef.current = new InkStrokeProcessor(tuning, w, h); // 构造即 configure+reset(读当前 tuning)
      const samples = processorRef.current.push(raw);
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
    if (d.kind === "ink") {
      const raw = extractSamples(e.nativeEvent, rectOf());
      rawStrokeRef.current.push(...raw);
      pendingRef.current.push(...(processorRef.current?.push(raw) ?? []));
    } else d.b = ptFrom(e);
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
    const finishInk = () => {
      rawStrokeRef.current = [];
      processorRef.current = null;
    };
    if (!d) {
      finishInk();
      return;
    }
    if (d.kind === "ink" && d.samples.length < 1) {
      finishInk();
      return;
    }
    if (d.kind === "shape" && d.a.x === d.b.x && d.a.y === d.b.y) return; // 形状不涉及原始累积
    if (d.kind === "ink" && onCommitStroke) {
      // 调参台模式:发原始数据给页面,不进 api(让调参台独占真源、撤销历史干净)
      onCommitStroke(rawStrokeRef.current, { ...sizeRef.current }, { tool: d.tool, color: d.color, width: d.width });
      finishInk();
      return;
    }
    finishInk();
    apiRef.current.push(d); // 生产:照旧 push
  };

  // pointercancel：系统手势（下拉通知、浏览器滚动接管等）取消指针时放弃进行中的操作，不提交。
  // 各分支只丢弃中间态，不写入 undo 历史，画布还原到操作前状态。
  const onCancel = () => {
    // 区域橡皮：丢弃工作副本，还原到操作前的对象列表（不提交任何擦除）
    if (workRef.current) {
      workRef.current = null;
      lastEraseRef.current = null;
      eraseChangedRef.current = false;
      eraserCursorRef.current = null;
      redrawCommitted(); // 读原始 apiRef.current.objects
      drawLive();
      return;
    }
    // 选区变换（移动/旋转/缩放）：丢弃预览，不调 commitDrag()，对象保持原始 transform
    if (dragRef.current) {
      dragRef.current = null;
      previewRef.current = null;
      excludeRef.current = null;
      redrawCommitted(); // 排除列表已清，原始对象重新出现在 committed 层
      drawLive();        // 清掉选区框预览
      return;
    }
    // 套索轨迹：丢弃轨迹，不调 finishLasso()，不改变选区
    if (lassoRef.current) {
      lassoRef.current = null;
      drawLive();
      return;
    }
    // 画笔/形状笔画：丢弃未提交的笔画，不调 apiRef.current.push()
    drawingRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingRef.current.length = 0;
    rawStrokeRef.current = [];
    processorRef.current = null;
    drawLive();
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
    <div ref={wrapRef} style={{ position: "absolute", left: 0, top: 0, zIndex: 30 }}>
      <canvas ref={committedRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
      <canvas
        ref={liveRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        style={{ position: "absolute", inset: 0, touchAction: "none", cursor }}
      />
    </div>
  );
}
