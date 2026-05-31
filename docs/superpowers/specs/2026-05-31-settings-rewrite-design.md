# 设置页全面重构 · 设计文档

**日期**: 2026-05-31
**状态**: 已通过头脑风暴 + 高保真视觉评审，待实现计划
**范围**: 完全重写 `/settings` 前端与路由；含一处网关小改（缩略图 JPEG 计量）

---

## 1. 背景与目标

当前 `/settings` 是一个单页 client 组件（`SettingsView.tsx` ~438 行），把**配置**、**实时仪表盘**、**任务队列**、**历史诊断**从上到下堆在一条滚动里。用户选定的四个核心问题（全部命中）：

1. **配置与实况混在一起** —「我去改的」（缓存目录 / AI 助教）和「我去看的」（缓存进度 / 任务 / 课程状态）职责不清。
2. **一条长滚动、没层次** — 缺清晰分区与信息层级。
3. **存储数字 / 状态词乱** — 播放 vs 缩略图双预算、`已缓存(部分)` 写死 30% 假进度、状态词跨组件不一致（即历史遗留的 Theme B）。
4. **想要真正的子路由** — 可直达 / 可收藏 / 可深链，而非单页 + tab 切换。

**北极星**（用户原话「满足正常用户，不满足我的设计」解码）：*可预测 + 连贯 + 完全可控*，**不是**砍功能。保留密集诊断、缩略图控制、分片计数 —— rich but organized。

---

## 2. 决策总览（头脑风暴逐项锁定）

| # | 决策 | 选择 |
|---|---|---|
| 路由 | 单页重组 vs 顶层多页 vs 嵌套子路由 | **`/settings` 下挂真实嵌套子路由**（B） |
| 骨架 | 左侧竖向子导航 vs 顶部标签 | **左侧子导航 + 顶部常驻状态条**（A + persist） |
| 存储 | 主预算+脚注 vs 总量+明细 vs +JPEG计量 | **总量 + 明细 + 单一硬上限条 + 网关计量 JPEG**（方案 3） |
| 进度 | 纯事实 vs 不确定条纹 vs 满底角标 | **不确定态斜纹条**（B）；总数已知则实心确定条 |
| 状态词 | — | **全站统一词表**（见 §7） |
| 视觉 | — | **MD3 深色内聚**：去平滑渐变、单色 SVG 图标、实心进度条 |

---

## 3. 路由与数据架构

```
web/src/app/settings/
  layout.tsx        ← (client) 共享骨架：顶部常驻状态条 + 左侧子导航 + <SettingsDataProvider>
  page.tsx          ← 概览        /settings
  cache/page.tsx    ← 缓存管理    /settings/cache
  tasks/page.tsx    ← 任务·历史   /settings/tasks
  system/page.tsx   ← 系统配置    /settings/system
```

**关键点：单一轮询源放在 layout。** Next.js App Router 的 layout 在子路由间切换时**不重渲染**——所以把唯一的 `useCoursesStatus()` 轮询放进 `layout.tsx` 里的 `SettingsDataProvider`（React Context）。状态条与四个子页都从 context 读 → **一份数据、一个轮询**，跨子页导航不重启轮询、彼此永远同步。响应式轮询节奏（1s 忙 / 5s 闲 + `markRecentAction`）保留。

- 子路由可深链 / 可收藏；active 高亮。
- 侧栏角标：缓存管理显示已缓存讲数，任务显示失败数（标红）。

---

## 4. 共享骨架（layout.tsx）

- **顶部常驻状态条**：网关在线/离线 · ffmpeg ✓/✗ · 数据实时/陈旧 · 存储一览 `播放 X / Y GB` · `全局暂停所有后台` 开关 · 下载中时显示速度。任何子页都能瞄一眼、随手暂停后台，不必回概览。
- **左侧竖向子导航**：概览 / 缓存管理 / 任务·历史 / 系统配置。
- 标签文案需防换行（`white-space:nowrap` + 徽标 `flex-shrink:0` + 标签 ellipsis）—— 评审中实测窄侧栏会把「任务·历史 + 2失败」挤换行。

---

## 5. 设计系统（与全站内聚，不引入外来风格）

沿用 `@/theme`（MD3，种子 `#4f8cff`，深色默认）：

- 色：dark primary `~#b0c6ff`、强调 `#4f8cff`、success `#3ecf8e`、warning `#e0a33e`、error、info(tertiary)；表面分层 surfaceContainerLow→Highest。
- 圆角：卡片 `radius.md`(12) · 胶囊/按钮/Chip `radius.full` · 大面板 `radius.lg`(20)。
- 间距：8px 基（0.5/1/1.5/2/3），禁用 0.25/0.75/1.2。
- 字体：系统栈（PingFang SC 等）。
- **去平滑渐变**：大数字与进度条用**实心**填充（用户明确要求）。斜纹不确定条是硬边条纹（非渐变），保留。
- **单色图标**：用 MUI 图标 / 单色 SVG，**禁用彩色 emoji**（评审中 `⚡`/`🖼`/🗑 emoji 渲染破坏内聚，已改单色 SVG）。
- **入场动画**：`animation-delay` 错峰淡入；进度动画必须无缝循环（斜纹位移 = 一个完整条纹周期 `条纹周期/cos45°`，勿用 `background-size` 缩放，否则抽搐）。
- 卡片等高对齐：同行卡片用 grid `align-items:stretch` + 卡片 `flex:1` + 底部操作 `margin-top:auto`，保证底边齐平。

视觉真源：见 `docs/superpowers/mockups/2026-05-31-settings/{overview,cache,tasks,system}.html`（已评审通过的高保真）。

---

## 6. 各子页内容

### 6.1 概览 `/settings`
落地仪表盘，一眼掌握系统 + 存储 + 活动。
- **存储卡**（方案 3）：标题总量 `本机缓存共 X GB` + 明细 chip（播放段蓝 / 缩略图绿·持久 / 源段紫·临时）+ **单一确定条**只对播放缓存硬上限 `X / Y GB · %` + 计数条（课程 / 已缓存讲次 / 缩略图就绪）。
- **系统健康卡**：网关 / ffmpeg / 缓存目录（截断路径 + 短状态 pill）/ 数据新鲜度。
- **当前活动卡**：正在缓存哪讲（+ 不确定斜纹条）· 队列深度 · `N 进行中 · M 失败`（链到任务页）。
- **同步有道进度**按钮。

### 6.2 缓存管理 `/settings/cache`
操作核心，保留全部密集诊断。
- 工具栏：搜索 · 课程过滤 · 排序 · 缩略图过滤 · 缓冲过滤 · 密度 · `批量缩略图` / `批量缓冲`。
- 视图切换：**按课程**（课程卡 + 单色 SVG 双环：外=缓存% / 内=看过%）↔ **全部讲次**（DataGrid 平铺表）。
- 课程详情抽屉（含逐段位图）。

### 6.3 任务·历史 `/settings/tasks`
- 顶部失败横幅：内联 `重试` / `清除`。
- 标签：进行中 ↔ 操作历史（只读冻结快照）。
- **整页全高任务列表** —— 有了专属路由，**退役**原 240px 小面板 + 全屏弹窗（页面即全视图）。
- 逐任务 `暂停 / 继续 / 取消 / 重试 / 清除`（动作层已建好，复用）。确定条 vs 不确定斜纹条。
- 队列深度读出。

### 6.4 系统配置 `/settings/system`
低频配置。
- 缓存目录：路径输入 + 更换 + 可用/占用/状态。
- 播放缓存上限：**v1 只读**（标注「网关配置」），未来可改可调（暂不做）。
- AI 助教：系统提示词 + 推理强度（低/中/高）+ 保存。

---

## 7. 统一状态词表（全站唯一）

| 维度 | 词 |
|---|---|
| 任务生命周期 | `排队` · `进行中` · `已暂停` · `已完成` · `已取消` · `失败` |
| 缓存覆盖 | `未缓存` · `缓存中（总数待确认）` · `已缓存 N/M` · `已缓存(完整)` |
| 缩略图 | `未生成` · `生成中` · `已生成` · `失败` |

消除现存不一致：`完成`→`已完成`、`已缓存(部分)`→ 见 §8、动作 toast 保持（已暂停/已继续/已取消/已重试/已清除）。

---

## 8. 存储模型（诚实）

**实情**（已查证 gateway）：`seg_cache`（播放段，唯一硬上限 `buffer.limit`，含 LIVE/AUTO/MANUAL —— 只是淘汰优先级不同，**不是**独立桶）；`thumb_seg_cache`（缩略图源段，64MB 上限，生成后即删 ≈0）；生成的缩略图 JPEG（持久占盘，**当前无人计量**）。

设计：
- **总量** = 播放段 + 缩略图 JPEG + 源段（一个标题数字）。
- **明细 chip**：播放段 / 缩略图(持久) / 源段(临时)。
- **进度条只对播放缓存那个唯一硬上限**，不伪造合并上限。
- **丢弃 `播放/离线` 拆分**（物理上不存在）。

**网关小改**（超出纯前端一点点，用户已同意）：统计 `thumb_dir` 下 JPEG 字节并在 `/api/status` 暴露新 key（如 `thumb.jpegBytes`），web `/api/courses/status` 透传进 `totals`。计算要便宜（缓存/节流，避免每秒 walk 目录）。

---

## 9. 诚实进度（CacheBar 改造）

- 总数已知 → 实心确定条 `已缓存 / 总数`。
- 总数未知且 cached>0 → **不确定态斜纹条** + `缓存中 · 已 N 段 · 总数待确认`。
- cached=0 → `未缓存`。
- **移除**写死 30% 填充 + `已缓存（部分）`。

---

## 10. 组件影响（现有 → 重构）

| 现有 | 去向 |
|---|---|
| `SettingsView.tsx`(438) | 拆解退役 → `layout.tsx` + 4 个 page 组件 + `SettingsDataProvider`(context) |
| `SettingsStatusBar.tsx` | → layout 顶部常驻状态条 |
| `StorageStrip.tsx` | → 概览 `StorageCard`（方案 3）+ 状态条里的 slim `StorageGlance` |
| `TaskQueuePanel` + `TaskQueueFullscreenDialog` | → `tasks/page.tsx`（面板/弹窗退役，页面即全视图） |
| `TaskRow.tsx` | 复用，状态词对齐 §7 |
| `CourseStatusGrid`/`CourseStatusCard`/`LectureGrid`/`CourseDetailDrawer` | → `cache/page.tsx` |
| `CacheDirCard`/`AssistantCard` | → `system/page.tsx` |
| `CacheBar.tsx`(common) | 诚实进度改造 §9 |
| `HealthBar.tsx`(当前未用) | 改造成概览 `HealthCard` 或删除 |
| `SectionHeader.tsx` | 复用 |
| `hooks/data.ts` | 轮询逻辑搬进/复用于 `SettingsDataProvider` |
| `types/api.ts` / `api/courses/status/route.ts` | 加缩略图 JPEG 字节字段 |

---

## 11. 验收（CLAUDE.md 硬性要求）

- 四条新路由各自 **e2e 走通**，复用隔离零流量栈 `web/scripts/_e2e_ui/`（ffmpeg 假 HLS + 隔离 DB/端口），**每步截图**留证。
- 测试含**失败信号**：状态词 / 进度条形态（确定 vs 不确定）/ 存储明细数值断言，能区分「生效 vs 没生效」。
- 网关 JPEG 计量改动：**kill -9 网关 → 重启 → 验证字节数仍正确**。
- 不写生产 DB / 生产缓存目录；部署 = build + 重启 run.sh（perl setsid detached），改 Python 必 kill -9 网关。
- 真实用户路径走查（正常 + 异常：空数据 / 网关掉线 / 重启状态保留），不靠「看代码应该对」。

---

## 12. 不做（YAGNI）

- 不做 `播放/离线` 字节拆分（物理不存在）。
- v1 不做移动端专属布局（局域网播放器，桌面为主）。
- v1 播放缓存上限只读（可调推迟，除非另行要求）。
- 不动 Cache/Thumb 表的 videoId 键（刻意镜像网关缓存，见既有约定）。
