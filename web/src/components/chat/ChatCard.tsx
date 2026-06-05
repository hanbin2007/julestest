"use client";
import * as React from "react";
import {
  Card,
  Chip,
  IconButton,
  LinearProgress,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import OpenInFullRoundedIcon from "@mui/icons-material/OpenInFullRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import LinkOffRoundedIcon from "@mui/icons-material/LinkOffRounded";
import { useChatStream } from "@/hooks/useChatStream";
import * as chatStreams from "@/lib/chatStreams";
import { hashSeed } from "@/lib/color";
import { StatusDot } from "@/components/common/StatusDot";
import { hoverElevate, smoothColors, DUR, EASE } from "@/theme/motion";
import type { EnrichedChat } from "@/lib/store";

// 中心页一张聊天卡。订阅自身流态:streaming 时顶部贴 LinearProgress + 角落 Stop;error 显示警告 chip。
// 点卡片:lesson-bound → router.push 到讲;independent → 父级 onOpen 在当前页 ChatOverlay 全屏。
export default function ChatCard({
  chat,
  onOpen,
  onRename,
  onDelete,
}: {
  chat: EnrichedChat;
  onOpen: (chat: EnrichedChat) => void;
  onRename: (id: string, title: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
}) {
  const stream = useChatStream(chat.id);
  const streaming = stream.phase === "streaming";
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(chat.title ?? "");

  const color =
    chat.kind === "lesson" && chat.courseName
      ? hashSeed(chat.courseName)
      : "var(--mui-palette-text-disabled)";

  const commitRename = async () => {
    const t = draft.trim();
    if (!t || t === chat.title) {
      setEditing(false);
      setDraft(chat.title ?? "");
      return;
    }
    try {
      await onRename(chat.id, t);
    } catch {
      setDraft(chat.title ?? "");
    }
    setEditing(false);
  };

  const meta =
    chat.kind === "lesson"
      ? `${chat.courseName ?? "未知课程"} · ${chat.lessonTitle ?? `讲 ${chat.videoId}`}`
      : "独立对话";

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={editing ? undefined : () => onOpen(chat)}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(chat);
        }
      }}
      sx={(t) => ({
        position: "relative",
        p: 2,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 1,
        cursor: editing ? "default" : "pointer",
        ...hoverElevate(t),
        // 始终保留 outline,仅在透明 ↔ primary 之间过渡,使流式描边淡入淡出。
        outline: `1.5px solid ${streaming ? (t.vars ?? t).palette.primary.main : "transparent"}`,
        // 在 hoverElevate(background-color/box-shadow)基础上追加 outline-color,统一时长/缓动。
        transition: t.transitions.create(
          ["background-color", "box-shadow", "outline-color"],
          { duration: DUR.base, easing: EASE },
        ),
        ...(editing ? { "&:hover": undefined } : {}),
        "&:focus-visible": { outline: `2px solid ${color}`, outlineOffset: 1 },
        overflow: "hidden",
      })}
    >
      {streaming && (
        <LinearProgress
          variant="indeterminate"
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
          }}
        />
      )}

      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
        <StatusDot color={color} size={10} />
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
          <Typography
            variant="subtitle2"
            noWrap
            sx={{ flex: 1, fontWeight: 700, color: chat.title ? "text.primary" : "text.secondary" }}
            title={chat.title || "新对话"}
          >
            {chat.title || "新对话"}
          </Typography>
        )}
        {chat.kind === "independent" && (
          <Chip
            icon={<LinkOffRoundedIcon sx={{ fontSize: 14 }} />}
            label="独立"
            size="small"
            variant="outlined"
            sx={{ height: 20, "& .MuiChip-label": { px: 1, fontSize: "0.7rem" } }}
          />
        )}
      </Stack>

      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        title={meta}
      >
        {meta}
      </Typography>

      {/* 流态行 → 最后一条预览;最后一条不存在 → 占位 */}
      {streaming ? (
        <Typography variant="caption" color="primary" sx={{ fontWeight: 500 }}>
          思考中 · {stream.charCount} 字
        </Typography>
      ) : stream.phase === "error" && stream.error ? (
        <Chip
          size="small"
          color="warning"
          label={stream.error}
          sx={{ alignSelf: "flex-start", height: 20, "& .MuiChip-label": { px: 1, fontSize: "0.7rem" } }}
        />
      ) : chat.lastMessage ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            flex: 1,
            minHeight: "3.6em",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {chat.lastMessage.role === "user" ? "🙋 " : "🤖 "}
          {chat.lastMessage.text}
        </Typography>
      ) : (
        <Typography variant="body2" color="text.disabled" sx={{ flex: 1, fontStyle: "italic" }}>
          还没有消息
        </Typography>
      )}

      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mt: "auto" }}
      >
        <Typography variant="caption" color="text.disabled" sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <ForumOutlinedIcon sx={{ fontSize: 14 }} />
          {chat.messageCount} 条 · {new Date(chat.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </Typography>
        <Stack direction="row" spacing={0.5} onClick={(e) => e.stopPropagation()}>
          {streaming && (
            <Tooltip title="停止">
              <IconButton size="small" onClick={() => chatStreams.stop(chat.id)} aria-label="stop">
                <StopRoundedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="打开">
            <IconButton size="small" onClick={() => onOpen(chat)} aria-label="open chat">
              <OpenInFullRoundedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="重命名">
            <IconButton
              size="small"
              onClick={() => {
                setDraft(chat.title ?? "");
                setEditing(true);
              }}
              aria-label="rename chat"
            >
              <EditRoundedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="删除">
            <IconButton
              size="small"
              onClick={() => void onDelete(chat.id)}
              aria-label="delete chat"
              // color(灰→红)与默认 hover 背景都纳入过渡,避免 0ms 硬切。
              sx={(t) => ({
                color: "text.disabled",
                transition: smoothColors(t),
                "&:hover": { color: "error.main" },
              })}
            >
              <DeleteOutlineRoundedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
    </Card>
  );
}
