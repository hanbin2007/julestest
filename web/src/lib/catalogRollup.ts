import { prisma } from "./db";

// 服务端用的目录汇总缓存：把课程→讲次(含 kind/duration/locked)在内存里缓存，
// 避免每次轮询都对 ~400 条 Video.raw 做 JSON.parse。增删目录时调用 invalidate。

export interface RollupVideo {
  videoId: number;
  kind: "vod" | "live";
  duration: number | null;
  locked: boolean;
  title: string | null;
}
export interface RollupCourse {
  productId: number;
  name: string;
  cardType: string | null;
  vids: RollupVideo[];
}
export interface VidMeta {
  courseId: number;
  courseName: string;
  title: string | null;
  kind: "vod" | "live";
}
export interface CatalogRollup {
  courses: RollupCourse[];
  byVid: Map<number, VidMeta>;
  // 精确按 (productId, videoId) 取课:videoId 跨课不唯一，byVid 会被后一门课覆盖，
  // 故有 productId 的笔记/对话改走这个 key 才能绑对课。键为 `${productId}:${videoId}`。
  byCourseVid: Map<string, VidMeta>;
}

let cache: CatalogRollup | null = null;

export function invalidateCatalogRollup() {
  cache = null;
}

export async function getCatalogRollup(): Promise<CatalogRollup> {
  if (cache) return cache;
  const [courseRows, videoRows] = await Promise.all([
    prisma.course.findMany({ orderBy: { productId: "asc" } }),
    prisma.video.findMany({ orderBy: [{ productId: "asc" }, { idx: "asc" }] }),
  ]);

  const byCourse = new Map<number, RollupVideo[]>();
  for (const v of videoRows) {
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(v.raw) as Record<string, unknown>;
    } catch {
      /* keep defaults */
    }
    const rv: RollupVideo = {
      videoId: v.videoId,
      kind: raw.kind === "live" ? "live" : "vod",
      duration: typeof raw.duration === "number" ? raw.duration : null,
      locked: raw.locked === true,
      title: v.title,
    };
    const list = byCourse.get(v.productId);
    if (list) list.push(rv);
    else byCourse.set(v.productId, [rv]);
  }

  const courses: RollupCourse[] = courseRows.map((c) => {
    let cardType: string | null = null;
    try {
      cardType = (JSON.parse(c.raw) as { cardType?: string | null }).cardType ?? null;
    } catch {
      /* ignore */
    }
    return { productId: c.productId, name: c.name, cardType, vids: byCourse.get(c.productId) ?? [] };
  });

  const byVid = new Map<number, VidMeta>();
  const byCourseVid = new Map<string, VidMeta>();
  for (const c of courses)
    for (const v of c.vids) {
      const meta: VidMeta = { courseId: c.productId, courseName: c.name, title: v.title, kind: v.kind };
      byVid.set(v.videoId, meta);
      byCourseVid.set(`${c.productId}:${v.videoId}`, meta);
    }

  cache = { courses, byVid, byCourseVid };
  return cache;
}
