import type { Video } from "@/types/api";

/** 最高清晰度 m3u8（播放用）。 */
export function pickM3u8(v: Video): string | null {
  const c = (v.clarity ?? []).filter((x) => x && x.url).sort((a, b) => (b.type || 0) - (a.type || 0));
  return c.length ? c[0].url : v.downloadUrl ?? null;
}

/** 最低清晰度 m3u8（缩略图源，解码更快）。 */
export function pickLow(v: Video): string {
  const c = (v.clarity ?? []).filter((x) => x && x.url).sort((a, b) => (a.type || 0) - (b.type || 0));
  return c.length ? c[0].url : "";
}

export function fmtDur(s: number | null | undefined): string {
  s = Math.max(0, Math.floor(s || 0));
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(x).padStart(2, "0")}`;
}

export function fmtBytes(n: number | null | undefined): string {
  n = n || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

// 缩略图雪碧图几何，与网关 youdao_course.py 常量对齐：每 10s 一帧、10 列、160×90。
// ArtPlayer 走 /api/thumb 动态返回的同一组值；笔记预览为避免逐讲打网关，直接用常量并
// 允许 ThumbStatus 元数据覆盖。若网关 THUMB_COLS/W/H/INTERVAL 变更，需同步此处。
export const THUMB = { interval: 10, cols: 10, w: 160, h: 90 } as const;

/** 某讲的雪碧图地址（经 next.config rewrite 代理到网关）。 */
export function thumbSheetUrl(videoId: number): string {
  return `/thumbs/${videoId}.jpg`;
}

// 计算时间戳 t 对应帧在雪碧图里的 CSS 定位。displayWidth 让卡片小图与悬停大图共用
// 一套几何（缩放整张雪碧图，而非只缩放单格）。meta 非空则覆盖常量。
export function thumbTile(
  t: number,
  displayWidth: number = THUMB.w,
  meta?: { width?: number | null; column?: number | null; height?: number | null },
): { width: number; height: number; backgroundSize: string; backgroundPosition: string } {
  const w = meta?.width ?? THUMB.w;
  const h = meta?.height ?? THUMB.h;
  const cols = meta?.column ?? THUMB.cols;
  const i = Math.floor(Math.max(0, t || 0) / THUMB.interval);
  const col = i % cols;
  const row = Math.floor(i / cols);
  const s = displayWidth / w;
  return {
    width: w * s,
    height: h * s,
    backgroundSize: `${cols * w * s}px auto`,
    backgroundPosition: `${-col * w * s}px ${-row * h * s}px`,
  };
}
