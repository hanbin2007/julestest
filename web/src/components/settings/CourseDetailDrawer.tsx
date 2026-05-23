"use client";
import * as React from "react";
import { Box, Drawer, IconButton, Typography } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { useCourseVideos } from "@/hooks/data";
import LectureGrid, { type GridRow } from "./LectureGrid";
import type { CourseStatus, CoursesStatus, VideoRow } from "@/types/api";

// 课程详情抽屉：点开某门课卡片后，展示该课全部讲次（含直播回放）的逐讲状态。
export default function CourseDetailDrawer({
  course,
  perVid,
  density,
  onRowThumb,
  onRowBuf,
  onClose,
}: {
  course: CourseStatus | null;
  perVid: CoursesStatus["perVid"];
  density: "comfortable" | "compact";
  onRowThumb: (r: VideoRow) => void;
  onRowBuf: (r: VideoRow) => void;
  onClose: () => void;
}) {
  const open = !!course;
  const { videos, isLoading } = useCourseVideos(open ? course!.productId : null);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  React.useEffect(() => setSelected(new Set()), [course?.productId]);

  const rows: GridRow[] = React.useMemo(() => {
    if (!course) return [];
    return videos.map((v) => {
      const b = perVid[String(v.videoId)];
      return {
        id: v.videoId,
        courseName: course.name,
        title: v.title ?? `视频 ${v.videoId}`,
        duration: v.duration,
        kind: v.kind === "live" ? "live" : "vod",
        bytes: b?.bytes ?? 0,
        thumbState: b?.thumb ?? "none",
        bufCached: b?.cached ?? 0,
        bufTotal: b?.total ?? null,
        bufState: b?.state ?? null,
        vrow: { v, courseId: course.productId, courseName: course.name },
      };
    });
  }, [course, videos, perVid]);

  const toggle = (id: number, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      on ? n.add(id) : n.delete(id);
      return n;
    });
  const toggleAll = (on: boolean) =>
    setSelected(on ? new Set(rows.map((r) => r.id)) : new Set());

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: "100%", md: 760 }, display: "flex", flexDirection: "column" } }}
    >
      {/* Header — auto height, never pushes grid off-screen */}
      <Box
        sx={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 1,
          p: 1.5,
          borderBottom: (t) => `1px solid ${t.palette.divider}`,
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }} noWrap>
            {course?.name}
          </Typography>
          {course && (
            <Typography variant="caption" color="text.secondary">
              {course.lectures} 讲 · 点播 {course.vod} · 回放 {course.live} · 已缓存 {course.cachedLectures} · 已看 {course.watched}
            </Typography>
          )}
        </Box>
        <IconButton onClick={onClose} aria-label="关闭" sx={{ flexShrink: 0 }}>
          <CloseRoundedIcon />
        </IconButton>
      </Box>

      {/* Grid body — flex:1 fills whatever remains after the header */}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {isLoading && rows.length === 0 ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", p: 2 }}>
            加载讲次中…
          </Typography>
        ) : (
          <LectureGrid
            rows={rows}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onRowThumb={onRowThumb}
            onRowBuf={onRowBuf}
            density={density}
          />
        )}
      </Box>
    </Drawer>
  );
}
