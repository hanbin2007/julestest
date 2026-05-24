// 状态类型定义。实际持久化已迁到服务端（Python 网关 + Next/SQLite），
// 见 src/lib/api.ts(读写) 与 src/hooks/persist.ts(SWR hooks)。不再用 localStorage。
import type { ChatEffort } from "./chatPrefs";

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
  productId: number; // 服务端现按 ${productId}:${videoId} 复合键存储，必填
  title?: string;
  courseName?: string;
}

export interface Note {
  id: string;
  t: number; // 时间戳（秒）
  text: string;
  strokes?: string | null; // 矢量批注 JSON（Stroke[]）；纯文字笔记为 null
  at: number; // ms
}

// 内置 Claude 助教消息（按讲）。
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  image?: string | null; // 附图文件 id（=消息 id），用 chatImageUrl(id) 取图
  videoT?: number | null; // 提问时的播放位置(秒)；存问答为笔记时作截图/跳转锚点
  at: number; // ms
}

// 缩略图雪碧图元数据（多为 null，前端按常量回退）。
export interface ThumbMeta {
  url?: string | null;
  number?: number | null;
  column?: number | null;
  width?: number | null;
  height?: number | null;
}

// 跨讲富化的笔记：附带所属课程/讲次/时长/缩略图状态，供统一管理界面。
export interface EnrichedNote {
  id: string;
  videoId: number;
  t: number; // 时间戳（秒）
  text: string;
  strokes?: string | null; // 矢量批注 JSON；非 null 即为批注笔记
  at: number; // ms
  courseId: number;
  courseName: string;
  lessonTitle: string;
  duration: number | null;
  kind: "vod" | "live";
  thumbState: string | null; // gen/ready/error/null
  thumb?: ThumbMeta;
  hasSnap: boolean; // 记笔记时抓的手动截图（优先于雪碧图作预览）
}

export interface NotesStats {
  total: number; // 笔记总数
  videos: number; // 已标注的讲数（distinct videoId）
  courses: number; // 覆盖课程数（distinct courseId）
}

export interface Prefs {
  rate: number;
  density: "comfortable" | "compact";
  floatTools?: boolean; // 播放器上常驻「批注/问AI」悬浮按钮（缺省视为开）
  systemPrompt?: string; // AI 助教自定义系统提示词（空/缺省用内置默认）
  chatEffort?: ChatEffort; // AI 助教思考等级（缺省 high）
}

export interface LastWatched {
  productId: number;
  videoId: number;
}
