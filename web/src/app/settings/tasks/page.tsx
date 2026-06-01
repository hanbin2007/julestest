"use client";
import * as React from "react";
import { Box, Typography } from "@mui/material";
import { markRecentAction } from "@/hooks/data";
import { useToast } from "@/components/common/Toast";
import { useSettingsData } from "@/components/settings/SettingsDataContext";
import TaskQueuePanel from "@/components/settings/TaskQueuePanel";
import { VERB_DONE } from "@/components/settings/cacheVocab";
import { taskAction } from "@/lib/api";
import type { CoursesStatus, TaskItem, TaskState, TaskVerb } from "@/types/api";

// 任务·历史：缓冲/预缓存/缩略图任务的实时进度与操作。数据来自 layout 的唯一轮询。
export default function TasksPage() {
  const toast = useToast();
  const { data, refresh } = useSettingsData();

  // 不丢弃 TaskActionResult：成功按返回的真实 state 乐观回填 + 人话 toast；失败弹网关 reason。
  // markRecentAction 让轮询提速到 1s 兜底确认，refresh 触发即时重拉。
  const handleTaskAction = async (task: TaskItem, verb: TaskVerb) => {
    markRecentAction();
    let res;
    try {
      res = await taskAction(task.kind, task.vid, verb);
    } catch (e) {
      toast("操作失败：" + (e as Error).message, { severity: "error" });
      refresh();
      return;
    }
    if (res.ok) {
      const newState = res.state as TaskState | null;
      if (newState) {
        refresh(
          (cur: CoursesStatus | undefined) => {
            if (!cur) return cur;
            const patch = (arr: TaskItem[]) =>
              arr.map((t) => (t.kind === task.kind && t.vid === task.vid ? { ...t, state: newState } : t));
            return { ...cur, tasks: patch(cur.tasks) };
          },
          { revalidate: false },
        );
      }
      toast(VERB_DONE[verb], { severity: "success" });
    } else {
      toast(res.reason || "操作未生效，任务状态可能已变化", { severity: "warning" });
    }
    refresh();
  };

  return (
    <Box sx={{ p: 2.5, maxWidth: 960, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box>
        <Typography variant="h6">任务 · 历史</Typography>
        <Typography variant="caption" color="text.disabled">
          缓冲 / 预缓存 / 缩略图任务的实时进度与操作，历史只读冻结快照。
        </Typography>
      </Box>
      <TaskQueuePanel
        tasks={data?.tasks ?? []}
        failedTasks={data?.failedTasks ?? []}
        allTasks={data?.allTasks ?? []}
        queue={data?.activity.queue ?? { thumb: 0, buffer: 0 }}
        onAction={handleTaskAction}
      />
    </Box>
  );
}
