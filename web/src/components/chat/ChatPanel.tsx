"use client";
import * as React from "react";
import {
  Box,
  Button,
  Checkbox,
  Drawer,
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
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import SplitscreenRoundedIcon from "@mui/icons-material/SplitscreenRounded";
import CloseFullscreenRoundedIcon from "@mui/icons-material/CloseFullscreenRounded";
import PsychologyRoundedIcon from "@mui/icons-material/PsychologyRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import FullscreenRoundedIcon from "@mui/icons-material/FullscreenRounded";
import BookmarkAddRoundedIcon from "@mui/icons-material/BookmarkAddRounded";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";

export const CHAT_WIDTH = 420;
import dynamic from "next/dynamic";
import { useChat } from "@/hooks/useChat";
import { usePrefs } from "@/hooks/persist";
import { chatImageUrl } from "@/lib/api";
import { EFFORT_LEVELS, DEFAULT_EFFORT, type ChatEffort } from "@/lib/chatPrefs";
import type { ChatMessage } from "@/lib/store";
import MarkdownReader from "./MarkdownReader";

// 懒加载 Markdown + KaTeX：仅在真正渲染助教回复时才拉这份较大的 chunk/CSS，
// 不拖累播放器页首屏。
const Markdown = dynamic(() => import("./Markdown").then((m) => m.Markdown), {
  ssr: false,
  loading: () => null,
});

// 把若干条消息拼成可读 Markdown（既用于全屏阅读，也用于存成笔记）。
// 问句以纯文本开头，这样 /notes 卡片的 3 行预览有意义（不会是一串 $\dfrac$）。
function buildQA(msgs: ChatMessage[]): string {
  return msgs
    .map((m) => (m.role === "user" ? `🙋 问：${m.text}` : `🤖 答：\n\n${m.text}`))
    .join("\n\n");
}

export interface ChatPrefill {
  text?: string;
  image?: string; // dataURL
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
  onOpenReader?: () => void; // 助教消息：全屏阅读
  onSaveOne?: () => void; // 助教消息：把这条问答存为笔记
}) {
  const isUser = role === "user";
  // 助教消息、已答完时才显示「全屏阅读 / 存为笔记」动作
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

export default function ChatPanel({
  open,
  onClose,
  videoId,
  productId = null,
  prefill,
  onConsumePrefill,
  split = false,
  onToggleSplit,
  onSaveNote,
  getVideoTime,
}: {
  open: boolean;
  onClose: () => void;
  videoId: number | null;
  productId?: number | null; // 对话课程归属标记
  prefill?: ChatPrefill | null;
  onConsumePrefill?: () => void;
  split?: boolean;
  onToggleSplit?: () => void;
  // 把一段问答存成当前讲的笔记；videoT = 提问时的播放位置(秒)，缺省由 page 用 currentTime 兜底
  onSaveNote?: (text: string, videoT?: number) => void | Promise<void>;
  getVideoTime?: () => number; // 发消息时记录提问时刻的播放位置
}) {
  const { history, send, clear, streaming, draftReply, pendingUser, error } = useChat(videoId, productId);
  const { prefs, setPrefs } = usePrefs();
  const effort: ChatEffort = prefs.chatEffort ?? DEFAULT_EFFORT;
  const [input, setInput] = React.useState("");
  const [attached, setAttached] = React.useState<string | null>(null); // dataURL
  const [effortAnchor, setEffortAnchor] = React.useState<null | HTMLElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const roRef = React.useRef<ResizeObserver | null>(null); // 贴底用：观察消息内容高度变化
  const effortLabel = EFFORT_LEVELS.find((l) => l.value === effort)?.label ?? "深入";

  // 「回到底部」：跟踪是否贴着底部（atBottomRef 给 effect 同步读，state 驱动按钮显隐）
  const [atBottom, setAtBottom] = React.useState(true);
  const atBottomRef = React.useRef(true);
  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80; // 距底 < 80px 视为在底部
    atBottomRef.current = near;
    setAtBottom((p) => (p === near ? p : near));
  }, []);
  // 内容高度变化（异步 Markdown 撑高 / 流式增长 / 图片加载）时，若用户在底部则贴底。
  // 用 callback ref 而非 effect：面板在抽屉里、开合会卸载/重挂内容节点，callback ref 能在重挂那刻
  // 立即把 ResizeObserver 挂上；普通 effect（依赖固定）只在组件首挂时跑，那时抽屉还没渲染内容 → 永远漏挂。
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

  // 一组消息的时间锚点 = 其中第一条带 videoT 的（通常是问句的提问时刻）
  const pairVideoT = (msgs: ChatMessage[]): number | undefined =>
    msgs.find((m) => m.videoT != null)?.videoT ?? undefined;
  // 多选「可选范围」存笔记
  const [selectMode, setSelectMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

  // 历史清空时退出多选，避免底栏残留过期 id
  React.useEffect(() => {
    if (history.length === 0 && selectMode) {
      setSelectMode(false);
      setSelectedIds(new Set());
    }
  }, [history.length, selectMode]);

  // 从某条助教回答往前找最近的提问，组成一对问答
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

  // 来自批注「问 Claude」的预填：填入输入框 + 挂上画面截图
  React.useEffect(() => {
    if (!prefill) return;
    setInput((prev) => prefill.text ?? prev);
    if (prefill.image) setAttached(prefill.image);
    onConsumePrefill?.();
  }, [prefill, onConsumePrefill]);

  // 打开面板时贴底（置贴底态后，上面的 ResizeObserver 会随异步内容撑高持续贴底）；
  // 往上翻看历史时（atBottomRef=false）不动，保持「不硬拽」。
  React.useEffect(() => {
    if (open) {
      atBottomRef.current = true;
      setAtBottom(true);
      scrollToBottom("auto");
    }
  }, [open, scrollToBottom]);

  const doSend = () => {
    const text = input.trim();
    if (!text || streaming || videoId == null) return;
    const videoT = getVideoTime ? Math.floor(getVideoTime()) : undefined;
    void send(text, attached ?? undefined, effort, videoT);
    setInput("");
    setAttached(null);
    atBottomRef.current = true; // 发送后总是跟到最新（即使此前滚上去了）
    setAtBottom(true);
  };

  const empty = history.length === 0 && !pendingUser && !streaming;

  const body = (
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {/* 头部 */}
        <Stack
          direction="row"
          sx={{ alignItems: "center", gap: 1, p: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
        >
          {selectMode ? (
            // 多选模式：标题与动作整组替换为「全选 / 已选 N / 取消」
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
              {/* 选条存笔记 */}
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
            </>
          )}
        </Stack>

        {/* 消息区（外层 relative 容器承载浮动「回到底部」按钮） */}
        <Box sx={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Box
            ref={scrollRef}
            onScroll={onScroll}
            sx={{ flex: 1, overflowY: "auto", p: 2 }}
          >
            <Box ref={setContentEl} sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
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
              selectMode={selectMode}
              selected={selectedIds.has(m.id)}
              onToggle={() => toggleSelect(m.id)}
              onOpenReader={m.role === "assistant" ? () => openReader(m.id) : undefined}
              onSaveOne={m.role === "assistant" && onSaveNote ? () => saveMsgs(pairFor(m.id)) : undefined}
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
          </Box>
          {/* 浮动「回到底部」：仅在离开底部时淡入 */}
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

        {/* 底部：多选模式 = 存笔记动作条；否则 = 输入区 */}
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
        )}

        {/* 全屏阅读器 */}
        <MarkdownReader
          open={reader.open}
          onClose={() => setReader((r) => ({ ...r, open: false }))}
          content={reader.content}
          title={reader.title}
          onSaveNote={onSaveNote ? () => { if (reader.content) void onSaveNote(reader.content, reader.videoT); } : undefined}
        />
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
