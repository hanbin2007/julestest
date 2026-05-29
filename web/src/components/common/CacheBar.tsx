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
//  3) 范围未知但已缓存 → 静态淡填充 + "已缓存（部分）"；cached===0 → "未缓存"。绝不显示「总数未知」。
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
  // 磁盘真相(cached)可能短暂 > seg_urls 长度(total)，如清晰度切换后磁盘多出几片：夹紧到
  // total，避免出现 146/145 段、101% 这类越界显示。
  const knownTotal = eff.total != null;
  const cachedShown = knownTotal ? Math.min(eff.cached, eff.total as number) : eff.cached;
  const pct = eff.total ? Math.min(100, Math.round((cachedShown / eff.total) * 100)) : 0;

  // total 现由 Plan 1 收敛为可信值；只有真正没有有序分片列表(buckets 也无)时 total 才会缺失。
  // 三态：已知总数 → "X/Y 段"；cached>0 但范围未知 → "已缓存（部分）"；cached===0 → "未缓存"。
  const partialUnknown = !knownTotal && eff.cached > 0;
  const label = knownTotal
    ? `${cachedShown}/${eff.total} 段`
    : partialUnknown
      ? "已缓存（部分）"
      : "未缓存";
  const tip = error
    ? "缓冲失败"
    : knownTotal
      ? `已缓存 ${cachedShown}/${eff.total} 段（${pct}%）${working ? " · 缓冲中" : ""}`
      : partialUnknown
        ? `已缓存 ${eff.cached} 段（范围未知，确切总数待补片时确认）`
        : "尚未缓存";

  const track = (t: import("@mui/material/styles").Theme) =>
    error ? alpha(t.palette.error.main, 0.18) : t.palette.action.hover;
  const fill = (t: import("@mui/material/styles").Theme) =>
    error ? t.palette.error.main : t.palette.success.main;

  const bar = (
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
        // 模式 2：比例填充（已知总数）；范围未知但已缓存 → 静态 30% 淡填充（不误导为「全满」）。
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            width: knownTotal ? `${pct}%` : partialUnknown ? "30%" : "0%",
            bgcolor: fill,
            opacity: knownTotal ? 1 : 0.5,
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

  const content = showLabel ? (
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
