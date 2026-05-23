import { prisma } from "@/lib/db";
import { getCatalogRollup } from "@/lib/catalogRollup";
import { listSnapIds } from "@/lib/noteSnaps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 全量笔记（跨讲）+ 课程/讲次/时长/缩略图状态富化，供统一笔记管理界面。
// videoId 非全局唯一（同一讲可属多课），按 byVid（productId 升序首个）口径展示。
export async function GET() {
  const [rows, rollup, thumbs, snapIds] = await Promise.all([
    prisma.note.findMany({ orderBy: { at: "desc" } }),
    getCatalogRollup(),
    prisma.thumbStatus.findMany(),
    listSnapIds(),
  ]);

  // videoId -> duration（byVid 不含时长，从 courses 汇总）
  const durByVid = new Map<number, number | null>();
  for (const c of rollup.courses)
    for (const v of c.vids) if (!durByVid.has(v.videoId)) durByVid.set(v.videoId, v.duration);

  const thumbByVid = new Map<number, (typeof thumbs)[number]>();
  for (const ts of thumbs) thumbByVid.set(ts.videoId, ts);

  const videoSet = new Set<number>();
  const courseSet = new Set<number>();
  const notes = rows.map((r) => {
    const m = rollup.byVid.get(r.videoId);
    const ts = thumbByVid.get(r.videoId);
    videoSet.add(r.videoId);
    if (m) courseSet.add(m.courseId);
    return {
      id: r.id,
      videoId: r.videoId,
      t: r.t,
      text: r.text,
      at: r.at.getTime(),
      courseId: m?.courseId ?? 0,
      courseName: m?.courseName ?? "未知课程",
      lessonTitle: m?.title ?? `视频 ${r.videoId}`,
      duration: durByVid.get(r.videoId) ?? null,
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
