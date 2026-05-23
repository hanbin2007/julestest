"use client";
import * as React from "react";
import useSWR from "swr";
import * as api from "@/lib/api";
import type { ChatMessage } from "@/lib/store";

// 按讲对话：SWR 拉历史 + 流式发送（读 SSE）。流式中把「待发用户消息 + 进行中的助手回复」
// 叠加在历史之上展示；done 后 revalidate，让服务端落库的消息接管。

export function useChat(videoId: number | null) {
  const key = videoId == null ? null : `/api/chat?videoId=${videoId}`;
  const { data, mutate } = useSWR(key, () => api.getChat(videoId as number), { revalidateOnFocus: false });
  const history: ChatMessage[] = data?.messages ?? [];

  const [streaming, setStreaming] = React.useState(false);
  const [draftReply, setDraftReply] = React.useState("");
  const [pendingUser, setPendingUser] = React.useState<{ text: string; image?: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const send = React.useCallback(
    async (text: string, image?: string) => {
      const vid = videoId;
      if (vid == null || !text.trim() || streaming) return;
      setError(null);
      setPendingUser({ text: text.trim(), image });
      setDraftReply("");
      setStreaming(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: vid, text: text.trim(), image }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let acc = "";
        // 逐帧解析 SSE：以空行分隔，data: <json>
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 2);
            if (!frame.startsWith("data:")) continue;
            const payload = frame.slice(5).trim();
            let obj: { delta?: string; done?: boolean; error?: string };
            try {
              obj = JSON.parse(payload);
            } catch {
              continue;
            }
            if (obj.delta) {
              acc += obj.delta;
              setDraftReply(acc);
            } else if (obj.error) {
              setError(obj.error);
            }
            // obj.done 时不必特殊处理，循环会随流结束
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message || "对话失败");
      } finally {
        setStreaming(false);
        setPendingUser(null);
        setDraftReply("");
        abortRef.current = null;
        await mutate(); // 拉回服务端落库的用户+助手消息
      }
    },
    [videoId, streaming, mutate]
  );

  const clear = React.useCallback(async () => {
    if (videoId == null) return;
    await api.clearChat(videoId);
    await mutate({ messages: [] }, { revalidate: false });
  }, [videoId, mutate]);

  return { history, send, clear, streaming, draftReply, pendingUser, error };
}
