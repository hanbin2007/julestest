// 纯单元测试（无网关/无 DB，直接 `node web/scripts/_e2e_totals_dedupe.mjs`）：
// totals.lectures / cachedLectures / thumbsReady 跨课去重 (#13)。
//
// 背景 bug：旧实现用 courseStatus.reduce((a,c)=>a+c.lectures,0) 等「各课逐项相加」，
// 同一 videoId 被多门课打包时会按 distinct (course,videoId) 重复计数——与 bufferBytes
// 早已按物理 vid 去重的口径矛盾。修复后这三项按 distinct videoId 计（thumbsReady 也只
// 按 distinct videoId，避免共享讲缩略图重复算）。
//
// 失败信号：把 statusTotals.ts 改回「各课相加」→ 共享讲被 ×2，本测试 FAIL。
import { computeDedupedTotals } from "../src/lib/statusTotals.ts";

let failures = 0;
function check(name, cond, extra) {
  console.log(cond ? `  ok  - ${name}` : `  FAIL- ${name}` + (extra ? ` :: ${extra}` : ""));
  if (!cond) failures++;
}

// 两门课共享 videoId=100（同一讲打进两门课），各自另有独占讲。
// 课 A: [100(共享), 200(独占)]；课 B: [100(共享), 300(独占)]。
// distinct videoId = {100,200,300} = 3 讲。
const courses = [
  { productId: 1, name: "课A", vids: [{ videoId: 100, kind: "vod" }, { videoId: 200, kind: "vod" }] },
  { productId: 2, name: "课B", vids: [{ videoId: 100, kind: "vod" }, { videoId: 300, kind: "live" }] },
];

// 缓存态：100 有缓存(cached>0)，200 无缓存，300 有缓存。
const cachedSet = new Set([100, 300]);
const getVid = (videoId) => (cachedSet.has(videoId) ? { cached: 5, total: 10 } : { cached: 0, total: 10 });
// 缩略图态：100 ready，200 ready，300 无。
const thumbReadySet = new Set([100, 200]);
const getThumb = (videoId) => (thumbReadySet.has(videoId) ? "ready" : null);

const t = computeDedupedTotals(courses, getVid, getThumb);

// lectures = distinct videoId 数 = {100,200,300} = 3（旧实现会算成 4：100 被两门各算一次）。
check("lectures 跨课去重 = 3", t.lectures === 3, `got ${t.lectures}`);
// cachedLectures = distinct videoId 中 cached>0 的 = {100,300} = 2（旧实现 100 会被 ×2 → 3）。
check("cachedLectures 跨课去重 = 2", t.cachedLectures === 2, `got ${t.cachedLectures}`);
// thumbsReady = distinct videoId 中 thumb==='ready' 的 = {100,200} = 2（旧实现 100 ×2 → 3）。
check("thumbsReady 跨课去重 = 2", t.thumbsReady === 2, `got ${t.thumbsReady}`);

// 无共享时与朴素求和等价（无回归）：两门完全不相交。
const disjoint = [
  { productId: 1, name: "课A", vids: [{ videoId: 11, kind: "vod" }] },
  { productId: 2, name: "课B", vids: [{ videoId: 22, kind: "vod" }] },
];
const t2 = computeDedupedTotals(disjoint, () => ({ cached: 1, total: 1 }), () => "ready");
check("无共享: lectures=2", t2.lectures === 2, `got ${t2.lectures}`);
check("无共享: cachedLectures=2", t2.cachedLectures === 2, `got ${t2.cachedLectures}`);
check("无共享: thumbsReady=2", t2.thumbsReady === 2, `got ${t2.thumbsReady}`);

// getVid 返回 null（网关无该 vid 任何态）应视为未缓存，不计入 cachedLectures。
const t3 = computeDedupedTotals(
  [{ productId: 1, name: "课A", vids: [{ videoId: 9, kind: "vod" }] }],
  () => null,
  () => null,
);
check("getVid=null → lectures=1 / cached=0 / thumb=0",
  t3.lectures === 1 && t3.cachedLectures === 0 && t3.thumbsReady === 0,
  JSON.stringify(t3));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
