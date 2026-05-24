import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { chatSchema, parseBody } from "@/lib/validate";
import { askStream } from "@/lib/claude";
import { saveChatImage } from "@/lib/chatImages";
import { getCatalogRollup } from "@/lib/catalogRollup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 某讲的对话历史（UI 渲染真相源）。
export async function GET(req: NextRequest) {
  const videoId = Number(new URL(req.url).searchParams.get("videoId") ?? "");
  if (!videoId) return Response.json({ error: "missing videoId" }, { status: 400 });
  const rows = await prisma.chatMessage.findMany({ where: { videoId }, orderBy: { at: "asc" } });
  return Response.json({
    messages: rows.map((r) => ({ id: r.id, role: r.role, text: r.text, image: r.image, at: r.at.getTime() })),
  });
}

const rid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// 发一条消息：落用户消息 → 调订阅版 Claude（resume 续上下文）→ SSE 流式回传 → 落助手消息。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, chatSchema);
  if (error) return error;
  const { videoId, productId, text, image, effort } = data;

  // 落用户消息（附图存盘）
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
    data: { id: userId, videoId, productId: productId ?? null, role: "user", text, image: imageRef },
  });

  // 上下文：课程/讲标题（best-effort）。有 productId 则精确取课，否则回退 byVid。
  let context: { courseName?: string; lessonTitle?: string } | undefined;
  try {
    const rollup = await getCatalogRollup();
    const meta =
      productId != null ? rollup.byCourseVid.get(`${productId}:${videoId}`) : rollup.byVid.get(videoId);
    if (meta) context = { courseName: meta.courseName, lessonTitle: meta.title ?? undefined };
  } catch {
    /* ignore */
  }

  const thread = await prisma.chatThread.findUnique({ where: { videoId } });

  // 用户自定义系统提示词（存在 Setting('prefs').systemPrompt；空则用内置默认）
  let systemPrompt: string | undefined;
  try {
    const row = await prisma.setting.findUnique({ where: { key: "prefs" } });
    if (row) systemPrompt = (JSON.parse(row.value) as { systemPrompt?: string }).systemPrompt;
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
      try {
        for await (const ev of askStream({ text, imageBase64, imageMediaType, sessionId: thread?.sessionId ?? undefined, context, systemPrompt, effort })) {
          if (req.signal.aborted) break;
          if (ev.type === "session") {
            sessionId = ev.sessionId;
          } else if (ev.type === "delta") {
            finalText += ev.text;
            send(controller, { delta: ev.text });
          } else if (ev.type === "error") {
            send(controller, { error: ev.message });
          } else if (ev.type === "done") {
            if (ev.text) finalText = ev.text; // 以完整助手文本为准
          }
        }
        // 落助手消息 + 会话 id（用于下次 resume）
        if (finalText.trim()) {
          await prisma.chatMessage.create({
            data: { id: `${rid()}-a`, videoId, productId: productId ?? null, role: "assistant", text: finalText },
          });
        }
        if (sessionId) {
          await prisma.chatThread.upsert({
            where: { videoId },
            create: { videoId, productId: productId ?? null, sessionId },
            update: { sessionId, productId: productId ?? null },
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
