import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { chatSchema, parseBody } from "@/lib/validate";
import { askStream } from "@/lib/claude";
import { saveChatImage } from "@/lib/chatImages";
import { getCatalogRollup } from "@/lib/catalogRollup";
import { SYSTEM_PROMPT_MAX } from "@/lib/chatPrefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 单聊天历史 + chat 元信息。chat 元用于 UI 上方标题/绑定标识(原绑定课程/讲)。
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const chatId = sp.get("chatId");
  if (!chatId) return Response.json({ error: "missing chatId" }, { status: 400 });
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) return Response.json({ error: "chat not found" }, { status: 404 });
  const rows = await prisma.chatMessage.findMany({
    where: { chatId },
    orderBy: { at: "asc" },
  });
  return Response.json({
    chat: {
      id: chat.id,
      kind: chat.kind,
      productId: chat.productId,
      videoId: chat.videoId,
      title: chat.title,
      createdAt: chat.createdAt.getTime(),
      updatedAt: chat.updatedAt.getTime(),
    },
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      text: r.text,
      image: r.image,
      videoT: r.videoT,
      videoId: r.videoId,
      productId: r.productId,
      at: r.at.getTime(),
    })),
  });
}

const rid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// 把首条用户消息截到 ~40 字作为 chat 标题(尾部 …)。已有 title 不动。
function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= 40) return t;
  // 防止 surrogate pair 截一半
  let cut = 40;
  while (cut > 0 && /[\uD800-\uDBFF]/.test(t.charAt(cut - 1))) cut--;
  return t.slice(0, cut) + "…";
}

// 发消息：要求 chatId(新建走 /api/chat/new),落用户消息 → askStream(resume) → SSE 流回 →
// 落助手消息 + 更新 sessionId。abort 时只保留用户消息,sessionId/助手消息都不写(下次能续上)。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, chatSchema);
  if (error) return error;
  const { chatId, text, image, effort, videoT, currentProductId, currentVideoId } = data;

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) return Response.json({ error: "chat not found" }, { status: 404 });

  // 落用户消息(附图存盘)。productId/videoId 记录「发送时所看的讲」,可空。
  const userId = rid();
  let imageBase64: string | undefined;
  let imageMediaType: string | undefined;
  let imageRef: string | null = null;
  if (image) {
    const m = image.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
    if (m) {
      imageMediaType = m[1];
      imageBase64 = m[2];
      try {
        await saveChatImage(userId, Buffer.from(imageBase64, "base64"));
        imageRef = userId;
      } catch {
        imageRef = null;
      }
    }
  }
  await prisma.chatMessage.create({
    data: {
      id: userId,
      chatId,
      videoId: currentVideoId ?? null,
      productId: currentProductId ?? null,
      role: "user",
      text,
      image: imageRef,
      videoT: videoT ?? null,
    },
  });

  // 首条用户消息且 chat 还无标题 → 派生一个。乐观写,不阻塞流。
  if (!chat.title) {
    const title = deriveTitle(text);
    if (title) {
      prisma.chat
        .update({ where: { id: chatId }, data: { title } })
        .catch(() => {/* 标题派生失败不影响主流程 */});
    }
  }

  // 上下文：仅 lesson 类 chat 注入 课程/讲 上下文，且用「当前所看的讲」而不是 chat 自己
  // 绑定的讲(支持跨讲复用同一 chat 时,system prompt 跟得上)。independent 不注入。
  let context: { courseName?: string; lessonTitle?: string } | undefined;
  if (chat.kind === "lesson" && currentProductId != null && currentVideoId != null) {
    try {
      const rollup = await getCatalogRollup();
      const meta = rollup.byCourseVid.get(`${currentProductId}:${currentVideoId}`);
      if (meta) context = { courseName: meta.courseName, lessonTitle: meta.title ?? undefined };
    } catch {
      /* ignore */
    }
  }

  // 用户自定义系统提示词(空则用内置默认)
  let systemPrompt: string | undefined;
  try {
    const row = await prisma.setting.findUnique({ where: { key: "prefs" } });
    if (row) {
      const v = (JSON.parse(row.value) as { systemPrompt?: string }).systemPrompt;
      if (typeof v === "string" && v.length <= SYSTEM_PROMPT_MAX) systemPrompt = v;
    }
  } catch {
    /* ignore，退化为默认人格 */
  }

  const enc = new TextEncoder();
  const send = (ctrl: ReadableStreamDefaultController, obj: unknown) =>
    ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

  const stream = new ReadableStream({
    async start(controller) {
      let finalText = "";
      let sessionId: string | null = null;
      let ok = false;
      try {
        for await (const ev of askStream({
          text,
          imageBase64,
          imageMediaType,
          sessionId: chat.sessionId ?? undefined,
          context,
          systemPrompt,
          effort,
          signal: req.signal,
        })) {
          if (req.signal.aborted) break;
          if (ev.type === "session") {
            sessionId = ev.sessionId;
          } else if (ev.type === "delta") {
            finalText += ev.text;
            send(controller, { delta: ev.text });
          } else if (ev.type === "error") {
            send(controller, { error: ev.message });
          } else if (ev.type === "done") {
            if (ev.text) finalText = ev.text;
            ok = true;
          }
        }
        // 仅在干净完成且未被取消时落库 + 更新 sessionId。abort 时这两步都跳过,保留
        // 停止前的 sessionId,下次发消息能从上次成功的位置 resume。
        if (ok && !req.signal.aborted && finalText.trim()) {
          await prisma.chatMessage.create({
            data: {
              id: `${rid()}-a`,
              chatId,
              videoId: currentVideoId ?? null,
              productId: currentProductId ?? null,
              role: "assistant",
              text: finalText,
              videoT: videoT ?? null,
            },
          });
        }
        if (ok && !req.signal.aborted) {
          // 拿到新 sessionId 就覆盖;否则只动 updatedAt(让 /api/chats 排序贴最新),
          // 不动 sessionId 防丢上次 session。
          await prisma.chat.update({
            where: { id: chatId },
            data: sessionId
              ? { sessionId, updatedAt: new Date() }
              : { updatedAt: new Date() },
          });
        }
        send(controller, { done: true });
      } catch (e) {
        send(controller, { error: (e as Error).message || "对话失败" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    },
  });
}
