import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { noteAddSchema, parseBody } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 细粒度新增：服务端分配 id/at，避免多设备整列表互相覆盖。返回整列表供前端对账。
export async function POST(req: NextRequest) {
  const { data, error } = await parseBody(req, noteAddSchema);
  if (error) return error;
  const { videoId, productId, text, t, strokes } = data;
  // 课程身份在创建时落库:productId 绑课;courseName/lessonTitle 从权威表派生为快照，
  // 目录日后被清/讲次下架时，笔记仍能正确显示与跳看（读路径实时目录优先、快照兜底）。
  let courseName: string | null = null;
  let lessonTitle: string | null = null;
  if (productId != null) {
    const [course, video] = await Promise.all([
      prisma.course.findUnique({ where: { productId } }),
      prisma.video.findUnique({ where: { productId_videoId: { productId, videoId } } }),
    ]);
    if (course) {
      try {
        courseName = (JSON.parse(course.raw) as { name?: string }).name ?? course.name ?? null;
      } catch {
        courseName = course.name ?? null;
      }
    }
    lessonTitle = video?.title ?? null;
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await prisma.note.create({
    data: { id, videoId, productId: productId ?? null, courseName, lessonTitle, t, text, strokes: strokes ?? null },
  });
  // 回包列表按 (videoId,productId) 收窄,避免把别课同 videoId 的笔记带回来;无 productId 时退化按 videoId。
  const where =
    productId == null
      ? { videoId }
      : { videoId, OR: [{ productId }, { productId: null }] };
  const rows = await prisma.note.findMany({ where, orderBy: { t: "asc" } });
  const notes = rows.map((r) => ({ id: r.id, t: r.t, text: r.text, strokes: r.strokes, at: r.at.getTime() }));
  return Response.json({ note: notes.find((n) => n.id === id), notes });
}
