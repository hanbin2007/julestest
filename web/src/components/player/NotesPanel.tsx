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
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import { useNotes } from "@/hooks/persist";
import { addNote, removeNote } from "@/lib/store";
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
  const notes = useNotes(videoId);
  const [text, setText] = React.useState("");
  const add = () => {
    if (!videoId || !text.trim()) return;
    addNote(videoId, Math.floor(getCurrentTime()), text.trim());
    setText("");
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
          {notes.map((n) => (
            <ListItem
              key={n.id}
              disablePadding
              secondaryAction={
                <IconButton edge="end" size="small" onClick={() => videoId && removeNote(videoId, n.id)}>
                  <DeleteOutlineRoundedIcon fontSize="small" />
                </IconButton>
              }
            >
              <ListItemButton onClick={() => onSeek(n.t)} sx={{ borderRadius: 2, alignItems: "flex-start" }}>
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
          ))}
        </List>
      </Box>
    </Drawer>
  );
}
