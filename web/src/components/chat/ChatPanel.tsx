"use client";
import * as React from "react";
import { Box, Drawer } from "@mui/material";
import ChatBody, { type ChatPrefill } from "./ChatBody";
export type { ChatPrefill };

export const CHAT_WIDTH = 420;

// 薄壳:Drawer(关闭态展开)或固定右栏(split 分屏)。内容委托给 ChatBody;状态都按 chatId 走。
// 多聊天后台并行的关键:本组件 unmount(关面板)不卸载 ChatBody 里的流(流活在 chatStreams 模块单例,
// 与组件生命周期解耦)。再开面板时,ChatBody 重新挂上对同一个 chatId 的订阅,看到进行中的流。
export default function ChatPanel({
  open,
  onClose,
  chatId,
  onChangeChatId,
  getCurrentLesson,
  prefill,
  onConsumePrefill,
  split = false,
  onToggleSplit,
  onSaveNote,
  getVideoTime,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string | null;
  onChangeChatId: (id: string | null) => void;
  getCurrentLesson?: () => { productId: number; videoId: number } | null;
  prefill?: ChatPrefill | null;
  onConsumePrefill?: () => void;
  split?: boolean;
  onToggleSplit?: () => void;
  onSaveNote?: (text: string, videoT?: number) => void | Promise<void>;
  getVideoTime?: () => number;
}) {
  const body = (
    <ChatBody
      chatId={chatId}
      onChangeChatId={onChangeChatId}
      getCurrentLesson={getCurrentLesson}
      prefill={prefill}
      onConsumePrefill={onConsumePrefill}
      split={split}
      onToggleSplit={onToggleSplit}
      onSaveNote={onSaveNote}
      getVideoTime={getVideoTime}
      onClose={onClose}
      showSwitcher
      showSplitToggle
    />
  );

  // 分屏:右侧常驻列(与左边播放器并排);Drawer 模式覆盖式从右滑出。
  if (split) {
    return (
      <Box
        sx={{
          position: "fixed",
          top: 0,
          right: 0,
          width: CHAT_WIDTH,
          height: "100dvh",
          zIndex: 1300,
          bgcolor: "background.paper",
          borderLeft: (t) => `1px solid ${t.palette.divider}`,
          boxShadow: 8,
        }}
      >
        {body}
      </Box>
    );
  }

  return (
    <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: 440, maxWidth: "96vw" } }}>
      {body}
    </Drawer>
  );
}
