"use client";
import * as React from "react";
import {
  Box,
  Chip,
  IconButton,
  InputAdornment,
  List,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import MyLocationRoundedIcon from "@mui/icons-material/MyLocationRounded";
import UnfoldLessRoundedIcon from "@mui/icons-material/UnfoldLessRounded";
import { SidebarSkeleton } from "@/components/common/Skeletons";
import type { Course } from "@/types/api";
import type { SelectFn } from "./sidebarTree";
import CourseItem from "./CourseItem";

export default function CourseSidebar({
  courses,
  loading,
  activeVideoId,
  activeCourseId,
  onSelect,
  onJumpToCurrent,
}: {
  courses: Course[];
  loading: boolean;
  activeVideoId: number | null;
  activeCourseId: number | null;
  onSelect: SelectFn;
  onJumpToCurrent?: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [cardFilter, setCardFilter] = React.useState<string | null>(null);
  // 各课展开状态上移到这里集中管理，「回到在看 / 收起其他」才能一次改完。
  const [openIds, setOpenIds] = React.useState<Set<number>>(() => new Set());
  // 自增脉冲：传给在看那门课，由它精确到小节地定位/收起（详见 CourseItem）。
  const [locateNonce, setLocateNonce] = React.useState(0);
  const [collapseNonce, setCollapseNonce] = React.useState(0);

  // 去重的卡片类型（保持课程出现顺序）；只有多于一种时才显示筛选行。
  const cardTypes = React.useMemo(() => {
    const seen: string[] = [];
    for (const c of courses) {
      const t = c.cardType || "课程";
      if (!seen.includes(t)) seen.push(t);
    }
    return seen;
  }, [courses]);

  const visibleCourses = React.useMemo(
    () => (cardFilter ? courses.filter((c) => (c.cardType || "课程") === cardFilter) : courses),
    [courses, cardFilter]
  );

  const toggle = React.useCallback((id: number) => {
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  // 回到在看：清掉挡住在看课程的筛选/搜索 → 展开该课 → 发脉冲（由 CourseItem 展开到小节并滚到位）→（无选中时）续看。
  const jumpToCurrent = React.useCallback(() => {
    if (activeCourseId == null) return;
    const ac = courses.find((c) => c.id === activeCourseId);
    if (ac && cardFilter && (ac.cardType || "课程") !== cardFilter) setCardFilter(null);
    if (query) setQuery("");
    setOpenIds((s) => new Set(s).add(activeCourseId));
    setLocateNonce((n) => n + 1);
    onJumpToCurrent?.();
  }, [activeCourseId, courses, cardFilter, query, onJumpToCurrent]);

  // 收起其他：只留在看那门课展开（没有在看就全部收起），并发脉冲让它再收到小节级。
  const collapseOthers = React.useCallback(() => {
    setOpenIds(activeCourseId != null ? new Set([activeCourseId]) : new Set());
    setCollapseNonce((n) => n + 1);
  }, [activeCourseId]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Box sx={{ p: 1.5, borderBottom: (t) => `1px solid ${t.palette.divider}` }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            我的课程
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="回到正在看">
            <span>
              <IconButton
                size="small"
                aria-label="回到正在看"
                onClick={jumpToCurrent}
                disabled={activeCourseId == null}
              >
                <MyLocationRoundedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="收起其他课程">
            <IconButton size="small" aria-label="收起其他课程" onClick={collapseOthers}>
              <UnfoldLessRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ ml: 0.5, fontVariantNumeric: "tabular-nums" }}
          >
            {visibleCourses.length} 门
          </Typography>
        </Box>
        <TextField
          size="small"
          fullWidth
          placeholder="搜索讲次 / 课程…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        {cardTypes.length > 1 && (
          <Stack
            direction="row"
            spacing={1}
            sx={{ mt: 1, overflowX: "auto", pb: 0.5, "&::-webkit-scrollbar": { display: "none" } }}
          >
            <Chip
              size="small"
              label="全部"
              color={cardFilter === null ? "primary" : "default"}
              variant={cardFilter === null ? "filled" : "outlined"}
              onClick={() => setCardFilter(null)}
              sx={{ flexShrink: 0 }}
            />
            {cardTypes.map((t) => (
              <Chip
                key={t}
                size="small"
                label={t}
                color={cardFilter === t ? "primary" : "default"}
                variant={cardFilter === t ? "filled" : "outlined"}
                onClick={() => setCardFilter((c) => (c === t ? null : t))}
                sx={{ flexShrink: 0 }}
              />
            ))}
          </Stack>
        )}
      </Box>
      <List sx={{ flex: 1, overflowY: "auto", p: 1 }}>
        {loading && <SidebarSkeleton />}
        {visibleCourses.map((c) => (
          <CourseItem
            key={c.id}
            course={c}
            activeVideoId={activeVideoId}
            onSelect={onSelect}
            query={query}
            open={openIds.has(c.id)}
            onToggle={() => toggle(c.id)}
            isActive={c.id === activeCourseId}
            locateNonce={locateNonce}
            collapseNonce={collapseNonce}
          />
        ))}
        {!loading && cardFilter && visibleCourses.length === 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
            无此类型课程
          </Typography>
        )}
      </List>
    </Box>
  );
}
