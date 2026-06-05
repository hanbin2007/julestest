"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Box,
  Button,
  Card,
  Chip,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import ChecklistRoundedIcon from "@mui/icons-material/ChecklistRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import NoteAltOutlinedIcon from "@mui/icons-material/NoteAltOutlined";
import { useAllNotes } from "@/hooks/persist";
import { DataBoundary } from "@/components/common/DataBoundary";
import { CardGridSkeleton } from "@/components/common/Skeletons";
import { useToast } from "@/components/common/Toast";
import { hashSeed } from "@/lib/color";
import { fmtDur } from "@/lib/media";
import type { EnrichedNote } from "@/lib/store";
import { StatNum } from "@/components/common/StatNum";
import { StatusDot } from "@/components/common/StatusDot";
import NoteCard from "./NoteCard";

type Sort = "time" | "recent";

const GRID_SX = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
  gridAutoRows: "1fr",
  gap: 1.5,
} as const;

export default function NotesView() {
  const router = useRouter();
  const toast = useToast();
  const { notes, stats, update, remove, removeBatch, error, isLoading, mutate } = useAllNotes();
  const [q, setQ] = React.useState("");
  const [courseId, setCourseId] = React.useState("");
  const [sort, setSort] = React.useState<Sort>("time");
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  // 课程下拉项（按笔记去重）
  const courseOptions = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const n of notes) if (!m.has(n.courseId)) m.set(n.courseId, n.courseName);
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [notes]);

  // 过滤 → 按课程分组 → 组内排序 → 组按最新活跃度排序
  const groups = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    const filtered = notes.filter((n) => {
      if (courseId && String(n.courseId) !== courseId) return false;
      if (
        s &&
        !n.text.toLowerCase().includes(s) &&
        !n.lessonTitle.toLowerCase().includes(s) &&
        !n.courseName.toLowerCase().includes(s)
      )
        return false;
      return true;
    });
    const map = new Map<number, { courseId: number; courseName: string; items: EnrichedNote[] }>();
    for (const n of filtered) {
      const g = map.get(n.courseId) ?? { courseId: n.courseId, courseName: n.courseName, items: [] };
      g.items.push(n);
      map.set(n.courseId, g);
    }
    const arr = [...map.values()];
    for (const g of arr)
      g.items.sort((a, b) =>
        sort === "recent" ? b.at - a.at : a.videoId - b.videoId || a.t - b.t,
      );
    arr.sort(
      (a, b) =>
        (b.items.length ? Math.max(...b.items.map((i) => i.at)) : 0) -
        (a.items.length ? Math.max(...a.items.map((i) => i.at)) : 0),
    );
    return arr;
  }, [notes, q, courseId, sort]);

  const shownCount = React.useMemo(() => groups.reduce((a, g) => a + g.items.length, 0), [groups]);

  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };
  const doBatchDelete = async () => {
    if (!selected.size) return;
    const ids = [...selected];
    try {
      await removeBatch(ids);
      toast(`已删除 ${ids.length} 条笔记`, { severity: "success" });
      exitSelect(); // 成功后才退出选择模式，失败时保留选中项以便重试
    } catch (e) {
      toast("删除失败：" + (e as Error).message, { severity: "error" });
    }
  };

  const jump = (cid: number, vid: number, t: number) =>
    router.push(`/?productId=${cid}&videoId=${vid}&t=${t}`);

  // 编辑批注：回看课页并带 annotation=id，让播放页进入批注模式并还原笔迹。
  const editAnnotation = (cid: number, vid: number, t: number, id: string) =>
    router.push(`/?productId=${cid}&videoId=${vid}&t=${t}&annotation=${encodeURIComponent(id)}`);

  const exportMd = () => {
    if (!shownCount) return toast("没有可导出的笔记");
    const date = new Date().toISOString().slice(0, 10);
    // 折行成单行 + 转义会破坏 md 结构的字符
    const esc = (str: string) =>
      str
        .replace(/\r?\n/g, " ")
        .replace(/([`|])/g, "\\$1")
        .replace(/^\s*([#\-*>])/, "\\$1");
    const lines: string[] = [`# 课程笔记 · 导出于 ${date}`, ""];
    for (const g of groups) {
      lines.push(`## ${g.courseName}`, "");
      const byLesson = new Map<number, { title: string; items: EnrichedNote[] }>();
      for (const it of g.items) {
        const e = byLesson.get(it.videoId) ?? { title: it.lessonTitle, items: [] };
        e.items.push(it);
        byLesson.set(it.videoId, e);
      }
      for (const { title, items } of byLesson.values()) {
        lines.push(`### ${title}`);
        for (const it of [...items].sort((a, b) => a.t - b.t))
          lines.push(`- **${fmtDur(it.t) || "0:00"}** ${esc(it.text)}`);
        lines.push("");
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const tag = courseId
      ? `-${(courseOptions.find((c) => String(c.id) === courseId)?.name ?? "").replace(/[\\/:*?"<>|]/g, "")}`
      : "";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `notes${tag}-${date}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出 ${shownCount} 条笔记`, { severity: "success" });
  };

  return (
    <Box sx={{ maxWidth: 1240, mx: "auto", p: { xs: 1.5, md: 3 } }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ xs: "flex-start", sm: "baseline" }}
        sx={{ mb: 1.5 }}
      >
        <Typography variant="h5" sx={{ flexShrink: 0 }}>
          笔记
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ ml: { xs: 0, sm: 1.5 }, mt: { xs: 0.5, sm: 0 } }}
        >
          跨课程的所有时间戳笔记，点卡片或 ▶ 即可跳到那一刻看课。
        </Typography>
      </Stack>

      {/* 统计概览（粘顶） */}
      <Card sx={{ p: 2, mb: 2, position: { md: "sticky" }, top: 8, zIndex: 2 }}>
        <Stack
          direction="row"
          spacing={3}
          sx={{ flexWrap: "wrap", alignItems: "center", rowGap: 1 }}
        >
          <StatNum value={stats.total} label="条笔记" />
          <StatNum value={stats.videos} label="个讲次" />
          <StatNum value={stats.courses} label="门课程" />
          {shownCount !== stats.total && (
            <Typography variant="caption" color="text.secondary">
              · 当前筛选 {shownCount} 条
            </Typography>
          )}
        </Stack>
      </Card>

      {/* 工具栏 */}
      <Card sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1.5, alignItems: "center" }}>
          <TextField
            size="small"
            placeholder="搜索笔记 / 讲次 / 课程…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            sx={{ flex: 1, minWidth: 180 }}
          />
          <TextField
            size="small"
            select
            label="课程"
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="">全部（{courseOptions.length}）</MenuItem>
            {courseOptions.map((c) => (
              <MenuItem key={c.id} value={String(c.id)}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="排序"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            sx={{ minWidth: 120 }}
          >
            <MenuItem value="time">时间顺序</MenuItem>
            <MenuItem value="recent">最近添加</MenuItem>
          </TextField>
          <Stack direction="row" sx={{ ml: { md: "auto" }, flexWrap: "wrap", gap: 1, alignItems: "center" }}>
            {selectMode ? (
              <>
                <Typography variant="caption" color="text.secondary">
                  已选 {selected.size}
                </Typography>
                <Button
                  color="error"
                  variant="contained"
                  startIcon={<DeleteSweepRoundedIcon />}
                  disabled={!selected.size}
                  onClick={doBatchDelete}
                >
                  删除所选
                </Button>
                <Button variant="text" startIcon={<CloseRoundedIcon />} onClick={exitSelect}>
                  取消
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outlined"
                  startIcon={<DownloadRoundedIcon />}
                  onClick={exportMd}
                  disabled={!shownCount}
                >
                  导出 Markdown
                </Button>
                <Button
                  variant="text"
                  startIcon={<ChecklistRoundedIcon />}
                  onClick={() => setSelectMode(true)}
                  disabled={!notes.length}
                >
                  选择
                </Button>
              </>
            )}
          </Stack>
        </Stack>
      </Card>

      {notes.length === 0 ? (
        <DataBoundary
          loading={isLoading}
          error={error}
          isEmpty={!isLoading && !error}
          onRetry={() => void mutate?.()}
          skeleton={<CardGridSkeleton />}
          empty={
            <Stack alignItems="center" spacing={1} sx={{ py: 8, color: "text.secondary" }}>
              <NoteAltOutlinedIcon sx={{ fontSize: 48, opacity: 0.5 }} />
              <Typography variant="body2">还没有任何笔记。</Typography>
              <Typography variant="caption">
                在看课页按 <b>B</b> 记书签，或用右侧「笔记」抽屉记一条。
              </Typography>
            </Stack>
          }
        >
          {null}
        </DataBoundary>
      ) : shownCount === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: "center" }}>
          无匹配笔记
        </Typography>
      ) : (
        groups.map((g) => {
          const color = hashSeed(g.courseName);
          return (
            <Box key={g.courseId} sx={{ mb: 3 }}>
              <Stack direction="row" sx={{ alignItems: "center", gap: 1, mb: 1.5 }}>
                <StatusDot color={color} size={10} />
                <Typography variant="subtitle1" sx={{ fontWeight: 700, minWidth: 0 }} noWrap title={g.courseName}>
                  {g.courseName}
                </Typography>
                <Chip size="small" variant="outlined" label={g.items.length} sx={{ height: 22 }} />
              </Stack>
              <Box sx={GRID_SX}>
                {g.items.map((n) => (
                  <NoteCard
                    key={n.id}
                    note={n}
                    color={color}
                    selectMode={selectMode}
                    selected={selected.has(n.id)}
                    onToggleSelect={toggleSelect}
                    onUpdate={update}
                    onDelete={remove}
                    onJump={jump}
                    onEditAnnotation={editAnnotation}
                  />
                ))}
              </Box>
            </Box>
          );
        })
      )}
    </Box>
  );
}
