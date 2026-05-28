"use client";
import * as React from "react";
import { AppBar, Box, Dialog, IconButton, Tab, Tabs, Toolbar, Typography } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import type { TaskItem, TaskVerb } from "@/types/api";
import TaskRow, { TASK_TABS, taskKey } from "./TaskRow";

// 全屏任务视图：进行中 / 操作历史(DB-backed,只读) / 失败(可重试)。复用 TaskRow。
export default function TaskQueueFullscreenDialog({
  open,
  onClose,
  tasks,
  failedTasks,
  allTasks,
  busy,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  tasks: TaskItem[];
  failedTasks: TaskItem[];
  // "操作历史"标签:DB-backed 任务历史(最近 500 条),只读。
  allTasks: TaskItem[];
  busy: Set<string>;
  onAction: (task: TaskItem, verb: TaskVerb) => void;
}) {
  const [tab, setTab] = React.useState(0);
  // 顺序：进行中 / 操作历史 / 失败。前两个标题取自 TASK_TABS，失败单列以便重试。
  const lists = [tasks, allTasks, failedTasks];
  const tabLabels = [TASK_TABS[0].label, TASK_TABS[1].label, "失败"];
  const tabEmpties = [TASK_TABS[0].empty, TASK_TABS[1].empty, "暂无失败的任务"];
  const current = lists[tab] ?? [];
  const isHistoryTab = tab === 1;

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <AppBar position="sticky" color="default" elevation={0} sx={{ borderBottom: (t) => `1px solid ${t.palette.divider}` }}>
        <Toolbar sx={{ gap: 1 }}>
          <Typography variant="h6" sx={{ flex: 1 }}>
            任务队列
          </Typography>
          <IconButton onClick={onClose} edge="end" aria-label="关闭">
            <CloseRoundedIcon />
          </IconButton>
        </Toolbar>
        <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ px: { xs: 1.5, md: 3 } }}>
          {tabLabels.map((label, i) => (
            <Tab key={label} label={`${label} ${lists[i].length}`} />
          ))}
        </Tabs>
      </AppBar>
      <Box sx={{ maxWidth: 880, width: "100%", mx: "auto", p: { xs: 1.5, md: 3 } }}>
        {current.length === 0 ? (
          <Box sx={{ py: 8, textAlign: "center" }}>
            <Typography variant="body2" color="text.disabled">
              {tabEmpties[tab]}
            </Typography>
          </Box>
        ) : (
          current.map((t, i) => (
            <TaskRow
              key={isHistoryTab ? `${taskKey(t)}-${i}` : taskKey(t)}
              task={t}
              busy={busy.has(taskKey(t))}
              onAction={(verb) => onAction(t, verb)}
              isHistory={isHistoryTab}
            />
          ))
        )}
      </Box>
    </Dialog>
  );
}
