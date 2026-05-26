"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  LinearProgress,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import MoreVertRoundedIcon from "@mui/icons-material/MoreVertRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import LinkOffRoundedIcon from "@mui/icons-material/LinkOffRounded";
import { useLessonChats } from "@/hooks/useLessonChats";
import { useChatStream } from "@/hooks/useChatStream";
import * as chatStreams from "@/lib/chatStreams";
import * as api from "@/lib/api";
import type { ChatMeta, EnrichedChat } from "@/lib/store";

// 「已 12s · 142 字」label。秒数靠 useNow tick;字数靠 useChatStream 订阅。
function useNowTick(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// 单条聊天行(切换器 Popover 内)。订阅它自己的流态显示进度/停止。
function ChatRow({
  chat,
  active,
  onPick,
  onRenamed,
  onRemoved,
}: {
  chat: EnrichedChat;
  active: boolean;
  onPick: () => void;
  onRenamed: () => void;
  onRemoved: () => void;
}) {
  const stream = useChatStream(chat.id);
  const now = useNowTick(stream.phase === "streaming");
  const [menuAnchor, setMenuAnchor] = React.useState<null | HTMLElement>(null);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(chat.title ?? "");
  const streaming = stream.phase === "streaming";
  const elapsed =
    streaming && stream.startedAt
      ? Math.max(0, Math.round((now - stream.startedAt) / 1000))
      : 0;

  const commitRename = async () => {
    const t = draft.trim();
    if (!t || t === chat.title) {
      setEditing(false);
      setDraft(chat.title ?? "");
      return;
    }
    try {
      await api.renameChat(chat.id, t);
      onRenamed();
    } catch {
      /* 服务端 400 → 回滚 */
      setDraft(chat.title ?? "");
    }
    setEditing(false);
  };

  return (
    <Box
      sx={{
        position: "relative",
        px: 1.5,
        py: 1,
        borderRadius: (t) => t.radius.sm,
        cursor: editing ? "default" : "pointer",
        "&:hover": { bgcolor: "action.hover" },
        bgcolor: active ? "action.selected" : "transparent",
      }}
      onClick={editing ? undefined : onPick}
    >
      {streaming && (
        <LinearProgress
          variant="indeterminate"
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            borderTopLeftRadius: (t) => t.radius.sm,
            borderTopRightRadius: (t) => t.radius.sm,
          }}
        />
      )}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
        {active && !editing && (
          <CheckRoundedIcon fontSize="small" color="primary" sx={{ flexShrink: 0 }} />
        )}
        {editing ? (
          <TextField
            size="small"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename();
              } else if (e.key === "Escape") {
                setEditing(false);
                setDraft(chat.title ?? "");
              }
            }}
            onBlur={() => void commitRename()}
            onClick={(e) => e.stopPropagation()}
            inputProps={{ maxLength: 120 }}
            sx={{ flex: 1 }}
          />
        ) : (
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              noWrap
              sx={{ fontWeight: active ? 600 : 400, color: chat.title ? "text.primary" : "text.secondary" }}
            >
              {chat.title || "新对话"}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {streaming
                ? `思考中 · 已 ${elapsed}s · ${stream.charCount} 字`
                : stream.phase === "error" && stream.error
                  ? stream.error
                  : `${chat.messageCount} 条 · ${new Date(chat.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
            </Typography>
          </Box>
        )}
        {streaming && !editing && (
          <Tooltip title="停止">
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                chatStreams.stop(chat.id);
              }}
            >
              <StopRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {!editing && (
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              setMenuAnchor(e.currentTarget);
            }}
            aria-label="chat actions"
          >
            <MoreVertRoundedIcon fontSize="small" />
          </IconButton>
        )}
      </Stack>
      <Menu
        anchorEl={menuAnchor}
        open={!!menuAnchor}
        onClose={() => setMenuAnchor(null)}
        onClick={(e) => e.stopPropagation()}
      >
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            setEditing(true);
            setDraft(chat.title ?? "");
          }}
        >
          <EditRoundedIcon fontSize="small" sx={{ mr: 1 }} /> 重命名
        </MenuItem>
        <MenuItem
          onClick={async () => {
            setMenuAnchor(null);
            await api.deleteChat(chat.id);
            chatStreams.forget(chat.id);
            onRemoved();
          }}
          sx={{ color: "error.main" }}
        >
          <DeleteOutlineRoundedIcon fontSize="small" sx={{ mr: 1 }} /> 删除
        </MenuItem>
      </Menu>
    </Box>
  );
}

// 切换器:头部「[标题 ▾]」点开 Popover 显示本讲所有 chat + 新建按钮 + 跳转 /chats。
export default function ChatSwitcher({
  chat,
  productId,
  videoId,
  onChangeChatId,
}: {
  chat: { id: string; title: string | null; kind: "lesson" | "independent"; productId: number | null; videoId: number | null } | null;
  productId: number | null;
  videoId: number | null;
  onChangeChatId: (id: string | null) => void;
}) {
  const router = useRouter();
  const [anchor, setAnchor] = React.useState<null | HTMLElement>(null);
  const { chats, mutate, create } = useLessonChats(productId, videoId);

  // 头部标题:当前 chat 的 title || "新对话"。绑定提示:当前 chat 是独立或绑别的讲时给个 caption。
  const title = chat?.title || "新对话";
  const offBinding =
    chat &&
    (chat.kind !== "lesson" ||
      (productId != null && videoId != null && (chat.productId !== productId || chat.videoId !== videoId)));

  const canBindCurrent = productId != null && videoId != null;

  const onCreateLesson = async () => {
    if (!canBindCurrent) return;
    const id = await create();
    if (id) {
      onChangeChatId(id);
      setAnchor(null);
    }
  };

  const onCreateIndependent = async () => {
    const r = await api.newChat("independent");
    setAnchor(null);
    // 独立聊天在 /chats 中心页打开(没有讲上下文,留在播放器没意义)
    router.push(`/chats?open=${encodeURIComponent(r.chat.id)}`);
  };

  const onPick = (id: string) => {
    onChangeChatId(id);
    setAnchor(null);
  };

  const onRemoved = (id: string) => {
    // 删的是当前 → 让父级回退到列表最近一个或 null
    if (chat?.id === id) {
      const next = chats.find((c) => c.id !== id);
      onChangeChatId(next?.id ?? null);
    }
    mutate();
  };

  return (
    <>
      <Button
        size="small"
        endIcon={<KeyboardArrowDownRoundedIcon />}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{
          textTransform: "none",
          flex: 1,
          minWidth: 0,
          justifyContent: "flex-start",
          color: "text.primary",
          px: 1,
          textAlign: "left",
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" noWrap sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            {title}
          </Typography>
          {offBinding && chat && (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <LinkOffRoundedIcon sx={{ fontSize: 12 }} />
              {chat.kind === "independent" ? "独立对话" : `原绑定: 课程 ${chat.productId} · 讲 ${chat.videoId}`}
            </Typography>
          )}
        </Box>
      </Button>
      <Popover
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ paper: { sx: { width: 360, maxWidth: "94vw", p: 1 } } }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, py: 0.5, display: "block" }}>
          本讲对话{!canBindCurrent ? "(请先选择一讲)" : ""}
        </Typography>
        <Box sx={{ maxHeight: 320, overflowY: "auto" }}>
          {chats.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>
              还没有对话。点下方「新建本讲对话」开始一段。
            </Typography>
          ) : (
            chats.map((c) => (
              <ChatRow
                key={c.id}
                chat={c}
                active={c.id === chat?.id}
                onPick={() => onPick(c.id)}
                onRenamed={() => mutate()}
                onRemoved={() => onRemoved(c.id)}
              />
            ))
          )}
        </Box>
        <Divider sx={{ my: 1 }} />
        <Stack spacing={0.5}>
          <Button
            size="small"
            startIcon={<AddRoundedIcon />}
            onClick={onCreateLesson}
            disabled={!canBindCurrent}
            sx={{ justifyContent: "flex-start", textTransform: "none" }}
          >
            新建本讲对话
          </Button>
          <Button
            size="small"
            startIcon={<AddRoundedIcon />}
            onClick={onCreateIndependent}
            sx={{ justifyContent: "flex-start", textTransform: "none" }}
          >
            新建独立对话
          </Button>
          <Button
            size="small"
            startIcon={<OpenInNewRoundedIcon />}
            onClick={() => {
              setAnchor(null);
              router.push("/chats");
            }}
            sx={{ justifyContent: "flex-start", textTransform: "none" }}
          >
            查看全部对话
          </Button>
        </Stack>
      </Popover>
    </>
  );
}
