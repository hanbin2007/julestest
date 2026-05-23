"use client";
import * as React from "react";
import {
  Box,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { useNotes } from "@/hooks/persist";
import { fmtDur } from "@/lib/media";

export default function NotesPanel({
  open,
  onClose,
  videoId,
  getCurrentTime,
  onSeek,
}: {
  open: boolean;
  onClose: () => void;
  videoId: number | null;
  getCurrentTime: () => number;
  onSeek: (t: number) => void;
}) {
  const { notes, add: addNote, update: updateNote, remove: removeNote } = useNotes(videoId);
  const [text, setText] = React.useState("");
  const [editId, setEditId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");

  const add = () => {
    if (!videoId || !text.trim()) return;
    void addNote(Math.floor(getCurrentTime()), text.trim());
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
  const saveEdit = (id: string, original: string) => {
    const next = draft.trim();
    if (!next || next === original) return cancelEdit();
    void updateNote(id, next);
    cancelEdit();
  };

  return (
    <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: 360, maxWidth: "92vw" } }}>
      <Box sx={{ p: 2, display: "flex", flexDirection: "column", height: "100%" }}>
        <Typography variant="h6" gutterBottom>
          时间戳笔记
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
          <TextField
            size="small"
            fullWidth
            placeholder={`在 ${fmtDur(getCurrentTime()) || "0:00"} 记一条…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <IconButton color="primary" onClick={add} aria-label="add note">
            <AddRoundedIcon />
          </IconButton>
        </Stack>
        <List sx={{ flex: 1, overflowY: "auto" }}>
          {notes.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>
              还没有笔记。播放时按 <b>B</b> 也能快速记一条。
            </Typography>
          )}
          {notes.map((n) => {
            if (editId === n.id) {
              const next = draft.trim();
              const dirty = !!next && next !== n.text;
              return (
                <ListItem key={n.id} disablePadding sx={{ alignItems: "flex-start", px: 1, py: 0.5, gap: 1 }}>
                  <Typography
                    variant="caption"
                    sx={{ color: "primary.main", fontWeight: 700, mt: 1.2, fontVariantNumeric: "tabular-nums" }}
                  >
                    {fmtDur(n.t) || "0:00"}
                  </Typography>
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
                        saveEdit(n.id, n.text);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                  />
                  <Stack direction="column" sx={{ mt: 0.5 }}>
                    <IconButton
                      size="small"
                      color="primary"
                      disabled={!dirty}
                      onClick={() => saveEdit(n.id, n.text)}
                      aria-label="save note"
                    >
                      <CheckRoundedIcon fontSize="small" />
                    </IconButton>
                    <IconButton size="small" onClick={cancelEdit} aria-label="cancel edit">
                      <CloseRoundedIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                </ListItem>
              );
            }
            return (
              <ListItem
                key={n.id}
                disablePadding
                sx={{ "& .MuiListItemSecondaryAction-root": { right: 4 } }}
                secondaryAction={
                  <Stack direction="row">
                    <Tooltip title="编辑">
                      <IconButton size="small" onClick={() => startEdit(n.id, n.text)} aria-label="edit note">
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="删除">
                      <IconButton size="small" onClick={() => void removeNote(n.id)} aria-label="delete note">
                        <DeleteOutlineRoundedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                }
              >
                <ListItemButton
                  onClick={() => onSeek(n.t)}
                  sx={{ borderRadius: 2, alignItems: "flex-start", pr: 9 }}
                >
                  <Typography
                    variant="caption"
                    sx={{ color: "primary.main", fontWeight: 700, mr: 1, mt: 0.2, fontVariantNumeric: "tabular-nums" }}
                  >
                    {fmtDur(n.t) || "0:00"}
                  </Typography>
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                    {n.text}
                  </Typography>
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>
      </Box>
    </Drawer>
  );
}
