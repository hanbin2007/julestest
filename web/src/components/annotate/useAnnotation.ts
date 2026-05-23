"use client";
import * as React from "react";
import { renderStrokes, type Stroke, type Tool, WIDTHS } from "./strokes";

// 批注状态：当前工具/颜色/线宽 + 笔画列表 + 撤销/重做。
// 画布绘制在 AnnotationLayer，本 hook 只管数据与历史。

interface State {
  strokes: Stroke[];
  undo: Stroke[][];
  redo: Stroke[][];
}
type Action =
  | { type: "push"; stroke: Stroke }
  | { type: "set"; strokes: Stroke[] } // 橡皮删除后整体替换
  | { type: "clear" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "load"; strokes: Stroke[] }; // 再编辑：载入并清空历史

const MAX_HISTORY = 50;
const cap = (a: Stroke[][]) => (a.length > MAX_HISTORY ? a.slice(a.length - MAX_HISTORY) : a);

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "push":
      return { strokes: [...s.strokes, a.stroke], undo: cap([...s.undo, s.strokes]), redo: [] };
    case "set":
      return { strokes: a.strokes, undo: cap([...s.undo, s.strokes]), redo: [] };
    case "clear":
      return s.strokes.length === 0 ? s : { strokes: [], undo: cap([...s.undo, s.strokes]), redo: [] };
    case "undo": {
      if (s.undo.length === 0) return s;
      const prev = s.undo[s.undo.length - 1];
      return { strokes: prev, undo: s.undo.slice(0, -1), redo: [...s.redo, s.strokes] };
    }
    case "redo": {
      if (s.redo.length === 0) return s;
      const next = s.redo[s.redo.length - 1];
      return { strokes: next, undo: cap([...s.undo, s.strokes]), redo: s.redo.slice(0, -1) };
    }
    case "load":
      return { strokes: a.strokes, undo: [], redo: [] };
  }
}

export type AnnotationApi = ReturnType<typeof useAnnotation>;

const COLORS = ["#ff5252", "#ffd54f", "#4fc3f7", "#69f0ae", "#ffffff", "#212121"];

export function useAnnotation() {
  const [tool, setTool] = React.useState<Tool>("pen");
  const [color, setColor] = React.useState<string>(COLORS[0]);
  const [width, setWidth] = React.useState<number>(WIDTHS[1]);
  const [state, dispatch] = React.useReducer(reducer, { strokes: [], undo: [], redo: [] });

  return {
    tool, setTool,
    color, setColor,
    width, setWidth,
    colors: COLORS,
    strokes: state.strokes,
    canUndo: state.undo.length > 0,
    canRedo: state.redo.length > 0,
    push: React.useCallback((stroke: Stroke) => dispatch({ type: "push", stroke }), []),
    setStrokes: React.useCallback((strokes: Stroke[]) => dispatch({ type: "set", strokes }), []),
    clear: React.useCallback(() => dispatch({ type: "clear" }), []),
    undo: React.useCallback(() => dispatch({ type: "undo" }), []),
    redo: React.useCallback(() => dispatch({ type: "redo" }), []),
    load: React.useCallback((strokes: Stroke[]) => dispatch({ type: "load", strokes }), []),
  };
}

// 服务端取帧 + 客户端合成笔迹：最可靠的合成路径。
// 浏览器对 HLS/MSE 视频 drawImage 常得黑帧，所以画面帧由 /api/frame（ffmpeg）给，
// 这里只把它当成一张普通同源图片（<img>）来 drawImage —— 不黑、不污染。
export async function bakeWithServerFrame(
  src: string | null,
  t: number,
  strokes: Stroke[]
): Promise<string | null> {
  if (!src) return null;
  try {
    const res = await fetch(`/api/frame?src=${encodeURIComponent(src)}&t=${Math.floor(t)}`);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;
    // createImageBitmap 比 Image+objectURL 可靠（后者在部分浏览器/无头里会静默失败）。
    const bmp = await createImageBitmap(blob);
    const cw = bmp.width || 1280;
    const ch = bmp.height || 720;
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, cw, ch);
    bmp.close?.();
    renderStrokes(ctx, strokes, cw, ch); // 在帧之上画笔迹（不要 clear，否则擦掉帧）
    return c.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

export interface BakeResult {
  image: string | null; // dataURL：优先合成 JPEG，污染时退化为笔迹 PNG
  kind: "composite" | "ink" | "none";
}

// 合成「当前画面帧 + 笔迹」。HLS/MSE 跨源会让 toDataURL 抛错 → 退化为笔迹-only PNG。
export function bakeAnnotation(video: HTMLVideoElement | null | undefined, strokes: Stroke[]): BakeResult {
  const vw = video?.videoWidth ?? 0;
  const vh = video?.videoHeight ?? 0;
  const w = vw || 1280;
  const h = vh || 720;
  // 控制体积：最宽 1600
  const scale = Math.min(1, 1600 / w);
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext("2d");
  if (!ctx) return { image: null, kind: "none" };

  if (video && vw && (video.readyState ?? 0) >= 2) {
    try {
      ctx.drawImage(video, 0, 0, cw, ch);
      renderStrokes(ctx, strokes, cw, ch); // 不要 clear，否则擦掉刚画的帧
      return { image: c.toDataURL("image/jpeg", 0.85), kind: "composite" };
    } catch {
      /* 跨源污染 → 退化 */
    }
  }
  // 兜底（拿不到画面帧 / 跨源污染）：中性底 + 笔迹，仍导出 JPEG（与截图通道一致）。
  ctx.fillStyle = "#1b1b1f";
  ctx.fillRect(0, 0, cw, ch);
  renderStrokes(ctx, strokes, cw, ch);
  try {
    return { image: c.toDataURL("image/jpeg", 0.85), kind: "ink" };
  } catch {
    return { image: null, kind: "none" };
  }
}
