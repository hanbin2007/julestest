import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod";
import { parseBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ videoId: z.coerce.number().int().positive() });

// 清空某讲对话：删消息 + 断开会话（下次重新开一个 session）。附图文件留着不强删。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, schema);
  if (error) return error;
  const { videoId } = data;
  await prisma.chatMessage.deleteMany({ where: { videoId } });
  await prisma.chatThread.deleteMany({ where: { videoId } });
  return Response.json({ ok: true });
}
