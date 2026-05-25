import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod";
import { parseBody } from "@/lib/validate";
import { deleteChatImages } from "@/lib/chatImages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  videoId: z.coerce.number().int().positive(),
  productId: z.coerce.number().int(), // 必填:按 (productId,videoId) 精确清空，避免误删同 videoId 的其它课对话
});

// 清空某讲对话：删消息 + 断开会话（下次重新开一个 session）+ 连带删附图文件。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, schema);
  if (error) return error;
  const { videoId, productId } = data;
  // 先取出待删消息里有附图的，删完库再删盘（best-effort）。
  const withImg = await prisma.chatMessage.findMany({
    where: { productId, videoId, image: { not: null } },
    select: { image: true },
  });
  await deleteChatImages(withImg.map((r) => r.image as string));
  await prisma.chatMessage.deleteMany({ where: { productId, videoId } });
  await prisma.chatThread.deleteMany({ where: { productId, videoId } });
  return Response.json({ ok: true });
}
