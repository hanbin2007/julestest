"use client";
import type { ReactNode } from "react";
import { Box, Card, Chip, Typography } from "@mui/material";
import { useSettingsData } from "./SettingsDataContext";

// 概览系统健康卡：键→pill 行。缓存目录显示截断路径 + 短状态 pill（与其它短 pill 一致）。
function Row({ k, children, last }: { k: string; children: ReactNode; last?: boolean }) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        py: 1.1,
        borderBottom: last ? "none" : (t) => `1px solid ${t.palette.divider}`,
      }}
    >
      <Typography variant="body2" color="text.secondary">{k}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

const CHIP_SX = { height: 22, fontSize: 11 } as const;

export default function HealthCard() {
  const { data } = useSettingsData();
  const h = data?.health;
  const dirOk = !!h?.cacheDirOk;
  const dir = h?.cacheDir || "—";
  const shortDir = dir.length > 28 ? "…" + dir.slice(-26) : dir;
  return (
    <Card sx={{ p: 2.25, height: "100%" }}>
      <Row k="网关">
        <Chip size="small" color={h?.gatewayOnline ? "success" : "error"} label={h?.gatewayOnline ? "在线" : "离线"} sx={CHIP_SX} />
      </Row>
      <Row k="ffmpeg">
        <Chip size="small" color={h?.ffmpeg ? "success" : "default"} label={h?.ffmpeg ? "可用" : "未装"} sx={CHIP_SX} />
      </Row>
      <Row k="缓存目录">
        <Typography
          variant="caption"
          color="text.secondary"
          title={dir}
          sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 190 }}
        >
          {shortDir}
        </Typography>
        <Chip size="small" color={dirOk ? "success" : "error"} label={dirOk ? "正常" : "丢失"} sx={CHIP_SX} />
      </Row>
      <Row k="数据新鲜度" last>
        <Chip size="small" color={h?.stale ? "default" : "success"} label={h?.stale ? "陈旧" : "实时 · 1s"} sx={CHIP_SX} />
      </Row>
    </Card>
  );
}
