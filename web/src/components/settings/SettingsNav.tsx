"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, Chip } from "@mui/material";
import GridViewOutlinedIcon from "@mui/icons-material/GridViewOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import ChecklistRoundedIcon from "@mui/icons-material/ChecklistRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import { useSettingsData } from "./SettingsDataContext";

// 左侧子导航：4 个真实子路由。MD3 图标 + active pill；缓存管理显示已缓存讲数，任务显示失败数(标红)。
const ITEMS = [
  { href: "/settings", label: "概览", Icon: GridViewOutlinedIcon, exact: true as const },
  { href: "/settings/cache", label: "缓存管理", Icon: StorageOutlinedIcon },
  { href: "/settings/tasks", label: "任务 · 历史", Icon: ChecklistRoundedIcon },
  { href: "/settings/system", label: "系统配置", Icon: TuneRoundedIcon },
];

export default function SettingsNav() {
  const pathname = usePathname();
  const { data } = useSettingsData();
  const failed = data?.failedTasks.length ?? 0;
  const cached = data?.totals.cachedLectures ?? 0;
  return (
    <Box
      component="nav"
      sx={{
        width: 234,
        flexShrink: 0,
        p: 1.5,
        borderRight: (t) => `1px solid ${t.palette.divider}`,
        bgcolor: "md3.surfaceContainerLow",
        overflowY: "auto",
      }}
    >
      {ITEMS.map(({ href, label, Icon, exact }) => {
        const active = exact ? pathname === href : !!pathname?.startsWith(href);
        const isTasks = href === "/settings/tasks";
        const isCache = href === "/settings/cache";
        const badgeWarn = isTasks && failed > 0;
        const badgeVal = isTasks ? failed : isCache ? cached : 0;
        return (
          <Box
            key={href}
            component={Link}
            href={href}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.25,
              px: 1.75,
              py: 1.1,
              mb: 0.25,
              borderRadius: (t) => t.radius.full,
              whiteSpace: "nowrap",
              fontWeight: 600,
              fontSize: 13.5,
              color: active ? "md3.onPrimaryContainer" : "text.secondary",
              bgcolor: active ? "md3.primaryContainer" : "transparent",
              "&:hover": { bgcolor: active ? "md3.primaryContainer" : "action.hover" },
            }}
          >
            <Icon sx={{ fontSize: 18, flexShrink: 0 }} />
            <Box sx={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</Box>
            {badgeVal > 0 && (
              <Chip
                size="small"
                label={badgeWarn ? `${failed} 失败` : badgeVal}
                color={badgeWarn ? "error" : "default"}
                variant={badgeWarn ? "outlined" : "filled"}
                sx={{ height: 20, fontSize: 11 }}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}
