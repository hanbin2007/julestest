"use client";
import * as React from "react";
import {
  Box,
  Drawer,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import SplitscreenRoundedIcon from "@mui/icons-material/SplitscreenRounded";
import CloseFullscreenRoundedIcon from "@mui/icons-material/CloseFullscreenRounded";

export const CHAT_WIDTH = 420;
import { useChat } from "@/hooks/useChat";
import { chatImageUrl } from "@/lib/api";

export interface ChatPrefill {
  text?: string;
  image?: string; // dataURL
}

function Bubble({
  role,
  text,
  imageSrc,
  pending,
}: {
  role: "user" | "assistant";
  text: string;
  imageSrc?: string | null;
  pending?: boolean;
}) {
  const isUser = role === "user";
  return (
    <Box sx={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <Box
        sx={{
          maxWidth: "85%",
          p: 1.25,
          borderRadius: (t) => t.radius.md,
          bgcolor: isUser ? "primary.main" : "md3.surfaceContainerHigh",
          color: isUser ? "primary.contrastText" : "text.primary",
        }}
      >
        {imageSrc && (
          <Box
            component="img"
            src={imageSrc}
            alt="批注画面"
            sx={{ display: "block", maxWidth: "100%", borderRadius: (t) => t.radius.sm, mb: text ? 1 : 0 }}
          />
        )}
        {text && (
          <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {text}
            {pending && <Box component="span" sx={{ opacity: 0.5 }}> ▍</Box>}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export default function ChatPanel({
  open,
  onClose,
  videoId,
  prefill,
  onConsumePrefill,
  split = false,
  onToggleSplit,
}: {
  open: boolean;
  onClose: () => void;
  videoId: number | null;
  prefill?: ChatPrefill | null;
  onConsumePrefill?: () => void;
  split?: boolean;
  onToggleSplit?: () => void;
}) {
  const { history, send, clear, streaming, draftReply, pendingUser, error } = useChat(videoId);
  const [input, setInput] = React.useState("");
  const [attached, setAttached] = React.useState<string | null>(null); // dataURL
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // 来自批注「问 Claude」的预填：填入输入框 + 挂上画面截图
  React.useEffect(() => {
    if (!prefill) return;
    setInput((prev) => prefill.text ?? prev);
    if (prefill.image) setAttached(prefill.image);
    onConsumePrefill?.();
  }, [prefill, onConsumePrefill]);

  // 新内容自动滚到底
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [history.length, draftReply, pendingUser, open]);

  const doSend = () => {
    const text = input.trim();
    if (!text || streaming || videoId == null) return;
    void send(text, attached ?? undefined);
    setInput("");
    setAttached(null);
  };

  const empty = history.length === 0 && !pendingUser && !streaming;

  const body = (
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {/* 头部 */}
        <Stack
          direction="row"
          sx={{ alignItems: "center", gap: 1, p: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
        >
          <AutoAwesomeRoundedIcon color="primary" />
          <Typography variant="h6" sx={{ flex: 1 }}>
            AI 助教
          </Typography>
          {onToggleSplit && (
            <Tooltip title={split ? "退出分屏" : "分屏（边看边聊）"}>
              <IconButton size="small" onClick={onToggleSplit} aria-label="toggle split">
                {split ? <CloseFullscreenRoundedIcon fontSize="small" /> : <SplitscreenRoundedIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="清空对话">
            <span>
              <IconButton size="small" disabled={history.length === 0 || streaming} onClick={() => void clear()}>
                <DeleteSweepRoundedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" onClick={onClose} aria-label="close chat">
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        </Stack>

        {/* 消息区 */}
        <Box ref={scrollRef} sx={{ flex: 1, overflowY: "auto", p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
          {empty && (
            <Typography variant="body2" color="text.secondary">
              用 Claude（opus 4.7）讲题。可以直接提问，或在看课时按 <b>a</b> 批注后点「问 Claude」连画面一起发。
            </Typography>
          )}
          {history.map((m) => (
            <Bubble
              key={m.id}
              role={m.role}
              text={m.text}
              imageSrc={m.image ? chatImageUrl(m.image) : null}
            />
          ))}
          {pendingUser && <Bubble role="user" text={pendingUser.text} imageSrc={pendingUser.image ?? null} />}
          {streaming && <Bubble role="assistant" text={draftReply} pending />}
          {error && (
            <Typography variant="caption" color="error">
              出错了：{error}
            </Typography>
          )}
        </Box>

        {/* 输入区 */}
        <Box sx={{ p: 1.5, borderTop: (t) => `1px solid ${t.palette.divider}` }}>
          {attached && (
            <Box sx={{ position: "relative", mb: 1, width: "fit-content" }}>
              <Box
                component="img"
                src={attached}
                alt="待发画面"
                sx={{ maxHeight: 88, borderRadius: (t) => t.radius.sm, display: "block" }}
              />
              <IconButton
                size="small"
                onClick={() => setAttached(null)}
                sx={{ position: "absolute", top: -8, right: -8, bgcolor: "background.paper", "&:hover": { bgcolor: "background.paper" } }}
              >
                <CloseRoundedIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Box>
          )}
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-end" }}>
            <TextField
              size="small"
              fullWidth
              multiline
              maxRows={5}
              placeholder={streaming ? "回答中…" : "问点什么…（Enter 发送）"}
              value={input}
              disabled={streaming || videoId == null}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  doSend();
                }
              }}
            />
            <IconButton color="primary" disabled={streaming || !input.trim()} onClick={doSend} aria-label="send">
              <SendRoundedIcon />
            </IconButton>
          </Stack>
        </Box>
      </Box>
  );

  // 分屏模式：固定在右侧的常驻面板（不是 Drawer），与左侧播放器并排，z-index 自控。
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
