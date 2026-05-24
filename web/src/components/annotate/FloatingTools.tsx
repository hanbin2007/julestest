"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
import { createPortal } from "react-dom";
import { Fab, Stack, Tooltip } from "@mui/material";
import GestureRoundedIcon from "@mui/icons-material/GestureRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import NoteAltOutlinedIcon from "@mui/icons-material/NoteAltOutlined";

// 播放器上常驻的「笔记 / 批注 / 问 AI」悬浮快捷钮。挂进 art.template.$player → 全屏也在。
// host 自身 pointer-events:none，只有按钮可点，避免挡住播放器点击（暂停/进度）。
export default function FloatingTools({
  art,
  visible,
  onNotes,
  onAnnotate,
  onChat,
}: {
  art: any;
  visible: boolean;
  onNotes: () => void;
  onAnnotate: () => void;
  onChat: () => void;
}) {
  const [host, setHost] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    const root: HTMLElement | undefined = art?.template?.$player;
    if (!root || !visible) return;
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;inset:0;z-index:25;pointer-events:none;";
    root.appendChild(el);
    setHost(el);
    return () => {
      el.remove();
      setHost(null);
    };
  }, [art, visible]);

  if (!host) return null;
  return createPortal(
    <Stack
      spacing={1}
      sx={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "auto" }}
    >
      <Tooltip title="笔记" placement="left">
        <Fab
          size="small"
          onClick={onNotes}
          aria-label="打开笔记面板"
          sx={{
            bgcolor: "md3.surfaceContainerHigh",
            color: "text.primary",
            boxShadow: 6,
            "&:hover": { bgcolor: "md3.surfaceContainerHighest" },
          }}
        >
          <NoteAltOutlinedIcon fontSize="small" />
        </Fab>
      </Tooltip>
      <Tooltip title="批注 (a)" placement="left">
        <Fab
          size="small"
          onClick={onAnnotate}
          aria-label="批注"
          sx={{
            bgcolor: "md3.surfaceContainerHigh",
            color: "text.primary",
            boxShadow: 6,
            "&:hover": { bgcolor: "md3.surfaceContainerHighest" },
          }}
        >
          <GestureRoundedIcon fontSize="small" />
        </Fab>
      </Tooltip>
      <Tooltip title="问 AI" placement="left">
        <Fab size="small" color="primary" onClick={onChat} aria-label="问 AI" sx={{ boxShadow: 6 }}>
          <AutoAwesomeRoundedIcon fontSize="small" />
        </Fab>
      </Tooltip>
    </Stack>,
    host
  );
}
