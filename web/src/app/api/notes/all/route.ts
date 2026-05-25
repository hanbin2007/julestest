import { prisma } from "@/lib/db";
import { getCatalogRollup } from "@/lib/catalogRollup";
import { listSnapIds } from "@/lib/noteSnaps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 全量笔记（跨讲）+ 课程/讲次/时长/缩略图状态富化，供统一笔记管理界面。
// 解析口径:笔记有 productId 时按 (productId, videoId) 精确取课（修「认错课」）；老笔记无
// productId 时回退 byVid。课程/讲次名三级兜底:实时目录优先 → 笔记存的快照 → 「未知」。
export async function GET() {
  const [rows, rollup, thumbs, snapIds] = await Promise.all([
    prisma.note.findMany({ orderBy: { at: "desc" } }),
    getCatalogRollup(),
    prisma.thumbStatus.findMany(),
    listSnapIds(),
  ]);

  const thumbByVid = new Map<number, (typeof thumbs)[number]>();
  for (const ts of thumbs) thumbByVid.set(ts.videoId, ts);

  const videoSet = new Set<number>();
  const courseSet = new Set<number>();
  const notes = rows.map((r) => {
    // 有 productId → 精确按 (productId, videoId) 取课;无 → 老笔记回退 byVid。
    const m =
      r.productId != null
        ? rollup.byCourseVid.get(`${r.productId}:${r.videoId}`)
        : rollup.byVid.get(r.videoId);
    const ts = thumbByVid.get(r.videoId);
    const courseId = r.productId ?? m?.courseId ?? 0;
    videoSet.add(r.videoId);
    if (courseId) courseSet.add(courseId);
    return {
      id: r.id,
      videoId: r.videoId,
      t: r.t,
      text: r.text,
      strokes: r.strokes,
      at: r.at.getTime(),
      // 三级兜底:实时目录 → 笔记创建时存的快照 → 占位。
      courseId,
      courseName: m?.courseName ?? r.courseName ?? "未知课程",
      lessonTitle: m?.title ?? r.lessonTitle ?? `视频 ${r.videoId}`,
      // 时长随 meta 同键解析（与课程身份一致）：有 productId 走 byCourseVid，老笔记走 byVid。
      duration: m?.duration ?? null,
      kind: m?.kind ?? "vod",
      thumbState: ts?.state ?? null,
      thumb: ts
        ? { url: ts.url, number: ts.number, column: ts.column, width: ts.width, height: ts.height }
        : undefined,
      hasSnap: snapIds.has(r.id),
    };
  });

  return Response.json({
    notes,
    stats: { total: notes.length, videos: videoSet.size, courses: courseSet.size },
  });
}
