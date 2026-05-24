"use client";
import * as React from "react";
import {
  Box,
  Dialog,
  InputAdornment,
  List,
  ListItemButton,
  TextField,
  Typography,
} from "@mui/material";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { useAllCourseVideos } from "@/hooks/data";
import { fmtDur } from "@/lib/media";
import type { Course, VideoRow } from "@/types/api";

export default function CommandPalette({
  open,
  onClose,
  courses,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  courses: Course[];
  onPick: (row: VideoRow) => void;
}) {
  // 仅在打开过后才加载全部课程（避免首页就拉 21 个请求）
  const [activated, setActivated] = React.useState(false);
  React.useEffect(() => {
    if (open) setActivated(true);
  }, [open]);
  const { rows } = useAllCourseVideos(activated ? courses : []);

  const [q, setQ] = React.useState("");
  const [idx, setIdx] = React.useState(0);
  const results = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? rows.filter(
          (r) => (r.v.title ?? "").toLowerCase().includes(s) || r.courseName.toLowerCase().includes(s)
        )
      : rows;
    return list.slice(0, 60);
  }, [q, rows]);
  React.useEffect(() => setIdx(0), [q, open]);

  const pick = (r?: VideoRow) => {
    if (!r) return;
    onPick(r);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      PaperProps={{ sx: { borderRadius: (t) => t.radius.lg, bgcolor: "md3.surfaceContainerHigh" } }}
    >
      <Box sx={{ p: 2 }}>
        <TextField
          autoFocus
          fullWidth
          placeholder="搜索任意讲次，回车直达…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              pick(results[idx]);
            }
          }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchRoundedIcon />
              </InputAdornment>
            ),
          }}
        />
        <List sx={{ maxHeight: 360, overflowY: "auto", mt: 1 }}>
          {results.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              {rows.length ? "无匹配" : "加载课程中…"}
            </Typography>
          )}
          {results.map((r, i) => (
            <ListItemButton
              key={`${r.courseId}:${r.v.videoId}`}
              selected={i === idx}
              onMouseEnter={() => setIdx(i)}
              onClick={() => pick(r)}
              sx={{ borderRadius: (t) => t.radius.sm }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap>
                  {r.v.title ?? `视频 ${r.v.videoId}`}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {r.courseName}
                </Typography>
              </Box>
              <Typography variant="caption" color="text.secondary">
                {fmtDur(r.v.duration)}
              </Typography>
            </ListItemButton>
          ))}
        </List>
      </Box>
    </Dialog>
  );
}
