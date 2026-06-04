"use client";
import * as React from "react";
import useSWR, { mutate as globalMutate } from "swr";
import * as api from "@/lib/api";
import * as chatStreams from "@/lib/chatStreams";
import type { ChatsStats, EnrichedChat } from "@/lib/store";

// 中心页 /chats 用:全量富化聊天列表 + 统计。变更后顺手扫所有 /api/chats? 变体让切换器同步。
export function useAllChats() {
  const key = api.chatsListKey(); // "/api/chats"
  const { data, error, isLoading, mutate } = useSWR(key, () => api.getChats(), {
    revalidateOnFocus: true,
  });
  const chats: EnrichedChat[] = data?.chats ?? [];
  const stats: ChatsStats = data?.stats ?? { total: 0, lesson: 0, independent: 0, courses: 0 };

  const refresh = React.useCallback(() => {
    void mutate();
    void globalMutate((k) => typeof k === "string" && k.startsWith("/api/chats?"));
  }, [mutate]);

  const create = React.useCallback(
    async (kind: "lesson" | "independent", productId?: number, videoId?: number) => {
      const r = await api.newChat(kind, productId, videoId);
      refresh();
      return r.chat;
    },
    [refresh],
  );

  const rename = React.useCallback(
    async (id: string, title: string) => {
      await api.renameChat(id, title);
      refresh();
    },
    [refresh],
  );

  const remove = React.useCallback(
    async (id: string) => {
      chatStreams.stop(id);
      await api.deleteChat(id);
      chatStreams.forget(id);
      refresh();
    },
    [refresh],
  );

  return { chats, stats, create, rename, remove, error, isLoading, refresh };
}
