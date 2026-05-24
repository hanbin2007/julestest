"use client";
import * as React from "react";
import { Box, Chip, IconButton, Tab, Tabs, Tooltip, Typography } from "@mui/material";
import { SparkLineChart } from "@mui/x-charts/SparkLineChart";
import OpenInFullRoundedIcon from "@mui/icons-material/OpenInFullRounded";
import { fmtBytes } from "@/lib/media";
import type { TaskItem, TaskVerb } from "@/types/api";
import TaskRow, { TASK_TABS, taskKey } from "./TaskRow";
import TaskQueueFullscreenDialog from "./TaskQueueFullscreenDialog";

const PANEL_CAP = 20; // 面板每标签只显示前 20 条，更多走「展开全屏」

function TaskQueuePanel({
  tasks,
  completedTasks,
  failedTasks,
  bps,
  series,
  queue,
  onAction,
}: {
  tasks: TaskItem[];
  completedTasks: TaskItem[];
  failedTasks: TaskItem[];
  bps: number;
  series: number[];
  queue: { thumb: number; buffer: number };
  onAction: (task: TaskItem, verb: TaskVerb) => Promise<void>;
}) {
  const [tab, setTab] = React.useState(0);
  const [fsOpen, setFsOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<Set<string>>(new Set());

  // 包一层管理 busy（动作在途禁用按钮，避免连点导致重复请求）。
  const run = React.useCallback(
    async (task: TaskItem, verb: TaskVerb) => {
      const key = taskKey(task);
      setBusy((s) => new Set(s).add(key));
      try {
        await onAction(task, verb);
      } finally {
        setBusy((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }
    },
    [onAction],
  );

  const lists = [tasks, completedTasks, failedTasks];
  const current = lists[tab] ?? [];
  const shown = current.slice(0, PANEL_CAP);
  const working = tasks.filter((t) => t.state === "working").length;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {/* 头部：标题 + 计数 + 速率 + 折线 + 展开全屏。flexWrap 让右侧组窄屏时换行。 */}
      <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, rowGap: 0.5, mb: 0.5 }}>
        <Typography variant="subtitle2">任务队列</Typography>
        <Chip size="small" label={`${working} 进行 · ${tasks.length} 总`} sx={{ height: 22, fontSize: 11 }} />
        <Box sx={{ ml: "auto", display: "flex", alignItems: "center", gap: 0.5 }}>
          <Tooltip title="下载速率">
            <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtBytes(bps)}/s
            </Typography>
          </Tooltip>
          {series.length > 1 && (
            <Box sx={{ width: 72, height: 22 }} role="img" aria-label={`下载速率 ${fmtBytes(bps)} 每秒`}>
              <SparkLineChart data={series} height={22} showHighlight={false} area />
            </Box>
          )}
          <Tooltip title="全屏查看全部任务">
            <IconButton size="small" onClick={() => setFsOpen(true)} sx={{ p: 0.25 }} aria-label="展开全屏">
              <OpenInFullRoundedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* 标签：进行中 / 已完成 / 失败 */}
      <Tabs
        value={tab}
        onChange={(_e, v) => setTab(v)}
        variant="fullWidth"
        sx={{
          minHeight: 32,
          mb: 0.5,
          "& .MuiTab-root": { minHeight: 32, fontSize: 12, py: 0, textTransform: "none" },
        }}
      >
        {TASK_TABS.map((t, i) => (
          <Tab key={t.label} label={`${t.label} ${lists[i].length}`} />
        ))}
      </Tabs>

      {/* 列表（可滚动） */}
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
        {current.length === 0 ? (
          <Box sx={{ height: "100%", minHeight: 80, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Typography variant="caption" color="text.disabled">
              {TASK_TABS[tab].empty}
            </Typography>
          </Box>
        ) : (
          <>
            {shown.map((t) => (
              <TaskRow key={taskKey(t)} task={t} busy={busy.has(taskKey(t))} onAction={(verb) => run(t, verb)} />
            ))}
            {current.length > shown.length && (
              <Box sx={{ py: 0.5, textAlign: "center" }}>
                <Typography variant="caption" color="primary" sx={{ cursor: "pointer" }} onClick={() => setFsOpen(true)}>
                  还有 {current.length - shown.length} 条，展开全屏查看全部
                </Typography>
              </Box>
            )}
          </>
        )}
      </Box>

      {(queue.thumb > 0 || queue.buffer > 0) && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, fontVariantNumeric: "tabular-nums" }}>
          队列深度：缓冲 {queue.buffer} · 缩略图 {queue.thumb}
        </Typography>
      )}

      <TaskQueueFullscreenDialog
        open={fsOpen}
        onClose={() => setFsOpen(false)}
        tasks={tasks}
        completedTasks={completedTasks}
        failedTasks={failedTasks}
        busy={busy}
        onAction={run}
      />
    </Box>
  );
}

export default React.memo(TaskQueuePanel);
