"use client";
import { Box, Breadcrumbs, Button, FormControlLabel, Stack, Switch, Typography } from "@mui/material";
import SkipPreviousRoundedIcon from "@mui/icons-material/SkipPreviousRounded";
import SkipNextRoundedIcon from "@mui/icons-material/SkipNextRounded";
import NoteAltOutlinedIcon from "@mui/icons-material/NoteAltOutlined";
import GestureRoundedIcon from "@mui/icons-material/GestureRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import { fmtDur } from "@/lib/media";
import type { Course, Video } from "@/types/api";

export default function PlayerMeta({
  course,
  video,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onNotes,
  onAnnotate,
  onChat,
  onCopyDownload,
  floatTools,
  onToggleFloat,
}: {
  course: Course;
  video: Video;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onNotes: () => void;
  onAnnotate: () => void;
  onChat: () => void;
  onCopyDownload: () => void;
  floatTools: boolean;
  onToggleFloat: (v: boolean) => void;
}) {
  const crumbs = [course.name, video.module, video.topic, video.examKey].filter(Boolean) as string[];
  return (
    <Box sx={{ width: "100%", maxWidth: 1100, mx: "auto", mt: 2 }}>
      <Breadcrumbs sx={{ fontSize: 12, color: "text.secondary", mb: 0.5 }}>
        {crumbs.map((c, i) => (
          <Typography key={i} variant="caption" color={i === 0 ? "text.primary" : "text.secondary"}>
            {c}
          </Typography>
        ))}
      </Breadcrumbs>
      <Typography variant="h5">{video.title ?? `视频 ${video.videoId}`}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {[video.examKey, fmtDur(video.duration) && `时长 ${fmtDur(video.duration)}`].filter(Boolean).join(" · ")}
      </Typography>
      <Stack direction="row" sx={{ mt: 1.5, flexWrap: "wrap", gap: 1.5 }}>
        <Button variant="outlined" startIcon={<SkipPreviousRoundedIcon />} disabled={!hasPrev} onClick={onPrev}>
          上一讲
        </Button>
        <Button variant="contained" endIcon={<SkipNextRoundedIcon />} disabled={!hasNext} onClick={onNext}>
          下一讲
        </Button>
        <Button variant="text" startIcon={<NoteAltOutlinedIcon />} onClick={onNotes}>
          笔记
        </Button>
        <Button variant="text" startIcon={<GestureRoundedIcon />} onClick={onAnnotate}>
          批注
        </Button>
        <Button variant="text" startIcon={<AutoAwesomeRoundedIcon />} onClick={onChat}>
          AI 助教
        </Button>
        <Button variant="text" startIcon={<DownloadRoundedIcon />} onClick={onCopyDownload}>
          复制下载命令
        </Button>
        <FormControlLabel
          sx={{ ml: "auto", mr: 0 }}
          control={
            <Switch size="small" checked={floatTools} onChange={(e) => onToggleFloat(e.target.checked)} />
          }
          label={<Typography variant="body2">悬浮工具</Typography>}
        />
      </Stack>
    </Box>
  );
}
