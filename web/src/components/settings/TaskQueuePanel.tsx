"use client";
import * as React from "react";
import { Alert, Box, Tab, Tabs, Typography } from "@mui/material";
import type { TaskItem, TaskVerb } from "@/types/api";
import TaskRow, { TASK_TABS, taskKey } from "./TaskRow";
import TaskQueueFullscreenDialog from "./TaskQueueFullscreenDialog";

const PANEL_CAP = 20; // 面板每标签只显示前 20 条，更多走「展开全屏」
const FAILED_CAP = 5; // 失败区内联只显示前 5 条可重试行，更多走「展开全屏」

function TaskQueuePanel({
  tasks,
  failedTasks,
  allTasks,
  queue,
  onAction,
  fsOpen,
  onFsOpenChange,
}: {
  tasks: TaskItem[];
  failedTasks: TaskItem[];
  // DB-backed 全部历史(最近 500 条倒序),网关重启不丢。
  allTasks: TaskItem[];
  queue: { thumb: number; buffer: number };
  onAction: (task: TaskItem, verb: TaskVerb) => Promise<void>;
  // 全屏弹窗开关：受控，便于顶部状态条徽标也能打开它。
  fsOpen: boolean;
  onFsOpenChange: (open: boolean) => void;
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

  // 历史标签客户端折叠：每 (kind,vid) 只保留最新一行。API 已按 at desc 返回完整时间线,
  // 首见即最新。折叠只作用于面板概览;全屏(TaskQueueFullscreenDialog)直接吃 allTasks 全量=完整时间线,不折叠。
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
  // 历史标签(tab===1)在面板里折叠成每任务最新态;进行中标签不折叠。
  const display = isHistoryTab ? collapseLatest(current) : current;
  const shown = display.slice(0, PANEL_CAP);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>任务队列</Typography>

      {/* 失败区：有失败任务时直接把可重试的失败行内联到面板最顶（不再只给数字横幅 + 埋进全屏）。
          每行带「重试」按钮，用户在第一眼能看到的地方就能直接重试。多于上限时折叠到全屏。 */}
      {failedTasks.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Alert severity="warning" sx={{ py: 0, mb: 0.5, alignItems: "center" }} icon={false}>
            {failedTasks.length} 个任务失败 · 点右侧重试
          </Alert>
          <Box
            sx={{
              border: (t) => `1px solid ${t.palette.warning.light}`,
              borderRadius: (t) => t.radius.md,
              px: 0.5,
              bgcolor: (t) => t.palette.warning.light + "14", // 极淡警示底色
            }}
          >
            {failedTasks.slice(0, FAILED_CAP).map((t) => (
              <TaskRow
                key={taskKey(t)}
                task={t}
                busy={busy.has(taskKey(t))}
                onAction={(verb) => run(t, verb)}
              />
            ))}
            {failedTasks.length > FAILED_CAP && (
              <Box sx={{ py: 0.5, textAlign: "center" }}>
                <Typography
                  variant="caption"
                  color="primary"
                  sx={{ cursor: "pointer" }}
                  onClick={() => onFsOpenChange(true)}
                >
                  还有 {failedTasks.length - FAILED_CAP} 个失败任务，展开全屏查看全部
                </Typography>
              </Box>
            )}
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

      {/* 列表（可滚动） */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          maxHeight: 240,
          overflowY: "auto",
          border: (t) => `1px solid ${t.palette.divider}`,
          borderRadius: (t) => t.radius.md,
          px: 0.5,
        }}
      >
        {display.length === 0 ? (
          <Box sx={{ height: "100%", minHeight: 80, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Typography variant="caption" color="text.disabled">
              {TASK_TABS[tab].empty}
            </Typography>
          </Box>
        ) : (
          <>
            {shown.map((t, i) => (
              <TaskRow
                key={isHistoryTab ? `${taskKey(t)}-${i}` : taskKey(t)}
                task={t}
                busy={busy.has(taskKey(t))}
                onAction={(verb) => run(t, verb)}
                isHistory={isHistoryTab}
              />
            ))}
            {display.length > shown.length && (
              <Box sx={{ py: 0.5, textAlign: "center" }}>
                <Typography variant="caption" color="primary" sx={{ cursor: "pointer" }} onClick={() => onFsOpenChange(true)}>
                  还有 {display.length - shown.length} 条，展开全屏查看全部
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
        onClose={() => onFsOpenChange(false)}
        tasks={tasks}
        failedTasks={failedTasks}
        allTasks={allTasks}
        busy={busy}
        onAction={run}
      />
    </Box>
  );
}

export default React.memo(TaskQueuePanel);
