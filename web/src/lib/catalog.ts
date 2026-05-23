import { prisma } from "./db";
import { gatewayGet } from "./gateway";
import { invalidateCatalogRollup } from "./catalogRollup";

// 目录数据(课程/视频)从 Python 网关同步进 SQLite，之后从 DB 读，不再每次打有道。
// 课程/视频整条 JSON 存进 raw，按原样回吐给前端，避免字段漂移。

// 视频目录结构版本：网关字段含义变化（如新增直播回放 kind/liveId）时 +1，
// 旧版本入库的课程会在下次访问时自动重拉，无需用户手动「刷新目录」。
const VIDEOS_SCHEMA = "v2-live";
const videosSchemaKey = (productId: number) => `videosSchema:${productId}`;

interface GwCourse {
  id: number;
  name: string;
  cardType: string | null;
  authors: string[];
}
interface GwVideo {
  videoId: number;
  productId: number;
  title: string | null;
  [k: string]: unknown;
}

export async function syncCourses(): Promise<GwCourse[]> {
  const { courses } = await gatewayGet<{ courses: GwCourse[] }>("/api/courses");
  await prisma.$transaction(
    courses.map((c) =>
      prisma.course.upsert({
        where: { productId: c.id },
        create: { productId: c.id, name: c.name, raw: JSON.stringify(c) },
        update: { name: c.name, raw: JSON.stringify(c), syncedAt: new Date() },
      }),
    ),
  );
  await prisma.syncMeta.upsert({
    where: { key: "courses" },
    create: { key: "courses", value: String(courses.length) },
    update: { value: String(courses.length) },
  });
  invalidateCatalogRollup();
  return courses;
}

export async function getCourses(): Promise<GwCourse[]> {
  const rows = await prisma.course.findMany({ orderBy: { productId: "asc" } });
  if (rows.length === 0) return syncCourses(); // 空库 -> 首次同步
  return rows.map((r) => JSON.parse(r.raw) as GwCourse);
}

export async function syncCourseVideos(productId: number): Promise<GwVideo[]> {
  // FK 需要父课程存在；缺了先同步课程列表。
  const course = await prisma.course.findUnique({ where: { productId } });
  if (!course) await syncCourses();
  const { videos } = await gatewayGet<{ videos: GwVideo[] }>(
    `/api/course?productId=${productId}`,
  );
  // 同一讲可能在一门课里被列两次（如「点播」与「直播回放」两个 tab 指向同一 videoId），
  // 复合主键 (productId, videoId) 仍会撞约束 -> 课程内按 videoId 去重，保留首次出现以维持顺序。
  const seen = new Set<number>();
  const uniqueVideos = videos.filter((v) =>
    seen.has(v.videoId) ? false : (seen.add(v.videoId), true),
  );
  await prisma.$transaction([
    prisma.video.deleteMany({ where: { productId } }),
    ...uniqueVideos.map((v, i) =>
      prisma.video.create({
        data: {
          videoId: v.videoId,
          productId,
          title: v.title ?? null,
          idx: i,
          raw: JSON.stringify(v),
        },
      }),
    ),
    // 标记这门课的视频已按当前结构版本入库。
    prisma.syncMeta.upsert({
      where: { key: videosSchemaKey(productId) },
      create: { key: videosSchemaKey(productId), value: VIDEOS_SCHEMA },
      update: { value: VIDEOS_SCHEMA },
    }),
  ]);
  invalidateCatalogRollup();
  return uniqueVideos;
}

export async function getCourseVideos(productId: number): Promise<GwVideo[]> {
  const rows = await prisma.video.findMany({
    where: { productId },
    orderBy: { idx: "asc" },
  });
  if (rows.length === 0) return syncCourseVideos(productId); // 该课首次访问 -> 拉取
  // 旧结构版本入库的课程（如缺直播回放）：重拉一次以补齐。
  const ver = await prisma.syncMeta.findUnique({
    where: { key: videosSchemaKey(productId) },
  });
  if (ver?.value !== VIDEOS_SCHEMA) return syncCourseVideos(productId);
  return rows.map((r) => JSON.parse(r.raw) as GwVideo);
}

// 主动刷新:重拉课程列表，并清空视频缓存(下次打开各课时按需重拉)。
export async function refreshCatalog(): Promise<number> {
  const courses = await syncCourses();
  await prisma.video.deleteMany({});
  invalidateCatalogRollup();
  return courses.length;
}
