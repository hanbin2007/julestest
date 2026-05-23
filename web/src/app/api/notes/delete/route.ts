import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 细粒度删除（幂等）。返回该讲剩余笔记。
export async function POST(req: NextRequest) {
  const d = await req.json().catch(() => ({}));
  const videoId = Number(d.videoId);
  const id = String(d.id ?? "");
  if (!videoId || !id) return Response.json({ error: "need videoId+id" }, { status: 400 });
  await prisma.note.deleteMany({ where: { videoId, id } });
  const rows = await prisma.note.findMany({ where: { videoId }, orderBy: { t: "asc" } });
  return Response.json({
    ok: true,
    notes: rows.map((r) => ({ id: r.id, t: r.t, text: r.text, at: r.at.getTime() })),
  });
}
