import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 某讲的时间戳笔记（服务端共享）。videoId 跨课不唯一,带上 productId 收窄到本课:
// 给了 productId → 只取本课 + 旧的无 productId 笔记(兜底,不漏);没给 → 退化为按 videoId 全取。
export async function GET(req: NextRequest) {
  const searchParams = new URL(req.url).searchParams;
  const videoId = Number(searchParams.get("videoId") ?? "");
  if (!videoId) return Response.json({ error: "missing videoId" }, { status: 400 });
  const pidRaw = searchParams.get("productId");
  const pidNum = pidRaw == null ? NaN : Number(pidRaw);
  const productId = Number.isInteger(pidNum) ? pidNum : null;
  const where =
    productId == null
      ? { videoId }
      : { videoId, OR: [{ productId }, { productId: null }] };
  const rows = await prisma.note.findMany({ where, orderBy: { t: "asc" } });
  return Response.json({
    notes: rows.map((r) => ({ id: r.id, t: r.t, text: r.text, strokes: r.strokes, at: r.at.getTime() })),
  });
}
