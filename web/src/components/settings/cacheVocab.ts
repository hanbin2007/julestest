import type { TaskState } from "@/types/api";

// 任务生命周期：全站唯一。消除 完成/已完成、cancelled/已取消 等漂移。
export const TASK_STATE_LABEL: Record<TaskState, string> = {
  working: "进行中",
  queued: "排队",
  paused: "已暂停",
  done: "已完成", // 注意：不是「完成」
  cancelled: "已取消",
  error: "失败",
};

// 缩略图就绪度
export const THUMB_LABEL: Record<"ready" | "gen" | "error" | "none", string> = {
  ready: "已生成",
  gen: "生成中",
  error: "失败",
  none: "未生成",
};

// 缓存覆盖文案（供 CacheBar）：cached / total → 人话标签。
export function coverageLabel(cached: number, total: number | null): string {
  if (cached <= 0) return "未缓存";
  if (total == null) return "缓存中（总数待确认）";
  const shown = Math.min(cached, total);
  return shown >= total ? "已缓存(完整)" : `已缓存 ${shown}/${total}`;
}

// 动作确认 toast
export const VERB_DONE: Record<string, string> = {
  pause: "已暂停", resume: "已继续", cancel: "已取消", retry: "已重试", dismiss: "已清除",
};
