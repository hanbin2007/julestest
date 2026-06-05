"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppBar, Badge, Box, IconButton, Toolbar, Tooltip, Typography } from "@mui/material";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import NoteAltOutlinedIcon from "@mui/icons-material/NoteAltOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import { useColorScheme } from "@mui/material/styles";
import { useAnyChatStreaming } from "@/hooks/useChatStream";

function ThemeModeToggle() {
  const { mode, setMode } = useColorScheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return <IconButton disabled />;
  const dark = mode !== "light";
  return (
    <Tooltip title={dark ? "切换浅色" : "切换深色"}>
      <IconButton onClick={() => setMode(dark ? "light" : "dark")}>
        {dark ? <LightModeRoundedIcon /> : <DarkModeRoundedIcon />}
      </IconButton>
    </Tooltip>
  );
}

// 内容滚动时给顶栏加阴影"浮起"(Cloudreve 风)。各页滚动容器不同,用捕获阶段监听任意嵌套滚动源。
function useScrollElevated() {
  const [elevated, setElevated] = React.useState(false);
  React.useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | Document | null;
      const top = !t || t === document ? window.scrollY : (t as HTMLElement).scrollTop ?? 0;
      setElevated(top > 4);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, []);
  return elevated;
}

export default function AppTopBar({
  onMenu,
  menuTooltip,
  onCommand,
  context,
}: {
  onMenu?: () => void;
  // ☰ 按钮的悬停 / a11y 文案:桌面端「折叠 / 展开课程列表」、移动端「目录」。
  menuTooltip?: string;
  onCommand?: () => void;
  // 顶栏中段的实时上下文(面包屑):首页=当前课程/讲次,其它页=区域名。填补中段空洞、并解决与侧栏「我的课程」的双标题。
  context?: React.ReactNode;
}) {
  const pathname = usePathname();
  const onSettings = pathname?.startsWith("/settings");
  const onNotes = pathname?.startsWith("/notes");
  const onChats = pathname?.startsWith("/chats");
  const onHome = !onSettings && !onNotes && !onChats;
  // 全局活跃指示器:任一 chat 在后台跑 → /chats 图标右上角加 dot,点击进 /chats 看具体哪个。
  const anyStreaming = useAnyChatStreaming();
  const elevated = useScrollElevated();
  return (
    <AppBar
      position="static"
      elevation={0}
      sx={{
        transition: "box-shadow .2s ease, background-color .2s ease",
        boxShadow: elevated ? 6 : "none",
        ...(elevated && { backgroundColor: "md3.surfaceContainer" }),
      }}
    >
      <Toolbar variant="dense" sx={{ gap: 1 }}>
        {onMenu && (
          <Tooltip title={menuTooltip ?? "目录"}>
            <IconButton edge="start" onClick={onMenu} aria-label={menuTooltip ?? "目录"}>
              <MenuRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
        {/* 返回键移到左侧(惯例);与 ☰ 互斥(☰ 仅首页、返回仅非首页) */}
        {!onHome && (
          <Tooltip title="返回播放">
            <IconButton edge={onMenu ? undefined : "start"} component={Link} href="/" aria-label="返回播放">
              <ArrowBackRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
        <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: "primary.main", boxShadow: (t) => `0 0 10px ${t.palette.primary.main}` }} />
        <Typography
          variant="subtitle1"
          component={Link}
          href="/"
          sx={{ fontWeight: 700, letterSpacing: 0.3, color: "inherit", textDecoration: "none", flexShrink: 0 }}
        >
          课程
        </Typography>
        {context && (
          <>
            <Typography variant="body2" sx={{ color: "text.disabled", mx: 0.5, flexShrink: 0 }}>
              ›
            </Typography>
            <Box
              sx={{ minWidth: 0, color: "text.secondary", fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {context}
            </Box>
          </>
        )}
        <Box sx={{ flex: 1, minWidth: 8 }} />
        {onCommand && (
          <Tooltip title="搜索 / 命令 (⌘K)">
            <IconButton onClick={onCommand}>
              <SearchRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
        <ThemeModeToggle />
        <Tooltip title={anyStreaming ? "对话(有进行中的)" : "对话"}>
          <IconButton component={Link} href="/chats" color={onChats ? "primary" : "default"}>
            <Badge
              variant="dot"
              color="primary"
              invisible={!anyStreaming}
              overlap="circular"
            >
              <ForumOutlinedIcon />
            </Badge>
          </IconButton>
        </Tooltip>
        <Tooltip title="笔记">
          <IconButton component={Link} href="/notes" color={onNotes ? "primary" : "default"}>
            <NoteAltOutlinedIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="设置">
          <IconButton component={Link} href="/settings" color={onSettings ? "primary" : "default"}>
            <SettingsRoundedIcon />
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
