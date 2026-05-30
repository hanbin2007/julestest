// 跨课去重的全局 totals 计算 (#13)。
//
// 为什么需要：CacheStatus / ThumbStatus 两张镜像表「故意」只按 videoId 建键，因为它们镜像
// 的是网关那份「物理上只认 vid」的磁盘缓存——同一讲被多门课打包时磁盘上只有一份。所以
// per-course 的计数（lectures / cachedLectures / thumbsReady）会把共享讲「重复算进每门
// 拥有它的课」。这对单门课视图是对的，但跨课求「全局总数」必须按 unique videoId 去重——
// 否则与 bufferBytes（早已用网关 buffer.bytes 物理去重）的口径自相矛盾（见 route.ts totals
// 处的注释）。本函数即按 distinct videoId 计这三项。
//
// 纯函数（无 IO），便于 `node web/scripts/_e2e_totals_dedupe.mjs` 直接单测。

// 仅取计算所需的最小结构形状（避免耦合 catalogRollup / api 的完整类型）。
export interface TotalsVid {
  videoId: number;
}
export interface TotalsCourse {
  vids: TotalsVid[];
}

// 与 route.ts buildCourseStatus 同口径：cached>0 即算「已缓存(含部分)」；thumb==='ready'
// 才算「缩略图就绪」。getVid 返回 null 表示网关/DB 无该 vid 任何态 → 视为未缓存。
export interface DedupedTotals {
  lectures: number;
  cachedLectures: number;
  thumbsReady: number;
}

export function computeDedupedTotals(
  courses: TotalsCourse[],
  getVid: (videoId: number) => { cached: number; total: number | null } | null,
  getThumb: (videoId: number) => string | null,
): DedupedTotals {
  // 按 distinct videoId 去重：同一讲跨多门课只进各集合一次。
  const seen = new Set<number>();
  let lectures = 0;
  let cachedLectures = 0;
  let thumbsReady = 0;
  for (const c of courses) {
    for (const v of c.vids) {
      if (seen.has(v.videoId)) continue; // 共享讲只算一次
      seen.add(v.videoId);
      lectures++;
      const b = getVid(v.videoId);
      if (b && b.cached > 0) cachedLectures++;
      if (getThumb(v.videoId) === "ready") thumbsReady++;
    }
  }
  return { lectures, cachedLectures, thumbsReady };
}
