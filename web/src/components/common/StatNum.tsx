"use client";
import * as React from "react";
import { Box, Typography } from "@mui/material";

/**
 * 统计概览里的「大数字 + 小标签」。
 * 数字走 h4 variant（1.4rem / 字重 700），辅以等宽数字与紧凑行高；标签用 caption。
 * 原各区内联实现字重为 800，统一收敛到主题上限 700。
 */
export function StatNum({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5 }}>
      <Typography variant="h4" component="span" sx={{ fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}
