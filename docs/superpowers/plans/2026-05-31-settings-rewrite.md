# 设置页全面重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单页 `SettingsView` 重写成 `/settings` 下的嵌套子路由（概览 / 缓存管理 / 任务·历史 / 系统配置），共享一个常驻状态条 + 左侧导航 + 单一轮询数据源，并落地诚实存储模型、诚实进度条与统一状态词。

**Architecture:** Next.js App Router 嵌套布局。`settings/layout.tsx`（client）在子路由间不重渲染，承载唯一的 `useCoursesStatus()` 轮询并通过 React Context 向下分发；4 个 `page.tsx` 是纯展示消费者。一处网关小改：计量 `thumb_dir` 下生成的 JPEG 字节并经 `/api/courses/status` 透传。

**Tech Stack:** Next.js 15 (App Router, client components), React 19, MUI v7 (`@mui/icons-material` = Material Symbols/MD3), SWR, Python gateway (stdlib http), 隔离零流量 e2e（`web/scripts/_e2e_ui/` ffmpeg 假 HLS + Playwright）。

**视觉真源（已评审通过）:** `docs/superpowers/mockups/2026-05-31-settings/{overview,cache,tasks,system}.html`。设计依据：`docs/superpowers/specs/2026-05-31-settings-rewrite-design.md`。

**关键约定（来自 CLAUDE.md / 记忆，必须遵守）:**
- 验收是 **e2e（真实用户路径 + 截图）**，不是 unit test。每个阶段跑 `_e2e_ui/drive.mjs` 断言，留 PNG。
- 不写生产 DB / 生产缓存目录；e2e 只用隔离栈（端口 3001/18808/18851，隔离 DB，`YD_EXTRA_ALLOWED_HOSTS`）。
- 改 Python 必 **kill -9 网关 → 重启** 验证（JPEG 计量跨重启正确）。改 Web 必 `npm run build` + 重启 next。
- 固定外壳：`body` 不滚动；页面内部 `height:100dvh + minHeight:0` 滚动（[[julestest-fixed-shell]]）。
- 圆角走 `(t)=>t.radius.X`，禁裸数字 `borderRadius`；间距用 8px 刻度（0.5/1/1.5/2/3）。
- 不要把 Cache/Thumb 表改成复合键（刻意镜像网关 vid-only 缓存）。

---

## File Structure

**网关（Python）:**
- Modify `ydcore/gateway.py` — 新增 `_thumb_jpeg_bytes` 节流缓存 + `/api/status` 暴露 `thumb.jpegBytes`。

**Web 类型 / 数据 / 路由:**
- Modify `web/src/types/api.ts` — `GwStatus.thumb.jpegBytes?`、`CoursesStatus.totals.thumbJpegBytes`。
- Modify `web/src/app/api/courses/status/route.ts` — 透传 `thumbJpegBytes`。
- Create `web/src/components/settings/SettingsDataContext.tsx` — Provider + `useSettingsData()`（封装现有 `useCoursesStatus`/`useCourses`/`usePrefs`，单轮询）。
- Modify `web/src/hooks/data.ts` — 无需改（Provider 复用现有 `useCoursesStatus`）。

**路由骨架:**
- Create `web/src/app/settings/layout.tsx` — AppTopBar + Provider + 常驻状态条 + 左侧 SettingsNav + `{children}`。
- Rewrite `web/src/app/settings/page.tsx` — 概览（原 SettingsView 退役）。
- Create `web/src/app/settings/cache/page.tsx` — 缓存管理。
- Create `web/src/app/settings/tasks/page.tsx` — 任务·历史。
- Create `web/src/app/settings/system/page.tsx` — 系统配置。

**新组件:**
- Create `web/src/components/settings/SettingsChrome.tsx` — 常驻状态条（健康 + 存储一览 + 全局暂停）。
- Create `web/src/components/settings/SettingsNav.tsx` — 左侧子导航（MD3 图标 + 角标）。
- Create `web/src/components/settings/StorageCard.tsx` — 方案 3 存储卡（总量 + 明细 chip + 单一硬上限条 + 计数）。
- Create `web/src/components/settings/HealthCard.tsx` — 系统健康卡。
- Create `web/src/components/settings/ActivityCard.tsx` — 当前活动卡。
- Create `web/src/components/settings/cacheVocab.ts` — 统一状态词常量（单一真相源）。

**复用 / 迁移（移动到对应 page，删 SettingsView 自身的编排）:**
- Reuse `CourseStatusGrid / CourseStatusCard / LectureGrid / CourseDetailDrawer`（→ cache/page）。
- Reuse `TaskQueuePanel`（→ tasks/page，整页全高）；**Delete** `TaskQueueFullscreenDialog.tsx`（页面即全视图）。
- Reuse `CacheDirCard / AssistantCard`（→ system/page）。
- Reuse `TaskRow`（图标改 Outlined 变体，词表改走 `cacheVocab`）。
- Modify `web/src/components/common/CacheBar.tsx` — 诚实进度（干掉写死 30%）。
- **Delete** `web/src/components/settings/SettingsView.tsx`、`SettingsStatusBar.tsx`、`StorageStrip.tsx`、`HealthBar.tsx`（被新结构取代）。

**e2e:**
- Modify `web/scripts/_e2e_ui/drive.mjs` — 加 4 子路由走查 + 断言；复用现有隔离栈。

---

## Phase 1 — 网关：诚实存储（JPEG 计量）

### Task 1: 网关 `thumb.jpegBytes`（节流缓存 + 暴露）

**Files:**
- Modify: `ydcore/gateway.py`（init ~`self.thumb_dir = THUMB_DIR` @198；`_api_status` thumb dict @2338-2347）
- Test: `web/scripts/_e2e_thumb_jpeg_bytes.mjs`（网关级，隔离栈）

- [ ] **Step 1: 加节流缓存方法 + 字段**（在 `__init__` 里 `self.thumb_dir = THUMB_DIR` 之后插入）

```python
        # 生成的缩略图 JPEG（持久占盘，区别于临时的 thumb_seg_cache 源段）：
        # 节流缓存其总字节，避免每次 /api/status 都 walk thumb_dir。15s 过期重算。
        self._thumb_jpeg_bytes = 0
        self._thumb_jpeg_ts = 0.0
```

放在类里（与其它 `_thumb_*` 方法同区）新增方法：

```python
    def _thumb_jpeg_total(self):
        # thumb_dir 下所有 *.jpg（每讲一张 sprite，命名 "<vid>.jpg"）字节合计。
        # 15s 节流：热路径(/api/status 每秒)不重复 walk；冷数据足够新。time.time() 网关已用。
        now = time.time()
        if now - self._thumb_jpeg_ts < 15 and self._thumb_jpeg_ts > 0:
            return self._thumb_jpeg_bytes
        total = 0
        try:
            with os.scandir(self.thumb_dir) as it:
                for e in it:
                    if e.is_file() and e.name.endswith(".jpg"):
                        try:
                            total += e.stat().st_size
                        except OSError:
                            pass
        except OSError:
            pass
        self._thumb_jpeg_bytes = total
        self._thumb_jpeg_ts = now
        return total
```

- [ ] **Step 2: 生成完成时让缓存立即失效**（`_gen_thumbs_inner` 成功分支，@~1363 `self._emit_task_event("thumb", vid, "done")` 之后）

```python
            self._emit_task_event("thumb", vid, "done")
            self._thumb_jpeg_ts = 0.0  # 失效 JPEG 字节缓存：下次 /api/status 立即重算纳入新图
```

- [ ] **Step 3: `/api/status` 暴露 `jpegBytes`**（thumb dict @2347，`"bytes": gw.thumb_seg_cache.size` 后加一项）

```python
                  "bytes": gw.thumb_seg_cache.size,
                  "jpegBytes": gw._thumb_jpeg_total()},
```

- [ ] **Step 4: 写网关级 e2e（含失败信号）**

`web/scripts/_e2e_thumb_jpeg_bytes.mjs`：起隔离网关（端口 18808，隔离 `YD_THUMB_DIR=/tmp/yd_e2e_jpeg`），断言：
1. 初始 `GET /api/status` → `thumb.jpegBytes === 0`（空目录）。
2. 往 `YD_THUMB_DIR` 写一个已知大小的假 `999.jpg`（如 4096 字节），`thumb._thumb_jpeg_ts` 失效后再 `GET /api/status` → `jpegBytes >= 4096`。
3. **失败信号**：删除该 jpg + 失效缓存（重启网关）后 `jpegBytes === 0`。能区分「真扫到了 vs 恒返回 0」。

```javascript
// 关键断言骨架
const s0 = await gw("/api/status");
assert(s0.thumb.jpegBytes === 0, `空目录应为0，实得 ${s0.thumb.jpegBytes}`);
fs.writeFileSync(path.join(JPEG_DIR, "999.jpg"), Buffer.alloc(4096));
// 触发失效：生成完成会清 ts；这里测试直接 kill -9 重启网关让 init 重扫
await restartGateway();
const s1 = await gw("/api/status");
assert(s1.thumb.jpegBytes >= 4096, `应计到 4096+，实得 ${s1.thumb.jpegBytes}`);
```

- [ ] **Step 5: 跑 e2e + kill -9 跨重启验证**

Run: `node web/scripts/_e2e_thumb_jpeg_bytes.mjs`
Expected: 3 断言全过；其中 step 含 `kill -9 网关 → 重启 → jpegBytes 仍正确`（启动时 `os.scandir` 重扫）。连跑两次都过。

- [ ] **Step 6: Commit**

```bash
git add ydcore/gateway.py web/scripts/_e2e_thumb_jpeg_bytes.mjs
git commit -m "feat(gateway): 计量缩略图 JPEG 字节并经 /api/status 暴露 thumb.jpegBytes（15s节流+生成即失效）"
```

---

## Phase 2 — Web 类型 / 路由透传

### Task 2: 类型 + 状态路由透传 `thumbJpegBytes`

**Files:**
- Modify: `web/src/types/api.ts:55-67`（GwStatus.thumb）、`:232-239`（totals）
- Modify: `web/src/app/api/courses/status/route.ts:203`（thumbBytes 取值处）、`:376-385`（totals）

- [ ] **Step 1: `GwStatus.thumb` 加 `jpegBytes?`**（`web/src/types/api.ts` thumb 块内 `bytes?: number;` 后）

```typescript
    bytes?: number;
    // 生成的缩略图 JPEG 持久占盘字节（网关 thumb.jpegBytes，区别于临时源段 bytes）。
    jpegBytes?: number;
```

- [ ] **Step 2: `CoursesStatus.totals` 加 `thumbJpegBytes`**（`:235` `thumbBytes: number;` 后）

```typescript
    thumbBytes: number;
    thumbJpegBytes: number; // 生成的缩略图 JPEG 持久占盘（来自网关 thumb.jpegBytes）
```

- [ ] **Step 3: 路由透传**（`web/src/app/api/courses/status/route.ts`，`const thumbBytes = gw.thumb.bytes ?? 0;` 旁加，并写进 totals @381）

```typescript
  const thumbBytes = gw.thumb.bytes ?? 0;
  const thumbJpegBytes = gw.thumb.jpegBytes ?? 0;
```
```typescript
      thumbBytes,
      thumbJpegBytes,
```

- [ ] **Step 4: 离线兜底分支也补字段**（route.ts 的离线兜底 `totals` @~649-652：`bufferBytes: totalBytes, bufferLimit: 0, thumbBytes: 0,` 后加 `thumbJpegBytes: 0,`，避免 TS 缺字段报错）。

- [ ] **Step 5: tsc 通过**

Run: `cd web && npx tsc --noEmit`
Expected: 无报错（新字段处处补齐）。

- [ ] **Step 6: Commit**

```bash
git add web/src/types/api.ts web/src/app/api/courses/status/route.ts
git commit -m "feat(api): totals.thumbJpegBytes 透传（类型+状态路由+离线兜底）"
```

---

## Phase 3 — 单一数据源 Context

### Task 3: `SettingsDataContext`（layout 持有的唯一轮询）

**Files:**
- Create: `web/src/components/settings/SettingsDataContext.tsx`

- [ ] **Step 1: 写 Provider + hook**

```tsx
"use client";
import * as React from "react";
import { useCourses, useCoursesStatus, type BpsSample } from "@/hooks/data";
import { usePrefs } from "@/lib/store"; // 现有 prefs hook（SettingsView 当前用法一致）
import type { Course, CoursesStatus } from "@/types/api";

interface SettingsData {
  data: CoursesStatus | undefined;
  refresh: () => void;
  bps: BpsSample;
  courses: Course[];
}
const Ctx = React.createContext<SettingsData | null>(null);

// layout 持有唯一轮询；子路由切换时 layout 不重渲染 → 轮询不重启、四页同步。
export function SettingsDataProvider({ children }: { children: React.ReactNode }) {
  const { courses } = useCourses();
  const { data, refresh, bps } = useCoursesStatus();
  const value = React.useMemo(() => ({ data, refresh, bps, courses }), [data, refresh, bps, courses]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettingsData(): SettingsData {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useSettingsData 必须在 SettingsDataProvider 内使用");
  return v;
}
```

> 注：`usePrefs` 来自 `@/hooks/persist`（旧 `SettingsView.tsx:22` 即此），返回 `{ prefs, setPrefs }`。prefs 不进 Context —— 由 `system/page` 自行 `import { usePrefs } from "@/hooks/persist"`（AssistantCard 也走它）。故上面 Provider 不含 prefs。

- [ ] **Step 2: tsc 通过**

Run: `cd web && npx tsc --noEmit`
Expected: 无报错（`BpsSample` 已从 `@/hooks/data` 导出，见 data.ts:59）。

- [ ] **Step 3: Commit**

```bash
git add web/src/components/settings/SettingsDataContext.tsx
git commit -m "feat(settings): SettingsDataProvider 单一轮询数据源（Context）"
```

---

## Phase 4 — 统一状态词

### Task 4: `cacheVocab.ts`（全站唯一词表）

**Files:**
- Create: `web/src/components/settings/cacheVocab.ts`

- [ ] **Step 1: 写常量**

```typescript
import type { TaskState } from "@/types/api";

// 任务生命周期：全站唯一。消除 完成/已完成、cancelled/已取消 等漂移。
export const TASK_STATE_LABEL: Record<TaskState, string> = {
  working: "进行中",
  queued: "排队",
  paused: "已暂停",
  done: "已完成", // 注意：不是「完成」
  cancelled: "已取消",
  error: "失败",
};

// 缩略图就绪度
export const THUMB_LABEL: Record<"ready" | "gen" | "error" | "none", string> = {
  ready: "已生成",
  gen: "生成中",
  error: "失败",
  none: "未生成",
};

// 缓存覆盖文案（供 CacheBar）：cached / total → 人话标签。
export function coverageLabel(cached: number, total: number | null): string {
  if (cached <= 0) return "未缓存";
  if (total == null) return "缓存中（总数待确认）";
  const shown = Math.min(cached, total);
  return shown >= total ? "已缓存(完整)" : `已缓存 ${shown}/${total}`;
}

// 动作确认 toast（保持现有）
export const VERB_DONE: Record<string, string> = {
  pause: "已暂停", resume: "已继续", cancel: "已取消", retry: "已重试", dismiss: "已清除",
};
```

- [ ] **Step 2: `TaskRow` 改用词表**（`web/src/components/settings/TaskRow.tsx` 的 `CHIP` 字典 → 引用 `TASK_STATE_LABEL`；当前 `done:"完成"` 修为 `已完成`）

```typescript
import { TASK_STATE_LABEL } from "./cacheVocab";
// CHIP label 全部改成 TASK_STATE_LABEL[state]（保留各自 color）。
```

- [ ] **Step 3: `TaskRow` 图标改 Outlined 变体（任务列表统一视觉重量）**

把 `DownloadRoundedIcon/ImageRoundedIcon/BoltRoundedIcon` → `FileDownloadOutlinedIcon/ImageOutlinedIcon/BoltOutlinedIcon`；动作 `PauseRounded/PlayArrowRounded/ReplayRounded/CloseRounded/DeleteOutlineRounded` → 对应 `*Outlined`（`PauseOutlined/PlayArrowOutlined/ReplayOutlined/CloseOutlined/DeleteOutlined`）。统一 `sx={{ fontSize: 18 }}`。（依据 mockup：任务行图标 outlined 等重；见 tasks.html 评审结论。）

- [ ] **Step 4: tsc + 验证 TaskRow 仍渲染**

Run: `cd web && npx tsc --noEmit`
Expected: 无报错（所有 Outlined 图标存在于 `@mui/icons-material`）。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/settings/cacheVocab.ts web/src/components/settings/TaskRow.tsx
git commit -m "feat(settings): 统一状态词表 cacheVocab + TaskRow 套用(已完成/Outlined等重图标)"
```

---

## Phase 5 — 诚实进度（CacheBar）

### Task 5: CacheBar 去掉写死 30%，未知总数走不确定态斜纹

**Files:**
- Modify: `web/src/components/common/CacheBar.tsx`

- [ ] **Step 1: 标签改走 `coverageLabel`**（替换 `:58-62` 的三态拼接）

```tsx
import { coverageLabel } from "@/components/settings/cacheVocab";
// ...
const label = coverageLabel(eff.cached, eff.total);
```

- [ ] **Step 2: 把「模式 2」的静态 30% 改成不确定态斜纹（`:101-114`）**

```tsx
      ) : knownTotal ? (
        // 模式 2a：比例填充（已知总数）
        <Box sx={{ position: "absolute", inset: 0, width: `${pct}%`, bgcolor: fill,
          borderRadius: height / 2, transition: "width .4s ease" }} />
      ) : partialUnknown ? (
        // 模式 2b：总数未知但已缓存 → 不确定态斜纹（流动），诚实表达「在缓存、比例未知」。
        // 周期位移 = 条纹周期/cos45°，整周期对齐 → 无缝循环不抽搐（勿用 background-size 缩放）。
        <Box sx={{
          position: "absolute", inset: 0, borderRadius: height / 2,
          backgroundImage: (t) =>
            `repeating-linear-gradient(45deg, ${alpha(fill(t),0.55)} 0 9px, ${alpha(fill(t),0.28)} 9px 18px)`,
          animation: `${flow} .9s linear infinite`,
        }} />
      ) : null /* cached===0 → 空轨 */}
```

新增 keyframes（文件顶部 `sweep` 旁）：

```tsx
const flow = keyframes`from { background-position: 0 0; } to { background-position: 25.456px 0; }`;
```

- [ ] **Step 3: 更新 tooltip 文案**（`:63-69` 的 `partialUnknown` 分支用「缓存中 · 已 N 段 · 总数待确认」）

```tsx
        : partialUnknown
          ? `缓存中 · 已 ${eff.cached} 段 · 总数待确认`
          : "尚未缓存";
```

- [ ] **Step 4: tsc 通过**

Run: `cd web && npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/common/CacheBar.tsx
git commit -m "fix(cachebar): 总数未知改不确定态斜纹条(无缝)，删写死30%，文案走统一词表"
```

---

## Phase 6 — 共享骨架（layout + 状态条 + 导航）

### Task 6: 常驻状态条 `SettingsChrome`

**Files:**
- Create: `web/src/components/settings/SettingsChrome.tsx`

- [ ] **Step 1: 写状态条**（健康点 + ffmpeg + 数据新鲜度 + 存储一览「播放 X/Y」+ 全局暂停开关）

```tsx
"use client";
import * as React from "react";
import { Box, Switch, Tooltip, Typography } from "@mui/material";
import { fmtBytes } from "@/lib/media";
import { bgPause } from "@/lib/api";
import { markRecentAction } from "@/hooks/data";
import { useToast } from "@/components/common/Toast"; // 现有 toast
import { useSettingsData } from "./SettingsDataContext";

export default function SettingsChrome() {
  const { data, refresh } = useSettingsData();
  const h = data?.health;
  const t = data?.totals;
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const online = !!h?.gatewayOnline;
  const paused = !!h?.bgPaused;

  const toggle = async () => {
    setBusy(true);
    try { await bgPause(!paused); markRecentAction(); await refresh();
          toast(!paused ? "已暂停所有后台缓存" : "已恢复后台缓存"); }
    finally { setBusy(false); }
  };

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2.25, px: 2.25, py: 1.25,
      flexWrap: "wrap", borderBottom: (th) => `1px solid ${th.palette.divider}`,
      bgcolor: (th) => th.palette.md3.surfaceContainerLow, fontSize: 13 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        <Box sx={{ width: 8, height: 8, borderRadius: "50%",
          bgcolor: online ? "success.main" : "error.main" }} />
        <Typography variant="caption" color="text.secondary">{online ? "网关在线" : "网关离线"}</Typography>
      </Box>
      <Typography variant="caption" color="text.secondary">ffmpeg {h?.ffmpeg ? "✓" : "✗"}</Typography>
      <Typography variant="caption" color="text.secondary">{h?.stale ? "数据陈旧" : "数据实时"}</Typography>
      {t && (
        <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
          播放 {fmtBytes(t.bufferBytes)} / {fmtBytes(t.bufferLimit)}
        </Typography>
      )}
      <Box sx={{ ml: "auto", display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="caption" color="text.secondary">暂停所有后台</Typography>
        <Tooltip title={paused ? "恢复后台缓存" : "暂停 缓冲/缩略图/预缓存 三类后台"}>
          <span><Switch size="small" checked={paused} disabled={busy || !online} onChange={toggle} /></span>
        </Tooltip>
      </Box>
    </Box>
  );
}
```

> 确认 `useToast` 的真实导出（`@/components/common/Toast`，ThemeRegistry 已挂 ToastProvider）。若签名不同，按现有用法调整。

- [ ] **Step 2: Commit**

```bash
git add web/src/components/settings/SettingsChrome.tsx
git commit -m "feat(settings): 常驻状态条(健康+存储一览+全局暂停)"
```

### Task 7: 左侧子导航 `SettingsNav`

**Files:**
- Create: `web/src/components/settings/SettingsNav.tsx`

- [ ] **Step 1: 写导航**（MD3 图标 + active 高亮 pill + 角标：失败数标红）

```tsx
"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, Chip } from "@mui/material";
import GridViewOutlinedIcon from "@mui/icons-material/GridViewOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import ChecklistRoundedIcon from "@mui/icons-material/ChecklistRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import { useSettingsData } from "./SettingsDataContext";

const ITEMS = [
  { href: "/settings", label: "概览", Icon: GridViewOutlinedIcon, exact: true },
  { href: "/settings/cache", label: "缓存管理", Icon: StorageOutlinedIcon },
  { href: "/settings/tasks", label: "任务 · 历史", Icon: ChecklistRoundedIcon },
  { href: "/settings/system", label: "系统配置", Icon: TuneRoundedIcon },
];

export default function SettingsNav() {
  const pathname = usePathname();
  const { data } = useSettingsData();
  const failed = data?.failedTasks.length ?? 0;
  const cached = data?.totals.cachedLectures ?? 0;
  return (
    <Box component="nav" sx={{ width: 234, flexShrink: 0, p: 1.5,
      borderRight: (t) => `1px solid ${t.palette.divider}`,
      bgcolor: (t) => t.palette.md3.surface, overflowY: "auto" }}>
      {ITEMS.map(({ href, label, Icon, exact }) => {
        const active = exact ? pathname === href : pathname?.startsWith(href);
        const badge = href === "/settings/cache" ? cached
          : href === "/settings/tasks" ? failed : 0;
        const badgeWarn = href === "/settings/tasks" && failed > 0;
        return (
          <Box key={href} component={Link} href={href}
            sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 1.75, py: 1.1, mb: 0.25,
              borderRadius: (t) => t.radius.full, whiteSpace: "nowrap", fontWeight: 600, fontSize: 13.5,
              color: active ? (t)=>t.palette.md3.onPrimaryContainer : "text.secondary",
              bgcolor: active ? (t)=>t.palette.md3.primaryContainer : "transparent",
              "&:hover": { bgcolor: active ? undefined : (t)=>t.palette.action.hover } }}>
            <Icon sx={{ fontSize: 18, flexShrink: 0 }} />
            <Box sx={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</Box>
            {badge > 0 && (
              <Chip size="small" label={badgeWarn ? `${failed} 失败` : badge}
                color={badgeWarn ? "error" : "default"} variant={badgeWarn ? "outlined" : "filled"}
                sx={{ height: 20, fontSize: 11 }} />
            )}
          </Box>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/settings/SettingsNav.tsx
git commit -m "feat(settings): 左侧子导航(MD3图标+active pill+失败角标)"
```

### Task 8: `settings/layout.tsx`（骨架装配）

**Files:**
- Create: `web/src/app/settings/layout.tsx`

- [ ] **Step 1: 写 layout**（固定外壳；AppTopBar + Provider + 状态条 + 侧栏 + 内容滚动区）

```tsx
"use client";
import { Box } from "@mui/material";
import AppTopBar from "@/components/common/AppTopBar";
import { SettingsDataProvider } from "@/components/settings/SettingsDataContext";
import SettingsChrome from "@/components/settings/SettingsChrome";
import SettingsNav from "@/components/settings/SettingsNav";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SettingsDataProvider>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100dvh", minHeight: 0 }}>
        <AppTopBar />
        <SettingsChrome />
        <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
          <SettingsNav />
          {/* 内容区：内部滚动（固定外壳）。各 page 自管内部布局。 */}
          <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{children}</Box>
        </Box>
      </Box>
    </SettingsDataProvider>
  );
}
```

- [ ] **Step 2: tsc 通过**（layout 依赖的 Provider/Chrome/Nav 均已建）

Run: `cd web && npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 3: Commit**

```bash
git add web/src/app/settings/layout.tsx
git commit -m "feat(settings): 嵌套布局骨架(AppTopBar+Provider+状态条+左侧导航+内容滚动)"
```

---

## Phase 7 — 概览页

### Task 9: `StorageCard` + `HealthCard` + `ActivityCard`

**Files:**
- Create: `web/src/components/settings/StorageCard.tsx`
- Create: `web/src/components/settings/HealthCard.tsx`
- Create: `web/src/components/settings/ActivityCard.tsx`

- [ ] **Step 1: `StorageCard`（方案 3）** — 总量标题 + 明细 chip + 单一硬上限条（只对 bufferBytes/bufferLimit）+ 计数。参照 `mockups/.../overview.html` 的存储卡。实心填充（无渐变）。

```tsx
"use client";
import { Box, Card, Chip, Typography, LinearProgress } from "@mui/material";
import { fmtBytes } from "@/lib/media";
import { useSettingsData } from "./SettingsDataContext";

export default function StorageCard() {
  const { data } = useSettingsData();
  const t = data?.totals;
  if (!t) return null;
  const total = t.bufferBytes + t.thumbJpegBytes + t.thumbBytes; // 播放段 + 持久JPEG + 临时源段
  const pct = t.bufferLimit ? Math.min(100, (t.bufferBytes / t.bufferLimit) * 100) : 0;
  const near = pct >= 90;
  return (
    <Card sx={{ p: 2.25 }}>
      <Box sx={{ display: "flex", alignItems: "flex-end", gap: 1.75 }}>
        <Typography sx={{ fontSize: "2.2rem", fontWeight: 700, lineHeight: 1, color: "primary.main",
          letterSpacing: "-1px" }}>{fmtBytes(total)}</Typography>
        <Typography variant="caption" color="text.disabled" sx={{ pb: 0.5 }}>本机缓存总占用</Typography>
      </Box>
      <LinearProgress variant="determinate" value={pct}
        color={near ? "warning" : "primary"} sx={{ my: 1.5, height: 12 }} />
      <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
        播放缓存 {fmtBytes(t.bufferBytes)} / {fmtBytes(t.bufferLimit)}（唯一硬上限）· {pct.toFixed(0)}%
      </Typography>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 1.5 }}>
        <Chip size="small" label={`播放段 ${fmtBytes(t.bufferBytes)}`} sx={{ bgcolor: (th)=>th.palette.md3.primaryContainer }} />
        <Chip size="small" color="success" variant="outlined" label={`缩略图 ${fmtBytes(t.thumbJpegBytes)} · 持久`} />
        <Chip size="small" color="info" variant="outlined" label={`源段 ${fmtBytes(t.thumbBytes)} · 临时`} />
      </Box>
      <Box sx={{ display: "flex", gap: 3, mt: 2, pt: 1.75, borderTop: (th)=>`1px solid ${th.palette.divider}` }}>
        <Stat n={data!.courses.length} l="课程" />
        <Stat n={t.cachedLectures} l="已缓存讲次" />
        <Stat n={t.thumbsReady} l="缩略图就绪" />
      </Box>
    </Card>
  );
}
function Stat({ n, l }: { n: number; l: string }) {
  return (<Box><Typography sx={{ fontSize: "1.3rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{n}</Typography>
    <Typography variant="caption" color="text.disabled">{l}</Typography></Box>);
}
```

- [ ] **Step 2: `HealthCard`** — 网关/ffmpeg/缓存目录(截断路径+短pill)/数据新鲜度。读 `data.health`。键→pill 行（参照 overview.html `.hrow`）。

- [ ] **Step 3: `ActivityCard`** — `data.activity`（正在缓存哪讲 + tier）+ 队列深度 + `N 进行中 · M 失败`（`tasks.length`/`failedTasks.length`），底部 `component={Link} href="/settings/tasks"` 跳转。正在缓存时显示不确定斜纹条（复用 CacheBar `state="working"` 或独立斜纹）。

- [ ] **Step 4: tsc 通过**

Run: `cd web && npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/settings/StorageCard.tsx web/src/components/settings/HealthCard.tsx web/src/components/settings/ActivityCard.tsx
git commit -m "feat(settings): 概览三卡(存储方案3/系统健康/当前活动)"
```

### Task 10: 概览页 `settings/page.tsx`（替换旧 SettingsView）

**Files:**
- Rewrite: `web/src/app/settings/page.tsx`

- [ ] **Step 1: 写概览页**（section 标题 + 三卡 + 同步按钮；`SectionHeader` 复用）

```tsx
"use client";
import * as React from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import SyncRoundedIcon from "@mui/icons-material/SyncRounded";
import StorageCard from "@/components/settings/StorageCard";
import HealthCard from "@/components/settings/HealthCard";
import ActivityCard from "@/components/settings/ActivityCard";
import SectionHeader from "@/components/settings/SectionHeader";
import { syncYoudaoProgress } from "@/lib/api";
import { useToast } from "@/components/common/Toast";

export default function OverviewPage() {
  const toast = useToast();
  const [syncing, setSyncing] = React.useState(false);
  const sync = async () => { setSyncing(true);
    try { const r = await syncYoudaoProgress(); toast(`同步完成：更新 ${r.videos.updated} 讲`); }
    catch { toast("同步失败"); } finally { setSyncing(false); } };
  return (
    <Box sx={{ p: 2.5, maxWidth: 920, display: "flex", flexDirection: "column", gap: 2.5 }}>
      <Box><Typography variant="h6">概览</Typography>
        <Typography variant="caption" color="text.disabled">系统、存储与当前活动一眼掌握。</Typography></Box>
      <Box><SectionHeader title="存储占用" /><StorageCard /></Box>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1.4fr 1fr" }, gap: 1.75, alignItems: "stretch" }}>
        <Box sx={{ display: "flex", flexDirection: "column" }}><SectionHeader title="系统健康" /><HealthCard /></Box>
        <Box sx={{ display: "flex", flexDirection: "column" }}><SectionHeader title="当前活动" /><ActivityCard /></Box>
      </Box>
      <Box><Button variant="outlined" startIcon={<SyncRoundedIcon />} disabled={syncing} onClick={sync}>同步有道进度</Button></Box>
    </Box>
  );
}
```

> `HealthCard`/`ActivityCard` 内部 `<Card sx={{ height:"100%" }}>` 让同行两卡底边齐平（mockup 评审结论）。
> `SectionHeader` 是 `{ title, hint }` props（**非 children**），自带 `mt:3, mb:1.5`；放进 `flex column gap:2.5` 容器时其 `mt:3` 会与 gap 叠加，可接受（或按需在该处包一层去掉外 gap）。

- [ ] **Step 2: build + 真机走查（概览）**

Run: `cd web && npm run build`，重启 next，浏览器开 `/settings`。
Expected: 概览渲染：存储总量+明细+硬上限条、健康、活动、同步按钮；状态条 + 左侧导航在位；切到 `/settings/cache` 等空路由 layout 不闪。

- [ ] **Step 3: Commit**

```bash
git add web/src/app/settings/page.tsx
git commit -m "feat(settings): 概览页(替换旧 SettingsView 编排)"
```

---

## Phase 8 — 缓存管理 / 任务 / 系统 三页

### Task 11: 缓存管理页 `settings/cache/page.tsx`

**Files:**
- Create: `web/src/app/settings/cache/page.tsx`

迁移 `SettingsView` 里的：工具栏（搜索/课程过滤/排序/缩略图过滤/缓冲过滤/密度 + 批量缓冲/批量缩略图）、按课程↔全部讲次 tab、`CourseStatusGrid`、`LectureGrid`、`CourseDetailDrawer`、批量动作 handler。

- [ ] **Step 1: 从旧 `SettingsView.tsx` 抽取相关 state/handler/JSX** 到本页，数据改从 `useSettingsData()` 取（替代页内自起的 `useCoursesStatus`）。课程视频列表仍用 `useAllCourseVideos(courses)`（按需，flat tab 激活时）。批量提交后调用 `markRecentAction()`（保持原行为）。
- [ ] **Step 2: 工具栏按钮图标用 MUI 图标**（批量缩略图 `ImageOutlinedIcon`、批量缓冲 `FileDownloadOutlinedIcon`），下拉用 MUI `Select`/`Menu`（原 SettingsView 已有实现，直接搬）。
- [ ] **Step 3: tsc + build + 走查**：`/settings/cache` 两视图切换、搜索/过滤/排序、点课程开抽屉看逐段位图、批量缓冲/缩略图入队 toast。
- [ ] **Step 4: Commit**

```bash
git add web/src/app/settings/cache/page.tsx
git commit -m "feat(settings): 缓存管理页(工具栏+按课程/全部讲次+课程详情抽屉)"
```

### Task 12: 任务·历史页 `settings/tasks/page.tsx`（退役全屏弹窗）

**Files:**
- Create: `web/src/app/settings/tasks/page.tsx`
- Modify: `web/src/components/settings/TaskQueuePanel.tsx`（去掉 `fsOpen`/`TaskQueueFullscreenDialog` 依赖，列表占满整页）
- Delete: `web/src/components/settings/TaskQueueFullscreenDialog.tsx`

- [ ] **Step 1: 写任务页**：失败横幅（内联重试/清除）+ 进行中↔操作历史两标签 + 整页全高列表 + 队列深度。`handleTaskAction` 从旧 SettingsView 搬（消费 `TaskActionResult`：乐观更新 + toast `VERB_DONE` + reason；调 `markRecentAction()` + `refresh()`）。数据走 `useSettingsData()`。
- [ ] **Step 2: 改 `TaskQueuePanel`**：移除 `fsOpen/onFsOpenChange/TaskQueueFullscreenDialog`；`maxHeight:240` 改成 `flex:1` 占满；`PANEL_CAP` 提高/取消（整页可滚）。`onAction`/`busy` 保留。
- [ ] **Step 3: 删除 `TaskQueueFullscreenDialog.tsx`** 并清理其 import。
- [ ] **Step 4: tsc + build + 走查**：进行中行显示确定/不确定条；暂停/继续/取消/重试/清除可用且 1s 内可见；失败横幅重试+清除；历史标签只读。
- [ ] **Step 5: Commit**

```bash
git add -A web/src/app/settings/tasks/page.tsx web/src/components/settings/TaskQueuePanel.tsx
git rm web/src/components/settings/TaskQueueFullscreenDialog.tsx
git commit -m "feat(settings): 任务·历史整页(退役全屏弹窗，页面即全视图)"
```

### Task 13: 系统配置页 `settings/system/page.tsx`

**Files:**
- Create: `web/src/app/settings/system/page.tsx`

- [ ] **Step 1: 写系统页**：`CacheDirCard`（复用）+ 播放缓存上限只读卡（显示 `data.totals.bufferLimit` via `fmtBytes`，标注「网关配置·只读」）+ `AssistantCard`（复用；`import { usePrefs } from "@/hooks/persist"` 取 `{prefs,setPrefs}`）。用 `<SectionHeader title="存储与目录" />` / `<SectionHeader title="AI 助教" />` 分区（title prop，非 children）。
- [ ] **Step 2: tsc + build + 走查**：缓存目录显示/更换、上限只读、AI 提示词与推理强度保存。
- [ ] **Step 3: Commit**

```bash
git add web/src/app/settings/system/page.tsx
git commit -m "feat(settings): 系统配置页(缓存目录+播放上限只读+AI助教)"
```

### Task 14: 删除被取代的旧组件

**Files:**
- Delete: `web/src/components/settings/SettingsView.tsx`、`SettingsStatusBar.tsx`、`StorageStrip.tsx`、`HealthBar.tsx`

- [ ] **Step 1: 确认无引用**

Run: `cd web && grep -rn "SettingsView\|SettingsStatusBar\|StorageStrip\|HealthBar" src | grep -v "settings/HealthCard"`
Expected: 仅历史/无关联匹配；若有 import 先清掉。

- [ ] **Step 2: 删除 + tsc + build**

Run: `git rm web/src/components/settings/{SettingsView,SettingsStatusBar,StorageStrip,HealthBar}.tsx && cd web && npx tsc --noEmit && npm run build`
Expected: tsc/build 通过。

> 注：`storageStripLabels` 纯函数若有独立测试 `_e2e_storage_strip_labels.mjs` 引用，连带删除或改指向 StorageCard 的等价逻辑。

- [ ] **Step 3: Commit**

```bash
git commit -m "chore(settings): 删除被新结构取代的 SettingsView/StatusBar/StorageStrip/HealthBar"
```

---

## Phase 9 — 全量 e2e + 部署

### Task 15: `_e2e_ui/drive.mjs` 扩展四路由走查

**Files:**
- Modify: `web/scripts/_e2e_ui/drive.mjs`

- [ ] **Step 1: 加路由走查 + 断言（含失败信号）**，复用现有隔离栈（3001/18808/18851）：
  - G. 导航：依次 `goto /settings`、`/settings/cache`、`/settings/tasks`、`/settings/system`，每页 `waitForSelector` 关键元素 + 截图 `uictl_route_*.png`。**失败信号**：断言 active nav 高亮跟随 URL（错误结构会拿不到 active class）。
  - H. 存储诚实：`/settings` 断言存储卡总量文本 = 播放+JPEG+源段（用注入的已知字节），且硬上限条 % 对应 bufferBytes/limit（非固定值）。
  - I. 诚实进度：构造一讲 `total=null & cached>0`，断言其 CacheBar 文案含「缓存中」「总数待确认」且**无** `30%` 固定宽度 inline style（grep 渲染 DOM）。
  - J. 词表：断言完成态 chip 文案为「已完成」（非「完成」）。
  - K. 单轮询：在 `/settings/cache↔tasks` 间切 3 次，断言 `/api/courses/status` 请求未因切路由暴增（layout 不重挂 → 轮询不重启）。
- [ ] **Step 2: 跑两次都过 + 留截图**

Run: `node web/scripts/_e2e_ui/drive.mjs`（连跑两次）
Expected: 全绿 ×2；`docs/superpowers/uac-shots/` 下新增四路由 + 诚实进度截图。

- [ ] **Step 3: Commit**

```bash
git add web/scripts/_e2e_ui/drive.mjs docs/superpowers/uac-shots/
git commit -m "test(settings): e2e 覆盖四子路由+存储诚实+诚实进度+词表+单轮询(隔离零流量)"
```

### Task 16: 部署 + 真机验收 + kill -9

- [ ] **Step 1: 部署**：`redeploy`（build + 重启 run.sh detached via perl setsid）。改了 Python → 必 kill -9 网关再起。
- [ ] **Step 2: 真机走查（正常 + 异常）**：四路由点一圈；空数据/网关掉线（状态条变「网关离线」、开关禁用）；**kill -9 网关 → 重启** 后 `thumb.jpegBytes` 仍正确、bgPaused 状态保留、失败任务清除后不复活。
- [ ] **Step 3: 截图存证**（`web/scripts/smoke.mjs` 或 drive 对 live 截图，节流：不下真视频）。
- [ ] **Step 4: 更新记忆** `julestest-cache-controls-redesign.md`：Theme B（设置页重构）已落地 + 部署。

---

## Self-Review

- **Spec 覆盖**：路由(Task 8/10-13)✓ 骨架+状态条+导航(6/7/8)✓ 存储方案3+JPEG计量(1/2/9)✓ 诚实进度(5)✓ 统一词表(4)✓ 组件迁移表(11-14)✓ 验收 e2e(15/16)✓ 全部 spec §3-§11 有对应任务。
- **占位扫描**：Task 11/12/13 的「从旧 SettingsView 抽取」是机械迁移既有代码（非新逻辑），故给出迁移指令 + 数据源切换点而非重贴数百行；新逻辑（Context/layout/StorageCard/CacheBar/gateway/vocab）均含完整代码。
- **类型一致**：`thumbJpegBytes`（totals）/`jpegBytes`（GwStatus.thumb 与网关 `jpegBytes`）命名贯穿一致；`coverageLabel`/`TASK_STATE_LABEL` 在 CacheBar/TaskRow 引用一致；`useSettingsData()` 返回 `{data,refresh,bps,courses}` 在各页消费一致。

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-31-settings-rewrite.md`.**
