"use client";
import * as React from "react";
import { Box, Chip, Tooltip, Typography } from "@mui/material";
import CloudDoneRoundedIcon from "@mui/icons-material/CloudDoneRounded";
import CloudOffRoundedIcon from "@mui/icons-material/CloudOffRounded";
import MovieFilterRoundedIcon from "@mui/icons-material/MovieFilterRounded";
import type { CoursesStatus } from "@/types/api";

// 顶部健康条：网关在线 / 数据新鲜度 / ffmpeg。陈旧时整体变暗并显示最近更新时间。
function HealthBar({ health }: { health: CoursesStatus["health"] | undefined }) {
  const online = !!health?.gatewayOnline;
  const stale = !!health?.stale;
  const ffmpeg = !!health?.ffmpeg;
  const t = health ? new Date(health.updatedAt) : null;
  const hhmmss = t
    ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`
    : "—";
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", opacity: stale ? 0.7 : 1 }}>
      <Chip
        size="small"
        icon={online ? <CloudDoneRoundedIcon /> : <CloudOffRoundedIcon />}
        color={online ? "success" : "error"}
        variant={online ? "filled" : "outlined"}
        label={online ? "网关在线" : "网关离线"}
      />
      <Tooltip title={`最近更新 ${hhmmss}`}>
        <Chip
          size="small"
          variant="outlined"
          color={stale ? "warning" : "default"}
          label={stale ? "数据陈旧" : "实时"}
          sx={{ fontVariantNumeric: "tabular-nums" }}
        />
      </Tooltip>
      <Chip
        size="small"
        variant="outlined"
        icon={<MovieFilterRoundedIcon />}
        color={ffmpeg ? "default" : "warning"}
        label={ffmpeg ? "ffmpeg 可用" : "ffmpeg 未装"}
      />
      <Typography variant="caption" color="text.disabled" sx={{ ml: "auto", fontVariantNumeric: "tabular-nums" }}>
        {hhmmss}
      </Typography>
    </Box>
  );
}

export default React.memo(HealthBar);
