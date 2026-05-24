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
  const { videoId, productId, id } = data;
  await prisma.note.deleteMany({ where: { videoId, id } });
  await deleteSnaps([id]); // 连带删手动截图，避免孤儿文件
  // 回包剩余列表按 (videoId,productId) 收窄,避免带回别课同 videoId 的笔记;无 productId 时退化按 videoId。
  const where =
    productId == null
      ? { videoId }
      : { videoId, OR: [{ productId }, { productId: null }] };
  const rows = await prisma.note.findMany({ where, orderBy: { t: "asc" } });
  return Response.json({
    ok: true,
    notes: rows.map((r) => ({ id: r.id, t: r.t, text: r.text, at: r.at.getTime() })),
  });
}
