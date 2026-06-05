"use client";
import { Box, Card, Typography } from "@mui/material";
import { fmtBytes } from "@/lib/media";
import { useSettingsData } from "@/components/settings/SettingsDataContext";
import SectionHeader from "@/components/settings/SectionHeader";
import CacheDirCard from "@/components/settings/CacheDirCard";
import AssistantCard from "@/components/settings/AssistantCard";

// 系统配置：低频设置。缓存目录 + 播放缓存上限(只读) + AI 助教。
export default function SystemPage() {
  const { data, refresh } = useSettingsData();
  const h = data?.health;
  const limit = data?.totals.bufferLimit ?? 0;
  return (
    <Box sx={{ p: 3, maxWidth: 760, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box>
        <Typography variant="h6">系统配置</Typography>
        <Typography variant="caption" color="text.disabled">低频设置：缓存位置、容量上限与 AI 助教。</Typography>
      </Box>

      <Box>
        <SectionHeader title="存储与目录" />
        <CacheDirCard cacheDir={h?.cacheDir ?? ""} cacheDirOk={h?.cacheDirOk ?? true} onSaved={refresh} />
        <Card sx={{ p: 2, mt: 1.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 1, display: "flex", alignItems: "center", gap: 1 }}>
            播放缓存上限
            <Box
              component="span"
              sx={{
                fontSize: (t) => t.typography.overline.fontSize,
                fontWeight: 700,
                letterSpacing: 0.4,
                lineHeight: 1.6,
                color: "text.disabled",
                border: (t) => `1px solid ${t.palette.divider}`,
                borderRadius: (t) => t.radius.full,
                px: 1,
                py: 0.5,
              }}
            >
              网关配置 · 只读
            </Box>
          </Typography>
          <Box
            sx={{
              display: "inline-flex",
              alignItems: "center",
              px: 2,
              py: 1,
              borderRadius: (t) => t.radius.md,
              border: (t) => `1px dashed ${t.palette.divider}`,
              bgcolor: "md3.surfaceContainer",
              fontVariantNumeric: "tabular-nums",
              fontWeight: 600,
            }}
          >
            {fmtBytes(limit)}
          </Box>
          <Typography variant="caption" color="text.disabled" sx={{ display: "block", mt: 1 }}>
            由网关环境变量配置（YD_*_CACHE_BYTES）。
          </Typography>
        </Card>
      </Box>

      <Box>
        <SectionHeader title="AI 助教" />
        <AssistantCard />
      </Box>
    </Box>
  );
}
