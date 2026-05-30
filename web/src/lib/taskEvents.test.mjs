import { test } from "node:test";
import assert from "node:assert/strict";

// 测试目标: taskEvents.ts 的纯函数逻辑(#14 同源化, 真 import .ts 而非手抄复刻)。
// Node 22 起 .mjs 可直接 import .ts(原生 strip-types), 见 _e2e_totals_dedupe.mjs 已证明。
import {
  parseCursor,
  formatCursor,
  planIngest,
  filterFreshEvents,
  eventRowId,
  normalizeEventProductId,
  resolveTaskCourse,
} from "./taskEvents.ts";

// ---- 游标解析 ----
test("parseCursor: '<epoch>:<seq>' 正常解析", () => {
  assert.deepEqual(parseCursor("5:100"), { epoch: 5, seq: 100 });
});
test("parseCursor: 旧纯数字格式视作 epoch=0", () => {
  assert.deepEqual(parseCursor("100"), { epoch: 0, seq: 100 });
});
test("parseCursor: 空/无值 → 0:0", () => {
  assert.deepEqual(parseCursor(""), { epoch: 0, seq: 0 });
  assert.deepEqual(parseCursor(null), { epoch: 0, seq: 0 });
  assert.deepEqual(parseCursor(undefined), { epoch: 0, seq: 0 });
});
test("formatCursor 与 parseCursor 往返一致", () => {
  assert.deepEqual(parseCursor(formatCursor(7, 42)), { epoch: 7, seq: 42 });
});

// ---- ingest 规划: corrupt epoch web 侧丢事件根治 ----
test("planIngest: 同 epoch 正常续传 since=curSeq, 不重请求", () => {
  const p = planIngest({ epoch: 5, seq: 100 }, 5, 150);
  assert.equal(p.epochFlip, false);
  assert.equal(p.seqRegressed, false);
  assert.equal(p.refetchFromZero, false);
  assert.equal(p.since, 100);
});
test("planIngest: 普通重启(epoch 翻转, seq 未回退) since=0 但无需重请求(老事件靠 epoch!=cur 带回)", () => {
  const p = planIngest({ epoch: 5, seq: 100 }, 6, 100);
  assert.equal(p.epochFlip, true);
  assert.equal(p.seqRegressed, false);
  assert.equal(p.refetchFromZero, false);
  assert.equal(p.since, 0);
});
test("planIngest: CORRUPT 重启(seq 回退到 0) → 必须 refetchFromZero(否则当前 epoch 低 seq 事件被网关侧过滤丢)", () => {
  // 失败信号: 旧逻辑此处 refetchFromZero 概念不存在, 只发 since=curSeq → 当前 epoch seq=1..N 全被网关过滤。
  const p = planIngest({ epoch: 5, seq: 100 }, 6, 3);
  assert.equal(p.seqRegressed, true);
  assert.equal(p.refetchFromZero, true, "seq 回退必须触发 since=0 重请求");
  assert.equal(p.since, 0);
});
test("planIngest: 同 epoch 但 seq 回退(理论 corrupt 未翻 epoch) 也要 refetch", () => {
  const p = planIngest({ epoch: 5, seq: 100 }, 5, 2);
  assert.equal(p.epochFlip, false);
  assert.equal(p.seqRegressed, true);
  assert.equal(p.refetchFromZero, true);
  assert.equal(p.since, 0);
});

// ---- fresh 过滤 ----
test("filterFreshEvents: 排除本 epoch 内 seq<=since, 保留老 epoch 残留与新事件", () => {
  const events = [
    { epoch: 5, seq: 99, kind: "buffer" }, // 老 epoch 残留 → 保留(epoch!=resEpoch)
    { epoch: 6, seq: 1, kind: "thumb" }, // 本 epoch seq<=since → 排除
    { epoch: 6, seq: 5, kind: "buffer" }, // 本 epoch 新事件 → 保留
  ];
  const fresh = filterFreshEvents(events, 6, 1);
  assert.deepEqual(fresh.map((e) => `${e.epoch}-${e.seq}`), ["5-99", "6-5"]);
});
test("filterFreshEvents: corrupt 重请求(since=0)下当前 epoch 全部低 seq 都保留", () => {
  const events = [
    { epoch: 6, seq: 1, kind: "buffer" },
    { epoch: 6, seq: 2, kind: "thumb" },
    { epoch: 6, seq: 3, kind: "prefetch" },
  ];
  const fresh = filterFreshEvents(events, 6, 0);
  assert.equal(fresh.length, 3, "since=0 时当前 epoch 低 seq 事件不再被丢");
});

// ---- 行 id + productId ----
test("eventRowId: 含 epoch", () => {
  assert.equal(eventRowId(6, 3), "evt-6-3");
  assert.equal(eventRowId(undefined, 3), "evt-0-3");
});
test("normalizeEventProductId: 仅有限数字保留, 否则 null", () => {
  assert.equal(normalizeEventProductId(815001), 815001);
  assert.equal(normalizeEventProductId(null), null);
  assert.equal(normalizeEventProductId(undefined), null);
  assert.equal(normalizeEventProductId(NaN), null);
  assert.equal(normalizeEventProductId("815001"), null);
});

// ---- 课程名解析: #15 回退边界 ----
const mkMeta = (courseId, courseName, title = null) => ({ courseId, courseName, title });
function fixtureMaps() {
  // 共享讲 7 属课程 X(100) 与课程 Y(200); byVid 后写覆盖到 Y。
  const byCourseVid = new Map([
    ["100:7", mkMeta(100, "课程X", "X-7")],
    ["200:7", mkMeta(200, "课程Y", "Y-7")],
  ]);
  const byVid = new Map([[7, mkMeta(200, "课程Y", "Y-7")]]); // 后写覆盖
  const courseNameByPid = new Map([[100, "课程X"], [200, "课程Y"], [300, "课程Z"]]);
  return { byCourseVid, byVid, courseNameByPid };
}

test("resolveTaskCourse: byCourseVid 命中 → 归属正确课(共享讲不被 byVid 后写覆盖坑)", () => {
  const { byCourseVid, byVid, courseNameByPid } = fixtureMaps();
  const r = resolveTaskCourse({ videoId: 7, productId: 100 }, byCourseVid, byVid, courseNameByPid);
  assert.equal(r.courseName, "课程X");
  assert.equal(r.courseId, 100);
});

test("resolveTaskCourse[#15 回退边界]: 讲已从课X移除(byCourseVid 未命中)但课X仍在 → 按 productId 查 Course.name, 不回退 byVid 归到课Y", () => {
  const { byVid, courseNameByPid } = fixtureMaps();
  // 模拟: 讲 7 从课X(100)目录移除 → byCourseVid 无 "100:7"; 但课Y(200)仍持有讲 7 → byVid 仍指向课Y。
  const byCourseVidMissing = new Map([["200:7", mkMeta(200, "课程Y", "Y-7")]]);
  const r = resolveTaskCourse({ videoId: 7, productId: 100 }, byCourseVidMissing, byVid, courseNameByPid);
  // 修复前: 回退 byVid → "课程Y"(归错课, 正是本 bug)。修复后: 按 productId=100 查 Course.name → "课程X"。
  assert.equal(r.courseName, "课程X", "应归属 productId 真正所属的课X, 不被 byVid 后写覆盖坑到课Y");
  assert.equal(r.courseId, 100);
  // 显式失败信号: 不等于 byVid 误解析的课Y。
  assert.notEqual(r.courseName, "课程Y");
});

test("resolveTaskCourse: 讲从课移除且该课也删了(courseNameByPid 无) → 最后回退 byVid(best-effort 不崩)", () => {
  const { byVid } = fixtureMaps();
  const byCourseVidMissing = new Map([["200:7", mkMeta(200, "课程Y", "Y-7")]]);
  const courseNameByPidNoX = new Map([[200, "课程Y"]]); // 课X(100) 已删
  const r = resolveTaskCourse({ videoId: 7, productId: 100 }, byCourseVidMissing, byVid, courseNameByPidNoX);
  assert.equal(r.courseName, "课程Y"); // 课X 没了, 回退 byVid 到课Y(best-effort)
});

test("resolveTaskCourse: productId 为 NULL 的存量行 → 直接回退 byVid", () => {
  const { byCourseVid, byVid, courseNameByPid } = fixtureMaps();
  const r = resolveTaskCourse({ videoId: 7, productId: null }, byCourseVid, byVid, courseNameByPid);
  assert.equal(r.courseName, "课程Y"); // byVid 后写覆盖到课Y
});

test("resolveTaskCourse: 完全未知讲 → 未知课程兜底", () => {
  const { byCourseVid, byVid, courseNameByPid } = fixtureMaps();
  const r = resolveTaskCourse({ videoId: 999, productId: 999 }, byCourseVid, byVid, courseNameByPid);
  assert.equal(r.courseName, "未知课程");
  assert.equal(r.courseId, 0);
});
