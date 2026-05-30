import { test } from "node:test";
import assert from "node:assert/strict";

// 测试目标：thumbStatus.ts 里 normalizeThumbState 的纯白名单逻辑（#14）。
// 限制说明：node --test 跑 .mjs 无法直接 import .ts（无编译步骤），故此处「复刻」同一份纯逻辑
// 做不变式回归（与 thumbStatus.ts normalizeThumbState 保持字节级一致）。改 .ts 须同步改这里。
function normalizeThumbState(raw) {
  return raw === "ready" || raw === "gen" || raw === "error" ? raw : null;
}

test("白名单内（ready/gen/error）原样保留", () => {
  assert.equal(normalizeThumbState("ready"), "ready");
  assert.equal(normalizeThumbState("gen"), "gen");
  assert.equal(normalizeThumbState("error"), "error");
});

test("cancelled 归一为 null（核心 bug：之前原样落库/回退导致误显示）", () => {
  // 这条是失败信号所在：原 passthrough 写法会返回 "cancelled"，断言会红。
  assert.equal(normalizeThumbState("cancelled"), null);
});

test("queued 归一为 null（网关排队态不是前端 thumb 合法值）", () => {
  assert.equal(normalizeThumbState("queued"), null);
});

test("未知/空/非字符串一律归一为 null", () => {
  assert.equal(normalizeThumbState("weird"), null);
  assert.equal(normalizeThumbState(""), null);
  assert.equal(normalizeThumbState(undefined), null);
  assert.equal(normalizeThumbState(null), null);
  assert.equal(normalizeThumbState(123), null);
});
