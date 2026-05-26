"use client";
import * as React from "react";
import useSWR, { mutate as globalMutate } from "swr";
import * as api from "@/lib/api";
import * as chatStreams from "@/lib/chatStreams";
import type { EnrichedChat } from "@/lib/store";

// 本讲下所有 chat 列表(切换器用)。变更后既 mutate 本 key 也 globalMutate 全局 /api/chats key
// 让中心页同步。
export function useLessonChats(productId: number | null, videoId: number | null) {
  const key =
    productId != null && videoId != null
      ? api.chatsListKey({ scope: "lesson", productId, videoId })
      : null;
  const { data, mutate } = useSWR(
    key,
    key ? () => api.getChats({ scope: "lesson", productId: productId!, videoId: videoId! }) : null,
    { revalidateOnFocus: true },
  );
  const chats: EnrichedChat[] = data?.chats ?? [];

  const refresh = React.useCallback(() => {
    void mutate();
    void globalMutate(
      (k) => typeof k === "string" && (k === "/api/chats" || k.startsWith("/api/chats?")),
    );
  }, [mutate]);

  const create = React.useCallback(async (): Promise<string | null> => {
    if (productId == null || videoId == null) return null;
    const r = await api.newChat("lesson", productId, videoId);
    refresh();
    return r.chat.id;
  }, [productId, videoId, refresh]);

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

  return { chats, mutate: refresh, create, rename, remove };
}
