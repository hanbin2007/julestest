import { test } from "node:test";
import assert from "node:assert/strict";

// 测试目标：thumbStatus.ts 里 normalizeThumbState 的纯白名单逻辑（#14）。
// Node 22 起 .mjs 可直接 import .ts（原生 strip-types），故直接 import 真源, 不再手抄复刻
// （之前手抄会「改了 .ts 忘了同步」漂移；见 _e2e_totals_dedupe.mjs 已证明能 import .ts）。
import { normalizeThumbState } from "./thumbStatus.ts";

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
