"use client";
import * as React from "react";
import { Alert, Box, Tab, Tabs, Typography } from "@mui/material";
import type { TaskItem, TaskVerb } from "@/types/api";
import TaskRow, { TASK_TABS, taskKey } from "./TaskRow";

// 任务·历史整页面板：失败横幅(内联重试/清除) + 进行中↔操作历史两标签 + 全量列表(页面即全视图)。
// 有了专属路由后退役了原 240px 小面板 + 全屏弹窗：列表直接铺开，由页面所在内容区滚动。
function TaskQueuePanel({
  tasks,
  failedTasks,
  allTasks,
  queue,
  onAction,
}: {
  tasks: TaskItem[];
  failedTasks: TaskItem[];
  // DB-backed 全部历史(最近 500 条倒序),网关重启不丢。
  allTasks: TaskItem[];
  queue: { thumb: number; buffer: number };
  onAction: (task: TaskItem, verb: TaskVerb) => Promise<void>;
}) {
  const [tab, setTab] = React.useState(0);
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

  // 历史标签客户端折叠：每 (kind,vid) 只保留最新一行。API 已按 at desc 返回，首见即最新。
  const collapseLatest = (rows: TaskItem[]) => {
    const seen = new Set<string>();
    const out: TaskItem[] = [];
    for (const t of rows) {
      const k = `${t.kind}:${t.vid}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  };

  const lists = [tasks, allTasks];
  const current = lists[tab] ?? [];
  const isHistoryTab = tab === 1;
  const display = isHistoryTab ? collapseLatest(current) : current;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* 失败区：可重试/清除的失败行内联到最顶，第一眼就能操作。 */}
      {failedTasks.length > 0 && (
        <Box sx={{ mb: 1.5 }}>
          <Alert severity="warning" sx={{ py: 0.75, mb: 0.75, alignItems: "center" }} icon={false}>
            {failedTasks.length} 个任务失败 · 点右侧重试或清除
          </Alert>
          <Box
            sx={{
              border: (t) => `1px solid ${t.palette.warning.light}`,
              borderRadius: (t) => t.radius.md,
              px: 0.5,
              py: 0.25,
              bgcolor: (t) => t.palette.warning.light + "14",
            }}
          >
            {failedTasks.map((t) => (
              <TaskRow key={taskKey(t)} task={t} busy={busy.has(taskKey(t))} onAction={(verb) => run(t, verb)} />
            ))}
          </Box>
        </Box>
      )}

      {/* 标签：进行中 / 操作历史 */}
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

      {isHistoryTab && (
        <Typography variant="caption" color="text.disabled" sx={{ mb: 0.5 }}>
          只读：历史是已完成 / 已取消 / 失败任务的冻结快照（网关重启不丢）。
        </Typography>
      )}

      {/* 列表：全量铺开，页面所在内容区滚动（不再 240px 截断 + 全屏弹窗）。 */}
      <Box
        sx={{
          border: (t) => `1px solid ${t.palette.divider}`,
          borderRadius: (t) => t.radius.md,
          px: 0.5,
          py: 0.5,
        }}
      >
        {display.length === 0 ? (
          <Box sx={{ minHeight: 80, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Typography variant="caption" color="text.disabled">{TASK_TABS[tab].empty}</Typography>
          </Box>
        ) : (
          display.map((t, i) => (
            <TaskRow
              key={isHistoryTab ? `${taskKey(t)}-${i}` : taskKey(t)}
              task={t}
              busy={busy.has(taskKey(t))}
              onAction={(verb) => run(t, verb)}
              isHistory={isHistoryTab}
            />
          ))
        )}
      </Box>

      {(queue.thumb > 0 || queue.buffer > 0) && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, fontVariantNumeric: "tabular-nums" }}>
          队列深度：缓冲 {queue.buffer} · 缩略图 {queue.thumb}
        </Typography>
      )}
    </Box>
  );
}

export default React.memo(TaskQueuePanel);
