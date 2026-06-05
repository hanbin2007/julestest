"use client";
import { Box } from "@mui/material";
import type { ReactNode } from "react";

// 统一的内容容器:固定 maxWidth + 居中 + 统一内边距。让无侧栏的内容页(笔记/对话/设置)
// 共用同一条"内容脊"——宽度一致、不再各自 920/1100/1240,切页时内容几何稳定。
export function PageContainer({
  children,
  maxWidth = 1200,
}: {
  children: ReactNode;
  maxWidth?: number;
}) {
  return (
    <Box data-page-container sx={{ width: "100%", maxWidth, mx: "auto", p: { xs: 2, md: 3 } }}>
      {children}
    </Box>
  );
}
