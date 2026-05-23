"use client";
import * as React from "react";
import { drawAll, hitTest, type Pt, type Stroke } from "./strokes";
import type { AnnotationApi } from "./useAnnotation";

// 覆盖在播放器画面上的批注画布。归一化坐标采集 + 实时重绘；
// 自适应容器尺寸（窗口/全屏切换）按 devicePixelRatio 重设像素尺寸。

export default function AnnotationLayer({ api }: { api: AnnotationApi }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const sizeRef = React.useRef({ w: 0, h: 0 }); // CSS 尺寸
  const drawingRef = React.useRef<Stroke | null>(null);
  const apiRef = React.useRef(api);
  apiRef.current = api;

  const redraw = React.useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const { w, h } = sizeRef.current;
    drawAll(ctx, apiRef.current.strokes, w, h);
    if (drawingRef.current) {
      // 在已提交笔画之上叠加当前正在画的一笔
      const s = drawingRef.current;
      drawAll(ctx, [...apiRef.current.strokes, s], w, h);
    }
  }, []);

  // 尺寸同步：容器变化时重设像素尺寸并重绘
  React.useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const parent = c.parentElement;
    if (!parent) return;
    const resize = () => {
      const w = parent.clientWidth, h = parent.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = w + "px";
      c.style.height = h + "px";
      const ctx = c.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { w, h };
      redraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [redraw]);

  // 笔画/工具变化重绘
  React.useEffect(() => {
    redraw();
  }, [api.strokes, redraw]);

  const ptFrom = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = ptFrom(e);
    const { tool, color, width } = apiRef.current;
    if (tool === "eraser") {
      eraseAt(p);
      return;
    }
    drawingRef.current = { tool, color, width, points: [p] };
    redraw();
  };

  const onMove = (e: React.PointerEvent) => {
    if (apiRef.current.tool === "eraser") {
      if (e.buttons) eraseAt(ptFrom(e));
      return;
    }
    const s = drawingRef.current;
    if (!s) return;
    const p = ptFrom(e);
    if (s.tool === "pen" || s.tool === "marker") s.points.push(p);
    else s.points = [s.points[0], p]; // 形状：始终 [起点, 当前]
    redraw();
  };

  const onUp = () => {
    const s = drawingRef.current;
    drawingRef.current = null;
    if (!s) return;
    // 丢弃无效笔画（形状没拖动 / 空折线）
    if ((s.tool === "pen" || s.tool === "marker") && s.points.length < 1) return;
    if (s.tool !== "pen" && s.tool !== "marker" && s.points.length < 2) return;
    apiRef.current.push(s);
  };

  const eraseAt = (p: Pt) => {
    const { w, h } = sizeRef.current;
    const strokes = apiRef.current.strokes;
    const idx = hitTest(strokes, p, w, h, 8);
    if (idx >= 0) apiRef.current.setStrokes(strokes.filter((_, i) => i !== idx));
  };

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        touchAction: "none",
        cursor: api.tool === "eraser" ? "cell" : "crosshair",
      }}
    />
  );
}
