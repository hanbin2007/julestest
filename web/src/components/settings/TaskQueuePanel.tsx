"use client";
import * as React from "react";
import { Box, Chip, CircularProgress, LinearProgress, Tooltip, Typography } from "@mui/material";
import { SparkLineChart } from "@mui/x-charts/SparkLineChart";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import ImageRoundedIcon from "@mui/icons-material/ImageRounded";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import { fmtBytes } from "@/lib/media";
import type { TaskItem } from "@/types/api";

const KIND = {
  buffer: { label: "缓冲", Icon: DownloadRoundedIcon, color: "primary" as const },
  thumb: { label: "缩略图", Icon: ImageRoundedIcon, color: "secondary" as const },
  prefetch: { label: "预缓存", Icon: BoltRoundedIcon, color: "info" as const },
};

function TaskRow({ task }: { task: TaskItem }) {
  const k = KIND[task.kind];
  const working = task.state === "working";
  const pct = task.cached != null && task.total ? Math.min(100, (task.cached / task.total) * 100) : null;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5, px: 0.5 }}>
      {/* State indicator: spinner for working, muted dot for queued */}
      {working ? (
        <CircularProgress size={14} thickness={6} />
      ) : (
        <Box sx={{ width: 14, display: "flex", justifyContent: "center", flexShrink: 0 }}>
          <Box sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: "text.disabled" }} />
        </Box>
      )}
      {/* Kind icon — consistent color per task type */}
      <k.Icon sx={{ fontSize: 16, color: `${k.color}.main`, flexShrink: 0 }} />
      {/* Title + course name + progress bar */}
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" noWrap title={task.title}>
          {task.title}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap title={task.courseName}>
          {task.courseName}
        </Typography>
        {pct != null && (
          <LinearProgress variant="determinate" value={pct} sx={{ mt: 0.5, height: 4, borderRadius: (t) => t.radius.full }} />
        )}
      </Box>
      {/* Right column: status chip + segment count, right-aligned and vertically stacked */}
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0.5, flexShrink: 0 }}>
        <Chip
          size="small"
          variant="outlined"
          color={working ? k.color : "default"}
          label={working ? "进行中" : "排队"}
          sx={{ height: 22, fontSize: 11 }}
        />
        {task.cached != null && (
          <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {task.cached}
            {task.total ? `/${task.total}` : ""} 段
          </Typography>
        )}
      </Box>
    </Box>
  );
}
const MemoRow = React.memo(TaskRow);

function TaskQueuePanel({
  tasks,
  bps,
  series,
  queue,
}: {
  tasks: TaskItem[];
  bps: number;
  series: number[];
  queue: { thumb: number; buffer: number };
}) {
  const working = tasks.filter((t) => t.state === "working").length;
  const total = tasks.length;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {/* Header: title + count chip + rate + sparkline.
          flexWrap lets the right-side group wrap below the title on narrow widths
          instead of squeezing or overflowing. */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1,
          rowGap: 0.5,
          mb: 1,
        }}
      >
        <Typography variant="subtitle2">任务队列</Typography>
        <Chip size="small" label={`${working} 进行 · ${total} 总`} sx={{ height: 22, fontSize: 11 }} />
        <Box sx={{ ml: "auto", display: "flex", alignItems: "center", gap: 1 }}>
          <Tooltip title="下载速率">
            <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtBytes(bps)}/s
            </Typography>
          </Tooltip>
          {series.length > 1 && (
            <Box sx={{ width: 84, height: 22 }} role="img" aria-label={`下载速率 ${fmtBytes(bps)} 每秒`}>
              <SparkLineChart data={series} height={22} showHighlight={false} area />
            </Box>
          )}
        </Box>
      </Box>

      {/* Scrollable task list */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          maxHeight: 168,
          overflowY: "auto",
          border: (t) => `1px solid ${t.palette.divider}`,
          borderRadius: (t) => t.radius.md,
          px: 0.5,
        }}
      >
        {total === 0 ? (
          // Empty state: fill the container and center vertically so it
          // looks intentional rather than a misaligned short label.
          <Box
            sx={{
              height: "100%",
              minHeight: 80,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Typography variant="caption" color="text.disabled">
              暂无进行中的任务
            </Typography>
          </Box>
        ) : (
          tasks.map((t) => <MemoRow key={`${t.kind}-${t.vid}`} task={t} />)
        )}
      </Box>

      {(queue.thumb > 0 || queue.buffer > 0) && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, fontVariantNumeric: "tabular-nums" }}>
          队列深度：缓冲 {queue.buffer} · 缩略图 {queue.thumb}
        </Typography>
      )}
    </Box>
  );
}

export default React.memo(TaskQueuePanel);
