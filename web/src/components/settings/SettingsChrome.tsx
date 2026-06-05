"use client";
import * as React from "react";
import { Box, Switch, Tooltip, Typography } from "@mui/material";
import { fmtBytes } from "@/lib/media";
import { bgPause } from "@/lib/api";
import { markRecentAction } from "@/hooks/data";
import { useToast } from "@/components/common/Toast";
import { useSettingsData } from "./SettingsDataContext";

// 设置页常驻状态条：在任意子路由都能瞄一眼网关健康 + 存储一览，并随手暂停所有后台缓存。
// 数据来自 layout 持有的唯一轮询（useSettingsData）；不自起第二个轮询。
export default function SettingsChrome() {
  const { data, refresh } = useSettingsData();
  const h = data?.health;
  const t = data?.totals;
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  // 首轮轮询前 data 未到：状态点/ffmpeg/新鲜度渲染中性「检测中…」，不要从假值派生红色「网关离线」。
  const pending = !data;
  const online = !!h?.gatewayOnline;
  const paused = !!h?.bgPaused;

  const toggle = async () => {
    setBusy(true);
    try {
      await bgPause(!paused);
      markRecentAction(); // 让轮询回到 1s 快刷，开关结果立刻可见
      await refresh();
      toast(!paused ? "已暂停所有后台缓存" : "已恢复后台缓存");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2.25,
        px: 2.25,
        py: 1.25,
        flexWrap: "wrap",
        borderBottom: (th) => `1px solid ${th.palette.divider}`,
        bgcolor: "md3.surfaceContainerLow",
        fontSize: 13,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            bgcolor: pending ? "text.disabled" : online ? "success.main" : "error.main",
          }}
        />
        <Typography variant="caption" color="text.secondary">{pending ? "网关检测中…" : online ? "网关在线" : "网关离线"}</Typography>
      </Box>
      <Typography variant="caption" color="text.secondary">ffmpeg {pending ? "检测中…" : h?.ffmpeg ? "✓" : "✗"}</Typography>
      <Typography variant="caption" color="text.secondary">{pending ? "数据检测中…" : h?.stale ? "数据陈旧" : "数据实时"}</Typography>
      {t && (
        <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
          播放 {fmtBytes(t.bufferBytes)} / {fmtBytes(t.bufferLimit)}
        </Typography>
      )}
      <Box sx={{ ml: "auto", display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="caption" color="text.secondary">暂停所有后台</Typography>
        <Tooltip title={paused ? "恢复后台缓存" : "暂停 缓冲/缩略图/预缓存 三类后台"}>
          <span>
            <Switch size="small" checked={paused} disabled={busy || !online} onChange={toggle} />
          </span>
        </Tooltip>
      </Box>
    </Box>
  );
}
