"use client";
import * as React from "react";
import useSWR from "swr";
import * as api from "@/lib/api";
import * as chatStreams from "@/lib/chatStreams";
import type { ChatMessage, ChatMeta } from "@/lib/store";
import type { ChatEffort } from "@/lib/chatPrefs";

// 单聊天 hook(按 chatId):
//   - SWR 拉历史(只读) + 订阅 chatStreams 拿实时流态(进度/draft/error)
//   - send: 转发到 chatStreams.startSend(此处不再持有 ctrl,卸载/切 chat 不打断流)
//   - stop / deleteCurrent
//
// 关键变化:不再有 cleanup-on-unmount abort — 这是允许后台并行的关键。abort 只在用户主动按
// 「停止」、删除当前 chat 时发生。换 chatId 时,旧的流继续在 store 里跑,新 chatId 渲染各自状态。
export function useChat(
  chatId: string | null,
  getCurrentLesson?: () => { productId: number; videoId: number } | null,
) {
  const swrKey = chatId ? `/api/chat?chatId=${chatId}` : null;
  const { data, mutate } = useSWR(
    swrKey,
    chatId ? () => api.getChat(chatId) : null,
    { revalidateOnFocus: false },
  );
  const history: ChatMessage[] = data?.messages ?? [];
  const chat: ChatMeta | null = data?.chat ?? null;

  // 订阅模块级流态。useSyncExternalStore 让组件在 store 变化时自动 rerender。
  const stream = React.useSyncExternalStore(
    React.useCallback((cb) => chatStreams.subscribe(chatId, cb), [chatId]),
    React.useCallback(() => chatStreams.get(chatId), [chatId]),
    React.useCallback(() => chatStreams.get(chatId), [chatId]),
  );

  const send = React.useCallback(
    (text: string, image?: string, effort?: ChatEffort, videoT?: number) => {
      if (!chatId || !text.trim()) return;
      if (stream.phase === "streaming") return; // UI 应已禁用,这里是双保险
      const cur = getCurrentLesson?.();
      void chatStreams.startSend({
        chatId,
        text: text.trim(),
        image,
        effort,
        videoT,
        currentProductId: cur?.productId ?? null,
        currentVideoId: cur?.videoId ?? null,
      });
    },
    [chatId, stream.phase, getCurrentLesson],
  );

  const stop = React.useCallback(() => {
    if (chatId) chatStreams.stop(chatId);
  }, [chatId]);

  // 删除当前 chat:先 stop 防 ctrl 泄漏,再调 API。父级负责切到下一个 chat(或 null)。
  const deleteCurrent = React.useCallback(async () => {
    if (!chatId) return;
    chatStreams.stop(chatId);
    await api.deleteChat(chatId);
    chatStreams.forget(chatId);
    await mutate(undefined, { revalidate: false });
  }, [chatId, mutate]);

  return {
    chat,
    history,
    send,
    stop,
    deleteCurrent,
    // 流态(给 ChatBody 渲染用)
    streaming: stream.phase === "streaming",
    draftReply: stream.draftReply,
    pendingUser: stream.pendingUser,
    startedAt: stream.startedAt,
    charCount: stream.charCount,
    error: stream.error,
  };
}
