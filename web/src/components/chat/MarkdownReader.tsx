"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import { Box, Dialog, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import BookmarkAddRoundedIcon from "@mui/icons-material/BookmarkAddRounded";

// 复用对话气泡里的 Markdown 渲染（懒加载 katex），全屏阅读长回答 / 笔记。
const Markdown = dynamic(() => import("./Markdown").then((m) => m.Markdown), {
  ssr: false,
  loading: () => null,
});

// 全屏阅读器：把一段 Markdown（回答 / 笔记）铺满屏幕、舒适排版地读。
// z-index 抬到 ArtPlayer 网页全屏(9999)之上、Toast(100000)之下，全屏/分屏下也盖得住。
export default function MarkdownReader({
  open,
  onClose,
  content,
  title,
  onSaveNote,
}: {
  open: boolean;
  onClose: () => void;
  content: string;
  title?: string;
  onSaveNote?: () => void; // 提供则显示「存为笔记」，存完不自动关
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen
      slotProps={{ root: { sx: { zIndex: 99000 } } }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <Stack
          direction="row"
          sx={{ alignItems: "center", gap: 1, px: 2, py: 1.5, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
        >
          <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 600 }} noWrap>
            {title || "阅读"}
          </Typography>
          {onSaveNote && (
            <Tooltip title="存为笔记">
              <IconButton size="small" onClick={onSaveNote} aria-label="save to notes">
                <BookmarkAddRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="关闭">
            <IconButton size="small" onClick={onClose} aria-label="close reader">
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        <Box sx={{ flex: 1, overflowY: "auto", py: { xs: 3, md: 5 } }}>
          <Box sx={{ maxWidth: 760, mx: "auto", px: { xs: 2.5, md: 3 }, fontSize: "1.02rem" }}>
            <Markdown>{content}</Markdown>
          </Box>
        </Box>
      </Box>
    </Dialog>
  );
}
