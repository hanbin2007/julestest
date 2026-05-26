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
  // 点播为 "vod"；直播回放为 "live"。旧目录数据可能缺字段，读取时按 "vod" 处理。
  kind?: "vod" | "live";
  // 仅直播回放：解密 key 接口需要的 liveId，以及按 分栏/年/月 的分组信息。
  liveId?: number | null;
  liveTab?: string | null;
  year?: string | null;
  month?: string | null;
  startTime?: number | null;
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
  // 直播回放：网关侧拼 Liveid 头取 AES key；点播置 null
  liveId?: number | null;
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

// ---- 设置页：每门课实时状态汇总（/api/courses/status）----
export interface VidStatusDetail {
  cached: number; // 已缓存分片数（磁盘真相，含观看/预缓存/重启后残留）
  total: number | null; // 总分片数（已知时）
  bytes: number; // 该讲占用字节
  state: "full" | "partial" | "cached" | "queued" | "working" | "paused" | "done" | "cancelled" | "error" | null;
  thumb: "ready" | "gen" | "error" | null;
}
export interface CourseStatus {
  productId: number;
  name: string;
  cardType: string | null;
  lectures: number;
  vod: number;
  live: number;
  allLocked: boolean;
  cachedLectures: number; // ≥1 分片已缓存（含部分）
  fullyCached: number; // 整集已缓存
  partialRatio: number; // cachedLectures / lectures
  fullRatio: number; // fullyCached / lectures
  cachedBytes: number; // 本课占用字节合计
  thumbsReady: number;
  thumbsGen: number;
  thumbsError: number;
  buffering: number;
  queued: number;
  watched: number; // t/d ≥ 0.9 的讲数
}
// 任务在面板里的呈现态：进行中(working/queued/paused) / 已完成(done/cancelled) / 失败(error)。
export type TaskState = "working" | "queued" | "paused" | "done" | "cancelled" | "error";
// 可对任务执行的操作（prefetch 只读、不接受任何操作）。
export type TaskVerb = "pause" | "resume" | "cancel" | "retry";

export interface TaskItem {
  vid: number;
  title: string;
  courseName: string;
  courseId: number;
  kind: "thumb" | "buffer" | "prefetch";
  state: TaskState;
  cached?: number;
  total?: number | null;
}

// 网关 /api/tasks/action 的返回：操作后即时复查到的最新状态（成功 ok=true）。
export interface TaskActionResult {
  ok: boolean;
  vid: string;
  kind: "buffer" | "thumb";
  state: TaskState | null;
  reason?: string | null;
}
// ---- 单讲逐片缓存 bitmap（/api/buffer/segments）：看课页 + 设置页缓存条 ----
export interface SegmentMap {
  total: number | null; // 总分片数（已知时）
  cached: number; // 已缓存分片数
  // 定长格子，每格 = 该区间已缓存占比 0..1（无论分片多少都给定长、可上色的一条）。
  // null 表示没有有序分片列表（如重启后只看过一次还没复看）→ 前端回退到比例条。
  buckets: number[] | null;
  playhead: number | null; // 预缓存播放头位置 0..1（仅当前自动预缓存那讲有值）
}
export interface SegmentsResponse {
  segments: Record<string, SegmentMap>;
}

export interface CoursesStatus {
  courses: CourseStatus[];
  perVid: Record<string, VidStatusDetail>;
  totals: {
    bufferBytes: number;
    bufferLimit: number;
    thumbBytes: number;
    lectures: number;
    cachedLectures: number;
    thumbsReady: number;
  };
  activity: {
    downloadingVid: number | null;
    title: string | null;
    tier: "buffer" | "prefetch" | "thumb" | null;
    queue: { thumb: number; buffer: number };
  };
  tasks: TaskItem[]; // 进行中：working / queued / paused
  completedTasks: TaskItem[]; // 已完成：done / cancelled（仅本会话任务）
  failedTasks: TaskItem[]; // 失败：error（可重试）
  health: {
    gatewayOnline: boolean;
    stale: boolean;
    ffmpeg: boolean;
    updatedAt: number;
    cacheDir: string; // 当前生效的缓存目录（空=临时/未知）
    cacheDirOk: boolean; // 该目录当前是否存在且可写（丢失/掉盘=false）
  };
  orphans: { vid: number; segments: number; bytes: number }[];
}
