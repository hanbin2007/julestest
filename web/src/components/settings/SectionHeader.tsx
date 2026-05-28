"use client";
import * as React from "react";
import { Box, Typography } from "@mui/material";

// 设置页 IA 分区标题：系统状态 / 缓存管理 / 其他设置。带可选副标题。
function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <Box sx={{ mt: 3, mb: 1, display: "flex", alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
      <Typography variant="overline" sx={{ fontWeight: 700, letterSpacing: 0.6, color: "text.secondary" }}>
        {title}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.disabled">
          {hint}
        </Typography>
      )}
    </Box>
  );
}

export default React.memo(SectionHeader);
