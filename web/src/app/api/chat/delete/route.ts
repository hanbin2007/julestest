import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { chatDeleteSchema, parseBody } from "@/lib/validate";
import { deleteChatImages } from "@/lib/chatImages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 删除一个 chat:先 best-effort 清盘上的附图,再删 chat(FK 级联删消息)。
// 取代了原 /api/chat/clear:多聊天下「清空」语义已变为「删除整个 chat,从切换器新建一条」。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, chatDeleteSchema);
  if (error) return error;
  const { chatId } = data;
  const withImg = await prisma.chatMessage.findMany({
    where: { chatId, image: { not: null } },
    select: { image: true },
  });
  await deleteChatImages(withImg.map((r) => r.image as string));
  try {
    await prisma.chat.delete({ where: { id: chatId } });
  } catch {
    // 已删或不存在 → 视为成功(幂等)
  }
  return Response.json({ ok: true });
}
