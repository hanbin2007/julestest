"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import {
  Box,
  Button,
  Checkbox,
  Fab,
  Fade,
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
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import SplitscreenRoundedIcon from "@mui/icons-material/SplitscreenRounded";
import CloseFullscreenRoundedIcon from "@mui/icons-material/CloseFullscreenRounded";
import PsychologyRoundedIcon from "@mui/icons-material/PsychologyRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import FullscreenRoundedIcon from "@mui/icons-material/FullscreenRounded";
import BookmarkAddRoundedIcon from "@mui/icons-material/BookmarkAddRounded";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";

import { useChat } from "@/hooks/useChat";
import { useLessonChats } from "@/hooks/useLessonChats";
import { usePrefs } from "@/hooks/persist";
import { chatImageUrl } from "@/lib/api";
import * as chatStreams from "@/lib/chatStreams";
import { EFFORT_LEVELS, DEFAULT_EFFORT, type ChatEffort } from "@/lib/chatPrefs";
import type { ChatMessage } from "@/lib/store";
import MarkdownReader from "./MarkdownReader";
import ChatSwitcher from "./ChatSwitcher";

// 懒加载 Markdown + KaTeX:仅在真正渲染助教回复时才拉这份较大的 chunk/CSS。
const Markdown = dynamic(() => import("./Markdown").then((m) => m.Markdown), {
  ssr: false,
  loading: () => null,
});

export interface ChatPrefill {
  text?: string;
  image?: string; // dataURL
}

// 把若干条消息拼成可读 Markdown(全屏阅读 + 存为笔记 共用)。
function buildQA(msgs: ChatMessage[]): string {
  return msgs
    .map((m) => (m.role === "user" ? `🙋 问：${m.text}` : `🤖 答：\n\n${m.text}`))
    .join("\n\n");
}

function Bubble({
  role,
  text,
  imageSrc,
  pending,
  selectMode,
  selected,
  onToggle,
  onOpenReader,
  onSaveOne,
}: {
  role: "user" | "assistant";
  text: string;
  imageSrc?: string | null;
  pending?: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  onOpenReader?: () => void;
  onSaveOne?: () => void;
}) {
  const isUser = role === "user";
  const showActions = !isUser && !pending && !!text && !selectMode && (onOpenReader || onSaveOne);
  return (
    <Box
      onClick={selectMode ? onToggle : undefined}
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 0.5,
        justifyContent: isUser ? "flex-end" : "flex-start",
        cursor: selectMode ? "pointer" : "default",
      }}
    >
      {selectMode && <Checkbox checked={!!selected} size="small" sx={{ p: 0.5, mt: 0.25 }} />}
      <Box sx={{ maxWidth: "85%", minWidth: 0 }}>
        <Box
          sx={{
            p: 1.25,
            borderRadius: (t) => t.radius.md,
            bgcolor: isUser ? "primary.main" : "md3.surfaceContainerHigh",
            color: isUser ? "primary.contrastText" : "text.primary",
            ...(selectMode && selected && { outline: (t) => `2px solid ${t.palette.primary.main}`, outlineOffset: 1 }),
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
        {showActions && (
          <Stack direction="row" sx={{ mt: 0.25, ml: 0.25 }}>
            {onOpenReader && (
              <Tooltip title="全屏阅读">
                <IconButton size="small" onClick={onOpenReader} aria-label="fullscreen read" sx={{ color: "text.disabled" }}>
                  <FullscreenRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            )}
            {onSaveOne && (
              <Tooltip title="存为笔记">
                <IconButton size="small" onClick={onSaveOne} aria-label="save qa to notes" sx={{ color: "text.disabled" }}>
                  <BookmarkAddRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
        )}
      </Box>
    </Box>
  );
}

export default function ChatBody({
  chatId,
  onChangeChatId,
  getCurrentLesson,
  prefill,
  onConsumePrefill,
  split = false,
  onToggleSplit,
  onSaveNote,
  getVideoTime,
  onClose,
  showSwitcher = true,
  showSplitToggle = true,
}: {
  chatId: string | null;
  onChangeChatId: (id: string | null) => void;
  getCurrentLesson?: () => { productId: number; videoId: number } | null;
  prefill?: ChatPrefill | null;
  onConsumePrefill?: () => void;
  split?: boolean;
  onToggleSplit?: () => void;
  onSaveNote?: (text: string, videoT?: number) => void | Promise<void>;
  getVideoTime?: () => number;
  onClose?: () => void; // 面板自带关闭按钮;overlay 用其自己的右上角
  showSwitcher?: boolean; // overlay 里关掉(独立对话不切换)
  showSplitToggle?: boolean;
}) {
  // 当前所看的讲(用于新建本讲对话 / 系统上下文注入)
  const cur = getCurrentLesson?.() ?? null;
  const { create: createLessonChat } = useLessonChats(
    cur?.productId ?? null,
    cur?.videoId ?? null,
  );

  const {
    chat,
    history,
    send,
    stop,
    streaming,
    draftReply,
    pendingUser,
    error,
  } = useChat(chatId, getCurrentLesson);
  const { prefs, setPrefs } = usePrefs();
  const effort: ChatEffort = prefs.chatEffort ?? DEFAULT_EFFORT;
  const [input, setInput] = React.useState("");
  const [attached, setAttached] = React.useState<string | null>(null);
  const [effortAnchor, setEffortAnchor] = React.useState<null | HTMLElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const roRef = React.useRef<ResizeObserver | null>(null);
  const effortLabel = EFFORT_LEVELS.find((l) => l.value === effort)?.label ?? "深入";

  // 「回到底部」
  const [atBottom, setAtBottom] = React.useState(true);
  const atBottomRef = React.useRef(true);
  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
    setAtBottom((p) => (p === near ? p : near));
  }, []);
  const setContentEl = React.useCallback(
    (node: HTMLDivElement | null) => {
      roRef.current?.disconnect();
      if (!node) {
        roRef.current = null;
        return;
      }
      const ro = new ResizeObserver(() => {
        if (atBottomRef.current) scrollToBottom("auto");
      });
      ro.observe(node);
      roRef.current = ro;
    },
    [scrollToBottom],
  );

  // 全屏阅读器
  const [reader, setReader] = React.useState<{ open: boolean; content: string; title: string; videoT?: number }>({
    open: false,
    content: "",
    title: "",
  });

  const pairVideoT = (msgs: ChatMessage[]): number | undefined =>
    msgs.find((m) => m.videoT != null)?.videoT ?? undefined;

  const [selectMode, setSelectMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (history.length === 0 && selectMode) {
      setSelectMode(false);
      setSelectedIds(new Set());
    }
  }, [history.length, selectMode]);

  // 切 chatId 时,清掉多选/草稿(避免上一段 chat 的状态泄漏到下一个)。
  React.useEffect(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setAttached(null);
  }, [chatId]);

  const pairFor = React.useCallback(
    (id: string): ChatMessage[] => {
      const i = history.findIndex((m) => m.id === id);
      if (i < 0) return [];
      const ans = history[i];
      for (let j = i - 1; j >= 0; j--) {
        if (history[j].role === "user") return [history[j], ans];
      }
      return [ans];
    },
    [history],
  );

  const openReader = React.useCallback(
    (id: string) => {
      const msgs = pairFor(id);
      if (!msgs.length) return;
      const q = msgs.find((m) => m.role === "user")?.text;
      setReader({ open: true, content: buildQA(msgs), title: q ? q.slice(0, 40) : "AI 回答", videoT: pairVideoT(msgs) });
    },
    [pairFor],
  );

  const saveMsgs = React.useCallback(
    (msgs: ChatMessage[]) => {
      const text = buildQA(msgs).trim();
      if (text && onSaveNote) void onSaveNote(text, pairVideoT(msgs));
    },
    [onSaveNote],
  );

  const toggleSelect = (id: string) =>
    setSelectedIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = history.length > 0 && selectedIds.size === history.length;
  const exitSelect = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };
  const saveSelected = () => {
    const msgs = history.filter((m) => selectedIds.has(m.id));
    if (msgs.length) saveMsgs(msgs);
    exitSelect();
  };

  // 来自批注「问 Claude」的预填:填入输入框 + 挂上画面截图
  React.useEffect(() => {
    if (!prefill) return;
    setInput((prev) => prefill.text ?? prev);
    if (prefill.image) setAttached(prefill.image);
    onConsumePrefill?.();
  }, [prefill, onConsumePrefill]);

  // 打开面板时贴底(切 chatId 也算"开了新内容"贴底)
  React.useEffect(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    // 等一帧让 history 先渲染
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [chatId, scrollToBottom]);

  // 发送:若 chatId 为空 → 先建一个 lesson 类 chat,再发。无讲上下文 + 无 chatId → 禁用。
  const doSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    const videoT = getVideoTime ? Math.floor(getVideoTime()) : undefined;
    let id = chatId;
    if (!id) {
      if (!cur) return; // 没讲也没 chat → 没法决定 kind,UI 应已禁用
      id = await createLessonChat();
      if (!id) return;
      onChangeChatId(id);
    }
    send(text, attached ?? undefined, effort, videoT);
    setInput("");
    setAttached(null);
    atBottomRef.current = true;
    setAtBottom(true);
  };

  // 「已停止 · 重试」内联检测:最后一条是 user 且没有进行中的流,代表上次中断/崩。
  const lastUserUnanswered =
    !streaming &&
    history.length > 0 &&
    history[history.length - 1].role === "user";

  const empty = history.length === 0 && !pendingUser && !streaming;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 头部 */}
      <Stack
        direction="row"
        sx={{ alignItems: "center", gap: 1, p: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
      >
        {selectMode ? (
          <>
            <Typography variant="h6" sx={{ flex: 1 }}>
              已选 {selectedIds.size}
            </Typography>
            <Button
              size="small"
              color="inherit"
              onClick={() => setSelectedIds(allSelected ? new Set() : new Set(history.map((m) => m.id)))}
              sx={{ textTransform: "none" }}
            >
              {allSelected ? "取消全选" : "全选"}
            </Button>
            <Button size="small" onClick={exitSelect} sx={{ textTransform: "none", color: "text.secondary" }}>
              取消
            </Button>
          </>
        ) : (
          <>
            <AutoAwesomeRoundedIcon color="primary" sx={{ flexShrink: 0 }} />
            {showSwitcher ? (
              <ChatSwitcher
                chat={chat}
                productId={cur?.productId ?? null}
                videoId={cur?.videoId ?? null}
                onChangeChatId={onChangeChatId}
              />
            ) : (
              <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 700 }} noWrap>
                {chat?.title || "新对话"}
              </Typography>
            )}
            {streaming && (
              <Tooltip title="停止">
                <IconButton size="small" onClick={stop} aria-label="stop streaming">
                  <StopRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title={`思考等级:${effortLabel}`}>
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
            {onSaveNote && (
              <Tooltip title="选条存为笔记">
                <span>
                  <IconButton
                    size="small"
                    disabled={history.length === 0 || streaming}
                    onClick={() => setSelectMode(true)}
                    aria-label="select to save notes"
                  >
                    <BookmarkAddRoundedIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            {showSplitToggle && onToggleSplit && (
              <Tooltip title={split ? "退出分屏" : "分屏（边看边聊）"}>
                <IconButton size="small" onClick={onToggleSplit} aria-label="toggle split">
                  {split ? <CloseFullscreenRoundedIcon fontSize="small" /> : <SplitscreenRoundedIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
            )}
            {onClose && (
              <IconButton size="small" onClick={onClose} aria-label="close chat">
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            )}
          </>
        )}
      </Stack>

      {/* 消息区 */}
      <Box sx={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Box
          ref={scrollRef}
          onScroll={onScroll}
          sx={{ flex: 1, overflowY: "auto", p: 2 }}
        >
          <Box ref={setContentEl} sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {empty && (
              <Typography variant="body2" color="text.secondary">
                用 Claude(opus 4.7)讲题。可直接提问,或在看课时按 <b>a</b> 批注后点「问 Claude」连画面一起发。
              </Typography>
            )}
            {history.map((m, i) => {
              const isLast = i === history.length - 1;
              const showRetryRow = isLast && m.role === "user" && lastUserUnanswered;
              return (
                <Box key={m.id}>
                  <Bubble
                    role={m.role}
                    text={m.text}
                    imageSrc={m.image ? chatImageUrl(m.image) : null}
                    selectMode={selectMode}
                    selected={selectedIds.has(m.id)}
                    onToggle={() => toggleSelect(m.id)}
                    onOpenReader={m.role === "assistant" ? () => openReader(m.id) : undefined}
                    onSaveOne={m.role === "assistant" && onSaveNote ? () => saveMsgs(pairFor(m.id)) : undefined}
                  />
                  {showRetryRow && !selectMode && (
                    <Stack direction="row" sx={{ mt: 0.25, justifyContent: "flex-end", gap: 1, alignItems: "center" }}>
                      <Typography variant="caption" color="text.secondary">
                        未完成
                      </Typography>
                      <Button
                        size="small"
                        startIcon={<RefreshRoundedIcon fontSize="small" />}
                        onClick={() => {
                          // 重试:复用这条用户消息文本再发一次。chatId 必存在(否则不会有 history)。
                          if (chatId) {
                            void chatStreams.startSend({
                              chatId,
                              text: m.text,
                              currentProductId: cur?.productId ?? null,
                              currentVideoId: cur?.videoId ?? null,
                              effort,
                              videoT: m.videoT ?? undefined,
                            });
                          }
                        }}
                        sx={{ textTransform: "none" }}
                      >
                        重试
                      </Button>
                    </Stack>
                  )}
                </Box>
              );
            })}
            {pendingUser && <Bubble role="user" text={pendingUser.text} imageSrc={pendingUser.image ?? null} />}
            {streaming && <Bubble role="assistant" text={draftReply} pending />}
            {error && (
              <Typography variant="caption" color="error">
                出错了:{error}
              </Typography>
            )}
          </Box>
        </Box>
        <Fade in={!atBottom} unmountOnExit>
          <Fab
            size="small"
            onClick={() => scrollToBottom("smooth")}
            aria-label="回到底部"
            sx={{
              position: "absolute",
              right: 16,
              bottom: 16,
              bgcolor: "md3.surfaceContainerHigh",
              color: "text.secondary",
              boxShadow: 6,
              "&:hover": { bgcolor: "md3.surfaceContainerHighest" },
            }}
          >
            <KeyboardArrowDownRoundedIcon />
          </Fab>
        </Fade>
      </Box>

      {/* 底部 */}
      {selectMode ? (
        <Box sx={{ p: 1.5, borderTop: (t) => `1px solid ${t.palette.divider}` }}>
          <Button
            fullWidth
            variant="contained"
            startIcon={<BookmarkAddRoundedIcon />}
            disabled={selectedIds.size === 0}
            onClick={saveSelected}
          >
            存为笔记{selectedIds.size ? `（${selectedIds.size}）` : ""}
          </Button>
        </Box>
      ) : (
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
              placeholder={streaming ? "回答中…" : chatId == null && !cur ? "选一讲再开始,或在 /chats 新建独立对话" : "问点什么…(Enter 发送)"}
              value={input}
              disabled={streaming || (chatId == null && !cur)}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void doSend();
                }
              }}
            />
            <IconButton color="primary" disabled={streaming || !input.trim()} onClick={() => void doSend()} aria-label="send">
              <SendRoundedIcon />
            </IconButton>
          </Stack>
        </Box>
      )}

      <MarkdownReader
        open={reader.open}
        onClose={() => setReader((r) => ({ ...r, open: false }))}
        content={reader.content}
        title={reader.title}
        onSaveNote={onSaveNote ? () => { if (reader.content) void onSaveNote(reader.content, reader.videoT); } : undefined}
      />
    </Box>
  );
}

