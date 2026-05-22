export interface Clarity {
  type: number;
  url: string;
}

export interface Course {
  id: number;
  name: string;
  cardType: string | null;
  authors: string[];
}

export interface Video {
  videoId: number;
  contentId: number;
  cardPackageId: number;
  productId: number;
  title: string | null;
  downloadUrl: string | null;
  clarity: Clarity[];
  locked: boolean;
  module: string | null;
  topic: string | null;
  examKey: string | null;
  duration: number | null;
}

export interface PlayResponse {
  url: string;
  m3u8: string;
}

export interface ThumbReady {
  state: "ready";
  url: string;
  number: number;
  column: number;
  width: number;
  height: number;
}
export type ThumbResponse = ThumbReady | { state: "gen" | "error"; reason?: string };

export type ThumbState = "gen" | "ready" | "error";

export interface BufferInfo {
  cached: number;
  total: number | null;
  state: "queued" | "working" | "done" | "error" | null;
}

export interface StatusResponse {
  thumb: {
    states: Record<string, ThumbState>;
    ready: number;
    generating: string[];
    queued: number;
    errors: number;
  };
  buffer: {
    perVid: Record<string, BufferInfo>;
    bytes: number;
    limit: number;
    queued: number;
    working: string[];
  };
  ffmpeg: boolean;
  thumbDir: string;
}

export interface ThumbsStatus {
  bytes: number;
  dir: string;
  ffmpeg: boolean;
  readyCount: number;
  queued: number;
}

export interface BatchResult {
  queued: number;
  skipped: number;
}

export interface BatchThumbVideo {
  videoId: number;
  contentId: number;
  cardPackageId: number;
  productId: number;
  duration: number | null;
  src: string;
}
export interface BatchBufferVideo {
  videoId: number;
  contentId: number;
  cardPackageId: number;
  productId: number;
  src: string;
}

// 课程树中带出的归属信息（设置页/命令面板用）
export interface VideoRow {
  v: Video;
  courseId: number;
  courseName: string;
}
