"use client";
import * as React from "react";
import { Box, Button, Typography } from "@mui/material";
import SyncRoundedIcon from "@mui/icons-material/SyncRounded";
import StorageCard from "@/components/settings/StorageCard";
import HealthCard from "@/components/settings/HealthCard";
import ActivityCard from "@/components/settings/ActivityCard";
import SectionHeader from "@/components/settings/SectionHeader";
import { syncYoudaoProgress } from "@/lib/api";
import { useToast } from "@/components/common/Toast";

// 概览：落地仪表盘。AppTopBar + 状态条 + 左侧导航由 settings/layout.tsx 提供，此处只渲染内容。
export default function OverviewPage() {
  const toast = useToast();
  const [syncing, setSyncing] = React.useState(false);
  const sync = async () => {
    setSyncing(true);
    try {
      const r = await syncYoudaoProgress();
      toast(`同步完成：更新 ${r.videos.updated} 讲`, { severity: "success" });
    } catch {
      toast("同步失败", { severity: "error" });
    } finally {
      setSyncing(false);
    }
  };
  return (
    <Box sx={{ p: 3, maxWidth: 920, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box>
        <Typography variant="h6">概览</Typography>
        <Typography variant="caption" color="text.disabled">系统、存储与当前活动一眼掌握。</Typography>
      </Box>
      <Box>
        <SectionHeader title="存储占用" />
        <StorageCard />
      </Box>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1.4fr 1fr" }, gap: 2, alignItems: "stretch" }}>
        <Box sx={{ display: "flex", flexDirection: "column" }}>
          <SectionHeader title="系统健康" />
          <HealthCard />
        </Box>
        <Box sx={{ display: "flex", flexDirection: "column" }}>
          <SectionHeader title="当前活动" />
          <ActivityCard />
        </Box>
      </Box>
      <Box>
        <Button variant="outlined" startIcon={<SyncRoundedIcon />} disabled={syncing} onClick={sync}>
          同步有道进度
        </Button>
      </Box>
    </Box>
  );
}
