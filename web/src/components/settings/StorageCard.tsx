"use client";
import { Box, Card, Chip, LinearProgress, Typography } from "@mui/material";
import { fmtBytes } from "@/lib/media";
import { StatNum } from "@/components/common/StatNum";
import { useSettingsData } from "./SettingsDataContext";

// 概览存储卡（方案 3）：一个标题总量 + 明细 chip（播放段/缩略图持久/源段临时）
// + 进度条只对「播放缓存」那个唯一硬上限 + 计数（课程/已缓存讲/缩略图就绪）。实心填充，无渐变。
export default function StorageCard() {
  const { data } = useSettingsData();
  if (!data) return null;
  const t = data.totals;
  const total = t.bufferBytes + t.thumbJpegBytes + t.thumbBytes; // 播放段 + 持久JPEG + 临时源段
  const pct = t.bufferLimit ? Math.min(100, (t.bufferBytes / t.bufferLimit) * 100) : 0;
  const near = pct >= 90;
  return (
    <Card sx={{ p: 2 }}>
      <Box sx={{ display: "flex", alignItems: "flex-end", gap: 2 }}>
        <Typography variant="h2" component="div" sx={{ lineHeight: 1, color: "primary.main", letterSpacing: "-1px", fontVariantNumeric: "tabular-nums" }}>
          {fmtBytes(total)}
        </Typography>
        <Typography variant="caption" color="text.disabled" sx={{ pb: 0.5 }}>本机缓存总占用</Typography>
      </Box>
      <LinearProgress variant="determinate" value={pct} color={near ? "warning" : "primary"} sx={{ my: 1.5, height: 12 }} />
      <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
        播放缓存 {fmtBytes(t.bufferBytes)} / {fmtBytes(t.bufferLimit)}（唯一硬上限）· {pct.toFixed(0)}%
      </Typography>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 1.5 }}>
        <Chip size="small" label={`播放段 ${fmtBytes(t.bufferBytes)}`} sx={{ bgcolor: "md3.primaryContainer", color: "md3.onPrimaryContainer" }} />
        <Chip size="small" color="success" variant="outlined" label={`缩略图 ${fmtBytes(t.thumbJpegBytes)} · 持久`} />
        <Chip size="small" color="info" variant="outlined" label={`源段 ${fmtBytes(t.thumbBytes)} · 临时`} />
      </Box>
      <Box sx={{ display: "flex", gap: 3, mt: 2, pt: 2, borderTop: (th) => `1px solid ${th.palette.divider}` }}>
        <StatNum value={data.courses.length} label="课程" />
        <StatNum value={t.cachedLectures} label="已缓存讲次" />
        <StatNum value={t.thumbsReady} label="缩略图就绪" />
      </Box>
    </Card>
  );
}
