import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 批量删除（按全局唯一主键 id，幂等）。返回实删条数。
export async function POST(req: NextRequest) {
  const d = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(d.ids) ? d.ids.map(String).filter(Boolean) : [];
  if (ids.length === 0) return Response.json({ error: "need ids[]" }, { status: 400 });
  const r = await prisma.note.deleteMany({ where: { id: { in: ids } } });
  return Response.json({ ok: true, deleted: r.count });
}
