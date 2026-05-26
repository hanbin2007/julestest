import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { chatNewSchema, parseBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 显式创建新 chat。切换器 / 中心页「新建」走这里,先建 chat 再让用户发首条消息。
// 不在 POST /api/chat 里内联创建,是为了让客户端 stream 状态从 t=0 就有 chatId 做键,
// 避免 "pending key → real key" 的换键复杂度(支撑后台并行的关键)。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, chatNewSchema);
  if (error) return error;
  const { kind, productId, videoId } = data;
  const id = `c-${randomUUID()}`;
  const chat = await prisma.chat.create({
    data: {
      id,
      kind,
      productId: kind === "lesson" ? productId! : null,
      videoId: kind === "lesson" ? videoId! : null,
      title: null,
      sessionId: null,
    },
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
  });
}
