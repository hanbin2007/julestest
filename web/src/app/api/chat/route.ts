import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { chatSchema, parseBody } from "@/lib/validate";
import { askStream } from "@/lib/claude";
import { saveChatImage } from "@/lib/chatImages";
import { getCatalogRollup } from "@/lib/catalogRollup";
import { SYSTEM_PROMPT_MAX } from "@/lib/chatPrefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 某讲的对话历史（UI 渲染真相源）。
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const videoId = Number(sp.get("videoId") ?? "");
  if (!videoId) return Response.json({ error: "missing videoId" }, { status: 400 });
  // productId 缺省(空)→按 videoId 取全部同讲消息；传了真值→按 (productId,videoId) 收窄，
  // 并兜底带上旧的 productId 为 null 的历史行（迁移前写入的）。
  const pidRaw = sp.get("productId");
  const pid = pidRaw != null && pidRaw !== "" ? Number(pidRaw) : null;
  const where =
    pid != null && Number.isFinite(pid)
      ? { videoId, OR: [{ productId: pid }, { productId: null }] }
      : { videoId };
  const rows = await prisma.chatMessage.findMany({ where, orderBy: { at: "asc" } });
  return Response.json({
    messages: rows.map((r) => ({ id: r.id, role: r.role, text: r.text, image: r.image, videoT: r.videoT, at: r.at.getTime() })),
  });
}

const rid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// 发一条消息：落用户消息 → 调订阅版 Claude（resume 续上下文）→ SSE 流式回传 → 落助手消息。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, chatSchema);
  if (error) return error;
  const { videoId, productId, text, image, effort, videoT } = data;

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
    data: { id: userId, videoId, productId: productId ?? 0, role: "user", text, image: imageRef, videoT: videoT ?? null },
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

  const thread = await prisma.chatThread.findUnique({
    where: { productId_videoId: { productId: productId ?? 0, videoId } },
  });

  // 用户自定义系统提示词（存在 Setting('prefs').systemPrompt；空则用内置默认）
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
      let ok = false; // 只在收到干净 done 时置真；error/异常中断/取消都不落库
      try {
        for await (const ev of askStream({ text, imageBase64, imageMediaType, sessionId: thread?.sessionId ?? undefined, context, systemPrompt, effort, signal: req.signal })) {
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
            ok = true;
          }
        }
        // 落助手消息 + 会话 id（用于下次 resume）。仅在干净完成且未被取消时落库。
        if (ok && !req.signal.aborted && finalText.trim()) {
          await prisma.chatMessage.create({
            data: { id: `${rid()}-a`, videoId, productId: productId ?? 0, role: "assistant", text: finalText, videoT: videoT ?? null },
          });
        }
        if (ok && !req.signal.aborted && sessionId) {
          await prisma.chatThread.upsert({
            where: { productId_videoId: { productId: productId ?? 0, videoId } },
            create: { videoId, productId: productId ?? 0, sessionId },
            update: { sessionId, productId: productId ?? 0 },
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
