"use client";
import * as React from "react";
import { Box, Chip, CircularProgress, IconButton, LinearProgress, Tooltip, Typography } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import ImageRoundedIcon from "@mui/icons-material/ImageRounded";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import type { TaskItem, TaskState, TaskVerb } from "@/types/api";

export const KIND = {
  buffer: { label: "缓冲", Icon: DownloadRoundedIcon, color: "primary" as const },
  thumb: { label: "缩略图", Icon: ImageRoundedIcon, color: "secondary" as const },
  prefetch: { label: "预缓存", Icon: BoltRoundedIcon, color: "info" as const },
};

// 两个标签：进行中(working/queued/paused) + 历史(DB-backed 全部任务,只读冻结快照)。
// 失败不再单列标签——改用进行中区上方的内联警示横幅突出。顺序对应 [tasks, allTasks]。
export const TASK_TABS = [
  { label: "进行中", empty: "暂无进行中的任务" },
  { label: "操作历史", empty: "暂无任务历史" },
] as const;

// 任务稳定标识：React key 与 busy 集合键统一走它，TaskItem 形状变了只改这一处。
export const taskKey = (t: TaskItem) => `${t.kind}-${t.vid}`;

// 某任务在当前状态下可执行的操作。prefetch 由播放驱动、切走自停 → 只读；
// 缩略图是单次原子 ffmpeg，无部分续传 → 只能取消/重试，没有暂停/继续。
export function availableVerbs(kind: TaskItem["kind"], state: TaskState): TaskVerb[] {
  if (kind === "prefetch") return [];
  if (kind === "buffer") {
    if (state === "working") return ["pause", "cancel"];
    if (state === "paused") return ["resume", "cancel"];
    if (state === "queued") return ["cancel"];
    if (state === "error") return ["retry"];
    return [];
  }
  // thumb
  if (state === "working" || state === "queued") return ["cancel"];
  if (state === "error") return ["retry"];
  return [];
}

type ChipColor = "default" | "primary" | "secondary" | "info" | "warning" | "success" | "error";
const CHIP: Record<TaskState, { label: string; color: ChipColor }> = {
  working: { label: "进行中", color: "default" }, // working 实际用 kind 色，见下
  queued: { label: "排队", color: "default" },
  paused: { label: "已暂停", color: "warning" },
  done: { label: "完成", color: "success" },
  cancelled: { label: "已取消", color: "default" },
  error: { label: "失败", color: "error" },
};

const VERB_BTN: Record<TaskVerb, { title: string; Icon: typeof PauseRoundedIcon; color?: "error" }> = {
  pause: { title: "暂停", Icon: PauseRoundedIcon },
  resume: { title: "继续", Icon: PlayArrowRoundedIcon },
  retry: { title: "重试", Icon: ReplayRoundedIcon },
  cancel: { title: "取消", Icon: CloseRoundedIcon, color: "error" },
};

function TaskRow({
  task,
  onAction,
  busy,
  isHistory = false,
}: {
  task: TaskItem;
  onAction?: (verb: TaskVerb) => void;
  busy?: boolean;
  // 历史只读视图: 隐藏"暂停/继续/取消/重试"按钮(那些动作只对当前态有效;
  // 历史里的 done/cancelled/error 是冻结快照)。
  isHistory?: boolean;
}) {
  const k = KIND[task.kind];
  const st = task.state;
  const working = st === "working";
  const pct = task.cached != null && task.total ? Math.min(100, (task.cached / task.total) * 100) : null;
  const chip = CHIP[st];
  const chipColor: ChipColor = working ? k.color : chip.color;
  const verbs = onAction && !isHistory ? availableVerbs(task.kind, st) : [];
  const dotColor =
    st === "paused" ? "warning.main" : st === "error" ? "error.main" : st === "done" ? "success.main" : "text.disabled";

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5, px: 0.5 }}>
      {/* 状态指示：进行中转圈，其余用对应颜色的点 */}
      {working ? (
        <CircularProgress size={14} thickness={6} />
      ) : (
        <Box sx={{ width: 14, display: "flex", justifyContent: "center", flexShrink: 0 }}>
          <Box sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: dotColor }} />
        </Box>
      )}
      {/* 类型图标 */}
      <k.Icon sx={{ fontSize: 16, color: `${k.color}.main`, flexShrink: 0 }} />
      {/* 标题 + 课程名 + 进度条 */}
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" noWrap title={`${k.label}: ${task.title}`}>
          {/* 历史标签里同 vid 多种 kind 都会出现(缓冲/缩略图/预缓存各一行),
             标题前加 kind 前缀区分,避免用户视觉以为"重复"。 */}
          {isHistory ? <Box component="span" sx={{ color: `${k.color}.main`, mr: 0.5 }}>[{k.label}]</Box> : null}
          {task.title}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap title={task.courseName}>
          {task.courseName}
        </Typography>
        {pct != null && (
          <LinearProgress variant="determinate" value={pct} sx={{ mt: 0.5, height: 4, borderRadius: (t) => t.radius.full }} />
        )}
      </Box>
      {/* 状态徽标 + 分片计数 */}
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0.5, flexShrink: 0 }}>
        <Chip size="small" variant="outlined" color={chipColor} label={chip.label} sx={{ height: 22, fontSize: 11 }} />
        {task.cached != null && (
          <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {task.cached}
            {task.total ? `/${task.total}` : ""} 段
          </Typography>
        )}
      </Box>
      {/* 操作按钮（按当前状态可用项渲染；动作进行中禁用避免连点） */}
      {verbs.length > 0 && (
        <Box sx={{ display: "flex", gap: 0.25, flexShrink: 0 }}>
          {verbs.map((v) => {
            const b = VERB_BTN[v];
            return (
              <Tooltip key={v} title={b.title}>
                <span>
                  <IconButton
                    size="small"
                    color={b.color}
                    disabled={busy}
                    onClick={() => onAction?.(v)}
                    sx={{ p: 0.25 }}
                    aria-label={b.title}
                  >
                    <b.Icon sx={{ fontSize: 16 }} />
                  </IconButton>
                </span>
              </Tooltip>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

export default React.memo(TaskRow);
