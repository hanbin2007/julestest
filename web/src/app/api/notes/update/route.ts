import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { noteUpdateSchema, parseBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 细粒度改文案（幂等）。只改 text，不动创建时间 at；返回该讲整列表供前端对账。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, noteUpdateSchema);
  if (error) return error;
  const { videoId, id, text, strokes } = data;
  // strokes 仅在传入时更新（再编辑批注）；不传则只改文案，保留原笔迹。
  const patch = strokes === undefined ? { text } : { text, strokes };
  await prisma.note.updateMany({ where: { videoId, id }, data: patch });
  const rows = await prisma.note.findMany({ where: { videoId }, orderBy: { t: "asc" } });
  return Response.json({
    ok: true,
    notes: rows.map((r) => ({ id: r.id, t: r.t, text: r.text, strokes: r.strokes, at: r.at.getTime() })),
  });
}
