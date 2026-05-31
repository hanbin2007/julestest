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
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
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

// 某任务在当前状态下可执行的操作。
// prefetch（自动·随播放）：现可控——pause/resume/cancel（无 retry：切回该讲即自动重新预缓存）。
// 缩略图是单次原子 ffmpeg，无部分续传 → 只能取消/重试，没有暂停/继续。
export function availableVerbs(kind: TaskItem["kind"], state: TaskState): TaskVerb[] {
  if (kind === "prefetch") {
    if (state === "working") return ["pause", "cancel"];
    if (state === "paused") return ["resume", "cancel"];
    return []; // cancelled/done 等终态：无操作（切回该讲会自动重启预缓存）
  }
  if (kind === "buffer") {
    if (state === "working") return ["pause", "cancel"];
    if (state === "paused") return ["resume", "cancel"];
    if (state === "queued") return ["cancel"];
    if (state === "error") return ["retry", "dismiss"];
    return [];
  }
  // thumb
  if (state === "working" || state === "queued") return ["cancel"];
  if (state === "error") return ["retry", "dismiss"];
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
  dismiss: { title: "清除（从失败列表移除）", Icon: DeleteOutlineRoundedIcon, color: "error" },
};

// 历史时间线时间戳格式化:今天显示 HH:mm,跨天显示 MM-DD HH:mm(本地时间)。
function fmtHistTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

// 取消按钮的标签/提示按 kind 区分：缓冲取消是「暂停并保留已缓存片段」(可恢复)，
// 缩略图取消是「终止」(单次 ffmpeg 无部分续传，取消后不可恢复)，
// 预缓存取消是「停止本讲自动预缓存」(已缓存片段保留；切回该讲会自动重新预缓存)。
function cancelMeta(kind: TaskItem["kind"]) {
  if (kind === "thumb") return { label: "终止", tip: "缩略图取消后不可恢复" };
  if (kind === "prefetch") return { label: "取消", tip: "停止本讲自动预缓存（已缓存片段保留；切回该讲会自动重新预缓存）" };
  return { label: "取消", tip: "取消会暂停并保留已缓存片段" };
}

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
  // 防御性兜底：历史里可能混入不在 TaskState/KIND 枚举内的网关瞬态(如缩略图 gen),
  // 直接 CHIP[st]/KIND[kind] 取到 undefined 再读 .color 会抛错把整页 unmount(白屏)。
  const k = KIND[task.kind] ?? { label: task.kind, Icon: DownloadRoundedIcon, color: "primary" as const };
  const st = task.state;
  // 历史是冻结快照:非终态(残留 working)不转圈,降级成静态点(dotColor 落到 text.disabled 灰点)。
  const working = st === "working" && !isHistory;
  const pct = task.cached != null && task.total ? Math.min(100, (task.cached / task.total) * 100) : null;
  const chip = CHIP[st] ?? { label: String(st), color: "default" as ChipColor };
  const chipColor: ChipColor = working ? k.color : chip.color;
  const verbs = onAction && !isHistory ? availableVerbs(task.kind, st) : [];
  const isPrefetch = task.kind === "prefetch";
  const isThumb = task.kind === "thumb";
  const dotColor =
    st === "paused" ? "warning.main" : st === "error" ? "error.main" : st === "done" ? "success.main" : "text.disabled";

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.75, px: 1 }}>
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
          {isPrefetch ? " · 自动·随播放（可暂停 / 取消）" : ""}
          {/* 历史模式:在课程名后追加该终态事件的发生时间(全屏完整时间线靠它区分同任务多行)。 */}
          {isHistory && task.at != null ? ` · ${fmtHistTime(task.at)}` : ""}
        </Typography>
        {/* 历史模式失败原因:有值才渲染,灰色小字。 */}
        {isHistory && task.reason ? (
          <Typography variant="caption" color="text.disabled" noWrap title={task.reason} sx={{ display: "block" }}>
            {task.reason}
          </Typography>
        ) : null}
        {pct != null && (
          <LinearProgress variant="determinate" value={pct} sx={{ mt: 0.5, height: 4, borderRadius: (t) => t.radius.full }} />
        )}
      </Box>
      {/* 状态徽标 + 分片计数（缩略图为单次 ffmpeg，段数无意义 → 不显示） */}
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0.5, flexShrink: 0 }}>
        {isPrefetch && (
          <Chip size="small" variant="outlined" color="info" label="自动·随播放" sx={{ height: 22, fontSize: 11 }} />
        )}
        <Chip size="small" variant="outlined" color={chipColor} label={chip.label} sx={{ height: 22, fontSize: 11 }} />
        {!isThumb && task.cached != null && (
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
            const cm = cancelMeta(task.kind);
            const title = v === "cancel" ? cm.tip : b.title;
            const aria = v === "cancel" ? cm.label : b.title;
            return (
              <Tooltip key={v} title={title}>
                <span>
                  <IconButton
                    size="small"
                    color={b.color}
                    disabled={busy}
                    onClick={() => onAction?.(v)}
                    sx={{ p: 0.5 }}
                    aria-label={aria}
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
