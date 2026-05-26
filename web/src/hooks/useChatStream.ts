"use client";
import * as React from "react";
import * as chatStreams from "@/lib/chatStreams";
import type { StreamState } from "@/lib/chatStreams";

// 列表/卡片场景的「只读」订阅:任何位置都能拿到指定 chatId 的实时流态(phase/已 N 秒/字数/error)。
// 不发起请求,纯订阅模块单例。chatId 为 null 直接返回 idle 占位。
export function useChatStream(chatId: string | null): StreamState {
  return React.useSyncExternalStore(
    React.useCallback((cb) => chatStreams.subscribe(chatId, cb), [chatId]),
    React.useCallback(() => chatStreams.get(chatId), [chatId]),
    React.useCallback(() => chatStreams.get(chatId), [chatId]),
  );
}

// 全局活跃指示器(顶栏 badge 用)。
export function useAnyChatStreaming(): boolean {
  return React.useSyncExternalStore(
    chatStreams.subscribeAny,
    chatStreams.isAnyStreaming,
    chatStreams.isAnyStreaming,
  );
}
