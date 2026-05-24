"use client";
import * as React from "react";
import { type AnnObject, type ActiveTool, COLORS, WIDTHS } from "./model";
import { renderObjects } from "./renderEngine";

// 批注状态：当前工具/颜色/线宽 + 对象列表 + 撤销/重做。
// 画布绘制在 AnnotationLayer，本 hook 只管数据与历史。内存模型是扁平 AnnObject[]，
// { v:2, objects } 信封只在序列化边界出现（见 model.ts）。

interface State {
  objects: AnnObject[];
  undo: AnnObject[][];
  redo: AnnObject[][];
}
type Action =
  | { type: "push"; object: AnnObject }
  | { type: "set"; objects: AnnObject[] } // 橡皮/变换后整体替换
  | { type: "clear" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "load"; objects: AnnObject[] }; // 再编辑：载入并清空历史

const MAX_HISTORY = 50;
const cap = (a: AnnObject[][]) => (a.length > MAX_HISTORY ? a.slice(a.length - MAX_HISTORY) : a);

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "push":
      return { objects: [...s.objects, a.object], undo: cap([...s.undo, s.objects]), redo: [] };
    case "set":
      return { objects: a.objects, undo: cap([...s.undo, s.objects]), redo: [] };
    case "clear":
      return s.objects.length === 0
        ? s
        : { objects: [], undo: cap([...s.undo, s.objects]), redo: [] };
    case "undo": {
      if (s.undo.length === 0) return s;
      const prev = s.undo[s.undo.length - 1];
      return { objects: prev, undo: s.undo.slice(0, -1), redo: [...s.redo, s.objects] };
    }
    case "redo": {
      if (s.redo.length === 0) return s;
      const next = s.redo[s.redo.length - 1];
      return { objects: next, undo: cap([...s.undo, s.objects]), redo: s.redo.slice(0, -1) };
    }
    case "load":
      return { objects: a.objects, undo: [], redo: [] };
  }
}

export type AnnotationApi = ReturnType<typeof useAnnotation>;

export function useAnnotation() {
  const [tool, setTool] = React.useState<ActiveTool>("pen");
  const [color, setColor] = React.useState<string>(COLORS[0]);
  const [width, setWidth] = React.useState<number>(WIDTHS[1]);
  const [state, dispatch] = React.useReducer(reducer, { objects: [], undo: [], redo: [] });

  return {
    tool,
    setTool,
    color,
    setColor,
    width,
    setWidth,
    colors: COLORS,
    objects: state.objects,
    canUndo: state.undo.length > 0,
    canRedo: state.redo.length > 0,
    push: React.useCallback((object: AnnObject) => dispatch({ type: "push", object }), []),
    setObjects: React.useCallback((objects: AnnObject[]) => dispatch({ type: "set", objects }), []),
    clear: React.useCallback(() => dispatch({ type: "clear" }), []),
    undo: React.useCallback(() => dispatch({ type: "undo" }), []),
    redo: React.useCallback(() => dispatch({ type: "redo" }), []),
    load: React.useCallback((objects: AnnObject[]) => dispatch({ type: "load", objects }), []),
  };
}

// 服务端取帧 + 客户端合成笔迹：最可靠的合成路径。
// 浏览器对 HLS/MSE 视频 drawImage 常得黑帧，所以画面帧由 /api/frame（ffmpeg）给，
// 这里只把它当成一张普通同源图片来 drawImage —— 不黑、不污染。
export async function bakeWithServerFrame(
  src: string | null,
  t: number,
  objects: AnnObject[]
): Promise<string | null> {
  if (!src) return null;
  try {
    const res = await fetch(`/api/frame?src=${encodeURIComponent(src)}&t=${Math.floor(t)}`);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;
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
    renderObjects(ctx, objects, cw, ch); // 在帧之上画笔迹（不要 clear，否则擦掉帧）
    return c.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

export interface BakeResult {
  image: string | null; // dataURL：优先合成 JPEG，污染时退化为笔迹 PNG
  kind: "composite" | "ink" | "none";
}

// 合成「当前画面帧 + 笔迹」。HLS/MSE 跨源会让 toDataURL 抛错 → 退化为笔迹-only。
export function bakeAnnotation(
  video: HTMLVideoElement | null | undefined,
  objects: AnnObject[]
): BakeResult {
  const vw = video?.videoWidth ?? 0;
  const vh = video?.videoHeight ?? 0;
  const w = vw || 1280;
  const h = vh || 720;
  const scale = Math.min(1, 1600 / w);
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext("2d");
  if (!ctx) return { image: null, kind: "none" };

  if (video && vw && (video.readyState ?? 0) >= 2) {
    try {
      ctx.drawImage(video, 0, 0, cw, ch);
      renderObjects(ctx, objects, cw, ch);
      return { image: c.toDataURL("image/jpeg", 0.85), kind: "composite" };
    } catch {
      /* 跨源污染 → 退化 */
    }
  }
  ctx.fillStyle = "#1b1b1f";
  ctx.fillRect(0, 0, cw, ch);
  renderObjects(ctx, objects, cw, ch);
  try {
    return { image: c.toDataURL("image/jpeg", 0.85), kind: "ink" };
  } catch {
    return { image: null, kind: "none" };
  }
}
