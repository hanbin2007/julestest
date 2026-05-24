import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { parseBody, progressSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 观看进度（跨设备）。GET 返回按 `${productId}:${videoId}` 索引的 map（续看轨/侧栏用）；POST 上报一条。
// 键含 productId:同一 videoId 跨课不唯一,只用 videoId 当键会让两门课的进度互相覆盖。
export async function GET() {
  const rows = await prisma.progress.findMany();
  const progress: Record<string, unknown> = {};
  for (const r of rows) {
    progress[`${r.productId}:${r.videoId}`] = {
      t: r.t,
      d: r.d,
      at: r.at.getTime(),
      videoId: r.videoId,
      productId: r.productId,
      title: r.title ?? undefined,
      courseName: r.courseName ?? undefined,
    };
  }
  return Response.json({ progress });
}

export async function POST(req: NextRequest) {
  const { data: body, error } = await parseBody(req, progressSchema);
  if (error) return error;
  const { videoId, productId } = body;
  const data = {
    t: body.t,
    d: body.d,
    title: body.title ?? null,
    courseName: body.courseName ?? null,
  };
  await prisma.progress.upsert({
    where: { productId_videoId: { productId, videoId } },
    create: { videoId, productId, ...data },
    update: data,
  });
  return Response.json({ ok: true });
}
