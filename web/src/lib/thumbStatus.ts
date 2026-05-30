// ThumbStatus 镜像 + 离线回退的白名单归一 (#14)。
//
// 为什么需要：网关 thumb_meta 的 state 可能是 gen / ready / error / cancelled / queued
// （见 ydcore/gateway.py thumb_meta），但前端 VidStatusDetail["thumb"] 的合法取值只有
// "ready" | "gen" | "error" | null。在线 build 路径早已在读 gw.thumb.states 时做了归一
// （s === ready|gen|error ? s : null），但两条「持久化镜像 → 离线回退」的旁路没有：
//   1. mirror() 把 gw.thumb.states 原样 upsert 进 ThumbStatus.state（cancelled/queued 也落库）。
//   2. fallback() 把 DB 里的 state 直接 cast 成 VidStatusDetail["thumb"]（不过滤）。
// 结果网关掉线后，离线回退会把 cancelled / queued / 未知值当作 thumb 状态吐给前端，
// 表现为「生成中(gen)」误显示或上色错乱（cancelled 被前端按未知态处理）。
//
// 本模块提供单一归一函数，mirror 写入侧 + 离线读取侧共用同一份白名单，根治这条旁路。
//
// 纯函数（无 IO），便于 `node --test` 直接单测。

// 前端合法 thumb 取值白名单（与 web/src/types/api.ts VidStatusDetail["thumb"] 一一对应）。
export type ThumbMirrorState = "ready" | "gen" | "error";

// 归一任意网关/DB 里的原始 thumb state 到白名单；非白名单（cancelled / queued / 空 / 未知）→ null。
// 与 route.ts 在线 build 路径的 thumbState() 同口径，避免三处各写一份判定漂移。
export function normalizeThumbState(raw: unknown): ThumbMirrorState | null {
  return raw === "ready" || raw === "gen" || raw === "error" ? raw : null;
}
