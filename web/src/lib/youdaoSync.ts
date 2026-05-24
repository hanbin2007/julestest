import { prisma } from "./db";
import { gatewayGet } from "./gateway";
import { getCourses } from "./catalog";
import { getCatalogRollup } from "./catalogRollup";

// 从有道把每门课的观看状态拉下来，按「不回退、已学完为准」合并进本地 Progress。
//
// 为什么是这套合并语义（而非严格按时间戳取最新）：
// 有道每讲只给「最后播放位置 playDuration / 累计 accumulativeDuration / 是否学完 study」，
// 不带任何时间戳，无法跨端比较「谁更新」。本地 Progress 才有 at 时间戳。能落地的「按最新合并」是：
//   · 位置  t = max(本地 t, 有道 playDuration)         —— 只前进不回退
//   · 完成  study===true 或本地 t/d≥0.9 → 记 t=d 哨兵 —— 与既有「已看」判定一致
//   · at    仅当有道带来了新进展时才更新为 now()       —— 此后本地继续观看凭更新的 at 自然胜出
// 即：有道的进度一次性补进来；之后本地的观看永远更新。accumulativeDuration 含重看噪声，不参与合并。

interface GwWatch {
  videoId: number;
  playDuration: number | null;
  accumulativeDuration: number | null;
  duration: number | null;
  study: boolean;
  title: string | null;
}

export interface YoudaoSyncResult {
  courses: { total: number; ok: number; failed: number };
  videos: { scanned: number; created: number; updated: number; skipped: number };
  failedProducts: number[];
}

const num = (x: unknown): number =>
  typeof x === "number" && Number.isFinite(x) ? x : 0;

// 限并发地拉每门课的观看状态，再合并。productId 可选：缺省同步全部已购课程。
export async function syncYoudaoProgress(
  productId?: number,
): Promise<YoudaoSyncResult> {
  const all = await getCourses();
  const targets = productId
    ? all.filter((c) => c.id === productId)
    : all;
  const { byVid } = await getCatalogRollup();
  const nameById = new Map(all.map((c) => [c.id, c.name]));

  // 现有进度一次性读出，避免逐讲查库。Progress 主键为 (productId,videoId)，
  // videoId 跨课不唯一，故 localBy 也按 `${productId}:${videoId}` 索引，否则两门课共享同一
  // videoId 时 Map 会互相覆盖，合并判定 changed 就会拿错课的本地进度比较（漏写/空写）。
  const rows = await prisma.progress.findMany({
    select: { productId: true, videoId: true, t: true, d: true },
  });
  const localBy = new Map(rows.map((r) => [`${r.productId}:${r.videoId}`, { t: r.t, d: r.d }]));

  const res: YoudaoSyncResult = {
    courses: { total: targets.length, ok: 0, failed: 0 },
    videos: { scanned: 0, created: 0, updated: 0, skipped: 0 },
    failedProducts: [],
  };

  // 待写入的 upsert 操作；最后统一在一个事务里落库（SQLite 写串行更稳）。
  const writes: { videoId: number; data: { t: number; d: number; productId: number; title: string | null; courseName: string | null } }[] = [];

  // 并发度 4：有道每条 detail 约 1s，~50 门课串行要近一分钟。
  const POOL = 4;
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const c = targets[i++];
      let watch: GwWatch[];
      try {
        const r = await gatewayGet<{ watch: GwWatch[] }>(
          `/api/watch_state?productId=${c.id}`,
        );
        watch = r.watch ?? [];
        res.courses.ok++;
      } catch {
        res.courses.failed++;
        res.failedProducts.push(c.id);
        continue;
      }
      for (const w of watch) {
        res.videos.scanned++;
        const ydDur = num(w.duration);
        let ydPos = num(w.playDuration);
        if (ydDur > 0) ydPos = Math.min(ydPos, ydDur);
        const ydStudy = w.study === true;
        // 有道这一讲没有任何观看信号 → 不动本地（本地数据必须存活）。
        if (!ydStudy && ydPos <= 0) {
          res.videos.skipped++;
          continue;
        }
        // 这一讲的 productId 即当前遍历的课 c.id（watch_state 就是按 c.id 拉的）。
        const key = `${c.id}:${w.videoId}`;
        const local = localBy.get(key);
        const localT = num(local?.t);
        const localD = num(local?.d);
        const newD = Math.max(localD, ydDur);
        const localComplete = localD > 0 && localT / localD >= 0.9;
        const completed = ydStudy || localComplete;
        // 已学完却处处拿不到时长 → 无法表达「已看」（watched 判定需 d>0），跳过。
        if (completed && newD <= 0) {
          res.videos.skipped++;
          continue;
        }
        // 已学完：记 t=d 哨兵（沿用既有 t/d≥0.9「已看」判定）；否则取更靠前的位置。
        const newT = completed && newD > 0 ? newD : Math.max(localT, ydPos);

        const meaningful = newT > 0 || newD > 0;
        const changed = local
          ? newT > localT + 0.5 || newD > localD + 0.5
          : meaningful;
        if (!changed) {
          res.videos.skipped++;
          continue;
        }

        const meta = byVid.get(w.videoId);
        writes.push({
          videoId: w.videoId,
          data: {
            t: newT,
            d: newD,
            productId: c.id,
            title: meta?.title ?? w.title ?? null,
            courseName: meta?.courseName ?? nameById.get(c.id) ?? null,
          },
        });
        if (local) res.videos.updated++;
        else res.videos.created++;
        // 本轮内若同一讲再次出现，按已合并值参与后续比较（同 (productId,videoId) 键）。
        localBy.set(key, { t: newT, d: newD });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, targets.length) }, worker));

  if (writes.length) {
    // at 由 @updatedAt 自动写为 now()，正是「有道带来新进展」的时刻。
    await prisma.$transaction(
      writes.map((w) =>
        prisma.progress.upsert({
          where: { productId_videoId: { productId: w.data.productId, videoId: w.videoId } },
          create: { videoId: w.videoId, ...w.data },
          update: w.data,
        }),
      ),
    );
  }
  return res;
}
