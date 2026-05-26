"use client";
import * as React from "react";
import { Box } from "@mui/material";
import AppTopBar from "@/components/common/AppTopBar";
import ChatsView from "@/components/chat/ChatsView";

// 镜像 /notes/page.tsx 的固定 shell:body 不滚,这里 100dvh + minHeight:0 让内部 ChatsView 滚。
// ChatsView 用 useSearchParams 消化 ?open=<id> 深链 → 必须包 Suspense(Next 15 要求)。
export default function ChatsPage() {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <AppTopBar />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <React.Suspense fallback={null}>
          <ChatsView />
        </React.Suspense>
      </Box>
    </Box>
  );
}
