import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { chatRenameSchema, parseBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, chatRenameSchema);
  if (error) return error;
  const { chatId, title } = data;
  try {
    const chat = await prisma.chat.update({
      where: { id: chatId },
      data: { title: title.trim() },
    });
    return Response.json({
      ok: true,
      chat: {
        id: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt.getTime(),
      },
    });
  } catch {
    return Response.json({ error: "chat not found" }, { status: 404 });
  }
}
