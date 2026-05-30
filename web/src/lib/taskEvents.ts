// 任务事件日志 ingest 的纯函数逻辑（无 IO），供 route.ts 与单测共享一份真源（#14 同理）。
//
// 为什么抽出来：ingestTaskEvents 的「游标解析 / epoch 翻转·corrupt 复位判定 / fresh 过滤 /
// productId 归一 / 课程名解析回退」原本散在 route.ts 里，多个 e2e/.test.mjs「手抄复刻」了它们
// （node --test 跑 .mjs 当时不能 import .ts）。Node 22 起 .mjs 可直接 import .ts（见
// _e2e_totals_dedupe.mjs 已证明），故把可纯函数化的部分收口到本模块，route.ts 与测试同时 import，
// 删手抄副本，根治「改了 .ts 却忘了同步手抄」的漂移。

// ---- 游标 "<epoch>:<seq>" ----
// 兼容旧纯数字 "<seq>"(升级前写的): 无 ":" 时视作 epoch=0、seq=该数字。
export interface Cursor {
  epoch: number;
  seq: number;
}
export function parseCursor(raw: unknown): Cursor {
  const parts = String(raw ?? "").split(":");
  if (parts.length === 2) {
    return { epoch: Number(parts[0]) || 0, seq: Number(parts[1]) || 0 };
  }
  return { epoch: 0, seq: Number(raw) || 0 }; // 旧格式: 纯 seq
}
export function formatCursor(epoch: number, seq: number): string {
  return `${epoch}:${seq}`;
}

// ---- ingest 规划: 给定本地游标 (curEpoch,curSeq) 与网关响应头 (resEpoch,resSeq) 决定本轮策略 ----
//
// 治本 corrupt(网关 task_events 损坏重启 → seq 归 0、epoch 翻转、deque 清空)下的丢事件:
//   旧逻辑只用 `?since=curSeq` 拉一次, 网关过滤 `e.seq>since OR e.epoch!=cur`。corrupt 后新事件
//   是【当前 epoch 的低 seq】(seq=1,2,… ≤ curSeq), 两个条件都不满足 → 被网关侧过滤掉, 直到
//   seq 自然爬回 curSeq 以上才自愈。web 端二次过滤(本地 since=0)救不回来——它们根本没进响应。
//   根因: 首个请求的 `?since=curSeq` 在【请求层】就把当前 epoch 低 seq 事件挡在网关外。
// 修: 当 resSeq < curSeq(网关峰值 seq 回退 = 被重置)时, 必须用 `?since=0` 【重新请求】, 让网关
//   把当前 epoch 从头全量带回。epochFlip 仅靠 id 幂等去重就够(不必重请求), 唯独 seq 回退要重请求。
export interface IngestPlan {
  epochFlip: boolean; // 网关 epoch 与本地游标 epoch 不一致(重启)
  seqRegressed: boolean; // 网关峰值 seq < 本地游标 seq(corrupt 复位信号)
  // 是否需要用 ?since=0 重新向网关请求(corrupt 复位下当前 epoch 低 seq 事件被首个请求过滤掉了)。
  refetchFromZero: boolean;
  // 本地 fresh 过滤用的 since: refetch 时为 0(全量重过滤), 否则同 epoch 续传用 curSeq、翻转用 0。
  since: number;
}
export function planIngest(cur: Cursor, resEpoch: number, resSeq: number): IngestPlan {
  const epochFlip = resEpoch !== cur.epoch;
  const seqRegressed = resSeq < cur.seq;
  // seq 回退 = corrupt 复位: 首个 ?since=curSeq 已把当前 epoch 低 seq 事件挡在网关外, 必须重请求。
  const refetchFromZero = seqRegressed;
  // since: 重请求 / epoch 翻转 → 0(从头重过滤); 同 epoch 正常续传 → curSeq。
  const since = refetchFromZero || epochFlip ? 0 : cur.seq;
  return { epochFlip, seqRegressed, refetchFromZero, since };
}

// ---- fresh 过滤: 排除「本 epoch 内 seq<=since 的已消费事件」 ----
// 其余(本 epoch 新事件 + 任何老 epoch 残留事件)都保留, 交由调用方按 id='evt-<epoch>-<seq>' 幂等去重。
// 仅取过滤需要的最小形状(epoch?/seq), 泛型 T 透传调用方的完整事件类型(不丢字段、不要求 index 签名)。
export interface SeqEpoch {
  epoch?: number;
  seq: number;
}
export function filterFreshEvents<T extends SeqEpoch>(events: T[], resEpoch: number, since: number): T[] {
  return (events ?? []).filter((e) => !((e.epoch ?? 0) === resEpoch && e.seq <= since));
}

// ---- TaskHistory 行 id + productId 归一 ----
export function eventRowId(epoch: number | undefined, seq: number): string {
  return `evt-${epoch ?? 0}-${seq}`;
}
// #15: 写入事件携带的 productId(共享讲归属)。网关从 video_meta 盖上, 可能缺省/为 null。
export function normalizeEventProductId(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

// ---- 课程名解析: 共享讲(同 videoId 跨课)按 (productId,videoId) 归属 (#15) ----
//
// byCourseVid 命中(讲仍在该课目录里) → 用它(归属正确)。
// byCourseVid 未命中(讲已从该课移除 / 该课已删, 但 productId 仍记在历史行里): 旧逻辑回退 byVid,
//   而 byVid 对共享讲是「后写覆盖」—— 可能把这条历史归到【另一门仍持有同 videoId 的课】(归错课)。
// 修: byCourseVid 未命中时, 先按 h.productId 直接查 Course.name(courseNameByPid 注入), 这样即便讲
//   已从课移除, 只要课还在就归属正确; 课也删了(courseNameByPid 也无) 才最后回退 byVid。
export interface CourseVidMeta {
  courseId: number;
  courseName: string;
  title: string | null;
}
export interface ResolvedCourse {
  courseName: string;
  courseId: number;
  title: string | null;
}
export function resolveTaskCourse(
  h: { videoId: number; productId: number | null },
  byCourseVid: Map<string, CourseVidMeta>,
  byVid: Map<number, CourseVidMeta>,
  // h.productId → Course.name(prisma 查 Course 表): 讲已从课移除但课仍在时按它归属, 不回退 byVid。
  courseNameByPid: Map<number, string>,
): ResolvedCourse {
  // 1) 讲仍在该课目录里 → 复合键命中, 归属正确(且带 title/kind)。
  if (h.productId != null) {
    const exact = byCourseVid.get(`${h.productId}:${h.videoId}`);
    if (exact) return { courseName: exact.courseName, courseId: exact.courseId, title: exact.title };
    // 2) 复合键未命中(讲从课移除/课改目录), 但 Course 表里这门课还在 → 用 h.productId 的课名,
    //    避免回退 byVid 把共享讲归到「后写覆盖」的另一门课(#15 回退边界 bug)。
    const name = courseNameByPid.get(h.productId);
    if (name != null) return { courseName: name, courseId: h.productId, title: null };
  }
  // 3) productId 为 NULL(存量行)或那门课也删了 → 最后回退 byVid(后写覆盖, best-effort)。
  const m = byVid.get(h.videoId);
  if (m) return { courseName: m.courseName, courseId: m.courseId, title: m.title };
  return { courseName: "未知课程", courseId: 0, title: null };
}
