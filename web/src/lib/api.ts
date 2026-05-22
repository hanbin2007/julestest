import { fetcher } from "./fetcher";
import { pickM3u8 } from "./media";
import type {
  BatchBufferVideo,
  BatchResult,
  BatchThumbVideo,
  Course,
  PlayResponse,
  StatusResponse,
  ThumbResponse,
  ThumbsStatus,
  Video,
} from "@/types/api";

export const getCourses = () => fetcher<{ courses: Course[] }>("/api/courses");

export const getCourseVideos = (productId: number) =>
  fetcher<{ videos: Video[] }>(`/api/course?productId=${productId}`);

export function play(v: Video, m3u8: string): Promise<PlayResponse> {
  const q =
    `videoId=${v.videoId}&contentId=${v.contentId}` +
    `&cardPackageId=${v.cardPackageId}&productId=${v.productId}` +
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
