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
  duration: number | null;
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

// 纯函数：把课程列表归约成 byVid / byCourseVid 两张索引（无 IO，便于单测）。
// 不变式：byVid 对同一 videoId「后写覆盖」（videoId 跨课不唯一，故只保留最后一门课的
// meta）；byCourseVid 以 `${productId}:${videoId}` 为键，跨课各自独立、不会互相覆盖。
export function buildKeyMaps(courses: RollupCourse[]): {
  byVid: Map<number, VidMeta>;
  byCourseVid: Map<string, VidMeta>;
} {
  const byVid = new Map<number, VidMeta>();
  const byCourseVid = new Map<string, VidMeta>();
  for (const c of courses)
    for (const v of c.vids) {
      const meta: VidMeta = {
        courseId: c.productId,
        courseName: c.name,
        title: v.title,
        kind: v.kind,
        duration: v.duration,
      };
      byVid.set(v.videoId, meta);
      byCourseVid.set(`${c.productId}:${v.videoId}`, meta);
    }
  return { byVid, byCourseVid };
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

  const { byVid, byCourseVid } = buildKeyMaps(courses);

  cache = { courses, byVid, byCourseVid };
  return cache;
}
