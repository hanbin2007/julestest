import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 某讲的时间戳笔记（服务端共享）。
export async function GET(req: NextRequest) {
  const videoId = Number(new URL(req.url).searchParams.get("videoId") ?? "");
  if (!videoId) return Response.json({ error: "missing videoId" }, { status: 400 });
  const rows = await prisma.note.findMany({ where: { videoId }, orderBy: { t: "asc" } });
  return Response.json({
    notes: rows.map((r) => ({ id: r.id, t: r.t, text: r.text, strokes: r.strokes, at: r.at.getTime() })),
  });
}
