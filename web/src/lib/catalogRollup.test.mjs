import { test } from "node:test";
import assert from "node:assert/strict";

// 测试目标：catalogRollup.ts 里 buildKeyMaps 的纯逻辑（byVid 后写覆盖 / byCourseVid 复合键独立）。
// 限制说明：node --test 跑 .mjs 无法直接 import .ts（无编译步骤），故此处「复刻」同一份纯逻辑
// 做不变式回归（与 buildKeyMaps 保持字节级一致）。若将来加了 TS→JS 编译产物，可改为直接 import。
function buildKeyMaps(courses) {
  const byVid = new Map();
  const byCourseVid = new Map();
  for (const c of courses)
    for (const v of c.vids) {
      const meta = {
        courseId: c.productId,
        courseName: c.name,
        title: v.title,
        kind: v.kind,
        duration: v.duration,
      };
      byVid.set(v.videoId, meta);
      byCourseVid.set(`${c.productId}:${v.videoId}`, meta);
    }
  return { byVid, byCourseVid };
}

const mkCourse = (productId, name, vids) => ({ productId, name, vids });
const mkVid = (videoId, title, duration = null, kind = "vod") => ({ videoId, title, duration, kind });

test("byVid 对共享 videoId 后写覆盖（保留最后一门课的 meta）", () => {
  const courses = [
    mkCourse(100, "课程A", [mkVid(7, "A-第7讲", 600)]),
    mkCourse(200, "课程B", [mkVid(7, "B-第7讲", 900)]),
  ];
  const { byVid } = buildKeyMaps(courses);
  // videoId=7 同时属于 100/200 两门课 → byVid 只保留后写的 200。
  assert.equal(byVid.size, 1);
  assert.equal(byVid.get(7).courseId, 200);
  assert.equal(byVid.get(7).courseName, "课程B");
  assert.equal(byVid.get(7).duration, 900);
});

test("byCourseVid 复合键各自独立，两门课的共享讲都保留", () => {
  const courses = [
    mkCourse(100, "课程A", [mkVid(7, "A-第7讲", 600)]),
    mkCourse(200, "课程B", [mkVid(7, "B-第7讲", 900)]),
  ];
  const { byCourseVid } = buildKeyMaps(courses);
  assert.equal(byCourseVid.size, 2);
  assert.equal(byCourseVid.get("100:7").courseName, "课程A");
  assert.equal(byCourseVid.get("100:7").duration, 600);
  assert.equal(byCourseVid.get("200:7").courseName, "课程B");
  assert.equal(byCourseVid.get("200:7").duration, 900);
});

test("duration 随复合键正确解析（共享讲在两门课时长不同）", () => {
  const courses = [
    mkCourse(1, "甲", [mkVid(5, "甲-5", 120, "live")]),
    mkCourse(2, "乙", [mkVid(5, "乙-5", 480, "vod")]),
  ];
  const { byVid, byCourseVid } = buildKeyMaps(courses);
  // 按复合键取到的是各自课的时长/类型；byVid 则是后写的乙。
  assert.equal(byCourseVid.get("1:5").duration, 120);
  assert.equal(byCourseVid.get("1:5").kind, "live");
  assert.equal(byCourseVid.get("2:5").duration, 480);
  assert.equal(byCourseVid.get("2:5").kind, "vod");
  assert.equal(byVid.get(5).duration, 480);
});

test("空课程 / 单门课身份正确，无副作用", () => {
  const empty = buildKeyMaps([mkCourse(9, "空课", [])]);
  assert.equal(empty.byVid.size, 0);
  assert.equal(empty.byCourseVid.size, 0);

  const one = buildKeyMaps([mkCourse(42, "唯一课", [mkVid(1, "一", 60), mkVid(2, "二", null)])]);
  assert.equal(one.byVid.size, 2);
  assert.equal(one.byCourseVid.size, 2);
  assert.equal(one.byVid.get(1).courseId, 42);
  assert.equal(one.byCourseVid.get("42:2").duration, null);
});
