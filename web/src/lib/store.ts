// 状态类型定义。实际持久化已迁到服务端（Python 网关 + Next/SQLite），
// 见 src/lib/api.ts(读写) 与 src/hooks/persist.ts(SWR hooks)。不再用 localStorage。

export interface ProgressEntry {
  t: number; // 最近播放位置（秒）
  d: number; // 时长
  at: number; // 时间戳（ms）
  videoId?: number;
  productId?: number;
  title?: string;
  courseName?: string;
}
export type ProgressMap = Record<string, ProgressEntry>;
export interface ProgressMeta {
  productId?: number;
  title?: string;
  courseName?: string;
}

export interface Note {
  id: string;
  t: number; // 时间戳（秒）
  text: string;
  at: number; // ms
}

export interface Prefs {
  rate: number;
  density: "comfortable" | "compact";
}

export interface LastWatched {
  productId: number;
  videoId: number;
}
