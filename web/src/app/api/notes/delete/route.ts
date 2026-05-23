import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { deleteSnaps } from "@/lib/noteSnaps";
import { noteDeleteSchema, parseBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 细粒度删除（幂等）。返回该讲剩余笔记。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, noteDeleteSchema);
  if (error) return error;
  const { videoId, id } = data;
  await prisma.note.deleteMany({ where: { videoId, id } });
  await deleteSnaps([id]); // 连带删手动截图，避免孤儿文件
  const rows = await prisma.note.findMany({ where: { videoId }, orderBy: { t: "asc" } });
  return Response.json({
    ok: true,
    notes: rows.map((r) => ({ id: r.id, t: r.t, text: r.text, at: r.at.getTime() })),
  });
}
