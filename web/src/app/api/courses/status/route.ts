import { prisma } from "@/lib/db";
import { gatewayGet, gatewayPost } from "@/lib/gateway";
import { getCatalogRollup, type VidMeta } from "@/lib/catalogRollup";
import { computeDedupedTotals } from "@/lib/statusTotals";
import { normalizeThumbState } from "@/lib/thumbStatus";
import {
  parseCursor,
  formatCursor,
  planIngest,
  filterFreshEvents,
  eventRowId,
  normalizeEventProductId,
  resolveTaskCourse,
} from "@/lib/taskEvents";
import type { CoursesStatus, CourseStatus, GwStatus, TaskEventsResp, TaskItem, VidStatusDetail } from "@/types/api";

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
  const { courses, byVid, byCourseVid } = await getCatalogRollup();
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
  // 白名单归一与 mirror 写入侧 / 离线回退侧共用 normalizeThumbState(#14)，三处一份口径。
  const thumbState = (vid: number): VidStatusDetail["thumb"] =>
    normalizeThumbState(gw!.thumb.states[String(vid)]);

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
  // 预缓存逐讲控制态（pf_control 镜像）：{ [vid]: "paused"|"cancelled" }；不在表中 = running（常态）。
  const pfControl = gw.live?.control ?? {};
  // 当前会话在缓存那讲：缓存满即视为完成、不再列任务。其控制态决定任务行展示态（running→working）。
  const activePrefetch = liveVid && !liveFull ? liveVid : null;

  // 进行中：缓冲 working/queued/paused + 预缓存(只读) + 缩略图 working/queued。
  // working/queued/paused 三者天然互斥：网关在同一把 buf_lock 快照里同时算出 buffer.working
  // 与 buffer.states，同一 vid 不会既在 working 列表又被 paused 扫描到，故无重复。
  const tasks: TaskItem[] = [];
  for (const v of bufWorking) tasks.push(mk(v, "buffer", "working"));
  for (const [v, st] of Object.entries(bufStates)) {
    if (st === "paused") tasks.push(mk(v, "buffer", "paused"));
  }
  // 预缓存任务行：当前会话在缓存那讲（未满）按控制态展示——paused→已暂停（可继续/取消），
  // 否则 working（自动·随播放）；cancelled 是终态不列进行中（切回该讲会自动重启预缓存）。
  if (activePrefetch) {
    const ctl = pfControl[activePrefetch];
    if (ctl !== "cancelled") {
      tasks.push(mk(activePrefetch, "prefetch", ctl === "paused" ? "paused" : "working"));
    }
  }
  // 跨重启残留：kill-9 后 worker 没了但 pf_control 持久化了 paused，且该讲非当前 active——
  // 仍列为可继续的暂停预缓存行（resume 时网关按 video_meta 重启 worker 续缓存）。
  for (const [v, ctl] of Object.entries(pfControl)) {
    if (ctl === "paused" && v !== activePrefetch) tasks.push(mk(v, "prefetch", "paused"));
  }
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
    // #15 回退边界: 共享讲(同 videoId 跨课)按 (productId,videoId) 归属。byCourseVid 命中即正确;
    // 未命中(讲已从该课移除/课改目录)时, 按 h.productId 直接查 Course.name(courseNameByPid)而非回退
    // byVid——byVid 对共享讲是「后写覆盖」, 回退会把这条历史归到另一门仍持有同 videoId 的课(归错课)。
    // 仅当那门课也删了(courseNameByPid 也无)才最后回退 byVid 兜底。courses 即 getCatalogRollup 的
    // 课列表, 直接取 productId→name(无需再查 prisma)。
    const courseNameByPid = new Map<number, string>(courses.map((c) => [c.productId, c.name]));
    allTasks = history.map((h) => {
      const c = resolveTaskCourse({ videoId: h.videoId, productId: h.productId }, byCourseVid, byVid, courseNameByPid);
      const b = perVidGw[String(h.videoId)];
      // 同 mk():仅 buffer/prefetch 附段数,避免 thumb 任务误显示 "完成 19/243 段"。
      const showSegs = h.kind !== "thumb";
      return {
        vid: h.videoId,
        title: c.title ?? `视频 ${h.videoId}`,
        courseName: c.courseName,
        courseId: c.courseId,
        kind: h.kind as TaskItem["kind"],
        state: h.state as TaskItem["state"],
        cached: showSegs ? b?.cached : undefined,
        total: showSegs ? (b?.total ?? null) : null,
        at: h.at.getTime(), // 全屏时间线显示时间;面板折叠后同任务只一行,但全屏需 at 区分同任务多行
        reason: h.reason ?? null, // 失败原因透传(配合 Task 2);非失败为 null
      };
    });
  } catch { /* 查询失败返回空数组 */ }

  const downloadingVid = bufWorking[0] ?? activePrefetch ?? thWorking[0] ?? null;
  const dlMeta = downloadingVid ? byVid.get(Number(downloadingVid)) : null;

  // lectures/cachedLectures/thumbsReady 跨课按 distinct videoId 去重（#13）：共享讲（同
  // videoId 打进多门课）磁盘上只有一份，不能像「各课逐项相加」那样重复计数——否则与
  // bufferBytes（已用网关 buffer.bytes 物理去重）口径矛盾。见 statusTotals.ts。
  const dedupTotals = computeDedupedTotals(
    courses,
    (videoId) => {
      const b = perVidGw[String(videoId)];
      return b ? { cached: b.cached, total: b.total } : null;
    },
    thumbState,
  );

  return {
    courses: courseStatus,
    perVid,
    totals: {
      // 全局总字节用网关 buffer.bytes：这是磁盘真实占用，天然按物理 vid 去重，不会像
      // 「各课 cachedBytes 相加」那样把共享讲重复计数（共享讲磁盘只有一份）。
      bufferBytes: gw.buffer.bytes,
      bufferLimit: gw.buffer.limit,
      thumbBytes,
      lectures: dedupTotals.lectures,
      cachedLectures: dedupTotals.cachedLectures,
      thumbsReady: dedupTotals.thumbsReady,
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
      // 全局后台缓存开关：网关 /api/status 顶层 bgPaused 透传（旧网关无此字段时缺省 false）。
      bgPaused: gw.bgPaused ?? false,
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
      // 白名单归一(#14)：网关 state 可能是 cancelled/queued 等非前端合法值；只镜像 ready/gen/error。
      // 归一为 null（cancelled/queued/未知）时删除镜像行——否则离线回退会把它当 thumb 态吐给前端
      // 误显示「生成中」/上色错乱。ThumbStatus.state 非空，故落库前必须先白名单化（不能写 null）。
      const norm = normalizeThumbState(st);
      if (norm)
        ops.push(prisma.thumbStatus.upsert({ where: { videoId }, create: { videoId, state: norm }, update: { state: norm } }));
      else ops.push(prisma.thumbStatus.deleteMany({ where: { videoId } }));
    }
    if (ops.length) await prisma.$transaction(ops);
    // 任务历史:从网关事件日志按 seq 增量拉取写库(替代旧的快照 diff + 字符串去重)。
    // 网关在每个真实终态落地点 append 带单调 seq 的事件;web 按 seq>游标拉增量,不依赖轮询时机、
    // 不按状态值去重 → done→working→done 第二个 done 不再被吞(见 2026-05-29 task-event-log 方案)。
    await ingestTaskEvents();
  } catch {
    /* 镜像失败不影响主返回 */
  }
}

// 事件日志增量拉取:游标 = SyncState['taskEventSeq'] = "<epoch>:<seq>"(#3)。
// 解析 [curEpoch, curSeq] → epoch 翻转(kill-9 重启,epoch 必 +1)靠 evt-<epoch>-<seq> 全新 id 幂等
// 去重, 老事件随响应带回(网关过滤保留 epoch!=cur 的残留);epoch 不变则 since=curSeq 续传。
// 行 id 用 'evt-<epoch>-<seq>':掉盘期复用的 seq 在新 epoch 下是另一行,web 不再误去重丢真终态。
// corrupt 治本(planIngest.refetchFromZero):网关日志损坏重启 → seq 归 0(< curSeq), 当前 epoch 低 seq
// 新事件会被首个 `?since=curSeq` 请求在网关侧过滤丢; 检测到 seq 回退 → 以 `?since=0` 重新请求拉回。
// 网关掉线/异常:catch 静默,游标不动,下轮续传(不漏不重;靠 (epoch,seq) + 幂等 upsert)。
async function ingestTaskEvents() {
  try {
    // 启动一次清理 + 回填(90 天清理 / 存量噪声 / full→done),与拉取解耦但同处触发。
    await initSyncOnce();

    // 读游标 "<epoch>:<seq>"(无则 "0:0")。SyncState 可能尚未建表 → 防御性 catch 退回 0:0。
    // parseCursor(@/lib/taskEvents) 兼容旧纯数字游标(epoch 视作 0),与测试同源一份(#14)。
    let cur = { epoch: 0, seq: 0 };
    try {
      const row = await prisma.syncState.findUnique({ where: { key: "taskEventSeq" } });
      if (row) cur = parseCursor(row.value);
    } catch { /* 表不存在/查询失败,游标保持 0:0 */ }

    // 先按 curSeq 拉一次。res.epoch/res.seq 回来后用 planIngest 判定本轮策略(epoch 翻转/corrupt 复位)。
    let res = await gatewayGet<TaskEventsResp>(`/api/task_events?since=${cur.seq}`, 10000);
    // 防御:极旧网关无 epoch 字段时退化为 0(本 task 与网关同次部署,正常永远有 epoch)。
    let resEpoch = Number.isFinite(res.epoch) ? res.epoch : 0;
    let plan = planIngest(cur, resEpoch, res.seq);

    // corrupt 治本(web 侧): 网关 task_events 损坏重启 → seq 归 0(< curSeq) → 新事件是【当前 epoch
    // 的低 seq】, 首个 `?since=curSeq` 请求把它们在网关侧(过滤 e.seq>since OR e.epoch!=cur)挡掉了,
    // 本地二次过滤救不回(它们根本没进响应)。检测到 seq 回退 → 用 `?since=0` 重新请求, 让网关把当前
    // epoch 从头全量带回。重复事件靠 id='evt-<epoch>-<seq>' 幂等去重, 不会重复计数。
    if (plan.refetchFromZero) {
      console.warn(
        `网关事件日志疑似被重置(seq 回退 ${cur.seq}→${res.seq}, epoch ${cur.epoch}→${resEpoch}); 以 since=0 重拉避免丢当前 epoch 低 seq 事件`,
      );
      res = await gatewayGet<TaskEventsResp>(`/api/task_events?since=0`, 10000);
      resEpoch = Number.isFinite(res.epoch) ? res.epoch : 0;
      // 重请求后用最新 res 重新规划(此时 since=0, 当前 epoch 低 seq 事件不再被过滤)。
      plan = planIngest(cur, resEpoch, res.seq);
    }

    // fresh = 排除"本 epoch 内 seq<=since 的已消费事件";其余(本 epoch 新事件 + 任何老 epoch
    // 残留事件)都进 upsert,按 id='evt-<epoch>-<seq>' 幂等去重。
    const fresh = filterFreshEvents(res.events ?? [], resEpoch, plan.since);
    const newCursor = formatCursor(resEpoch, res.seq);

    if (fresh.length === 0) {
      // 没有新事件:仍把游标推进到网关当前 (epoch, seq),减少下轮重复传输。
      await prisma.syncState.upsert({
        where: { key: "taskEventSeq" },
        create: { key: "taskEventSeq", value: newCursor },
        update: { value: newCursor },
      });
      return;
    }

    // 事件行用 upsert(按 id='evt-<epoch>-<seq>' 幂等)而非 createMany({skipDuplicates}):
    // SQLite provider 的 Prisma createMany 不支持 skipDuplicates(类型为 never)。
    // 同一事件再次拉到(并发轮询/续传重叠/epoch 翻转重拉)时 upsert 走 update no-op,
    // 不抛 P2002、不毒化游标。TaskHistory.seq 仍存 epoch 内 seq(列语义不变)。
    await prisma.$transaction([
      ...fresh.map((e) => {
        const id = eventRowId(e.epoch, e.seq);
        // #15: 写入事件携带的 productId(共享讲归属)。网关从 video_meta 盖上,可能缺省/为 null。
        const pid = normalizeEventProductId(e.productId);
        const row = {
          kind: e.kind,
          videoId: Number(e.vid),
          productId: pid,
          state: e.state,
          reason: e.reason ?? null,
          at: new Date(e.ts * 1000),
          seq: e.seq,
        };
        return prisma.taskHistory.upsert({
          where: { id },
          create: { id, ...row },
          update: {}, // 已存在则不动(幂等);事件是不可变的,无需覆盖
        });
      }),
      prisma.syncState.upsert({
        where: { key: "taskEventSeq" },
        create: { key: "taskEventSeq", value: newCursor },
        update: { value: newCursor },
      }),
    ]);
  } catch {
    /* 网关掉线/事务失败:游标不动,下轮按同一 (epoch,seq) 续传(不漏不重) */
  }
}

// 回填路径用的历史行:随机 id + now(seq=NULL)。
// 事件路径不用此 helper(它用 id='evt-<epoch>-<seq>' + at=new Date(ts*1000),见 ingestTaskEvents)。
function mkHistRow(kind: string, videoId: number, state: string, reason?: string | null) {
  return {
    id: `${kind}-${videoId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    videoId,
    state,
    reason: reason ?? null,
  };
}

// 进程级一次性启动迁移:90 天清理 + 存量噪声清理 + full→done 回填。与事件拉取解耦。
// (旧的 lastTaskState diff 逻辑已删:写入侧不再做快照 diff,改由网关事件日志 + seq 增量驱动。)
let syncInited = false;

async function initSyncOnce() {
  if (syncInited) return;
  syncInited = true;

  // 启动一次清理: TaskHistory 表 append-only, 半年后膨胀至几 M 行 → 查询慢。
  // 保留最近 90 天足够"全部"标签展示, 旧记录无价值删掉。
  try {
    const cutoff = new Date(Date.now() - 90 * 86400 * 1000);
    await prisma.taskHistory.deleteMany({ where: { at: { lt: cutoff } } });
  } catch { /* 清理失败不致命 */ }

  // 启动幂等清理迁移(2026-05-29 操作历史清理计划 Task 5):清存量噪声。
  // 仅删"确定无价值"的:测试桩 + 决策 1 要清的 thumb cancelled + 被更晚终态取代的僵尸 working/queued。
  // 幂等:连跑两次第二次影响 0 行也不报错(deleteMany / DELETE 都天然幂等)。
  // (事件日志方案后运行态根本不再入库,working/queued 行只会是历史残留。)
  try {
    // (a) e2e 测试桩(合成 vid,grep 仓库无真实引用)
    await prisma.taskHistory.deleteMany({ where: { videoId: { in: [999000111, 888000222, 777000333] } } });
    // (c) 决策 2026-05-29:缩略图取消完全不进历史 → 清存量 354 行
    await prisma.taskHistory.deleteMany({ where: { kind: "thumb", state: "cancelled" } });
    // (b) 被更晚终态取代的僵尸 working/queued(append-only 残骸)。用原生 SQL 做 EXISTS 子查询:
    // 只删"同 (kind,videoId) 有更晚行"的 working/queued;没有更晚态的(真·进行中)不删。
    await prisma.$executeRawUnsafe(
      `DELETE FROM TaskHistory WHERE state IN ('working','queued') AND EXISTS (
         SELECT 1 FROM TaskHistory t2 WHERE t2.kind=TaskHistory.kind
         AND t2.videoId=TaskHistory.videoId AND t2.at > TaskHistory.at)`,
    );
  } catch { /* 清理失败不致命 */ }

  // 跨会话回填: CacheStatus 里 state='full' (=cached=total 整集已缓存好) 的 vid
  // 在 TaskHistory 里如果没记录过 buffer "done", 一次性补上 kind='buffer' state='done'。
  // 这覆盖了用户在 buf_state.json 持久化之前(老版本)做过的 buffer/prefetch 完成,
  // 让"全部"标签显示的不只是 thumb,而是所有曾整集缓存好的讲。
  // 回填行 seq=NULL(mkHistRow 不带 seq)+随机 id+now:它们不是事件日志事件,不占 seq 序号。
  try {
    const fullCached = await prisma.cacheStatus.findMany({
      where: { state: "full" },
      select: { videoId: true },
    });
    const vids = fullCached.map((c) => c.videoId);
    if (vids.length > 0) {
      // 已存在 buffer done 的讲不重复回填(直接查库,不再依赖内存 Map)。
      const existing = await prisma.taskHistory.findMany({
        where: { kind: "buffer", state: "done", videoId: { in: vids } },
        select: { videoId: true },
      });
      const have = new Set(existing.map((r) => r.videoId));
      const backfill = vids.filter((vid) => !have.has(vid));
      if (backfill.length > 0) {
        await prisma.taskHistory.createMany({
          data: backfill.map((vid) => mkHistRow("buffer", vid, "done")),
        });
      }
    }
  } catch { /* 回填失败不致命 */ }
}

async function fallback(
  courses: Awaited<ReturnType<typeof getCatalogRollup>>["courses"],
  byVid: Map<number, VidMeta>,
  watched: Set<string>,
): Promise<CoursesStatus> {
  const [cs, ts] = await Promise.all([prisma.cacheStatus.findMany(), prisma.thumbStatus.findMany()]);
  const cacheBy = new Map(cs.map((r) => [r.videoId, r]));
  // 离线回退也走白名单归一(#14)：自愈任何在本修复前已被污染（cancelled/queued 落库）的镜像行——
  // 否则网关掉线时会把非法值当 thumb 态吐给前端误显示「生成中」/上色错乱。归一一次，下游两处共用。
  const thumbBy = new Map(ts.map((r) => [r.videoId, normalizeThumbState(r.state)]));
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
    (videoId) => thumbBy.get(videoId) ?? null,
    false,
  );
  // 全局总字节按 unique videoId 去重：cacheBy 本身就是 videoId 建键（每讲一行），直接累加其
  // 字节即天然去重；不能用「各课 cachedBytes 相加」，那会把共享讲在每门拥有它的课里重复计数。
  const totalBytes = Array.from(cacheBy.values()).reduce((a, r) => a + (r.bytes || 0), 0);

  // 同 build()：lectures/cachedLectures/thumbsReady 跨课按 distinct videoId 去重（#13）。
  const dedupTotals = computeDedupedTotals(
    courses,
    (videoId) => {
      const b = cacheBy.get(videoId);
      return b ? { cached: b.cachedSegments, total: b.totalSegments } : null;
    },
    (videoId) => thumbBy.get(videoId) ?? null,
  );

  return {
    courses: courseStatus,
    perVid,
    totals: {
      bufferBytes: totalBytes,
      bufferLimit: 0,
      thumbBytes: 0,
      lectures: dedupTotals.lectures,
      cachedLectures: dedupTotals.cachedLectures,
      thumbsReady: dedupTotals.thumbsReady,
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
      bgPaused: false, // 网关离线：开关态未知，按未暂停显示（避免误导）。
    },
    orphans: [],
  };
}
