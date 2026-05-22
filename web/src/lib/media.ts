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
