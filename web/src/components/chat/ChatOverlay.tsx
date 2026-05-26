"use client";
import * as React from "react";
import { Box, Dialog } from "@mui/material";
import ChatBody from "./ChatBody";

// 独立聊天在 /chats 页内全屏展开(不跳转)。复用 ChatBody;隐藏切换器/分屏按钮 — 独立聊天没绑讲,这两个无意义。
// z-index 抬到 ArtPlayer 网页全屏(9999)之上,与 MarkdownReader 同款形态。
export default function ChatOverlay({
  open,
  chatId,
  onClose,
}: {
  open: boolean;
  chatId: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen
      slotProps={{ root: { sx: { zIndex: 99000 } } }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%", maxWidth: 760, width: "100%", mx: "auto" }}>
        <ChatBody
          chatId={chatId}
          onChangeChatId={(id) => {
            // 用户在独立聊天里点了「新建独立对话」之类动作时 — 切到新 chat。
            if (!id) onClose();
          }}
          onClose={onClose}
          showSwitcher={false}
          showSplitToggle={false}
        />
      </Box>
    </Dialog>
  );
}
