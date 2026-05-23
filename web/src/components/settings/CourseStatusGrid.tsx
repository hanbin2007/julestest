"use client";
import * as React from "react";
import { Box, Card, Skeleton, Typography } from "@mui/material";
import CourseStatusCard from "./CourseStatusCard";
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

function CourseStatusGrid({
  courses,
  loading,
  sort,
  busyIds,
  onOpen,
  onBuffer,
  onThumbs,
}: {
  courses: CourseStatus[];
  loading: boolean;
  sort: CourseSort;
  busyIds: Set<number>;
  onOpen: (c: CourseStatus) => void;
  onBuffer: (c: CourseStatus) => void;
  onThumbs: (c: CourseStatus) => void;
}) {
  const sorted = React.useMemo(() => sortCourses(courses, sort), [courses, sort]);

  if (loading && courses.length === 0) {
    return (
      <Box sx={GRID_SX}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} sx={{ p: 1.5, height: 168 }}>
            <Skeleton width="70%" />
            <Box sx={{ display: "flex", gap: 1.5, mt: 1 }}>
              <Skeleton variant="circular" width={76} height={76} />
              <Box sx={{ flex: 1 }}>
                <Skeleton /> <Skeleton width="80%" /> <Skeleton width="60%" />
              </Box>
            </Box>
          </Card>
        ))}
      </Box>
    );
  }
  if (sorted.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: "center" }}>
        无匹配课程
      </Typography>
    );
  }
  return (
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
  );
}

export default React.memo(CourseStatusGrid);
