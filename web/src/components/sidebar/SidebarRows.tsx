"use client";
import * as React from "react";
import { Box, CircularProgress, Collapse, ListItemButton, Typography } from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import { fmtDur } from "@/lib/media";
import type { Video } from "@/types/api";
import type { GroupNode } from "./sidebarTree";
import { DUR, EASE, smoothColors } from "@/theme/motion";

// 板块标题（视频 / 直播回放）。
export function BoardLabel({
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

// 单讲观看进度环：≥90% 打勾，≤1% 空白，其余画进度圈。
export function Ring({ ratio, color }: { ratio: number; color: string }) {
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

export function VideoRow({
  v,
  active,
  onSelect,
  color,
  ratio,
  rowRef,
}: {
  v: Video;
  active: boolean;
  onSelect: () => void;
  color: string;
  ratio: number;
  rowRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <ListItemButton
      ref={rowRef}
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
        // 左侧选中指示：圆角药丸,竖直内缩避开行圆角——不再被圆角裁出怪弧。
        // 指示条始终生成(仅 opacity 0/1 切换),否则伪元素「不存在→存在」无法过渡仍会瞬现。
        "&::before": {
          content: '""',
          position: "absolute",
          left: 0,
          top: "20%",
          bottom: "20%",
          width: "3px",
          borderRadius: "999px",
          backgroundColor: color,
          opacity: 0,
          transition: (t) => smoothColors(t, ["opacity"]),
        },
        "&.Mui-selected::before": {
          opacity: 1,
        },
      }}
    >
      {v.locked ? (
        <LockOutlinedIcon sx={{ fontSize: 16, color: "text.disabled" }} />
      ) : v.kind === "live" ? (
        <ReplayRoundedIcon sx={{ fontSize: 17, transition: (t) => smoothColors(t, ["color"]), color: active ? color : "text.secondary" }} />
      ) : (
        <PlayArrowRoundedIcon sx={{ fontSize: 18, transition: (t) => smoothColors(t, ["color"]), color: active ? color : "text.secondary" }} />
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

// 一个分组节点（递归渲染子组 + 本组视频）。默认展开，collapsed 仅记被收起的 key。
export function GroupEl({
  node,
  render,
  collapsed,
  onToggle,
  forceOpen,
}: {
  node: GroupNode;
  render: (v: Video) => React.ReactNode;
  collapsed: Set<string>; // 被收起的组 key（默认全开，故只记收起的）
  onToggle: (key: string) => void;
  forceOpen: boolean; // 搜索时强制全开，盖过收起状态
}) {
  const open = forceOpen || !collapsed.has(node.key);
  return (
    <Box sx={{ ml: 0.5 }}>
      <ListItemButton onClick={() => onToggle(node.key)} sx={{ borderRadius: (t) => t.radius.sm, py: 0.5, gap: 0.5 }}>
        <ChevronRightIcon
          sx={{ fontSize: 16, transition: `transform ${DUR.base}ms ${EASE}`, transform: open ? "rotate(90deg)" : "none", color: "text.secondary" }}
        />
        <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary" }}>
          {node.name}
        </Typography>
      </ListItemButton>
      {/* 同 CourseItem：保持挂载以保住退出动画 */}
      <Collapse in={open}>
        <Box sx={{ pl: 1.5, ml: 1.5, borderLeft: (t) => `1px solid ${t.palette.divider}` }}>
          {node.kids.map((k) => (
            <GroupEl key={k.key} node={k} render={render} collapsed={collapsed} onToggle={onToggle} forceOpen={forceOpen} />
          ))}
          {node.vids.map(render)}
        </Box>
      </Collapse>
    </Box>
  );
}
