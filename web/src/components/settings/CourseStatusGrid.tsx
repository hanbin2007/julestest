"use client";
import * as React from "react";
import { Box, Card, Skeleton, Typography } from "@mui/material";
import CourseStatusCard from "./CourseStatusCard";
import { DataBoundary } from "@/components/common/DataBoundary";
import type { CourseStatus } from "@/types/api";

export type CourseSort = "default" | "cache" | "watched" | "size" | "name";

const GRID_SX = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
  gridAutoRows: "1fr",
  gap: 1.5,
} as const;

function sortCourses(courses: CourseStatus[], sort: CourseSort): CourseStatus[] {
  const arr = [...courses];
  const tie = (a: CourseStatus, b: CourseStatus) => a.productId - b.productId; // 稳定，避免每秒重排
  switch (sort) {
    case "cache":
      return arr.sort((a, b) => b.partialRatio - a.partialRatio || tie(a, b));
    case "watched":
      return arr.sort(
        (a, b) => b.watched / (b.lectures || 1) - a.watched / (a.lectures || 1) || tie(a, b),
      );
    case "size":
      return arr.sort((a, b) => b.cachedBytes - a.cachedBytes || tie(a, b));
    case "name":
      return arr.sort((a, b) => a.name.localeCompare(b.name, "zh") || tie(a, b));
    default:
      return arr.sort(tie);
  }
}

const GridSkeleton = (
  <Box sx={GRID_SX}>
    {Array.from({ length: 6 }).map((_, i) => (
      // Height matches realistic card: 2-line title (~35px) + dial row + chip row + actions
      <Card key={i} sx={{ p: 1.5, height: 196 }}>
        {/* Two-line title placeholder to match clamped header */}
        <Skeleton width="85%" />
        <Skeleton width="55%" sx={{ mb: 1 }} />
        <Box sx={{ display: "flex", gap: 1.5 }}>
          <Skeleton variant="circular" width={76} height={76} />
          <Box sx={{ flex: 1 }}>
            <Skeleton />
            <Skeleton width="80%" />
            <Skeleton width="60%" />
          </Box>
        </Box>
      </Card>
    ))}
  </Box>
);

const EmptyState = (
  <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: "center" }}>
    无匹配课程
  </Typography>
);

function CourseStatusGrid({
  courses,
  loading,
  error,
  onRetry,
  sort,
  busyIds,
  onOpen,
  onBuffer,
  onThumbs,
}: {
  courses: CourseStatus[];
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  sort: CourseSort;
  busyIds: Set<number>;
  onOpen: (c: CourseStatus) => void;
  onBuffer: (c: CourseStatus) => void;
  onThumbs: (c: CourseStatus) => void;
}) {
  const sorted = React.useMemo(() => sortCourses(courses, sort), [courses, sort]);

  // 三态收口于 DataBoundary：error(且无可展示数据)→行内重试面板；loading→骨架；
  // 空(已加载但筛选/无课)→“无匹配课程”。修复原 loading={!data} 在请求出错时骨架永转。
  return (
    <DataBoundary
      loading={loading && courses.length === 0}
      error={error}
      onRetry={onRetry}
      isEmpty={sorted.length === 0}
      skeleton={GridSkeleton}
      empty={EmptyState}
      errorTitle="课程状态加载失败"
      errorHint="无法获取课程缓存状态，请检查网关 / 网络后重试。"
    >
    <Box>
      {/* 常驻图例：解释卡片上的双环含义(原来只在 hover tooltip 里,发现性差)。 */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1, px: 0.5, flexWrap: "wrap" }}>
        <Typography variant="caption" color="text.secondary">环形图例</Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Box sx={{ width: 12, height: 12, borderRadius: "50%", border: "3px solid", borderColor: "primary.main" }} />
          <Typography variant="caption" color="text.secondary">外环 = 缓存进度</Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Box sx={{ width: 12, height: 12, borderRadius: "50%", border: "2px dashed", borderColor: "success.main" }} />
          <Typography variant="caption" color="text.secondary">内环(虚线) = 已看</Typography>
        </Box>
      </Box>
      <Box sx={GRID_SX}>
        {sorted.map((c) => (
          <CourseStatusCard
            key={c.productId}
            course={c}
            busy={busyIds.has(c.productId)}
            onOpen={onOpen}
            onBuffer={onBuffer}
            onThumbs={onThumbs}
          />
        ))}
      </Box>
    </Box>
    </DataBoundary>
  );
}

export default React.memo(CourseStatusGrid);
