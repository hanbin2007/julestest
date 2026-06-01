"use client";
import type { ReactNode } from "react";
import { Box } from "@mui/material";
import AppTopBar from "@/components/common/AppTopBar";
import { SettingsDataProvider } from "@/components/settings/SettingsDataContext";
import SettingsChrome from "@/components/settings/SettingsChrome";
import SettingsNav from "@/components/settings/SettingsNav";

// /settings/* 共享骨架。layout 在子路由间不重渲染 → SettingsDataProvider 的唯一轮询不重启。
// 固定外壳：height:100dvh + minHeight:0，内容区内部滚动（body 不滚，见全站约定）。
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <SettingsDataProvider>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100dvh", minHeight: 0 }}>
        <AppTopBar />
        <SettingsChrome />
        <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
          <SettingsNav />
          <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{children}</Box>
        </Box>
      </Box>
    </SettingsDataProvider>
  );
}
