import { prisma } from "@/lib/db";
import { gatewayGet } from "@/lib/gateway";
import { getCatalogRollup, type VidMeta } from "@/lib/catalogRollup";
import type { CoursesStatus, CourseStatus, TaskItem, VidStatusDetail } from "@/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 网关 /api/status 的(增强后)形状
interface GwStatus {
  thumb: { states: Record<string, string>; ready: number; generating: string[]; working: string[]; queued_vids: string[]; queued: number; errors: number; session?: string[] };
  buffer: {
    perVid: Record<string, { cached: number; total: number | null; state: string | null; bytes: number; thumbBytes: number }>;
    bytes: number;
    limit: number;
    queued: number;
    working: string[];
    queued_vids: string[];
    states?: Record<string, string>;
  };
  live?: { active: string | null; playhead: Record<string, number | null>; done?: string[]; inFlight: { live: number; auto: number; manual: number } };
  ffmpeg: boolean;
  thumbDir: string;
  cacheDir?: string;
  cacheDirOk?: boolean;
}
interface GwThumbsStatus {
  bytes: number;
}

type RollupCourses = Awaited<ReturnType<typeof getCatalogRollup>>["courses"];
// 单讲的归一化缓存视图：网关实时态与 DB 回退态收敛到同一形状，喂给 buildCourseStatus。
type VidAgg = { cached: number; total: number | null; state: VidStatusDetail["state"] | null; bytes: number };

// 把"逐讲缓存/缩略图状态 -> 每门课汇总(CourseStatus)"的聚合抽成单一实现。
// 网关在线(build)与离线回退(fallback)只是取数来源不同：用 getVid/getThumb 注入，
// countTasks 仅在线时统计 buffering/queued（DB 回退里无任务态，恒 0）。同时填充 perVid。
// 注意：CacheStatus / ThumbStatus 两张镜像表「故意」只按 videoId 建键（@id videoId），
// 因为它们镜像的是网关那份「物理上只认 vid」的磁盘缓存——同一讲被多门课打包时磁盘上只有
// 一份。所以这里 per-course 的 cachedBytes 会把这一份字节「重复算进每门拥有它的课」；
// 这对单门课视图是对的，但跨课求「全局总字节」必须按 unique videoId 去重（见 build/fallback
// 里的 totals.bufferBytes）。请勿把这两张表改成复合键。
function buildCourseStatus(
  courses: RollupCourses,
  watched: Set<string>,
  perVid: Record<string, VidStatusDetail>,
  getVid: (videoId: number) => VidAgg | null,
  getThumb: (videoId: number) => VidStatusDetail["thumb"],
  countTasks: boolean,
): CourseStatus[] {
  return courses.map((c) => {
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
      const b = getVid(v.videoId);
      const th = getThumb(v.videoId);
      if (b) {
        if (b.cached > 0) cachedLectures++;
        if (b.total && b.cached >= b.total) fullyCached++;
        cachedBytes += b.bytes || 0;
        if (countTasks) {
          if (b.state === "working") buffering++;
          else if (b.state === "queued") queued++;
        }
        perVid[String(v.videoId)] = {
          cached: b.cached,
          total: b.total,
          bytes: b.bytes || 0,
          state: b.state,
          thumb: th,
        };
      } else if (th) {
        perVid[String(v.videoId)] = { cached: 0, total: null, bytes: 0, state: null, thumb: th };
      }
      if (th === "ready") thumbsReady++;
      else if (th === "gen") thumbsGen++;
      else if (th === "error") thumbsError++;
      if (watched.has(`${c.productId}:${v.videoId}`)) watchedN++;
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
}

// 多标签页同时轮询时，200ms 内合并为一次上游调用。
let last: { at: number; data: CoursesStatus } | null = null;
let pending: Promise<CoursesStatus> | null = null;

export async function GET() {
  const now = Date.now();
  if (last && now - last.at < 200) return Response.json(last.data);
  if (!pending) {
    pending = build()
      .then((data) => {
        last = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        pending = null;
      });
  }
  // build 失败时所有并发等待者优雅降级，不缓存失败结果，下次请求可重试。
  try {
    return Response.json(await pending);
  } catch {
    return Response.json({ error: "状态获取失败" }, { status: 503 });
  }
}

async function build(): Promise<CoursesStatus> {
  const { courses, byVid } = await getCatalogRollup();
  const progress = await prisma.progress.findMany({ select: { productId: true, videoId: true, t: true, d: true } });
  const watched = new Set(progress.filter((p) => p.d > 0 && p.t / p.d >= 0.9).map((p) => `${p.productId}:${p.videoId}`));

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

  const courseStatus = buildCourseStatus(
    courses,
    watched,
    perVid,
    (videoId) => {
      const b = perVidGw[String(videoId)];
      return b
        ? { cached: b.cached, total: b.total, state: (b.state as VidStatusDetail["state"]) ?? null, bytes: b.bytes || 0 }
        : null;
    },
    thumbState,
    true,
  );

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
  const bufStates = gw.buffer.states ?? {};
  const thStates = gw.thumb.states ?? {};
  const thSession = new Set(gw.thumb.session ?? []);

  // 自动预缓存(prefetch)：网关的 pf_active 只增不清（看完 / 缓存满 / 切走都不归零），故"上次在看
  // 那讲"会一直挂在 live.active。仅当它尚未缓存满才算真正进行中；缓存满即视为完成、不再列为任务
  // （否则会"完成了还显示进行中"）。total 未知时保守按进行中显示。
  const liveVid = gw.live?.active ?? null;
  const livePer = liveVid ? perVidGw[liveVid] : undefined;
  const liveFull = !!livePer && livePer.total != null && livePer.cached >= livePer.total;
  const activePrefetch = liveVid && !liveFull ? liveVid : null;

  // 进行中：缓冲 working/queued/paused + 预缓存(只读) + 缩略图 working/queued。
  // working/queued/paused 三者天然互斥：网关在同一把 buf_lock 快照里同时算出 buffer.working
  // 与 buffer.states，同一 vid 不会既在 working 列表又被 paused 扫描到，故无重复。
  const tasks: TaskItem[] = [];
  for (const v of bufWorking) tasks.push(mk(v, "buffer", "working"));
  for (const [v, st] of Object.entries(bufStates)) {
    if (st === "paused") tasks.push(mk(v, "buffer", "paused"));
  }
  if (activePrefetch) tasks.push(mk(activePrefetch, "prefetch", "working"));
  for (const v of thWorking) tasks.push(mk(v, "thumb", "working"));
  for (const v of bufQueued) tasks.push(mk(v, "buffer", "queued"));
  for (const v of thQueued) tasks.push(mk(v, "thumb", "queued"));

  // 已完成 / 失败：最近优先、各类限额（dict 末尾=最新）。缩略图只取本会话任务，
  // 排除网关启动时从索引预载的历史 ready（那些是"有缩略图"而非"本次任务"）。
  const CAP = 100;
  const recent = <T,>(a: T[]) => a.slice(-CAP).reverse();
  const bufEntries = Object.entries(bufStates);
  const thEntries = Object.entries(thStates).filter(([v]) => thSession.has(v));
  // 预缓存完成（本会话看完且整集缓存满）。去重：已有缓冲任务的讲不再单独列预缓存（缓冲"完成"
  // 已表达"整集已缓存"）；当前仍在预缓存那讲若刚被淘汰回到进行中，也排除避免与进行中重复。
  const pfDone = (gw.live?.done ?? []).filter((v) => !(v in bufStates) && v !== activePrefetch);
  const completedTasks: TaskItem[] = [
    ...recent(bufEntries.filter(([, st]) => st === "done" || st === "cancelled")).map(([v, st]) =>
      mk(v, "buffer", st as TaskItem["state"]),
    ),
    ...recent(thEntries.filter(([, st]) => st === "ready" || st === "cancelled")).map(([v, st]) =>
      mk(v, "thumb", st === "ready" ? "done" : "cancelled"),
    ),
    ...recent(pfDone).map((v) => mk(v, "prefetch", "done")),
  ];
  const failedTasks: TaskItem[] = [
    ...recent(bufEntries.filter(([, st]) => st === "error")).map(([v]) => mk(v, "buffer", "error")),
    ...recent(thEntries.filter(([, st]) => st === "error")).map(([v]) => mk(v, "thumb", "error")),
  ];

  // 孤儿：磁盘有缓存但不在目录里（避免几 GB 静默消失）
  const orphans = Object.entries(perVidGw)
    .filter(([vid, b]) => b.cached > 0 && !byVid.has(Number(vid)))
    .map(([vid, b]) => ({ vid: Number(vid), segments: b.cached, bytes: b.bytes || 0 }));

  const downloadingVid = bufWorking[0] ?? activePrefetch ?? thWorking[0] ?? null;
  const dlMeta = downloadingVid ? byVid.get(Number(downloadingVid)) : null;

  return {
    courses: courseStatus,
    perVid,
    totals: {
      // 全局总字节用网关 buffer.bytes：这是磁盘真实占用，天然按物理 vid 去重，不会像
      // 「各课 cachedBytes 相加」那样把共享讲重复计数（共享讲磁盘只有一份）。
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
      tier: bufWorking[0] ? "buffer" : activePrefetch ? "prefetch" : thWorking[0] ? "thumb" : null,
      // 队列深度按 queued_vids 列表长度算，而非原始 qsize：后者会把已取消/在途的条目也算进去，
      // 虚高显示。queued_vids 是网关在同一把锁里算出的「真正还在排队的 vid」，更准。
      queue: { thumb: thQueued.length, buffer: bufQueued.length },
    },
    tasks,
    completedTasks,
    failedTasks,
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

// CacheStatus / ThumbStatus 故意只按 videoId 镜像（与网关物理 vid-only 磁盘缓存一一对应，
// 同一讲跨课只有一份）。键保持 videoId，勿改成复合键；跨课总量去重在 totals 处处理。
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
  watched: Set<string>,
): Promise<CoursesStatus> {
  const [cs, ts] = await Promise.all([prisma.cacheStatus.findMany(), prisma.thumbStatus.findMany()]);
  const cacheBy = new Map(cs.map((r) => [r.videoId, r]));
  const thumbBy = new Map(ts.map((r) => [r.videoId, r.state]));
  const perVid: Record<string, VidStatusDetail> = {};

  const courseStatus = buildCourseStatus(
    courses,
    watched,
    perVid,
    (videoId) => {
      const b = cacheBy.get(videoId);
      return b
        ? { cached: b.cachedSegments, total: b.totalSegments, state: (b.state as VidStatusDetail["state"]) ?? null, bytes: b.bytes || 0 }
        : null;
    },
    (videoId) => (thumbBy.get(videoId) as VidStatusDetail["thumb"]) ?? null,
    false,
  );
  // 全局总字节按 unique videoId 去重：cacheBy 本身就是 videoId 建键（每讲一行），直接累加其
  // 字节即天然去重；不能用「各课 cachedBytes 相加」，那会把共享讲在每门拥有它的课里重复计数。
  const totalBytes = Array.from(cacheBy.values()).reduce((a, r) => a + (r.bytes || 0), 0);

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
    completedTasks: [], // 网关离线时无任务运行态可查（DB 镜像只有缓存进度，不含任务历史）
    failedTasks: [],
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
