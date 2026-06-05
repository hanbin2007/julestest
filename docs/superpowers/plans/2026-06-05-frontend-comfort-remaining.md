# Frontend Comfort — Remaining Phases (1b · 3 · 4) Implementation Plan

> **For agentic workers:** 执行用 Workflow 工具(并行 + 每任务 spec→质量 双阶段评审,见 [[feedback-use-workflow-parallel]])。本计划按**文件不相交任务组**切分以便并行;阶段间(1b→3→4)有 build+e2e barrier + 单独提交。

**Goal:** 收尾前端舒适度整改——播放器/设置边缘态(1b)、网格/排版/共享组件归一(3)、统一 AppShell + chrome 修整(4)。

**Architecture:** 每阶段:共享基础(组件/token)先串行建好 → 文件不相交任务组并行实现(各走 TDD→spec 评审→质量评审)→ 主循环 build :3001 + e2e barrier + 提交。阶段顺序 1b→3→4(4 重构布局,放最后)。

**Tech:** Next15 / MUI7 / MD3 · worktree 跑 :3001 验证 · playwright-core e2e · 已有 `DataBoundary`(Phase1a)、`hoverElevate/smoothColors`(Phase2)。

**前置事实(执行者须知):**
- 工作根:`web/`(worktree)。`@/theme/motion`(DUR/EASE/hoverElevate/smoothColors)、`@/components/common/DataBoundary`、`@/components/common/Skeletons`(SidebarSkeleton/PlayerSkeleton/CardGridSkeleton)已存在。
- 验证拓扑:改源码 → 主循环 `npm run build` + 重启 `:3001` → 跑 `web/scripts/_e2e_*.mjs`。agent 只编辑源码、不跑 build/server。
- 约束:每任务严格只改分配文件;不改 `motion.ts`/`DataBoundary` 签名(可扩展)。

---

## Phase 1b — 播放器取流失败 + 设置首帧假态

**根因:** 取流 `play()` reject → `src` 仍 null、`sel` 仍在 → 播放器永久"加载中…";设置 Health/Chrome/Activity 在首轮轮询前用 `undefined` 数据派生出"离线/丢失/空闲"假态;缓存网格 `loading={!data}` 在出错时永转骨架。

**验证:** 新增 `web/scripts/_e2e_1b.mjs`,用 playwright route 拦截:
- 拦 `**/api/play`(或取流端点)→ abort → 断言播放器出现「重试」按钮(非永久"加载中…")。
- 拦 `**/api/courses/status`(或 health 数据源)→ 延迟/abort → 断言设置首屏不出现"离线"红、而是"检测中…"中性态。
- 失败信号:旧码 abort→永久"加载中…"/红;改后→重试/中性。

### 任务(文件不相交)
- **1b-foundation(串行先做):** `web/src/hooks/data.ts` — 让 `useCoursesStatus`(及 health/activity 用到的 hook)暴露 `error`/`isLoading`(仿 Phase1a 的 persist 改法)。这是 1b-T2/T3 的共享依赖,单独先改,避免 data.ts 竞争。
- **1b-T1 播放器重试:** `web/src/app/page.tsx` — 找到 `play()` 调用(约 :201-203)与"加载中…"分支(约 :652-682)。加 `streamError` state:取流 reject 时置位;渲染播放器盒内的重试 overlay(图标 + "取流失败" + 「重试」按钮,点击清错并重新触发当前 `sel` 的加载)。成功取流时清错。复用 `DataBoundary` 或独立 overlay(播放器盒在 #000 上,样式从简)。
- **1b-T2 设置假态:** `web/src/components/settings/HealthCard.tsx` + `web/src/components/settings/SettingsChrome.tsx` — 数据 `isLoading && !data` 时,网关/ffmpeg/缓存目录渲染中性"检测中…"(灰),不派生红"离线/丢失";有数据后正常。`ActivityCard.tsx` 同理:无数据时不显示"空闲·0",显示骨架/中性。
- **1b-T3 缓存网格出错:** `web/src/components/settings/CourseStatusGrid.tsx`(+必要时 `web/src/app/settings/cache/page.tsx`) — 把 `loading={!data}` 改为基于 `isLoading`/`error`:出错走 `DataBoundary` 的重试面板,而非永久骨架。

**barrier:** build + `_e2e_1b` 红→绿连跑两次 + `_e2e_depth/edge/motion` 回归 + tsc。提交 `feat(edge): Phase 1b 播放器重试 + 设置假态`。

---

## Phase 3 — 网格 / 排版 / 共享组件归一

**根因:** 间距脱离 ×8(theme.ts:45 自定却到处犯,集中在 settings:18/14/10/8.8px);排版用裸 fontSize/`fontWeight:800`(主题最大 700);`StatNum` 在 NotesView/ChatsView 重复、状态点手写 9×。

**验证:** 新增 `web/scripts/_e2e_grid.mjs`:静态+运行时混合——
- 运行时:抓 settings 概览页所有卡片的 computed padding,断言全部 ∈ {8,16,24}px(无 18/14/10);抓页面所有文本 computed fontWeight,断言无 800。
- 失败信号:旧码有 18px padding / fontWeight 800 → 红;改后 → 绿。
- (排版 variant 化主要靠 spec 评审静态保证;e2e 守住"无 800、间距归网格"两条硬线。)

### 任务
- **3-foundation(串行先做):** 建共享组件 —— `web/src/components/common/StatNum.tsx`(从 NotesView/ChatsView 的重复 StatNum 提炼,props {value, label};用主题 variant、去掉 800)、`web/src/components/common/StatusDot.tsx`(props {color, size?};统一那 9 处手写的圆点)。**这两个文件先建好**,供下列分区任务引用。
- **3-A 笔记区:** `web/src/components/notes/NotesView.tsx`、`NoteCard.tsx`、`NotePreview.tsx`、`NoteViewer.tsx`、`web/src/components/player/NotesPanel.tsx` — 间距 snap 到 0.5/1/1.5/2/3;裸 fontSize→最近 variant(或 sx 用 token);用 `<StatNum>`/`<StatusDot>` 替换本区重复;去 `fontWeight:800`。
- **3-B 对话区:** `web/src/components/chat/ChatsView.tsx`、`ChatCard.tsx`、`ChatSwitcher.tsx` — 同 3-A 处理(间距/排版/StatNum/StatusDot/去 800)。
- **3-C 设置区:** `web/src/components/settings/SettingsNav.tsx`、`SettingsChrome.tsx`、`StorageCard.tsx`、`HealthCard.tsx`、`ActivityCard.tsx`、`CacheDirCard.tsx`、`CourseStatusCard.tsx`、`CourseStatusGrid.tsx`、`SectionHeader.tsx`、`web/src/app/settings/page.tsx`、`settings/system/page.tsx`、`settings/tasks/page.tsx`、`settings/cache/page.tsx` — 间距 snap(重灾区:把 2.25→2、1.75→1.5/2、1.25→1、1.1→1、2.5→2/3、0.25→0.5);卡片内 padding 统一(选 `p:2`=16);裸 fontSize/800→variant;状态点→StatusDot。
- **3-D 侧栏/首页/通用:** `web/src/components/sidebar/SidebarRows.tsx`、`CourseSidebar.tsx`、`CourseItem.tsx`、`web/src/components/home/ContinueWatchingRail.tsx`、`web/src/components/common/AppTopBar.tsx`(仅间距/排版,**不动布局结构**——结构归 Phase4) — 间距/排版归一、去 800、状态点→StatusDot。

> 分区按文件不相交,可并行。3-C 触碰 1b 改过的 HealthCard/ActivityCard/SettingsChrome/CourseStatusGrid——**Phase 1b 已提交**故无冲突(顺序在后)。

**barrier:** build + `_e2e_grid` 红→绿连跑两次 + 全 e2e 回归 + tsc。提交 `refactor(ui): Phase 3 间距/排版/共享组件归一`。

---

## Phase 4 — AppShell + chrome(结构,放最后)

**根因:** 无共享 shell——AppTopBar 在 4 处手摆,各路由自定 maxWidth(920/1100/1240)/对齐(居中 vs 左)→ 切页左边缘跳;顶栏中段空洞(flex:1 spacer);返回箭头在右上(惯例左);"课程"(顶栏)vs"我的课程"(侧栏)双标题;设置状态条与卡片信息重复。

**设计决策(已据诊断锁定,执行者照此做):**
1. **`<AppShell>`** 新组件,统一:顶栏 + 可选左 rail + 单一内容容器(**maxWidth 统一 1200、内容居中 `mx:auto`、`p:{xs:2, md:3}`**)。各路由把"内容"和"可选 rail"塞进去,不再各自造列。
2. **顶栏中段填实时上下文**,顶替空洞与双标题:左侧 logo 点后显示 `当前课程 / 讲次`(首页有选中讲次时)或区域名(设置/笔记/对话);**侧栏保留"我的课程"**作为列表头,顶栏不再单写"课程"。
3. **返回箭头移到左**(`edge="start"`,非首页时显示,紧邻 ☰ 菜单),从右侧图标簇移除。
4. **设置:概览页去掉 SettingsChrome 状态条**(卡片已含网关/ffmpeg/播放量);仅保留唯一的"暂停所有后台"开关——移入 AppShell 顶栏右簇或仅在子路由保留状态条。

**验证:** 新增 `web/scripts/_e2e_shell.mjs`:
- 跨 `/`、`/settings`、`/notes`、`/chats` 抓内容容器的 `getBoundingClientRect().left` 与 `maxWidth`,断言四页**左边缘一致**(±2px)、maxWidth 一致(1200)。失败信号:旧码三种宽度/两种对齐 → left 不一致 → 红;改后一致 → 绿。
- 断言返回箭头(非首页)在视口左半(x < 视口宽/2);断言顶栏无"课程"裸标题与"我的课程"并存。

### 任务
- **4-foundation(串行先做):** 建 `web/src/components/common/AppShell.tsx` —— props `{ rail?: ReactNode; children: ReactNode; topbarContext?: ReactNode }`;内部渲染改造后的 AppTopBar(返回键左移、中段渲染 `topbarContext`)+ 可选 rail + 单一内容容器(maxWidth 1200、居中、统一 padding)。**同时改 `AppTopBar.tsx`**:返回键 `edge="start"` 左移、中段 `flex:1` 改为渲染传入的 context、去掉裸"课程"标题(由 context 顶替)。这是后续迁移的共享依赖。
- **4-migrate(foundation 后,可并行,文件不相交):**
  - 4-M1 首页:`web/src/app/page.tsx` — 用 `<AppShell rail={<侧栏>} topbarContext={当前课程/讲次}>`,移除自造列/maxWidth/对齐;**保留播放器/分屏逻辑**,只换外层壳;continue-watching rail 选中讲次后移到播放器下方或收起(诊断 #7)。
  - 4-M2 设置:`web/src/app/settings/layout.tsx`(+ `settings/page.tsx`)— 用 AppShell(rail=SettingsNav);概览去状态条;卡片密度交 Phase3 已做。
  - 4-M3 笔记:`web/src/app/notes/page.tsx` + `web/src/components/notes/NotesView.tsx` 的外层容器 — 用 AppShell(无 rail),去掉 NotesView 自带的 `maxWidth:1240/mx:auto`。
  - 4-M4 对话:`web/src/app/chats/page.tsx` + `web/src/components/chat/ChatsView.tsx` 外层 — 同 4-M3。

> 迁移任务都依赖 4-foundation 的 AppShell/AppTopBar;foundation 串行先建,迁移再并行(各路由文件不相交)。

**barrier:** build + `_e2e_shell` 红→绿连跑两次 + 全 e2e 回归 + tsc + 四页两模式截图肉眼复核(左边缘对齐、顶栏不空、返回键在左)。提交 `feat(shell): Phase 4 AppShell + chrome 统一`。

---

## 收尾(全部阶段后)
- 整体终审:`superpowers:requesting-code-review`(或 code-reviewer agent)审 `main..worktree-frontend-polish-iso` 全量,清掉累计的非阻塞遗留(Rail no-op motion.div、个别 ease-out/0.2s 未走 token、Chip 状态色硬切等)。
- `superpowers:finishing-a-development-branch` 收尾。

## Self-review(spec 覆盖核对)
- 诊断 T1-T3 全覆盖:深度(P0✓)、边缘态列表(P1a✓)+播放器/设置(P1b)、动效(P2✓)、网格/排版/组件(P3)、AppShell/顶栏/返回键/双标题/设置密度(P4)。✓ 无遗漏。
- 无占位:各任务有确切文件 + 确切改动 + 确切 e2e 失败信号。
- 类型一致:复用既有 `DataBoundary`/`hoverElevate`/`smoothColors`/`CardGridSkeleton` 命名;新建 `StatNum`/`StatusDot`/`AppShell` 命名贯穿引用。
