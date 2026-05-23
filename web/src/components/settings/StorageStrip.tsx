"use client";
import * as React from "react";
import { Box, Tooltip, Typography } from "@mui/material";
import { fmtBytes } from "@/lib/media";

// 存储条：缓冲已用/上限 的堆叠横条 + 缩略图占用。宽度过渡动画，避免饼图每秒重排闪烁。
function StorageStrip({
  bufferBytes,
  bufferLimit,
  thumbBytes,
}: {
  bufferBytes: number;
  bufferLimit: number;
  thumbBytes: number;
}) {
  const limit = bufferLimit || 1;
  const usedPct = Math.min(100, (bufferBytes / limit) * 100);
  const near = usedPct >= 90;
  return (
    // height 100% + justify center mirrors HealthBar so both short components
    // sit vertically centered rather than leaving a void when TaskQueuePanel is taller.
    <Box
      sx={{
        height: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 1,
      }}
    >
      {/* Row 1: section label + detail labels that wrap gracefully when narrow */}
      <Box
        sx={{
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 1,
          rowGap: 0.5,
        }}
      >
        <Typography variant="subtitle2">存储</Typography>
        {/* ml: "auto" pushes the detail text right on wide containers;
            flexWrap lets it drop to a new line rather than overflow on narrow ones. */}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ ml: "auto", fontVariantNumeric: "tabular-nums" }}
        >
          缓冲 {fmtBytes(bufferBytes)} / {fmtBytes(bufferLimit)}　·　缩略图 {fmtBytes(thumbBytes)}
        </Typography>
      </Box>

      {/* Row 2: progress bar with full tooltip */}
      <Tooltip title={`缓冲缓存：${fmtBytes(bufferBytes)} / 上限 ${fmtBytes(bufferLimit)}（${usedPct.toFixed(1)}%）`}>
        <Box
          sx={{
            position: "relative",
            height: 12,
            borderRadius: "999px",
            overflow: "hidden",
            bgcolor: (t) => t.palette.action.hover,
          }}
        >
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              width: `${usedPct}%`,
              borderRadius: "999px",
              transition: "width .4s ease",
              bgcolor: (t) => (near ? t.palette.warning.main : t.palette.primary.main),
            }}
          />
        </Box>
      </Tooltip>

      {/* Row 3: percent readout beneath the bar — gives the column a third visual row
          so it balances against the taller TaskQueuePanel. Warning color at ≥90%. */}
      <Typography
        variant="caption"
        color={near ? "warning.main" : "text.disabled"}
        sx={{ fontVariantNumeric: "tabular-nums" }}
      >
        已使用 {usedPct.toFixed(0)}%
      </Typography>
    </Box>
  );
}

export default React.memo(StorageStrip);
