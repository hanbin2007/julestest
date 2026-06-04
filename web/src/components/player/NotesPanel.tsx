"use client";
import * as React from "react";
import {
  Box,
  Chip,
  Drawer,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import GestureRoundedIcon from "@mui/icons-material/GestureRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import OpenInFullRoundedIcon from "@mui/icons-material/OpenInFullRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import SplitscreenRoundedIcon from "@mui/icons-material/SplitscreenRounded";
import CloseFullscreenRoundedIcon from "@mui/icons-material/CloseFullscreenRounded";
import NoteAltOutlinedIcon from "@mui/icons-material/NoteAltOutlined";
import { useAllNotes } from "@/hooks/persist";
import { hashSeed } from "@/lib/color";
import { fmtDur } from "@/lib/media";
import type { EnrichedNote } from "@/lib/store";
import NotePreview from "@/components/notes/NotePreview";
import { smoothColors } from "@/theme/motion";

// 分屏时面板宽度（与 ChatPanel 的 CHAT_WIDTH 同类常量，供 page.tsx 算播放器右偏移）。
export const NOTES_WIDTH = 400;

// 看课页的笔记面板：默认看「当前课程」全部讲的笔记，可切课程/全部；增改删 + 跳转 + 预览。
// 一个组件两种渲染：普通态=右侧 Drawer；网页全屏分屏态=右侧固定窗格（与 AI 助教分屏一致）。
export default function NotesPanel({
  open,
  onClose,
  split = false,
  onToggleSplit,
  currentVideoId,
  currentCourseId,
  onAddNote,
  onJump,
  onPreview,
  onEditAnnotation,
}: {
  open: boolean;
  onClose: () => void;
  split?: boolean;
  onToggleSplit?: () => void;
  currentVideoId: number | null;
  currentCourseId: number | null;
  onAddNote: (text: string) => void; // 记到「当前讲」当前时刻（page 抓时间+截图）
  onJump: (courseId: number, videoId: number, t: number) => void;
  onPreview: (note: EnrichedNote) => void;
  onEditAnnotation: (courseId: number, videoId: number, t: number, id: string) => void;
}) {
  const { notes, update, remove } = useAllNotes();
  const [text, setText] = React.useState("");
  const [courseFilter, setCourseFilter] = React.useState<string>(""); // "" = 全部
  const [editId, setEditId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");

  // 仅在「打开的那一下」默认聚焦到当前课程；打开期间手动切了筛选不被切讲重置。
  const prevOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !prevOpen.current) {
      setCourseFilter(currentCourseId != null ? String(currentCourseId) : "");
    }
    prevOpen.current = open;
  }, [open, currentCourseId]);

  const add = () => {
    const t = text.trim();
    if (!t || currentVideoId == null) return;
    onAddNote(t);
    setText("");
  };
  const startEdit = (id: string, current: string) => {
    setEditId(id);
    setDraft(current);
  };
  const cancelEdit = () => {
    setEditId(null);
    setDraft("");
  };
  const saveEdit = (videoId: number, id: string, original: string) => {
    const next = draft.trim();
    if (!next || next === original) return cancelEdit();
    void update(videoId, id, next);
    cancelEdit();
  };

  // 课程下拉项（按现有笔记去重）
  const courseOptions = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const n of notes) if (!m.has(n.courseId)) m.set(n.courseId, n.courseName);
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [notes]);

  // 过滤（按课程）→ 按讲分组 → 组内按时间排序 → 组按 课程名,讲 排序
  const groups = React.useMemo(() => {
    const filtered = courseFilter ? notes.filter((n) => String(n.courseId) === courseFilter) : notes;
    // 按 (课程, 讲) 分组：videoId 跨课程不唯一，单用 videoId 会把两门课的同号讲并到一起。
    const map = new Map<
      string,
      { videoId: number; courseId: number; courseName: string; lessonTitle: string; items: EnrichedNote[] }
    >();
    for (const n of filtered) {
      const key = `${n.courseId}:${n.videoId}`;
      const g =
        map.get(key) ??
        { videoId: n.videoId, courseId: n.courseId, courseName: n.courseName, lessonTitle: n.lessonTitle, items: [] };
      g.items.push(n);
      map.set(key, g);
    }
    const arr = [...map.values()];
    for (const g of arr) g.items.sort((a, b) => a.t - b.t);
    arr.sort((a, b) => a.courseName.localeCompare(b.courseName, "zh") || a.videoId - b.videoId);
    return arr;
  }, [notes, courseFilter]);

  const shown = React.useMemo(() => groups.reduce((a, g) => a + g.items.length, 0), [groups]);
  const showCourseInHeader = !courseFilter; // 「全部」时讲标题前缀课程名

  const body = (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 头部 */}
      <Stack
        direction="row"
        sx={{ alignItems: "center", gap: 1, px: 2, py: 1.5, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
      >
        <Typography variant="h6" sx={{ flexShrink: 0 }}>
          笔记
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {shown} 条
        </Typography>
        {onToggleSplit && (
          <Tooltip title={split ? "退出分屏" : "分屏（边看边记）"}>
            <IconButton size="small" onClick={onToggleSplit} aria-label="toggle notes split">
              {split ? <CloseFullscreenRoundedIcon fontSize="small" /> : <SplitscreenRoundedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
        <IconButton size="small" onClick={onClose} aria-label="close notes">
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Stack>

      {/* 课程筛选 */}
      <Box sx={{ px: 2, pt: 1.5 }}>
        <TextField
          size="small"
          select
          fullWidth
          label="课程"
          value={courseFilter}
          onChange={(e) => setCourseFilter(e.target.value)}
        >
          <MenuItem value="">全部（{courseOptions.length}）</MenuItem>
          {courseOptions.map((c) => (
            <MenuItem key={c.id} value={String(c.id)}>
              {c.name}
              {c.id === currentCourseId ? " · 当前" : ""}
            </MenuItem>
          ))}
        </TextField>
      </Box>

      {/* 记到本讲 */}
      <Stack direction="row" spacing={1} sx={{ px: 2, py: 1.5 }}>
        <TextField
          size="small"
          fullWidth
          placeholder={currentVideoId == null ? "选一讲后可记笔记" : "在当前时刻记到本讲…"}
          value={text}
          disabled={currentVideoId == null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <IconButton color="primary" onClick={add} disabled={currentVideoId == null || !text.trim()} aria-label="add note">
          <AddRoundedIcon />
        </IconButton>
      </Stack>

      {/* 列表 */}
      <Box sx={{ flex: 1, overflowY: "auto", px: 1.5, pb: 1.5 }}>
        {notes.length === 0 ? (
          <Stack alignItems="center" spacing={1} sx={{ py: 6, color: "text.secondary" }}>
            <NoteAltOutlinedIcon sx={{ fontSize: 40, opacity: 0.5 }} />
            <Typography variant="body2">还没有笔记。</Typography>
            <Typography variant="caption">
              播放时按 <b>B</b> 或上面输入框记一条。
            </Typography>
          </Stack>
        ) : shown === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: "center" }}>
            该课程暂无笔记
          </Typography>
        ) : (
          groups.map((g) => {
            const color = hashSeed(g.courseName);
            return (
              <Box key={`${g.courseId}:${g.videoId}`} sx={{ mt: 1.5 }}>
                <Stack direction="row" sx={{ alignItems: "center", gap: 0.75, px: 0.5, mb: 0.5 }}>
                  <Box sx={{ width: 8, height: 8, borderRadius: "999px", bgcolor: color, flex: "0 0 auto" }} />
                  <Typography
                    variant="caption"
                    sx={{ fontWeight: 700, minWidth: 0 }}
                    noWrap
                    title={`${g.courseName} · ${g.lessonTitle}`}
                  >
                    {showCourseInHeader ? `${g.courseName} · ` : ""}
                    {g.lessonTitle}
                  </Typography>
                  {g.courseId === currentCourseId && g.videoId === currentVideoId && (
                    <Chip size="small" label="本讲" sx={{ height: 18, "& .MuiChip-label": { px: 0.75, fontSize: 10 } }} />
                  )}
                </Stack>
                <Stack spacing={0.5}>
                  {g.items.map((n) => (
                    <NoteRow
                      key={n.id}
                      note={n}
                      color={color}
                      editing={editId === n.id}
                      draft={draft}
                      setDraft={setDraft}
                      onStartEdit={() => startEdit(n.id, n.text)}
                      onCancelEdit={cancelEdit}
                      onSaveEdit={() => saveEdit(n.videoId, n.id, n.text)}
                      onJump={() => onJump(n.courseId, n.videoId, n.t)}
                      onPreview={() => onPreview(n)}
                      onEditAnnotation={() => onEditAnnotation(n.courseId, n.videoId, n.t, n.id)}
                      onDelete={() => void remove(n.videoId, n.id)}
                    />
                  ))}
                </Stack>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );

  // 分屏：右侧固定窗格（不是 Drawer），z-index 自控，与左侧播放器并排。
  if (split) {
    return (
      <Box
        sx={{
          position: "fixed",
          top: 0,
          right: 0,
          width: NOTES_WIDTH,
          height: "100dvh",
          zIndex: 1300,
          bgcolor: "background.paper",
          borderLeft: (t) => `1px solid ${t.palette.divider}`,
          boxShadow: 8,
        }}
      >
        {body}
      </Box>
    );
  }

  return (
    <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: NOTES_WIDTH, maxWidth: "96vw" } }}>
      {body}
    </Drawer>
  );
}

// 单条笔记行：缩略图 + 时间/文字 + 行内编辑 + 动作。
function NoteRow({
  note,
  color,
  editing,
  draft,
  setDraft,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onJump,
  onPreview,
  onEditAnnotation,
  onDelete,
}: {
  note: EnrichedNote;
  color: string;
  editing: boolean;
  draft: string;
  setDraft: (s: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onJump: () => void;
  onPreview: () => void;
  onEditAnnotation: () => void;
  onDelete: () => void;
}) {
  const isAnnotation = !!note.strokes;
  const dirty = !!draft.trim() && draft.trim() !== note.text;
  return (
    <Box
      sx={{
        display: "flex",
        gap: 1,
        p: 0.75,
        borderRadius: (t) => t.radius.sm,
        transition: (t) => smoothColors(t, ["background-color"]),
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Box
        sx={{ flex: "0 0 auto", cursor: "zoom-in", borderRadius: (t) => t.radius.sm, overflow: "hidden" }}
        onClick={onPreview}
      >
        <NotePreview
          noteId={note.id}
          videoId={note.videoId}
          t={note.t}
          ready={note.thumbState === "ready"}
          hasSnap={note.hasSnap}
          meta={note.thumb}
          color={color}
        />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
        <Stack direction="row" sx={{ alignItems: "center", gap: 0.5 }}>
          <Typography
            variant="caption"
            sx={{ color: "primary.main", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
          >
            {fmtDur(note.t) || "0:00"}
          </Typography>
          {isAnnotation && (
            <Tooltip title="批注">
              <GestureRoundedIcon sx={{ fontSize: 13, color: "text.secondary" }} />
            </Tooltip>
          )}
        </Stack>
        {editing ? (
          <TextField
            size="small"
            fullWidth
            multiline
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSaveEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelEdit();
              }
            }}
          />
        ) : (
          <Typography
            variant="body2"
            onClick={onPreview}
            sx={{
              cursor: "pointer",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {note.text}
          </Typography>
        )}
        <Stack direction="row" sx={{ alignItems: "center", mt: 0.25, ml: -0.5 }}>
          {editing ? (
            <>
              <Tooltip title="保存 (Enter)">
                <span>
                  <IconButton size="small" color="primary" disabled={!dirty} onClick={onSaveEdit} aria-label="save note">
                    <CheckRoundedIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="取消 (Esc)">
                <IconButton size="small" onClick={onCancelEdit} aria-label="cancel edit">
                  <CloseRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </>
          ) : (
            <>
              <Tooltip title="跳转看课">
                <IconButton size="small" onClick={onJump} aria-label="jump to watch">
                  <PlayArrowRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="预览">
                <IconButton size="small" onClick={onPreview} aria-label="preview note">
                  <OpenInFullRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="编辑文字">
                <IconButton size="small" onClick={onStartEdit} aria-label="edit note">
                  <EditOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              {isAnnotation && (
                <Tooltip title="编辑批注">
                  <IconButton size="small" onClick={onEditAnnotation} aria-label="edit annotation">
                    <GestureRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title="删除">
                <IconButton size="small" onClick={onDelete} aria-label="delete note">
                  <DeleteOutlineRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
