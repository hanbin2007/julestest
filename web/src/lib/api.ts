import { fetcher } from "./fetcher";
import { pickM3u8 } from "./media";
import type {
  BatchBufferVideo,
  BatchResult,
  BatchThumbVideo,
  Course,
  CoursesStatus,
  PlayResponse,
  StatusResponse,
  ThumbResponse,
  ThumbsStatus,
  Video,
} from "@/types/api";
import type {
  LastWatched,
  Note,
  Prefs,
  ProgressEntry,
  ProgressMap,
  ProgressMeta,
} from "./store";

export const getCourses = () => fetcher<{ courses: Course[] }>("/api/courses");

// 主动刷新目录（会话过期后重抓 req.txt 再点刷新）
export const refreshCatalog = () =>
  postJson<{ ok: boolean; courses: number }>("/api/courses/refresh", {});

export const getCourseVideos = (productId: number) =>
  fetcher<{ videos: Video[] }>(`/api/course?productId=${productId}`);

export function play(v: Video, m3u8: string): Promise<PlayResponse> {
  const q =
    `videoId=${v.videoId}&contentId=${v.contentId}` +
    `&cardPackageId=${v.cardPackageId}&productId=${v.productId}` +
    (v.liveId ? `&liveId=${v.liveId}` : "") + // 直播回放：解密 key 需要 Liveid 头
    `&m3u8=${encodeURIComponent(m3u8)}`;
  return fetcher<PlayResponse>(`/api/play?${q}`);
}

export function getThumb(v: Video, src: string): Promise<ThumbResponse> {
  const q =
    `videoId=${v.videoId}&contentId=${v.contentId}` +
    `&cardPackageId=${v.cardPackageId}&productId=${v.productId}` +
    `&duration=${v.duration ?? 0}&src=${encodeURIComponent(src)}`;
  return fetcher<ThumbResponse>(`/api/thumb?${q}`);
}

export const getStatus = () => fetcher<StatusResponse>("/api/status");
export const getThumbsStatus = () => fetcher<ThumbsStatus>("/api/thumbs/status");
// 设置页：每门课实时状态汇总（网关 per-vid + 目录 + 进度 的服务端聚合）
export const getCoursesStatus = () => fetcher<CoursesStatus>("/api/courses/status");

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const batchThumbs = (videos: BatchThumbVideo[]) =>
  postJson<BatchResult>("/api/thumbs/batch", { videos });
export const batchBuffer = (videos: BatchBufferVideo[]) =>
  postJson<BatchResult>("/api/buffer/batch", { videos });

export const proxiedPlayUrl = (url: string) => url; // /api/play 已返回 /p?... 同源路径
export { pickM3u8 };

// ---- 服务端状态：进度 / 笔记 / 设置（跨设备共享）----
export const getProgressAll = () =>
  fetcher<{ progress: ProgressMap }>("/api/progress");
export const postProgress = (
  videoId: number,
  t: number,
  d: number,
  meta?: ProgressMeta,
) => postJson<{ ok: boolean }>("/api/progress", { videoId, t, d, ...meta });

export const getNotes = (videoId: number) =>
  fetcher<{ notes: Note[] }>(`/api/notes?videoId=${videoId}`);
export const addNote = (videoId: number, t: number, text: string) =>
  postJson<{ note: Note; notes: Note[] }>("/api/notes/add", { videoId, t, text });
export const deleteNote = (videoId: number, id: string) =>
  postJson<{ ok: boolean; notes: Note[] }>("/api/notes/delete", { videoId, id });

export const getSettings = () =>
  fetcher<{ prefs: Prefs; last: LastWatched | null }>("/api/settings");
export const patchSettings = (patch: {
  prefs?: Partial<Prefs>;
  last?: LastWatched;
}) => postJson<{ ok: boolean }>("/api/settings", patch);

export type { ProgressEntry };
