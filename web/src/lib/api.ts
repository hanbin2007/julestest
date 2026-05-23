import { fetcher } from "./fetcher";
import { pickM3u8 } from "./media";
import type {
  BatchBufferVideo,
  BatchResult,
  BatchThumbVideo,
  Course,
  CoursesStatus,
  PlayResponse,
  SegmentsResponse,
  StatusResponse,
  ThumbResponse,
  ThumbsStatus,
  Video,
} from "@/types/api";
import type {
  ChatMessage,
  EnrichedNote,
  LastWatched,
  Note,
  NotesStats,
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
// 单讲逐片缓存 bitmap（可批量）：缓存条用。经兜底代理透传给网关 /api/buffer/segments。
export const getSegmentMaps = (vids: number[], buckets = 60) => {
  const q = vids.map((v) => `vid=${v}`).join("&") + `&buckets=${buckets}`;
  return fetcher<SegmentsResponse>(`/api/buffer/segments?${q}`);
};

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

export interface YoudaoSyncResult {
  ok: boolean;
  courses: { total: number; ok: number; failed: number };
  videos: { scanned: number; created: number; updated: number; skipped: number };
  failedProducts: number[];
}
// 从有道同步观看状态并按「不回退、已学完为准」合并进本地进度。productId 缺省同步全部课程。
export const syncYoudaoProgress = (productId?: number) =>
  postJson<YoudaoSyncResult>(
    "/api/progress/sync-youdao",
    productId ? { productId } : {},
  );

export const getNotes = (videoId: number) =>
  fetcher<{ notes: Note[] }>(`/api/notes?videoId=${videoId}`);
export const addNote = (videoId: number, t: number, text: string, strokes?: string) =>
  postJson<{ note: Note; notes: Note[] }>("/api/notes/add", { videoId, t, text, strokes });
export const updateNote = (videoId: number, id: string, text: string, strokes?: string) =>
  postJson<{ ok: boolean; notes: Note[] }>("/api/notes/update", { videoId, id, text, strokes });
export const deleteNote = (videoId: number, id: string) =>
  postJson<{ ok: boolean; notes: Note[] }>("/api/notes/delete", { videoId, id });

// 统一管理：全量富化笔记 + 统计；批量删除（按全局唯一 id）。
export const getAllNotes = () =>
  fetcher<{ notes: EnrichedNote[]; stats: NotesStats }>("/api/notes/all");
export const deleteNotesBatch = (ids: string[]) =>
  postJson<{ ok: boolean; deleted: number }>("/api/notes/delete-batch", { ids });
// 缺图时按 videoId 现场生成/查询缩略图（服务端解析 src+ids 转发网关）。
export const getNoteThumb = (videoId: number) =>
  fetcher<ThumbResponse>(`/api/notes/thumb?videoId=${videoId}`);
// 记笔记时抓的当前画面（JPEG dataURL）保存到服务端；URL 供 <img> 直接显示。
export const saveNoteSnapshot = (id: string, image: string) =>
  postJson<{ ok: boolean }>("/api/notes/snapshot", { id, image });
export const noteSnapshotUrl = (id: string) =>
  `/api/notes/snapshot?id=${encodeURIComponent(id)}`;

// ---- 内置 Claude 助教（按讲对话）----
export const getChat = (videoId: number) =>
  fetcher<{ messages: ChatMessage[] }>(`/api/chat?videoId=${videoId}`);
export const clearChat = (videoId: number) =>
  postJson<{ ok: boolean }>("/api/chat/clear", { videoId });
export const chatImageUrl = (id: string) => `/api/chat/image?id=${encodeURIComponent(id)}`;
// 流式发送：返回原始 Response，由 useChat 读取 SSE（不走 fetcher/JSON）。
export const sendChat = (videoId: number, text: string, image?: string) =>
  fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, text, image }),
  });

export const getSettings = () =>
  fetcher<{ prefs: Prefs; last: LastWatched | null }>("/api/settings");
export const patchSettings = (patch: {
  prefs?: Partial<Prefs>;
  last?: LastWatched;
}) => postJson<{ ok: boolean }>("/api/settings", patch);

export type { ProgressEntry };
