"use client";
import * as React from "react";
import { Box, Card, Chip, CircularProgress, IconButton, Tooltip, Typography } from "@mui/material";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import OndemandVideoRoundedIcon from "@mui/icons-material/OndemandVideoRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import ImageRoundedIcon from "@mui/icons-material/ImageRounded";
import { hashSeed } from "@/lib/color";
import { fmtBytes } from "@/lib/media";
import type { CourseStatus } from "@/types/api";

// 缓存双环：底轨 + 部分缓存(淡)到 partialRatio + 整集缓存(实)到 fullRatio；内圈=已看。
function CacheDial({ course, color }: { course: CourseStatus; color: string }) {
  const size = 76;
  const full = Math.round(course.fullRatio * 100);
  const partial = Math.round(course.partialRatio * 100);
  const watch = course.lectures ? Math.round((course.watched / course.lectures) * 100) : 0;
  const done = course.lectures > 0 && course.fullyCached === course.lectures;
  const ring = (value: number, c: string, s: number, thickness: number) => (
    <CircularProgress
      variant="determinate"
      value={value}
      size={s}
      thickness={thickness}
      sx={{ color: c, position: "absolute", inset: 0, m: "auto" }}
    />
  );
  // Accessible summary for screen readers
  const ariaLabel = `缓存 ${course.cachedLectures}/${course.lectures} 讲，已看 ${course.watched}，占用 ${fmtBytes(course.cachedBytes)}`;
  return (
    <Box
      aria-label={ariaLabel}
      role="img"
      sx={{ position: "relative", width: size, height: size, flex: "0 0 auto" }}
    >
      {ring(100, "action.hover", size, 5)}
      {ring(partial, `color-mix(in srgb, ${color} 38%, transparent)`, size, 5)}
      {ring(full, color, size, 5)}
      {ring(watch, "success.main", size - 16, 4)}
      <Box sx={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {done ? (
          <CheckCircleRoundedIcon sx={{ color: "success.main", fontSize: 26 }} />
        ) : course.allLocked ? (
          <LockOutlinedIcon sx={{ color: "text.disabled", fontSize: 22 }} />
        ) : (
          // Slightly larger than caption to stay legible inside the inner ring clearance (~52px)
          <Typography
            component="span"
            sx={{
              fontSize: "0.7rem",
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
            }}
          >
            {course.cachedLectures}/{course.lectures}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function CourseStatusCard({
  course,
  busy,
  onOpen,
  onBuffer,
  onThumbs,
}: {
  course: CourseStatus;
  busy?: boolean;
  onOpen: (c: CourseStatus) => void;
  onBuffer: (c: CourseStatus) => void;
  onThumbs: (c: CourseStatus) => void;
}) {
  const color = hashSeed(course.name);
  const thumbDone = course.lectures > 0 && course.thumbsReady === course.lectures;

  // Stop click from reaching the card when an action button fires
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  // Keyboard activation for the card itself; guard against events bubbling from child buttons
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      const target = e.target as HTMLElement;
      // Only fire if the focused element is the card itself, not a nested button/interactive
      if (target === e.currentTarget) {
        e.preventDefault();
        onOpen(course);
      }
    }
  };

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={`打开 ${course.name} 详情`}
      onClick={() => onOpen(course)}
      onKeyDown={handleKeyDown}
      sx={{
        p: 1.5,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
        position: "relative",
        transition: "transform .15s, box-shadow .15s",
        "&:hover": {
          transform: "translateY(-2px)",
          boxShadow: "0 6px 20px rgba(0,0,0,.18)",
        },
        "&:focus-visible": {
          outline: "2px solid",
          outlineColor: color,
          outlineOffset: 2,
        },
        // Actions: visible at rest on mobile; subtly visible on desktop, full on hover/focus-within
        "& .card-actions": {
          opacity: { xs: 1, md: 0.55 },
          transition: "opacity .15s",
        },
        "&:hover .card-actions, &:focus-within .card-actions": {
          opacity: 1,
        },
      }}
    >
      {/* Header: title (2-line clamp) + optional card-type chip */}
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, mb: 1 }}>
        <Typography
          variant="subtitle2"
          title={course.name}
          sx={{
            flex: 1,
            fontWeight: 700,
            lineHeight: 1.25,
            minWidth: 0,
            // Stable 2-line header so all cards align across the row
            minHeight: "calc(1.25em * 2)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            wordBreak: "break-word",
          }}
        >
          {course.name}
        </Typography>
        {course.cardType && (
          <Chip
            size="small"
            label={course.cardType}
            sx={{ height: 22, fontSize: 11, flexShrink: 0, alignSelf: "flex-start" }}
          />
        )}
      </Box>

      {/* Dial + stats row */}
      <Box sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
        <CacheDial course={course} color={color} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stat
            label="缓存"
            value={`${course.cachedLectures}/${course.lectures} 讲`}
            hint={course.fullyCached ? `整集 ${course.fullyCached}` : undefined}
          />
          {/* Dim zero watched count so courses with activity stand out */}
          <Stat
            label="已看"
            value={`${course.watched}`}
            hint={course.buffering ? `缓冲中 ${course.buffering}` : undefined}
            muted={course.watched === 0}
          />
          {/* Dim zero byte usage */}
          <Stat label="占用" value={fmtBytes(course.cachedBytes)} muted={course.cachedBytes === 0} />
        </Box>
      </Box>

      {/* Chip row: 点播 / 回放 / 缩略图 */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          columnGap: 0.5,
          rowGap: 0.5,
          mt: 1,
          flexWrap: "wrap",
        }}
      >
        <Chip
          size="small"
          variant="outlined"
          icon={<OndemandVideoRoundedIcon />}
          label={`点播 ${course.vod}`}
          sx={{
            height: 22,
            // Dim zero-value chip so populated courses stand out
            opacity: course.vod === 0 ? 0.45 : 1,
          }}
        />
        {course.live > 0 && (
          <Chip
            size="small"
            variant="outlined"
            icon={<ReplayRoundedIcon />}
            label={`回放 ${course.live}`}
            sx={{ height: 22 }}
          />
        )}
        <Chip
          size="small"
          color={thumbDone ? "success" : course.thumbsError ? "error" : course.thumbsGen ? "primary" : "default"}
          variant="outlined"
          label={`缩略图 ${course.thumbsReady}/${course.lectures}`}
          sx={{ height: 22 }}
        />
      </Box>

      {/* Action buttons: always keyboard-reachable; subtle at rest on desktop */}
      <Box
        className="card-actions"
        sx={{ display: "flex", gap: 0.5, mt: "auto", pt: 1, justifyContent: "flex-end" }}
      >
        <Tooltip title="缓冲整集（本课全部讲次）">
          <span>
            <IconButton
              size="small"
              aria-label="缓冲整集"
              disabled={busy || course.allLocked}
              onClick={stop(() => onBuffer(course))}
            >
              <DownloadRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="生成全部缩略图">
          <span>
            <IconButton
              size="small"
              aria-label="生成全部缩略图"
              disabled={busy || course.allLocked}
              onClick={stop(() => onThumbs(course))}
            >
              <ImageRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  muted,
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5, lineHeight: 1.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ width: 30 }}>
        {label}
      </Typography>
      {/* De-emphasize zero values so populated metrics read louder */}
      <Typography
        variant="caption"
        sx={{
          fontWeight: muted ? 400 : 600,
          fontVariantNumeric: "tabular-nums",
          color: muted ? "text.disabled" : "text.primary",
        }}
      >
        {value}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.disabled" noWrap>
          · {hint}
        </Typography>
      )}
    </Box>
  );
}

export default React.memo(CourseStatusCard);
