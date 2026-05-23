import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 细粒度改文案（幂等）。只改 text，不动创建时间 at；返回该讲整列表供前端对账。
export async function POST(req: NextRequest) {
  const d = await req.json().catch(() => ({}));
  const videoId = Number(d.videoId);
  const id = String(d.id ?? "");
  const text = String(d.text ?? "").trim();
  if (!videoId || !id || !text) {
    return Response.json({ error: "need videoId+id+text" }, { status: 400 });
  }
  await prisma.note.updateMany({ where: { videoId, id }, data: { text } });
  const rows = await prisma.note.findMany({ where: { videoId }, orderBy: { t: "asc" } });
  return Response.json({
    ok: true,
    notes: rows.map((r) => ({ id: r.id, t: r.t, text: r.text, at: r.at.getTime() })),
  });
}
