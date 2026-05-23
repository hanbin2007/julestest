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
    <Box>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, mb: 0.75 }}>
        <Typography variant="subtitle2">存储</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ ml: "auto", fontVariantNumeric: "tabular-nums" }}>
          缓冲 {fmtBytes(bufferBytes)} / {fmtBytes(bufferLimit)}　·　缩略图 {fmtBytes(thumbBytes)}
        </Typography>
      </Box>
      <Tooltip title={`缓冲缓存：${fmtBytes(bufferBytes)} / 上限 ${fmtBytes(bufferLimit)}（${usedPct.toFixed(1)}%）`}>
        <Box
          sx={{
            position: "relative",
            height: 12,
            borderRadius: 6,
            overflow: "hidden",
            bgcolor: (t) => t.palette.action.hover,
          }}
        >
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              width: `${usedPct}%`,
              borderRadius: 6,
              transition: "width .4s ease",
              bgcolor: (t) => (near ? t.palette.warning.main : t.palette.primary.main),
            }}
          />
        </Box>
      </Tooltip>
    </Box>
  );
}

export default React.memo(StorageStrip);
