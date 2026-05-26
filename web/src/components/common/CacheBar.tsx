"use client";
import * as React from "react";
import { Box, Tooltip, Typography } from "@mui/material";
import { alpha, keyframes } from "@mui/material/styles";
import type { SegmentMap } from "@/types/api";

// 缓冲中：一道高光从左扫到右，提示"正在补片"。
const sweep = keyframes`
  0% { transform: translateX(-120%); }
  100% { transform: translateX(120%); }
`;

export interface CacheBarProps {
  /** 来自 /api/buffer/segments 的逐片 bitmap；优先用它（含 total/cached/buckets/playhead）。 */
  map?: SegmentMap | null;
  /** 没拉到 bitmap 时的兜底计数（如设置页平铺视图，只用 courses/status 的计数）。 */
  cached?: number;
  total?: number | null;
  /** 缓冲/缩略图状态："working" 显示扫光、"error" 红色。来自 perVid.state。 */
  state?: string | null;
  height?: number;
  /** 条右侧附 "已缓存/总数" 文字。 */
  showLabel?: boolean;
  /** 显示预缓存播放头竖线（看课页用）。 */
  showPlayhead?: boolean;
}

// 单讲缓存条："已缓存的地方"用绿色标出。三种保真度：
//  1) 有 buckets → 逐片分布图（哪些位置缓存了一目了然，非连续也能看出）
//  2) 无 buckets 但已知总数 → 比例填充条（从左填到 cached/total）
//  3) 连总数都未知（如重启后只看过一次没复看）→ "N 段（总数未知）" 文字，不画条
function CacheBar({
  map,
  cached,
  total,
  state,
  height = 8,
  showLabel = false,
  showPlayhead = false,
}: CacheBarProps) {
  const eff = {
    total: map?.total ?? total ?? null,
    cached: map?.cached ?? cached ?? 0,
    buckets: map?.buckets ?? null,
    playhead: map?.playhead ?? null,
  };
  const working = state === "working";
  const error = state === "error";
  const pct = eff.total ? Math.round((eff.cached / eff.total) * 100) : 0;

  const label =
    eff.total != null
      ? `${eff.cached}/${eff.total} 段`
      : eff.cached > 0
        ? `${eff.cached} 段`
        : "—";
  const tip = error
    ? "缓冲失败"
    : eff.total != null
      ? `已缓存 ${eff.cached}/${eff.total} 段（${pct}%）${working ? " · 缓冲中" : ""}`
      : eff.cached > 0
        ? `已缓存 ${eff.cached} 段（总数未知）`
        : "尚未缓存";

  // 模式 3：总数未知且无 bitmap —— 不画误导性的条，只给文字。失败时仍画红条以保留信号。
  const unknownTotal = !eff.buckets && eff.total == null && !error;

  const track = (t: import("@mui/material/styles").Theme) =>
    error ? alpha(t.palette.error.main, 0.18) : t.palette.action.hover;
  const fill = (t: import("@mui/material/styles").Theme) =>
    error ? t.palette.error.main : t.palette.success.main;

  const bar = unknownTotal ? (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{
        fontVariantNumeric: "tabular-nums",
        // 窄容器(课程详情抽屉)里挤不下时截断；完整说明走 Tooltip。
        display: "block",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {eff.cached > 0 ? `${eff.cached} 段（总数未知）` : "—"}
    </Typography>
  ) : (
    <Box
      sx={{
        position: "relative",
        height,
        borderRadius: height / 2,
        overflow: "hidden",
        bgcolor: track,
        width: "100%",
        display: "flex",
      }}
    >
      {eff.buckets ? (
        // 模式 1：逐片分布。每格按该区间缓存占比上色（含部分缓存的浅色）。
        eff.buckets.map((cov, i) => (
          <Box
            key={i}
            sx={{
              flex: 1,
              minWidth: 0,
              bgcolor: (t) => (cov > 0 ? alpha(fill(t), 0.4 + 0.6 * Math.min(cov, 1)) : "transparent"),
              transition: "background-color .3s ease",
            }}
          />
        ))
      ) : (
        // 模式 2：比例填充。
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            width: `${pct}%`,
            bgcolor: fill,
            borderRadius: height / 2,
            transition: "width .4s ease",
          }}
        />
      )}

      {/* 预缓存播放头：看课页显示自动缓存正以哪里为中心扩散。 */}
      {showPlayhead && eff.playhead != null && (
        <Box
          sx={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${Math.min(100, Math.max(0, eff.playhead * 100))}%`,
            width: 2,
            transform: "translateX(-1px)",
            bgcolor: "primary.main",
            boxShadow: (t) => `0 0 4px ${t.palette.primary.main}`,
          }}
        />
      )}

      {/* 缓冲中：扫光提示在补片。 */}
      {working && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            background: (t) =>
              `linear-gradient(90deg, transparent, ${alpha(t.palette.common.white, 0.45)}, transparent)`,
            animation: `${sweep} 1.3s ease-in-out infinite`,
          }}
        />
      )}
    </Box>
  );

  const content =
    showLabel && !unknownTotal ? (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, width: "100%" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>{bar}</Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
        >
          {label}
        </Typography>
      </Box>
    ) : (
      bar
    );

  return (
    <Tooltip title={tip} arrow>
      <Box sx={{ width: "100%" }}>{content}</Box>
    </Tooltip>
  );
}

export default React.memo(CacheBar);
