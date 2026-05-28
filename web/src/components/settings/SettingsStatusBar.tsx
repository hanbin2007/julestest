"use client";
import * as React from "react";
import { Box, Card, Chip, Tooltip, Typography } from "@mui/material";
import CloudDoneRoundedIcon from "@mui/icons-material/CloudDoneRounded";
import CloudOffRoundedIcon from "@mui/icons-material/CloudOffRounded";
import FolderOffRoundedIcon from "@mui/icons-material/FolderOffRounded";
import MovieFilterRoundedIcon from "@mui/icons-material/MovieFilterRounded";
import ListAltRoundedIcon from "@mui/icons-material/ListAltRounded";
import { SparkLineChart } from "@mui/x-charts/SparkLineChart";
import { fmtBytes } from "@/lib/media";
import type { CoursesStatus } from "@/types/api";

// 顶部贴顶状态条：被动状态（网关/ffmpeg/缓存目录）+ 下载速率 + 「N 个任务进行中」徽标。
// 徽标点击打开全屏任务面板。完整任务管理在下方「任务队列」区，不再挤在贴顶卡里。
function SettingsStatusBar({
  health,
  bps,
  series,
  working,
  onOpenTasks,
}: {
  health: CoursesStatus["health"] | undefined;
  bps: number;
  series: number[];
  working: number;
  onOpenTasks: () => void;
}) {
  const online = !!health?.gatewayOnline;
  const ffmpeg = !!health?.ffmpeg;
  const cacheDir = health?.cacheDir ?? "";
  const cacheDirOk = health?.cacheDirOk ?? true;
  const dirMissing = online && !!cacheDir && !cacheDirOk;
  return (
    <Card
      sx={{
        p: 1,
        mb: 2,
        position: { md: "sticky" },
        top: 8,
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 1,
        rowGap: 0.5,
      }}
    >
      <Chip
        size="small"
        icon={online ? <CloudDoneRoundedIcon /> : <CloudOffRoundedIcon />}
        color={online ? "success" : "error"}
        variant="outlined"
        label={online ? "网关在线" : "网关离线"}
      />
      {!ffmpeg && (
        <Chip size="small" variant="outlined" color="warning" icon={<MovieFilterRoundedIcon />} label="ffmpeg 未装" />
      )}
      {dirMissing && (
        <Tooltip title={`缓存目录丢失：${cacheDir}`}>
          <Chip size="small" variant="filled" color="error" icon={<FolderOffRoundedIcon />} label="缓存目录丢失" />
        </Tooltip>
      )}
      <Box sx={{ ml: { md: "auto" }, display: "flex", alignItems: "center", gap: 1 }}>
        <Tooltip title="下载速率">
          <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {fmtBytes(bps)}/s
          </Typography>
        </Tooltip>
        {series.length > 1 && (
          <Box sx={{ width: 72, height: 22 }} role="img" aria-label={`下载速率 ${fmtBytes(bps)} 每秒`}>
            <SparkLineChart data={series} height={22} showHighlight={false} area />
          </Box>
        )}
        <Tooltip title="查看全部任务">
          <Chip
            size="small"
            color={working > 0 ? "primary" : "default"}
            variant={working > 0 ? "filled" : "outlined"}
            icon={<ListAltRoundedIcon />}
            label={working > 0 ? `${working} 个任务进行中` : "任务队列"}
            onClick={onOpenTasks}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>
      </Box>
    </Card>
  );
}

export default React.memo(SettingsStatusBar);
