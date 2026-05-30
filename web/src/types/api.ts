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

// 网关 /api/status 的（增强后）形状。仅服务端 /api/courses/status 消费，浏览器不读。
// 单一规范定义：以前 /api/status 与 /api/courses/status 各有一份且已漂移，现收口于此。
// cached = 磁盘真相，total = len(seg_urls)（网关 _vid_counts 单一真相源算出，二字段不会分歧）。
export interface GwStatus {
  thumb: {
    states: Record<string, string>;
    ready: number;
    generating: string[];
    working: string[];
    queued_vids: string[];
    queued: number;
    errors: number;
    session?: string[];
    bytes?: number;
    // 仅 error 态附原因（网关 thumb_meta[vid].reason），供 web 写历史/展示失败原因用。
    reasons?: Record<string, string | null>;
  };
  buffer: {
    perVid: Record<
      string,
      { cached: number; total: number | null; state: string | null; bytes: number; thumbBytes: number; reason?: string | null }
    >;
    bytes: number;
    limit: number;
    queued: number;
    working: string[];
    queued_vids: string[];
    states?: Record<string, string>;
  };
  live?: {
    active: string | null;
    playhead: Record<string, number | null>;
    done?: string[];
    inFlight: { live: number; auto: number; manual: number };
  };
  ffmpeg: boolean;
  thumbDir: string;
  cacheDir?: string;
  cacheDirOk?: boolean;
  // 预留 hint(网关仍在 /api/status 里发, 但 route.ts 当前【从不读】): 本意是「maxSeq 未涨就跳过拉
  // task_events 省一次请求」。⚠️ 若将来真要据它跳过, 必须用 (epoch, maxSeq) 复合判定而非裸 maxSeq:
  // corrupt 重启会把 seq 复位到 0(< 本地游标), 裸 maxSeq 比较会误判「没涨」而 stale-skip, 永远拉不到
  // 当前 epoch 的低 seq 新事件(正是 ingestTaskEvents.refetchFromZero 治的那条路)。当前未消费, 留作文档。
  tasks?: { maxSeq: number };
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
  // 直播回放：网关侧拼 Liveid 头取 AES key；点播置 null
  liveId?: number | null;
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
  // 历史时间线：TaskHistory.at 的毫秒时间戳（全屏完整时间线显示时间、区分同任务多行）。实时任务无此值。
  at?: number;
  // 失败原因（state=error 时由网关 reason 透传）；其它态为 null/undefined。
  reason?: string | null;
}

// ---- 任务事件日志(网关 /api/task_events)：真终态转换点 append,带单调 seq ----
// 网关单条事件。vid 为字符串(网关 str(vid));写库时 videoId=Number(ev.vid)、at=new Date(ev.ts*1000)。
export interface TaskEvent {
  epoch: number; // per-boot epoch(每次网关启动 +1);事件行 id='evt-<epoch>-<seq>'(#3)
  seq: number; // epoch 内单调序号(跨重启可复用,靠 epoch 区分行)
  kind: string; // 'buffer' | 'thumb' | 'prefetch'
  vid: string; // 网关侧 str(vid)
  productId?: number | null; // 共享讲归属(#15):网关从 video_meta 盖上,可能为 null/缺省
  state: string; // buffer: done|error|paused|cancelled / thumb: done|error / prefetch: done
  reason: string | null; // 仅 error 填(最多 200 字)
  ts: number; // time.time() 浮点秒
}
// 网关 /api/task_events?since=N 的返回:epoch=本 boot epoch,seq=当前峰值序号,
// events=本 epoch 内 seq>N + 任何老 epoch 残留事件(各自带 epoch,web 按 id 去重)。
export interface TaskEventsResp {
  events: TaskEvent[];
  epoch: number;
  seq: number;
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
  allTasks: TaskItem[]; // 全部历史：DB-backed,网关重启不丢;倒序最近 500 条
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
