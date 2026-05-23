import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { noteAddSchema, parseBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 细粒度新增：服务端分配 id/at，避免多设备整列表互相覆盖。返回整列表供前端对账。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, noteAddSchema);
  if (error) return error;
  const { videoId, text, t } = data;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await prisma.note.create({ data: { id, videoId, t, text } });
  const rows = await prisma.note.findMany({ where: { videoId }, orderBy: { t: "asc" } });
  const notes = rows.map((r) => ({ id: r.id, t: r.t, text: r.text, at: r.at.getTime() }));
  return Response.json({ note: notes.find((n) => n.id === id), notes });
}
