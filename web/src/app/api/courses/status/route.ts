import { prisma } from "@/lib/db";
import { gatewayGet } from "@/lib/gateway";
import { getCatalogRollup, type VidMeta } from "@/lib/catalogRollup";
import type { CoursesStatus, CourseStatus, TaskItem, VidStatusDetail } from "@/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 网关 /api/status 的(增强后)形状
interface GwStatus {
  thumb: { states: Record<string, string>; ready: number; generating: string[]; working: string[]; queued_vids: string[]; queued: number; errors: number };
  buffer: {
    perVid: Record<string, { cached: number; total: number | null; state: string | null; bytes: number; thumbBytes: number }>;
    bytes: number;
    limit: number;
    queued: number;
    working: string[];
    queued_vids: string[];
  };
  live?: { active: string | null; playhead: Record<string, number | null>; inFlight: { live: number; auto: number; manual: number } };
  ffmpeg: boolean;
  thumbDir: string;
  cacheDir?: string;
  cacheDirOk?: boolean;
}
interface GwThumbsStatus {
  bytes: number;
}

// 多标签页同时轮询时，200ms 内合并为一次上游调用。
let last: { at: number; data: CoursesStatus } | null = null;
let pending: Promise<CoursesStatus> | null = null;

export async function GET() {
  const now = Date.now();
  if (last && now - last.at < 200) return Response.json(last.data);
  if (pending) return Response.json(await pending);
  pending = build()
    .then((data) => {
      last = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      pending = null;
    });
  return Response.json(await pending);
}

async function build(): Promise<CoursesStatus> {
  const { courses, byVid } = await getCatalogRollup();
  const progress = await prisma.progress.findMany({ select: { videoId: true, t: true, d: true } });
  const watched = new Set(progress.filter((p) => p.d > 0 && p.t / p.d >= 0.9).map((p) => p.videoId));

  let gw: GwStatus | null = null;
  let thumbBytes = 0;
  try {
    [gw, thumbBytes] = await Promise.all([
      gatewayGet<GwStatus>("/api/status"),
      gatewayGet<GwThumbsStatus>("/api/thumbs/status").then((t) => t.bytes).catch(() => 0),
    ]);
  } catch {
    gw = null;
  }

  if (!gw) return fallback(courses, byVid, watched);

  // 镜像进 DB（含 bytes，供网关挂掉时回退）
  void mirror(gw);

  const perVidGw = gw.buffer.perVid;
  const perVid: Record<string, VidStatusDetail> = {};
  const thumbState = (vid: number): VidStatusDetail["thumb"] => {
    const s = gw!.thumb.states[String(vid)];
    return s === "ready" || s === "gen" || s === "error" ? s : null;
  };

  const courseStatus: CourseStatus[] = courses.map((c) => {
    let cachedLectures = 0,
      fullyCached = 0,
      cachedBytes = 0,
      thumbsReady = 0,
      thumbsGen = 0,
      thumbsError = 0,
      buffering = 0,
      queued = 0,
      watchedN = 0,
      vod = 0,
      live = 0,
      lockedN = 0;
    for (const v of c.vids) {
      if (v.kind === "live") live++;
      else vod++;
      if (v.locked) lockedN++;
      const b = perVidGw[String(v.videoId)];
      const th = thumbState(v.videoId);
      if (b) {
        if (b.cached > 0) cachedLectures++;
        if (b.total && b.cached >= b.total) fullyCached++;
        cachedBytes += b.bytes || 0;
        if (b.state === "working") buffering++;
        else if (b.state === "queued") queued++;
        perVid[String(v.videoId)] = {
          cached: b.cached,
          total: b.total,
          bytes: b.bytes || 0,
          state: (b.state as VidStatusDetail["state"]) ?? null,
          thumb: th,
        };
      } else if (th) {
        perVid[String(v.videoId)] = { cached: 0, total: null, bytes: 0, state: null, thumb: th };
      }
      if (th === "ready") thumbsReady++;
      else if (th === "gen") thumbsGen++;
      else if (th === "error") thumbsError++;
      if (watched.has(v.videoId)) watchedN++;
    }
    const lectures = c.vids.length;
    return {
      productId: c.productId,
      name: c.name,
      cardType: c.cardType,
      lectures,
      vod,
      live,
      allLocked: lectures > 0 && lockedN === lectures,
      cachedLectures,
      fullyCached,
      partialRatio: lectures > 0 ? cachedLectures / lectures : 0,
      fullRatio: lectures > 0 ? fullyCached / lectures : 0,
      cachedBytes,
      thumbsReady,
      thumbsGen,
      thumbsError,
      buffering,
      queued,
      watched: watchedN,
    };
  });

  // 任务队列：进行中 + 排队（进行中优先）
  const mk = (vid: string, kind: TaskItem["kind"], state: TaskItem["state"]): TaskItem => {
    const m = byVid.get(Number(vid));
    const b = perVidGw[vid];
    return {
      vid: Number(vid),
      title: m?.title ?? `视频 ${vid}`,
      courseName: m?.courseName ?? "未知课程",
      courseId: m?.courseId ?? 0,
      kind,
      state,
      cached: b?.cached,
      total: b?.total ?? null,
    };
  };
  // 字段全部兜底默认值：兼容尚未升级到本版本的网关（避免 for...of undefined 崩溃）。
  const bufWorking = gw.buffer.working ?? [];
  const bufQueued = gw.buffer.queued_vids ?? [];
  const thWorking = gw.thumb.working ?? [];
  const thQueued = gw.thumb.queued_vids ?? [];
  const tasks: TaskItem[] = [];
  for (const v of bufWorking) tasks.push(mk(v, "buffer", "working"));
  if (gw.live?.active) tasks.push(mk(gw.live.active, "prefetch", "working"));
  for (const v of thWorking) tasks.push(mk(v, "thumb", "working"));
  for (const v of bufQueued) tasks.push(mk(v, "buffer", "queued"));
  for (const v of thQueued) tasks.push(mk(v, "thumb", "queued"));

  // 孤儿：磁盘有缓存但不在目录里（避免几 GB 静默消失）
  const orphans = Object.entries(perVidGw)
    .filter(([vid, b]) => b.cached > 0 && !byVid.has(Number(vid)))
    .map(([vid, b]) => ({ vid: Number(vid), segments: b.cached, bytes: b.bytes || 0 }));

  const downloadingVid = bufWorking[0] ?? gw.live?.active ?? thWorking[0] ?? null;
  const dlMeta = downloadingVid ? byVid.get(Number(downloadingVid)) : null;

  return {
    courses: courseStatus,
    perVid,
    totals: {
      bufferBytes: gw.buffer.bytes,
      bufferLimit: gw.buffer.limit,
      thumbBytes,
      lectures: courseStatus.reduce((a, c) => a + c.lectures, 0),
      cachedLectures: courseStatus.reduce((a, c) => a + c.cachedLectures, 0),
      thumbsReady: courseStatus.reduce((a, c) => a + c.thumbsReady, 0),
    },
    activity: {
      downloadingVid: downloadingVid ? Number(downloadingVid) : null,
      title: dlMeta?.title ?? null,
      tier: bufWorking[0] ? "buffer" : gw.live?.active ? "prefetch" : thWorking[0] ? "thumb" : null,
      queue: { thumb: gw.thumb.queued ?? 0, buffer: gw.buffer.queued ?? 0 },
    },
    tasks,
    health: {
      gatewayOnline: true,
      stale: false,
      ffmpeg: gw.ffmpeg,
      updatedAt: Date.now(),
      cacheDir: gw.cacheDir ?? "",
      cacheDirOk: gw.cacheDirOk ?? true,
    },
    orphans,
  };
}

async function mirror(gw: GwStatus) {
  try {
    const ops = [];
    for (const [vid, b] of Object.entries(gw.buffer.perVid)) {
      const videoId = Number(vid);
      if (!videoId) continue;
      const data = { cachedSegments: b.cached || 0, totalSegments: b.total ?? null, state: b.state ?? null, bytes: b.bytes || 0 };
      ops.push(prisma.cacheStatus.upsert({ where: { videoId }, create: { videoId, ...data }, update: data }));
    }
    for (const [vid, st] of Object.entries(gw.thumb.states)) {
      const videoId = Number(vid);
      if (!videoId) continue;
      ops.push(prisma.thumbStatus.upsert({ where: { videoId }, create: { videoId, state: st }, update: { state: st } }));
    }
    if (ops.length) await prisma.$transaction(ops);
  } catch {
    /* 镜像失败不影响主返回 */
  }
}

async function fallback(
  courses: Awaited<ReturnType<typeof getCatalogRollup>>["courses"],
  byVid: Map<number, VidMeta>,
  watched: Set<number>,
): Promise<CoursesStatus> {
  const [cs, ts] = await Promise.all([prisma.cacheStatus.findMany(), prisma.thumbStatus.findMany()]);
  const cacheBy = new Map(cs.map((r) => [r.videoId, r]));
  const thumbBy = new Map(ts.map((r) => [r.videoId, r.state]));
  const perVid: Record<string, VidStatusDetail> = {};
  let totalBytes = 0;

  const courseStatus: CourseStatus[] = courses.map((c) => {
    let cachedLectures = 0,
      fullyCached = 0,
      cachedBytes = 0,
      thumbsReady = 0,
      thumbsGen = 0,
      thumbsError = 0,
      watchedN = 0,
      vod = 0,
      live = 0,
      lockedN = 0;
    for (const v of c.vids) {
      if (v.kind === "live") live++;
      else vod++;
      if (v.locked) lockedN++;
      const b = cacheBy.get(v.videoId);
      const th = (thumbBy.get(v.videoId) as VidStatusDetail["thumb"]) ?? null;
      if (b) {
        if (b.cachedSegments > 0) cachedLectures++;
        if (b.totalSegments && b.cachedSegments >= b.totalSegments) fullyCached++;
        cachedBytes += b.bytes || 0;
        totalBytes += b.bytes || 0;
        perVid[String(v.videoId)] = {
          cached: b.cachedSegments,
          total: b.totalSegments,
          bytes: b.bytes || 0,
          state: (b.state as VidStatusDetail["state"]) ?? null,
          thumb: th,
        };
      } else if (th) {
        perVid[String(v.videoId)] = { cached: 0, total: null, bytes: 0, state: null, thumb: th };
      }
      if (th === "ready") thumbsReady++;
      else if (th === "gen") thumbsGen++;
      else if (th === "error") thumbsError++;
      if (watched.has(v.videoId)) watchedN++;
    }
    const lectures = c.vids.length;
    return {
      productId: c.productId,
      name: c.name,
      cardType: c.cardType,
      lectures,
      vod,
      live,
      allLocked: lectures > 0 && lockedN === lectures,
      cachedLectures,
      fullyCached,
      partialRatio: lectures > 0 ? cachedLectures / lectures : 0,
      fullRatio: lectures > 0 ? fullyCached / lectures : 0,
      cachedBytes,
      thumbsReady,
      thumbsGen,
      thumbsError,
      buffering: 0,
      queued: 0,
      watched: watchedN,
    };
  });

  return {
    courses: courseStatus,
    perVid,
    totals: {
      bufferBytes: totalBytes,
      bufferLimit: 0,
      thumbBytes: 0,
      lectures: courseStatus.reduce((a, c) => a + c.lectures, 0),
      cachedLectures: courseStatus.reduce((a, c) => a + c.cachedLectures, 0),
      thumbsReady: courseStatus.reduce((a, c) => a + c.thumbsReady, 0),
    },
    activity: { downloadingVid: null, title: null, tier: null, queue: { thumb: 0, buffer: 0 } },
    tasks: [],
    // 网关离线时无法得知缓存目录状态：cacheDirOk 保持 true，避免与“网关离线”重复报警。
    health: {
      gatewayOnline: false,
      stale: true,
      ffmpeg: true,
      updatedAt: Date.now(),
      cacheDir: "",
      cacheDirOk: true,
    },
    orphans: [],
  };
}
