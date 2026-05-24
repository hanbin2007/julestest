"use client";
import * as React from "react";
import {
  Box,
  Button,
  Drawer,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
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
import PsychologyRoundedIcon from "@mui/icons-material/PsychologyRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";

export const CHAT_WIDTH = 420;
import dynamic from "next/dynamic";
import { useChat } from "@/hooks/useChat";
import { usePrefs } from "@/hooks/persist";
import { chatImageUrl } from "@/lib/api";
import { EFFORT_LEVELS, DEFAULT_EFFORT, type ChatEffort } from "@/lib/chatPrefs";

// 懒加载 Markdown + KaTeX：仅在真正渲染助教回复时才拉这份较大的 chunk/CSS，
// 不拖累播放器页首屏。
const Markdown = dynamic(() => import("./Markdown").then((m) => m.Markdown), {
  ssr: false,
  loading: () => null,
});

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
        {/* 用户消息保留原样纯文本；助教回复渲染 Markdown + LaTeX */}
        {isUser ? (
          text && (
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {text}
            </Typography>
          )
        ) : (
          <>
            {text && <Markdown>{text}</Markdown>}
            {pending && (
              <Box component="span" sx={{ opacity: 0.5 }}>
                {text ? " ▍" : "思考中… ▍"}
              </Box>
            )}
          </>
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
  const { prefs, setPrefs } = usePrefs();
  const effort: ChatEffort = prefs.chatEffort ?? DEFAULT_EFFORT;
  const [input, setInput] = React.useState("");
  const [attached, setAttached] = React.useState<string | null>(null); // dataURL
  const [effortAnchor, setEffortAnchor] = React.useState<null | HTMLElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const effortLabel = EFFORT_LEVELS.find((l) => l.value === effort)?.label ?? "深入";

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
    void send(text, attached ?? undefined, effort);
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
          {/* 思考等级：越高越深入也越慢 */}
          <Tooltip title={`思考等级：${effortLabel}`}>
            <Button
              size="small"
              color="inherit"
              startIcon={<PsychologyRoundedIcon fontSize="small" />}
              onClick={(e) => setEffortAnchor(e.currentTarget)}
              sx={{ minWidth: 0, px: 1, color: "text.secondary", textTransform: "none" }}
            >
              {effortLabel}
            </Button>
          </Tooltip>
          <Menu anchorEl={effortAnchor} open={!!effortAnchor} onClose={() => setEffortAnchor(null)}>
            {EFFORT_LEVELS.map((l) => (
              <MenuItem
                key={l.value}
                selected={l.value === effort}
                onClick={() => {
                  void setPrefs({ chatEffort: l.value });
                  setEffortAnchor(null);
                }}
                sx={{ gap: 1 }}
              >
                <ListItemText primary={l.label} secondary={l.hint} />
                {l.value === effort && <CheckRoundedIcon fontSize="small" color="primary" />}
              </MenuItem>
            ))}
          </Menu>
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
