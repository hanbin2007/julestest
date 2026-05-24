"use client";
import * as React from "react";
import { Box, Chip, Collapse, ListItemButton, Typography } from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import OndemandVideoRoundedIcon from "@mui/icons-material/OndemandVideoRounded";
import LiveTvRoundedIcon from "@mui/icons-material/LiveTvRounded";
import { useCourseVideos } from "@/hooks/data";
import { useProgressMap } from "@/hooks/persist";
import { hashSeed } from "@/lib/color";
import { SidebarSkeleton } from "@/components/common/Skeletons";
import type { Course, Video } from "@/types/api";
import {
  allGroupKeys,
  buildLiveGroups,
  buildTree,
  pathToVideo,
  type SelectFn,
} from "./sidebarTree";
import { BoardLabel, GroupEl, VideoRow } from "./SidebarRows";

export default function CourseItem({
  course,
  activeVideoId,
  onSelect,
  query,
  open,
  onToggle,
  isActive,
  locateNonce,
  collapseNonce,
}: {
  course: Course;
  activeVideoId: number | null;
  onSelect: SelectFn;
  query: string;
  open: boolean;
  onToggle: () => void;
  isActive: boolean; // 这门课是不是正在看的那门
  locateNonce: number; // 「回到在看」脉冲
  collapseNonce: number; // 「收起其他」脉冲
}) {
  const wantOpen = open || !!query;
  const { videos, isLoading } = useCourseVideos(wantOpen ? course.id : null);
  const progress = useProgressMap();
  const color = hashSeed(course.name);

  // 组级展开：默认全开，只记“被收起”的组 key（精确到小节）。
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => new Set());
  const [pending, setPending] = React.useState<"locate" | "collapse" | null>(null);
  const selfRef = React.useRef<HTMLDivElement | null>(null); // 课程根元素（定位兜底）
  const activeRowRef = React.useRef<HTMLDivElement | null>(null); // 在看那一小节

  const toggleGroup = React.useCallback((key: string) => {
    setCollapsedGroups((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }, []);

  // 把脉冲翻成一次待执行动作（仅在看那门课响应；挂载时不触发）。
  const locRef = React.useRef(locateNonce);
  React.useEffect(() => {
    if (isActive && locateNonce !== locRef.current) setPending("locate");
    locRef.current = locateNonce;
  }, [locateNonce, isActive]);
  const colRef = React.useRef(collapseNonce);
  React.useEffect(() => {
    if (isActive && collapseNonce !== colRef.current) setPending("collapse");
    colRef.current = collapseNonce;
  }, [collapseNonce, isActive]);

  // 待执行动作：等本课视频加载好再算分组路径，精确到小节地收起/定位。
  React.useEffect(() => {
    if (!pending || !isActive || videos.length === 0) return;
    const live = videos.filter((v) => v.kind === "live");
    const vod = videos.filter((v) => v.kind !== "live");
    const { groups: gp } = buildTree(vod);
    const lg = buildLiveGroups(live);
    const path =
      activeVideoId != null
        ? pathToVideo(gp, activeVideoId) ?? pathToVideo(lg, activeVideoId)
        : null;
    if (pending === "collapse") {
      // 收起：除在看小节的整条祖先链外，全部组都收起。
      const keep = new Set(path ?? []);
      const all = [...allGroupKeys(gp), ...allGroupKeys(lg)];
      setCollapsedGroups(new Set(all.filter((k) => !keep.has(k))));
    } else if (path?.length) {
      // 定位：确保通往在看小节的整条链都展开。
      setCollapsedGroups((s) => {
        const n = new Set(s);
        path.forEach((k) => n.delete(k));
        return n;
      });
    }
    // 组展开是 ~300ms 动画：滚两次（先即时反馈，再在动画落地后定位）。
    const scroll = () =>
      (activeRowRef.current ?? selfRef.current)?.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(scroll, 80);
    window.setTimeout(scroll, 360);
    setPending(null);
  }, [pending, isActive, videos, activeVideoId]);

  const playable = videos.filter((v) => !v.locked);
  const watched = playable.filter((v) => {
    const e = progress[`${course.id}:${v.videoId}`];
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
    const e = progress[`${course.id}:${v.videoId}`];
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
      rowRef={v.videoId === activeVideoId ? activeRowRef : undefined}
    />
  );

  return (
    <Box ref={selfRef} sx={{ mb: 0.5, scrollMarginTop: 8 }}>
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
              {groups.map((g) => (
                <GroupEl
                  key={g.key}
                  node={g}
                  render={renderRow}
                  collapsed={collapsedGroups}
                  onToggle={toggleGroup}
                  forceOpen={!!query}
                />
              ))}
              {/* 直播回放板块 */}
              {hasLive && (
                <>
                  <BoardLabel
                    icon={<LiveTvRoundedIcon sx={{ fontSize: 16, color: "text.secondary" }} />}
                    label="直播回放"
                    count={liveVideos.length}
                  />
                  {liveGroups.map((g) => (
                    <GroupEl
                      key={g.key}
                      node={g}
                      render={renderRow}
                      collapsed={collapsedGroups}
                      onToggle={toggleGroup}
                      forceOpen={!!query}
                    />
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
