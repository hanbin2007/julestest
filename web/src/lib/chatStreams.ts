// 跨组件、跨 chat 的流式状态层。
//
// 为什么不放在 React state 里:`useChat` 是组件级 hook,组件卸载会清理 fetch/abort 控制器,
// 切 chat 就会打断进行中的流 — 这与「多个对话可后台并行」直接冲突。所以把 SSE 流的状态
// 搬到模块级单例:用 Map<chatId, StreamState> 存,事件订阅广播,React 侧 useSyncExternalStore
// 订阅。流的生命周期与任何组件 mount 无关,只在用户主动停止 / 流自然结束 / 出错时收尾。
//
// 这同时支撑了:进度展示(列表/卡片任意位置都能订阅同一 chatId 看到 phase/秒数/字数),
// 停止(模块单例上调 ctrl.abort()),全局活跃 badge(isAnyStreaming 聚合订阅)。
"use client";

import { mutate as globalMutate } from "swr";
import type { ChatEffort } from "./chatPrefs";

export type StreamPhase = "idle" | "streaming" | "error";

export interface StreamState {
  phase: StreamPhase;
  draftReply: string;
  pendingUser: { text: string; image?: string; videoT?: number } | null;
  startedAt: number | null;
  charCount: number;
  error: string | null;
}

const IDLE: StreamState = {
  phase: "idle",
  draftReply: "",
  pendingUser: null,
  startedAt: null,
  charCount: 0,
  error: null,
};

// 内部:控制器 + 状态。控制器不放进 StreamState 是为了让 state 浅比较稳定且可序列化展示。
interface InternalState extends StreamState {
  ctrl: AbortController | null;
}

const streams = new Map<string, InternalState>();
const listeners = new Map<string, Set<() => void>>();
const globalListeners = new Set<() => void>();

function ensure(chatId: string): InternalState {
  let s = streams.get(chatId);
  if (!s) {
    s = { ...IDLE, ctrl: null };
    streams.set(chatId, s);
  }
  return s;
}

function emit(chatId: string) {
  const set = listeners.get(chatId);
  if (set) for (const cb of set) cb();
  for (const cb of globalListeners) cb();
}

export function get(chatId: string | null): StreamState {
  if (!chatId) return IDLE;
  const s = streams.get(chatId);
  if (!s) return IDLE;
  // 返回去掉 ctrl 的快照;同一帧多次 get 返回同对象引用以让 useSyncExternalStore 的 ===
  // 浅比较稳定。这里靠 emit 之后才换新对象;读取时返回当前 cached snapshot。
  return s as StreamState;
}

export function subscribe(chatId: string | null, cb: () => void): () => void {
  if (!chatId) return () => {};
  let set = listeners.get(chatId);
  if (!set) {
    set = new Set();
    listeners.set(chatId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(chatId);
  };
}

// 全局活跃指示器(顶栏 badge 用):任一 chat streaming → true。
export function subscribeAny(cb: () => void): () => void {
  globalListeners.add(cb);
  return () => globalListeners.delete(cb);
}
export function isAnyStreaming(): boolean {
  for (const s of streams.values()) if (s.phase === "streaming") return true;
  return false;
}

function setState(chatId: string, patch: Partial<InternalState>) {
  const cur = ensure(chatId);
  // 用新对象引用替换,确保 useSyncExternalStore 的浅比较视为变更。
  const next = { ...cur, ...patch };
  streams.set(chatId, next);
  emit(chatId);
}

export interface SendBody {
  chatId: string;
  text: string;
  image?: string;
  effort?: ChatEffort;
  videoT?: number;
  currentProductId?: number | null;
  currentVideoId?: number | null;
}

// 发消息 + 跑 SSE。返回 promise 仅供调用方可选 await(通常不 await — fire and forget,状态从订阅看)。
export async function startSend(body: SendBody): Promise<void> {
  const { chatId } = body;
  // 已有在跑 → 拒绝(UI 应禁用发送按钮)
  const cur = ensure(chatId);
  if (cur.phase === "streaming") return;

  const ctrl = new AbortController();
  setState(chatId, {
    phase: "streaming",
    pendingUser: { text: body.text, image: body.image, videoT: body.videoT },
    draftReply: "",
    startedAt: Date.now(),
    charCount: 0,
    error: null,
    ctrl,
  });

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      if (res.status === 404) throw new Error("聊天已被删除");
      throw new Error(`HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let acc = "";
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
          // 直接写 streams[chatId].draftReply,避免每个 delta 都 spread 一遍 — 但要 emit。
          const s = ensure(chatId);
          streams.set(chatId, { ...s, draftReply: acc, charCount: acc.length });
          emit(chatId);
        } else if (obj.error) {
          setState(chatId, { error: obj.error });
        }
      }
    }
    // 干净完结:清流态,触发 SWR revalidate 让历史拉回服务端落库的助手消息。
    setState(chatId, {
      phase: "idle",
      draftReply: "",
      pendingUser: null,
      startedAt: null,
      charCount: 0,
      error: null,
      ctrl: null,
    });
    void globalMutate(`/api/chat?chatId=${chatId}`);
    void globalMutate(
      (k) =>
        typeof k === "string" && (k === "/api/chats" || k.startsWith("/api/chats?")),
    );
  } catch (e) {
    const isAbort = (e as Error).name === "AbortError";
    setState(chatId, {
      phase: "error",
      draftReply: "", // 抛弃半截助手回复,只保留用户消息(已落库)
      pendingUser: null,
      startedAt: null,
      charCount: 0,
      error: isAbort ? "已停止" : (e as Error).message || "对话失败",
      ctrl: null,
    });
    // 仍然 revalidate 让已落库的用户消息显示出来(供「重试」)
    void globalMutate(`/api/chat?chatId=${chatId}`);
    void globalMutate(
      (k) =>
        typeof k === "string" && (k === "/api/chats" || k.startsWith("/api/chats?")),
    );
  }
}

// 用户主动停止。等价于 ctrl.abort();剩余收尾走 startSend 的 catch 分支(error='已停止')。
export function stop(chatId: string): void {
  const s = streams.get(chatId);
  if (s?.ctrl) s.ctrl.abort();
}

// 清掉某 chat 的 entry(删除 chat 后调,避免 Map 漏)。
export function forget(chatId: string): void {
  stop(chatId);
  streams.delete(chatId);
  listeners.delete(chatId);
  for (const cb of globalListeners) cb();
}

// 清流态的「错误」标记,通常在用户点「重试」前用,避免 chip 残留。
export function clearError(chatId: string): void {
  const s = streams.get(chatId);
  if (s && s.phase === "error") {
    setState(chatId, { phase: "idle", error: null });
  }
}
