import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 细粒度新增：服务端分配 id/at，避免多设备整列表互相覆盖。返回整列表供前端对账。
export async function POST(req: NextRequest) {
  const d = await req.json().catch(() => ({}));
  const videoId = Number(d.videoId);
  const text = String(d.text ?? "").trim();
  if (!videoId || !text) return Response.json({ error: "need videoId+text" }, { status: 400 });
  const t = Math.floor(Number(d.t) || 0);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await prisma.note.create({ data: { id, videoId, t, text } });
  const rows = await prisma.note.findMany({ where: { videoId }, orderBy: { t: "asc" } });
  const notes = rows.map((r) => ({ id: r.id, t: r.t, text: r.text, at: r.at.getTime() }));
  return Response.json({ note: notes.find((n) => n.id === id), notes });
}
