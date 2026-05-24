"use client";
import * as React from "react";
import { type AnnObject, type InkSample, type Pt, identity, newId } from "./model";
import { clearAndRender, drawObject, hitTestTop } from "./renderEngine";
import { extractSamples, isDrawingPointer } from "./inputPipeline";
import type { AnnotationApi } from "./useAnnotation";

// 覆盖在播放器画面上的批注画布。两层：
//  · committed（底，pointer-events:none）只在对象/尺寸变化时重画（静止画面帧背景，零开销）。
//  · live（顶，收指针）每个 rAF 重画当前正在画的一笔。
// Goodnotes 级流畅靠：getCoalescedEvents 全速采样 + rAF 批处理（不再每个事件全量重绘）+
// Apple Pencil 压感 + 掌拒（手指/手掌不画）。

export default function AnnotationLayer({ api }: { api: AnnotationApi }) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const committedRef = React.useRef<HTMLCanvasElement>(null);
  const liveRef = React.useRef<HTMLCanvasElement>(null);
  const sizeRef = React.useRef({ w: 0, h: 0 }); // CSS 尺寸
  const drawingRef = React.useRef<AnnObject | null>(null); // 当前正在画的一笔（不入 React 状态）
  const pendingRef = React.useRef<InkSample[]>([]); // 本帧待并入的采样
  const rafRef = React.useRef<number | null>(null);
  const apiRef = React.useRef(api);
  apiRef.current = api;

  const redrawCommitted = React.useCallback(() => {
    const ctx = committedRef.current?.getContext("2d");
    if (!ctx) return;
    const { w, h } = sizeRef.current;
    clearAndRender(ctx, apiRef.current.objects, w, h);
  }, []);

  const drawLive = React.useCallback(() => {
    const ctx = liveRef.current?.getContext("2d");
    if (!ctx) return;
    const { w, h } = sizeRef.current;
    ctx.clearRect(0, 0, w, h);
    const d = drawingRef.current;
    if (d) drawObject(ctx, d, w, h, false); // last:false → 开放笔尾，提交时再封口
  }, []);

  // 尺寸同步：容器变化时重设两块画布像素尺寸并重绘
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

  // 已提交对象变化 → 重画底层
  React.useEffect(() => {
    redrawCommitted();
  }, [api.objects, redrawCommitted]);

  const rectOf = () => liveRef.current!.getBoundingClientRect();

  const ptFrom = (e: React.PointerEvent): Pt => {
    const r = rectOf();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
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
      // 不自循环：onMove 每个事件都会再 schedule；笔停住时无 move → 不空转重画。
    });
  }, [drawLive]);

  const eraseAt = (p: Pt) => {
    const { w, h } = sizeRef.current;
    const objects = apiRef.current.objects;
    const id = hitTestTop(objects, p, w, h, 8);
    if (id) apiRef.current.setObjects(objects.filter((o) => o.id !== id));
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
    if (tool === "pen" || tool === "marker") {
      const samples = extractSamples(e.nativeEvent, rectOf());
      drawingRef.current = { kind: "ink", id: newId(), tool, color, width, samples, transform: identity() };
    } else if (tool === "line" || tool === "rect" || tool === "ellipse" || tool === "arrow") {
      const p = ptFrom(e);
      drawingRef.current = { kind: "shape", id: newId(), tool, color, width, a: p, b: p, transform: identity() };
    } else {
      return; // lasso / eraser-area：后续阶段
    }
    scheduleRaf();
  };

  const onMove = (e: React.PointerEvent) => {
    const tool = apiRef.current.tool;
    if (tool === "eraser") {
      if (e.buttons && isDrawingPointer(e.pointerType)) eraseAt(ptFrom(e));
      return;
    }
    const d = drawingRef.current;
    if (!d) return;
    if (!isDrawingPointer(e.pointerType)) return; // 落笔后忽略杂散触摸
    if (d.kind === "ink") {
      pendingRef.current.push(...extractSamples(e.nativeEvent, rectOf()));
    } else {
      d.b = ptFrom(e); // 形状：始终 [起点, 当前]
    }
    scheduleRaf();
  };

  const onUp = () => {
    const d = drawingRef.current;
    drawingRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // 收尾：把残余采样并入
    if (d && d.kind === "ink" && pendingRef.current.length) {
      d.samples.push(...pendingRef.current);
    }
    pendingRef.current.length = 0;
    drawLive(); // 清空 live 层
    if (!d) return;
    // 丢弃无效笔（空墨迹 / 没拖动的形状）
    if (d.kind === "ink" && d.samples.length < 1) return;
    if (d.kind === "shape" && d.a.x === d.b.x && d.a.y === d.b.y) return;
    apiRef.current.push(d); // → 触发 committed 重画
  };

  const cursor = api.tool === "eraser" ? "cell" : "crosshair";

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
