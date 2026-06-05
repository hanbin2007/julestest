"use client";
import { Box } from "@mui/material";

/**
 * 统一的状态/分组圆点。各区原本散落 width/height=8|10 的内联 Box，统一收敛到此。
 */
export function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: "999px",
        bgcolor: color,
        flex: "0 0 auto",
      }}
    />
  );
}
