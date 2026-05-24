"use client";
import * as React from "react";
import { Box, Card, Checkbox, Chip, IconButton, Stack, TextField, Tooltip, Typography } from "@mui/material";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import GestureRoundedIcon from "@mui/icons-material/GestureRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import OpenInFullRoundedIcon from "@mui/icons-material/OpenInFullRounded";
import NotePreview from "./NotePreview";
import NoteViewer from "./NoteViewer";
import { fmtDur } from "@/lib/media";
import type { EnrichedNote } from "@/lib/store";

export default function NoteCard({
  note,
  color,
  selectMode,
  selected,
  onToggleSelect,
  onUpdate,
  onDelete,
  onJump,
  onEditAnnotation,
}: {
  note: EnrichedNote;
  color: string;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onUpdate: (videoId: number, id: string, text: string) => void;
  onDelete: (videoId: number, id: string) => void;
  onJump: (courseId: number, videoId: number, t: number) => void;
  onEditAnnotation: (courseId: number, videoId: number, t: number, id: string) => void;
}) {
  const isAnnotation = !!note.strokes;
  const [editing, setEditing] = React.useState(false);
  const [reader, setReader] = React.useState(false);
  const [draft, setDraft] = React.useState(note.text);
  const dirty = !!draft.trim() && draft.trim() !== note.text;

  const startEdit = () => {
    setDraft(note.text);
    setEditing(true);
  };
  const cancel = () => setEditing(false);
  const save = () => {
    const next = draft.trim();
    if (!next || next === note.text) return setEditing(false);
    onUpdate(note.videoId, note.id, next);
    setEditing(false);
  };

  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const cardClick = () => {
    if (editing) return;
    if (selectMode) onToggleSelect(note.id);
    else onJump(note.courseId, note.videoId, note.t);
  };

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={`${note.lessonTitle} ${fmtDur(note.t) || "0:00"} 笔记`}
      onClick={cardClick}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && !editing) {
          e.preventDefault();
          cardClick();
        }
      }}
      sx={{
        p: 1.5,
        height: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 1,
        cursor: editing ? "default" : "pointer",
        transition: "transform .15s, box-shadow .15s",
        // 课程色不在卡上重复（与分组标题色点冗余）；仅选中时描边强调
        ...(selected && { outline: `2px solid ${color}`, outlineOffset: "-1px" }),
        "&:hover": editing ? {} : { transform: "translateY(-2px)", boxShadow: "0 6px 20px rgba(0,0,0,.18)" },
        "&:focus-visible": { outline: "2px solid", outlineColor: color, outlineOffset: 2 },
      }}
    >
      {selectMode && (
        <Checkbox
          checked={selected}
          onClick={stop(() => onToggleSelect(note.id))}
          size="small"
          sx={{
            position: "absolute",
            top: 4,
            left: 4,
            zIndex: 2,
            p: 0.25,
            borderRadius: (t) => t.radius.sm,
            bgcolor: "background.paper",
            "&:hover": { bgcolor: "background.paper" },
          }}
        />
      )}

      <Box sx={{ display: "flex", gap: 1.5, minWidth: 0 }}>
        <NotePreview
          noteId={note.id}
          videoId={note.videoId}
          t={note.t}
          ready={note.thumbState === "ready"}
          hasSnap={note.hasSnap}
          meta={note.thumb}
          color={color}
        />
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Stack direction="row" sx={{ alignItems: "center", gap: 0.5 }}>
            <Typography
              variant="caption"
              sx={{ color: "primary.main", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
            >
              {fmtDur(note.t) || "0:00"}
            </Typography>
            {note.kind === "live" && (
              <Typography variant="caption" color="text.disabled">
                · 回放
              </Typography>
            )}
            {isAnnotation && (
              <Chip
                size="small"
                variant="outlined"
                icon={<GestureRoundedIcon />}
                label="批注"
                sx={{ height: 20, "& .MuiChip-label": { px: 0.75, fontSize: 11 } }}
              />
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary" noWrap title={note.lessonTitle}>
            {note.lessonTitle}
          </Typography>
          {editing ? (
            <TextField
              multiline
              size="small"
              autoFocus
              fullWidth
              value={draft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  save();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancel();
                }
              }}
            />
          ) : (
            <Typography
              variant="body2"
              sx={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {note.text}
            </Typography>
          )}
        </Box>
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: "auto" }}>
        {editing ? (
          <>
            <Tooltip title="保存 (Enter)">
              <span>
                <IconButton size="small" color="primary" disabled={!dirty} onClick={stop(save)} aria-label="save note">
                  <CheckRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="取消 (Esc)">
              <IconButton size="small" onClick={stop(cancel)} aria-label="cancel edit">
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        ) : (
          <>
            <Tooltip title="跳转看课">
              <IconButton
                size="small"
                onClick={stop(() => onJump(note.courseId, note.videoId, note.t))}
                aria-label="jump to watch"
              >
                <PlayArrowRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="预览">
              <IconButton size="small" onClick={stop(() => setReader(true))} aria-label="preview note">
                <OpenInFullRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="编辑文字">
              <IconButton size="small" onClick={stop(startEdit)} aria-label="edit note">
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            {isAnnotation && (
              <Tooltip title="编辑批注">
                <IconButton
                  size="small"
                  onClick={stop(() => onEditAnnotation(note.courseId, note.videoId, note.t, note.id))}
                  aria-label="edit annotation"
                >
                  <GestureRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title="删除">
              <IconButton size="small" onClick={stop(() => onDelete(note.videoId, note.id))} aria-label="delete note">
                <DeleteOutlineRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Box>

      <NoteViewer
        note={note}
        open={reader}
        onClose={() => setReader(false)}
        onJump={onJump}
        onEditAnnotation={onEditAnnotation}
      />
    </Card>
  );
}
