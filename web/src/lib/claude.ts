/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync } from "fs";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { chatSessionDir } from "./chatImages";
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_EFFORT, type ChatEffort } from "./chatPrefs";

// 用 Claude Agent SDK 驱动的「理科助教」——复用本机已登录的 Claude 订阅（不走计费 API）。
// 纯问答：关掉全部工具、不加载本项目/用户的 .claude 配置；多轮靠会话 resume。

export interface ChatContext {
  courseName?: string;
  lessonTitle?: string;
}

export interface AskParams {
  text: string;
  imageBase64?: string; // 纯 base64（无 data: 前缀）
  imageMediaType?: string; // 默认 image/jpeg
  sessionId?: string | null; // 有则 resume 续上下文
  context?: ChatContext;
  systemPrompt?: string; // 用户在设置里自定义的系统提示词（空则用默认）
  effort?: ChatEffort; // 思考等级
  signal?: AbortSignal; // 客户端断连/切讲时中止 SDK query
}

export type ChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "delta"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

function buildSystemPrompt(ctx?: ChatContext, custom?: string): string {
  // 基底人格 = 用户自定义（非空）否则内置默认；课程/讲上下文始终自动追加。
  const base = custom?.trim() ? custom.trim() : DEFAULT_SYSTEM_PROMPT;
  const where =
    ctx?.courseName || ctx?.lessonTitle
      ? `学生正在看课程「${ctx?.courseName ?? ""}」的「${ctx?.lessonTitle ?? ""}」这一讲。`
      : "";
  return [base, where].filter(Boolean).join("\n");
}

function buildOptions(p: AskParams): Options {
  // 强制走订阅：移除 ANTHROPIC_API_KEY（设了它会优先于订阅）。保留其余 env（PATH/HOME 等，
  // keychain 凭据读取需要），CLAUDE_CODE_OAUTH_TOKEN 若有也保留。
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const cwd = chatSessionDir();
  try {
    mkdirSync(cwd, { recursive: true });
  } catch {
    /* ignore */
  }

  // SDK 取消用 abortController（非裸 signal）；把传入的 AbortSignal 桥接到一个 controller。
  let abortController: AbortController | undefined;
  if (p.signal) {
    abortController = new AbortController();
    if (p.signal.aborted) abortController.abort();
    else p.signal.addEventListener("abort", () => abortController!.abort(), { once: true });
  }

  return {
    model: "claude-opus-4-7",
    tools: [], // 纯问答，关闭全部内置工具
    settingSources: [], // 不加载 ~/.claude 与项目 .claude（避免污染助教人格）
    includePartialMessages: true, // 逐字流式
    systemPrompt: buildSystemPrompt(p.context, p.systemPrompt),
    effort: p.effort ?? DEFAULT_EFFORT, // 思考等级；adaptive thinking 为 Opus 4.7 默认
    cwd,
    env: env as NodeJS.ProcessEnv,
    ...(p.sessionId ? { resume: p.sessionId } : {}),
    ...(abortController ? { abortController } : {}),
  };
}

function imagePrompt(p: AskParams): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: p.imageMediaType ?? "image/jpeg", data: p.imageBase64 },
          },
          { type: "text", text: p.text },
        ],
      },
    } as unknown as SDKUserMessage;
  })();
}

/** 发一条消息，流式产出事件。带图用 streaming-input，纯文本用 string prompt。 */
export async function* askStream(p: AskParams): AsyncGenerator<ChatEvent> {
  const options = buildOptions(p);
  const prompt = p.imageBase64 ? imagePrompt(p) : p.text;

  let finalText = "";
  let sessionSent = false;
  let sawResult = false;
  const q = query({ prompt, options });
  try {
    for await (const m of q as AsyncIterable<any>) {
      const sid = m?.session_id as string | undefined;
      if (sid && !sessionSent) {
        sessionSent = true;
        yield { type: "session", sessionId: sid };
      }
      if (m.type === "stream_event") {
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          yield { type: "delta", text: ev.delta.text as string };
        }
      } else if (m.type === "assistant") {
        const blocks = m.message?.content ?? [];
        finalText = blocks
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        // 助手层错误（鉴权/限流等）是终态：报错后立即结束，别再当成功落库。
        if (m.error) {
          yield { type: "error", message: String(m.error) };
          return;
        }
      } else if (m.type === "result") {
        sawResult = true;
        // result 是终态：失败子类型/is_error 一律报错，绝不当成功 done。
        if (m.subtype !== "success" || m.is_error) {
          yield {
            type: "error",
            message: (Array.isArray(m.errors) ? m.errors.join("; ") : "") || m.subtype || "对话失败",
          };
          return;
        }
        yield { type: "done", text: m.result || finalText };
        return;
      }
    }
    // 流结束却没收到 result（异常中断）：不要发裸 done（会被当成功落库）。
    if (!sawResult) yield { type: "error", message: "对话异常结束" };
  } catch (e) {
    yield { type: "error", message: (e as Error).message || "Claude 调用失败" };
  } finally {
    try {
      (q as any).close?.();
    } catch {
      /* ignore */
    }
  }
}
