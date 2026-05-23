"use client";
import * as React from "react";
import {
  Box,
  Chip,
  Collapse,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
  CircularProgress,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import OndemandVideoRoundedIcon from "@mui/icons-material/OndemandVideoRounded";
import LiveTvRoundedIcon from "@mui/icons-material/LiveTvRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import MyLocationRoundedIcon from "@mui/icons-material/MyLocationRounded";
import UnfoldLessRoundedIcon from "@mui/icons-material/UnfoldLessRounded";
import { useCourseVideos } from "@/hooks/data";
import { useProgressMap } from "@/hooks/persist";
import { fmtDur } from "@/lib/media";
import { hashSeed } from "@/lib/color";
import { SidebarSkeleton } from "@/components/common/Skeletons";
import type { Course, Video } from "@/types/api";

interface SelectFn {
  (video: Video, course: Course): void;
}

interface GroupNode {
  name: string;
  kids: GroupNode[];
  vids: Video[];
}
function buildTree(videos: Video[]): { root: Video[]; groups: GroupNode[] } {
  const groups: GroupNode[] = [];
  const idx = new Map<string, GroupNode>();
  const root: Video[] = [];
  for (const v of videos) {
    const path = [v.module, v.topic, v.examKey].filter(Boolean) as string[];
    if (!path.length) {
      root.push(v);
      continue;
    }
    let level = groups;
    let key = "";
    let node: GroupNode | undefined;
    for (const p of path) {
      key += "|" + p;
      node = idx.get(key);
      if (!node) {
        node = { name: p, kids: [], vids: [] };
        idx.set(key, node);
        level.push(node);
      }
      level = node.kids;
    }
    node!.vids.push(v);
  }
  return { root, groups };
}

// 直播回放分组：有多个分栏(liveTab)时按 分栏 > 年月 两层，否则直接按 年月。
function buildLiveGroups(videos: Video[]): GroupNode[] {
  const monthName = (v: Video) =>
    v.year && v.month ? `${v.year}年${Number(v.month)}月` : "其他";
  const byMonth = (vids: Video[]): GroupNode[] => {
    const map = new Map<string, GroupNode>();
    const order: string[] = [];
    for (const v of vids) {
      const n = monthName(v);
      let g = map.get(n);
      if (!g) {
        g = { name: n, kids: [], vids: [] };
        map.set(n, g);
        order.push(n);
      }
      g.vids.push(v);
    }
    for (const g of map.values())
      g.vids.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    return order.map((n) => map.get(n)!);
  };
  const tabs = Array.from(new Set(videos.map((v) => v.liveTab || "")));
  if (tabs.length <= 1) return byMonth(videos);
  return tabs.map((t) => ({
    name: t || "直播回放",
    kids: byMonth(videos.filter((v) => (v.liveTab || "") === t)),
    vids: [],
  }));
}

// 板块标题（视频 / 直播回放）。
function BoardLabel({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, px: 1, pt: 1, pb: 0.5 }}>
      {icon}
      <Typography variant="caption" sx={{ fontWeight: 800, letterSpacing: 0.5, color: "text.secondary" }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ ml: "auto", color: "text.disabled", fontVariantNumeric: "tabular-nums" }}>
        {count}
      </Typography>
    </Box>
  );
}

function Ring({ ratio, color }: { ratio: number; color: string }) {
  if (ratio >= 0.9)
    return <CheckCircleRoundedIcon sx={{ fontSize: 18, color: "success.main" }} />;
  if (ratio <= 0.01) return <Box sx={{ width: 18 }} />;
  return (
    <Box sx={{ position: "relative", width: 18, height: 18 }}>
      <CircularProgress
        variant="determinate"
        value={ratio * 100}
        size={18}
        thickness={5}
        sx={{ color }}
      />
    </Box>
  );
}

function VideoRow({
  v,
  active,
  onSelect,
  color,
  ratio,
}: {
  v: Video;
  active: boolean;
  onSelect: () => void;
  color: string;
  ratio: number;
}) {
  return (
    <ListItemButton
      onClick={() => !v.locked && onSelect()}
      disabled={v.locked}
      selected={active}
      sx={{
        borderRadius: (t) => t.radius.sm,
        py: 0.5,
        pl: 1,
        gap: 1,
        "&.Mui-selected": {
          bgcolor: `color-mix(in srgb, ${color} 22%, transparent)`,
        },
        // 左侧选中指示：圆角药丸，竖直内缩避开行圆角——不再被圆角裁出怪弧
        "&.Mui-selected::before": {
          content: '""',
          position: "absolute",
          left: 0,
          top: "20%",
          bottom: "20%",
          width: "3px",
          borderRadius: "999px",
          backgroundColor: color,
        },
      }}
    >
      {v.locked ? (
        <LockOutlinedIcon sx={{ fontSize: 16, color: "text.disabled" }} />
      ) : v.kind === "live" ? (
        <ReplayRoundedIcon sx={{ fontSize: 17, color: active ? color : "text.secondary" }} />
      ) : (
        <PlayArrowRoundedIcon sx={{ fontSize: 18, color: active ? color : "text.secondary" }} />
      )}
      <Typography
        variant="body2"
        sx={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        title={v.title ?? ""}
      >
        {v.title ?? `视频 ${v.videoId}`}
      </Typography>
      {!!fmtDur(v.duration) && (
        <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {fmtDur(v.duration)}
        </Typography>
      )}
      <Ring ratio={ratio} color={color} />
    </ListItemButton>
  );
}

function GroupEl({
  node,
  render,
}: {
  node: GroupNode;
  render: (v: Video) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <Box sx={{ ml: 0.5 }}>
      <ListItemButton onClick={() => setOpen((o) => !o)} sx={{ borderRadius: (t) => t.radius.sm, py: 0.5, gap: 0.5 }}>
        <ChevronRightIcon
          sx={{ fontSize: 16, transition: ".18s", transform: open ? "rotate(90deg)" : "none", color: "text.secondary" }}
        />
        <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary" }}>
          {node.name}
        </Typography>
      </ListItemButton>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ pl: 1.5, ml: 1.5, borderLeft: (t) => `1px solid ${t.palette.divider}` }}>
          {node.kids.map((k, i) => (
            <GroupEl key={i} node={k} render={render} />
          ))}
          {node.vids.map(render)}
        </Box>
      </Collapse>
    </Box>
  );
}

function CourseItem({
  course,
  activeVideoId,
  onSelect,
  query,
  open,
  onToggle,
  rootRef,
}: {
  course: Course;
  activeVideoId: number | null;
  onSelect: SelectFn;
  query: string;
  open: boolean;
  onToggle: () => void;
  rootRef?: (el: HTMLDivElement | null) => void;
}) {
  const wantOpen = open || !!query;
  const { videos, isLoading } = useCourseVideos(wantOpen ? course.id : null);
  const progress = useProgressMap();
  const color = hashSeed(course.name);

  const playable = videos.filter((v) => !v.locked);
  const watched = playable.filter((v) => {
    const e = progress[String(v.videoId)];
    return e && e.d && e.t / e.d >= 0.9;
  }).length;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? videos.filter(
        (v) => (v.title ?? "").toLowerCase().includes(q) || course.name.toLowerCase().includes(q)
      )
    : videos;
  const courseMatches = q ? course.name.toLowerCase().includes(q) : true;
  if (q && !courseMatches && filtered.length === 0) return null;

  // 拆成两个板块：点播视频 与 直播回放（旧目录缺 kind 时按点播处理）。
  const liveVideos = filtered.filter((v) => v.kind === "live");
  const vodVideos = filtered.filter((v) => v.kind !== "live");
  const { root, groups } = buildTree(vodVideos);
  const liveGroups = buildLiveGroups(liveVideos);
  const hasLive = liveVideos.length > 0;
  const ratioOf = (v: Video) => {
    const e = progress[String(v.videoId)];
    return e && e.d ? Math.min(1, e.t / e.d) : 0;
  };
  const renderRow = (v: Video) => (
    <VideoRow
      key={v.videoId}
      v={v}
      active={v.videoId === activeVideoId}
      onSelect={() => onSelect(v, course)}
      color={color}
      ratio={ratioOf(v)}
    />
  );

  return (
    <Box ref={rootRef} sx={{ mb: 0.5, scrollMarginTop: 8 }}>
      <ListItemButton onClick={onToggle} sx={{ borderRadius: (t) => t.radius.sm, gap: 1 }}>
        <ChevronRightIcon
          sx={{ fontSize: 18, transition: ".18s", transform: wantOpen ? "rotate(90deg)" : "none", color: "text.secondary" }}
        />
        <Typography
          variant="body2"
          sx={{ flex: 1, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={course.name}
        >
          {course.name}
        </Typography>
        {playable.length > 0 && watched > 0 && (
          <Typography variant="caption" sx={{ color: watched >= playable.length ? "success.main" : "text.secondary" }}>
            {watched}/{playable.length}
          </Typography>
        )}
        <Chip size="small" label={course.cardType || "课程"} sx={{ height: 22, fontSize: 11 }} />
      </ListItemButton>
      <Collapse in={wantOpen} unmountOnExit>
        <Box sx={{ pl: 0.5 }}>
          {isLoading && <SidebarSkeleton />}
          {!isLoading && (
            <>
              {/* 视频板块（有直播回放时才加标题，避免单板块下多余标签） */}
              {hasLive && vodVideos.length > 0 && (
                <BoardLabel
                  icon={<OndemandVideoRoundedIcon sx={{ fontSize: 16, color: "text.secondary" }} />}
                  label="视频"
                  count={vodVideos.length}
                />
              )}
              {root.map(renderRow)}
              {groups.map((g, i) => (
                <GroupEl key={i} node={g} render={renderRow} />
              ))}
              {/* 直播回放板块 */}
              {hasLive && (
                <>
                  <BoardLabel
                    icon={<LiveTvRoundedIcon sx={{ fontSize: 16, color: "text.secondary" }} />}
                    label="直播回放"
                    count={liveVideos.length}
                  />
                  {liveGroups.map((g, i) => (
                    <GroupEl key={`live-${i}`} node={g} render={renderRow} />
                  ))}
                </>
              )}
              {filtered.length === 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ pl: 2 }}>
                  无匹配
                </Typography>
              )}
            </>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

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
  // 自增令牌：每次点「回到在看」都触发滚动 effect，重复点也能再次滚到位。
  const [jumpToken, setJumpToken] = React.useState(0);
  const rowRefs = React.useRef<Map<number, HTMLDivElement>>(new Map());

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

  // 回到在看：清掉挡住在看课程的筛选 → 展开该课 → 滚到可视区 →（无选中时）续看。
  const jumpToCurrent = React.useCallback(() => {
    if (activeCourseId == null) return;
    const ac = courses.find((c) => c.id === activeCourseId);
    if (ac && cardFilter && (ac.cardType || "课程") !== cardFilter) setCardFilter(null);
    setOpenIds((s) => new Set(s).add(activeCourseId));
    setJumpToken((n) => n + 1);
    onJumpToCurrent?.();
  }, [activeCourseId, courses, cardFilter, onJumpToCurrent]);

  // 收起其他：只留在看那门课展开（没有在看就全部收起）。
  const collapseOthers = React.useCallback(() => {
    setOpenIds(activeCourseId != null ? new Set([activeCourseId]) : new Set());
  }, [activeCourseId]);

  // 展开动画跑完后再滚动；依赖 jumpToken 让连点也能重新滚到位。
  React.useEffect(() => {
    if (jumpToken === 0 || activeCourseId == null) return;
    const t = window.setTimeout(() => {
      rowRefs.current
        .get(activeCourseId)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(t);
  }, [jumpToken, activeCourseId]);

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
            rootRef={(el) => {
              if (el) rowRefs.current.set(c.id, el);
              else rowRefs.current.delete(c.id);
            }}
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
