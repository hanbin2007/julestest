// 轻量 localStorage 持久化：观看进度、时间戳笔记、偏好。SSR 安全（带 guard）。

const PROGRESS = "ydc.progress.v1";
const NOTES = "ydc.notes.v1";
const PREFS = "ydc.prefs.v1";
const LAST = "ydc.last.v1";

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, val: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(val));
    window.dispatchEvent(new CustomEvent("ydc-store", { detail: { key } }));
  } catch {
    /* quota */
  }
}

export interface ProgressEntry {
  t: number; // 最近播放位置（秒）
  d: number; // 时长
  at: number; // 时间戳
  videoId?: number;
  productId?: number;
  title?: string;
  courseName?: string;
}
export type ProgressMap = Record<string, ProgressEntry>;
export interface ProgressMeta {
  videoId?: number;
  productId?: number;
  title?: string;
  courseName?: string;
}

export const getProgressMap = () => read<ProgressMap>(PROGRESS, {});
export function setProgress(videoId: number | string, t: number, d: number, meta?: ProgressMeta) {
  const m = getProgressMap();
  const prev = m[String(videoId)] ?? {};
  m[String(videoId)] = { ...prev, t, d, at: Date.now(), videoId: Number(videoId), ...meta };
  write(PROGRESS, m);
}
export function getProgress(videoId: number | string): ProgressEntry | undefined {
  return getProgressMap()[String(videoId)];
}
export function watchedRatio(videoId: number | string): number {
  const e = getProgress(videoId);
  if (!e || !e.d) return 0;
  return Math.min(1, e.t / e.d);
}

export interface Note {
  id: string;
  t: number; // 时间戳（秒）
  text: string;
  at: number;
}
export type NotesMap = Record<string, Note[]>;
export const getNotesMap = () => read<NotesMap>(NOTES, {});
export function getNotes(videoId: number | string): Note[] {
  return getNotesMap()[String(videoId)] ?? [];
}
export function addNote(videoId: number | string, t: number, text: string): Note {
  const m = getNotesMap();
  const key = String(videoId);
  const note: Note = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, t, text, at: Date.now() };
  m[key] = [...(m[key] ?? []), note].sort((a, b) => a.t - b.t);
  write(NOTES, m);
  return note;
}
export function removeNote(videoId: number | string, id: string) {
  const m = getNotesMap();
  const key = String(videoId);
  m[key] = (m[key] ?? []).filter((n) => n.id !== id);
  write(NOTES, m);
}

export interface Prefs {
  rate: number;
  density: "comfortable" | "compact";
}
export const getPrefs = (): Prefs => read<Prefs>(PREFS, { rate: 1, density: "comfortable" });
export function setPrefs(p: Partial<Prefs>) {
  write(PREFS, { ...getPrefs(), ...p });
}

export interface LastWatched {
  productId: number;
  videoId: number;
}
export const getLast = () => read<LastWatched | null>(LAST, null);
export const setLast = (l: LastWatched) => write(LAST, l);
