/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync } from "fs";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { chatSessionDir } from "./chatImages";

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
}

export type ChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "delta"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

function buildSystemPrompt(ctx?: ChatContext): string {
  const where =
    ctx?.courseName || ctx?.lessonTitle
      ? `学生正在看课程「${ctx?.courseName ?? ""}」的「${ctx?.lessonTitle ?? ""}」这一讲。`
      : "";
  return [
    "你是一位耐心、严谨的中文理科助教（数学 / 物理 / 化学 / 生物等）。",
    where,
    "学生可能发来课程画面截图或他在画面上的批注（圈画、标注、写的步骤）。请：",
    "- 先看懂图里的题目 / 图形 / 公式，必要时先复述你的理解再作答；",
    "- 讲清思路与每一步推导，而不是只丢最终答案；",
    "- 用简洁的中文；公式可用文本或简单符号表达；",
    "- 信息不足时，先指出缺什么，再在合理假设下给出解法。",
  ]
    .filter(Boolean)
    .join("\n");
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

  return {
    model: "claude-opus-4-7",
    tools: [], // 纯问答，关闭全部内置工具
    settingSources: [], // 不加载 ~/.claude 与项目 .claude（避免污染助教人格）
    includePartialMessages: true, // 逐字流式
    systemPrompt: buildSystemPrompt(p.context),
    cwd,
    env: env as NodeJS.ProcessEnv,
    ...(p.sessionId ? { resume: p.sessionId } : {}),
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
        if (m.error) yield { type: "error", message: String(m.error) };
      } else if (m.type === "result") {
        yield { type: "done", text: finalText };
        return;
      }
    }
    yield { type: "done", text: finalText };
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
