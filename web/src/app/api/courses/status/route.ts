import { prisma } from "@/lib/db";
import { gatewayGet, gatewayPost } from "@/lib/gateway";
import { getCatalogRollup, type VidMeta } from "@/lib/catalogRollup";
import type { CoursesStatus, CourseStatus, GwStatus, TaskItem, VidStatusDetail } from "@/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GwStatus（网关 /api/status 的规范形状）现集中定义在 @/types/api，此处仅 import。

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

// 触发网关 /api/warm 的限频:每 5s 至多一次。
// 网关侧 idempotent:已知 seg_urls && 与磁盘有交集 → skip;清晰度漂移 → 重新拉。
// 重复 fire 不会真重做活,所以不用 warmTried"一会话一次"那么严;每 5s 是为了让用户在
// 设置页停留时也能持续地把新出现的"待 warm"vid 拉齐(比如刚开过新课、新缓存的讲)。
let lastWarmAt = 0;

async function triggerWarmIfNeeded(
  perVidGw: Record<string, { cached: number; total: number | null }>,
  byVid: Map<number, VidMeta>,
) {
  if (Date.now() - lastWarmAt < 5000) return;
  // 给所有"磁盘有缓存"的 vid 都发一遍 warm。网关 idempotent:
  //   - 没有 seg_urls → 真 warm
  //   - 有 seg_urls 且与磁盘有 URL 交集 → skip(常态)
  //   - 有 seg_urls 但与磁盘 0 交集(清晰度漂移) → 重新 warm 修复 bucket bar
  // 重复发 cheap(单网关 round-trip + 18 vid 各 0.5s m3u8 拉,大头是 skip 路径)。
  const needed: number[] = [];
  for (const [vid, b] of Object.entries(perVidGw)) {
    const id = Number(vid);
    if (!id) continue;
    if (b.cached > 0 && byVid.has(id)) needed.push(id);
  }
  if (needed.length === 0) return;
  lastWarmAt = Date.now();

  try {
    const rows = await prisma.video.findMany({
      where: { videoId: { in: needed } },
      select: { videoId: true, productId: true, raw: true },
    });
    const videos = rows.map((r) => {
      let raw: Record<string, unknown> = {};
      try { raw = JSON.parse(r.raw) as Record<string, unknown>; } catch { /* ignore */ }
      // 必须与播放路径 pickM3u8 完全一致(最高清晰度优先):
      // 播放时 ArtPlayer 缓存的是高清分片,如果 warm 拉低清 m3u8,seg_urls 里 URL 就和
      // 磁盘上分片对不上,导致设置页"缓冲条"按 URL 匹配算出 cached=0(明明盘上有片)。
      const clarity = (Array.isArray(raw.clarity) ? raw.clarity as Array<{ url?: string; type?: number }> : [])
        .filter((c) => c?.url)
        .sort((a, b) => (b.type || 0) - (a.type || 0));
      const src = clarity[0]?.url || (raw.downloadUrl as string) || "";
      return {
        videoId: r.videoId,
        contentId: raw.contentId as number,
        cardPackageId: raw.cardPackageId as number,
        productId: r.productId,
        src,
        duration: (raw.duration as number) ?? 0,
        liveId: (raw.liveId as number) ?? null,
      };
    }).filter((v) => v.src && v.contentId && v.cardPackageId);

    if (videos.length === 0) return;
    // fire-and-forget: 网关侧逐个串行取 m3u8,耗时可能数秒;下一次 polling 就能看到 total。
    void gatewayPost("/api/warm", { videos }).catch(() => { /* 失败 5s 后会再试 */ });
  } catch { /* DB 查询失败,5s 后再试 */ }
}

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
  try {
    gw = await gatewayGet<GwStatus>("/api/status");
  } catch {
    gw = null;
  }

  if (!gw) return fallback(courses, byVid, watched);
  const thumbBytes = gw.thumb.bytes ?? 0;

  // 镜像进 DB(含 bytes,供网关挂掉时回退) + 同步等任务历史落库:
  // 必须 await,否则 fire-and-forget 下面 findMany allTasks 读不到刚 append 的行,
  // 用户首次访问要等下次轮询才看到回填的历史。整次镜像 < 50ms,值得 await。
  await mirror(gw);

  const perVidGw = gw.buffer.perVid;
  // 网关重启后若 seg_urls.json 缺失（首次升级或被删），perVid 会有大批 cached>0 但 total=null。
  // 一次性 fire 给 /api/warm 让网关只取 m3u8 学到分片顺序+总数（不下分片）。下次轮询就有 total 了。
  void triggerWarmIfNeeded(perVidGw, byVid);
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
    // "段"是 buffer/prefetch 的概念(分片下载进度);thumb(ffmpeg 单次原子调用)没有段数。
    // 给 thumb 任务附段数会让"thumb done + cached<total"看起来像"任务完成但只下了一半",
    // 实际只是缩略图生成完毕、缓冲恰好还没下完。仅 buffer/prefetch 附段数。
    const showSegs = kind !== "thumb";
    return {
      vid: Number(vid),
      title: m?.title ?? `视频 ${vid}`,
      courseName: m?.courseName ?? "未知课程",
      courseId: m?.courseId ?? 0,
      kind,
      state,
      cached: showSegs ? b?.cached : undefined,
      total: showSegs ? (b?.total ?? null) : null,
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

  // 全部历史:从 TaskHistory 倒序取 500 条,转 TaskItem 形状供前端展示
  let allTasks: TaskItem[] = [];
  try {
    const history = await prisma.taskHistory.findMany({
      orderBy: { at: "desc" },
      take: 500,
    });
    allTasks = history.map((h) => {
      const m = byVid.get(h.videoId);
      const b = perVidGw[String(h.videoId)];
      // 同 mk():仅 buffer/prefetch 附段数,避免 thumb 任务误显示 "完成 19/243 段"。
      const showSegs = h.kind !== "thumb";
      return {
        vid: h.videoId,
        title: m?.title ?? `视频 ${h.videoId}`,
        courseName: m?.courseName ?? "未知课程",
        courseId: m?.courseId ?? 0,
        kind: h.kind as TaskItem["kind"],
        state: h.state as TaskItem["state"],
        cached: showSegs ? b?.cached : undefined,
        total: showSegs ? (b?.total ?? null) : null,
      };
    });
  } catch { /* 查询失败返回空数组 */ }

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
    allTasks,
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
    // 任务历史:每次状态变化 append 一条;同 (vid, kind) 重复 state 自动去重。
    await appendTaskHistory(gw);
  } catch {
    /* 镜像失败不影响主返回 */
  }
}

// 内存:进程级缓存"上次写入的状态",避免每次都查 DB 比对。同 (kind, videoId) 状态不变不重复写。
// 首次启动:从 TaskHistory 读历史最新态填进来,网关重启不会让旧任务被重复 append 成"新事件"。
const lastTaskState = new Map<string, string>();
let lastTaskStateInited = false;

function mkHistRow(kind: string, videoId: number, state: string, reason?: string | null) {
  return {
    id: `${kind}-${videoId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    videoId,
    state,
    reason: reason ?? null,
  };
}

async function initLastTaskStateOnce() {
  if (lastTaskStateInited) return;
  lastTaskStateInited = true;
  // 取每个 (kind, videoId) 在 TaskHistory 里的最新状态填进 Map。
  // 取最近 2000 行(覆盖 ~500 个唯一任务足够), Set 跟踪已见 (kind,videoId) 跳重。
  try {
    const recent = await prisma.taskHistory.findMany({
      orderBy: { at: "desc" },
      take: 2000,
    });
    const seen = new Set<string>();
    for (const r of recent) {
      const key = `${r.kind}:${r.videoId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lastTaskState.set(key, r.state);
    }
  } catch { /* 表不存在或查询失败,Map 保持空 */ }

  // 启动一次清理: TaskHistory 表 append-only, 半年后膨胀至几 M 行 → 查询慢。
  // 保留最近 90 天足够"全部"标签展示, 旧记录无价值删掉。
  try {
    const cutoff = new Date(Date.now() - 90 * 86400 * 1000);
    await prisma.taskHistory.deleteMany({ where: { at: { lt: cutoff } } });
  } catch { /* 清理失败不致命 */ }

  // 跨会话回填: CacheStatus 里 state='full' (=cached=total 整集已缓存好) 的 vid
  // 在 TaskHistory 里如果没记录过 "done", 一次性补上 kind='buffer' state='done'。
  // 这覆盖了用户在 buf_state.json 持久化之前(老版本)做过的 buffer/prefetch 完成,
  // 让"全部"标签显示的不只是 thumb,而是所有曾整集缓存好的讲。
  try {
    const fullCached = await prisma.cacheStatus.findMany({
      where: { state: "full" },
      select: { videoId: true },
    });
    const backfill = fullCached
      .map((c) => c.videoId)
      .filter((vid) => !lastTaskState.has(`buffer:${vid}`));
    if (backfill.length > 0) {
      const data = backfill.map((vid) => mkHistRow("buffer", vid, "done"));
      await prisma.taskHistory.createMany({ data });
      backfill.forEach((vid) => lastTaskState.set(`buffer:${vid}`, "done"));
    }
  } catch { /* 回填失败不致命 */ }
}

async function appendTaskHistory(gw: GwStatus) {
  await initLastTaskStateOnce();

  type Row = { kind: "buffer" | "thumb" | "prefetch"; videoId: number; state: string; reason?: string | null };
  const rows: Row[] = [];

  // buffer: gw.buffer.states 含全部曾经设过状态的 vid(本进程持续累计;buf_state.json 跨重启回载)
  const bufStates = gw.buffer.states ?? {};
  for (const [vid, st] of Object.entries(bufStates)) {
    const videoId = Number(vid);
    if (!videoId || !st) continue;
    rows.push({ kind: "buffer", videoId, state: st });
  }
  // thumb: gw.thumb.states {vid: "ready"|"gen"|"error"|"cancelled"}
  // 启动时回载的 ready 状态借助 lastTaskState 去重不会重复 append;真正的转换才会进。
  for (const [vid, st] of Object.entries(gw.thumb.states ?? {})) {
    const videoId = Number(vid);
    if (!videoId || !st) continue;
    // gen 是"生成中"瞬态,不是历史事件:写进历史会冻结一条无意义的"生成中",且 gen 不在
    // TaskState 枚举内,渲染取色会崩(白屏)。只把终态写入历史(ready→done / error / cancelled)。
    if (st !== "ready" && st !== "error" && st !== "cancelled") continue;
    rows.push({ kind: "thumb", videoId, state: st === "ready" ? "done" : st });
  }
  // prefetch: gw.live.done = 本会话预缓存满的讲(若网关持久化 pf_done 后跨会话也保留)
  for (const vid of gw.live?.done ?? []) {
    const videoId = Number(vid);
    if (!videoId) continue;
    rows.push({ kind: "prefetch", videoId, state: "done" });
  }

  // 去重: 只写"上次不同的"
  const fresh: Row[] = [];
  for (const r of rows) {
    const key = `${r.kind}:${r.videoId}`;
    if (lastTaskState.get(key) === r.state) continue;
    lastTaskState.set(key, r.state);
    fresh.push(r);
  }
  if (fresh.length === 0) return;

  await prisma.taskHistory.createMany({
    data: fresh.map((r) => mkHistRow(r.kind, r.videoId, r.state, r.reason)),
  }).catch(() => { /* 镜像失败不影响主返回 */ });
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
    allTasks: [], // 网关离线时跳过 TaskHistory 查询;保持响应轻量
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
