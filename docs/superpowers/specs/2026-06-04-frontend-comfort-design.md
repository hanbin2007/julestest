# 前端"舒适度"整改 — 设计 (Frontend Comfort Overhaul)

日期: 2026-06-04 · 分支: `worktree-frontend-polish-iso`

## 背景与根因

全前端 5 维度审计 + 实测得出:`theme.ts`/`md3.ts` 的设计 token(MD3 色阶、圆角刻度、×8 间距、CJK 字体栈)**做得很好,但缺"强制执行层"**——没有共享 shell、没有共享原子组件、没有动效 token、数据 hook 还丢掉了状态信号。于是每个页面各自重造 shell/间距/对齐/深度/动效/边缘态,**所有接缝处都在轻微漂移**。这种弥散的漂移就是"总觉得不对劲"的来源。对照基准是 Cloudreve 前端:一致性 / 留白节奏 / 克制动效 / 边缘态完备 / 即时反馈 / 深度。

强力表述:**代码到处写明了规则却不遵守自己的规则**(`theme.ts:45` 注释禁用 0.25/0.75/1.2 间距却到处犯;`theme.ts:33` 注释说 paper 要比背景亮却同色;framer-motion 装了只在 1/70 文件用;Skeletons/空态/错误 Alert 都造好了却没接到该接的地方)。

## 目标 / 非目标

- **目标**:消除弥散的不一致;让深度、节奏、动效、边缘态、布局各自成系统并被强制执行。每个修复符合 `AGENTS.md` 验收(可重复 e2e + 失败信号;改 web 须 build+重启)。
- **非目标**:不改后端解密/网关逻辑;不改 ArtPlayer 核心;不做与诊断无关的重构;不推送 origin(本地自用项目)。

## 运行/验证拓扑(本次隔离)

工作在 worktree `.claude/worktrees/frontend-polish-iso`(分支 `worktree-frontend-polish-iso`,从当前 `main` HEAD reset 而来)。主 checkout 的 next 仍跑在 `:3000`(免受影响)。本 worktree 的 node_modules 软链主 checkout,`.env` 已复制;构建后跑独立 next 在 **`:3001`**,共用网关 `:8808`、同一 DB。所有 e2e/截图针对 `:3001`。
> 注:用户要求"别乱塞截图"——故 PNG 证据不入库,改由 e2e 脚本按需重生成(满足 AGENTS.md「可重复 + 留下截图能力」)。

## 路线图(5 阶段 · 逐阶段先批设计后实现)

| 阶段 | 内容 | 风险 | 状态 |
|---|---|---|---|
| **0 · 深度地基** | md3 表面层次 + chrome 滚动浮起 + hover 阴影 | 低代码/全局 | ✅ 已实现+验证 |
| 1 · 边缘态 | hooks 暴露 error/loading;notes/chats skeleton+error+empty;播放器重试;设置无假红;error.tsx/ErrorBoundary | 中 | 🔄 列表+兜底已实现,余播放器/设置假红 |
| 2 · 动效/反馈 | chat 乐观改名/删除;列表 AnimatePresence;导航 pill 过渡;transitions token | 中 | 待批设计 |
| 3 · 网格归一 | 间距→×8;排版→variants;抽 StatNum/StatusDot/LiftCard | 低/多文件 | 待批设计 |
| 4 · AppShell+chrome | 单一 AppShell(统一 maxWidth/对齐);顶栏空洞→实时上下文;返回键→左;双标题;设置密度 | 高/全路由 | 待批设计 |

---

## Phase 0 · 深度地基(已实现并验证)

### 问题
暗色下 `background == surface == surfaceContainerLow == #1b1b1f`(tone 10),所有 Card/Drawer/侧栏/AppBar 与背景同色(对比度 **1.00**),只靠 1px `outlineVariant` 描边分隔;且 `theme.ts` 把所有 elevation 归零。

### 锁定决策
1. **表面层次 = 双向**:页面降到 **tone 6**,卡片从 tone10 提到 **tone12**。三级层次 `背景(6) < 侧栏/导航(10) < 卡片(12)`。
2. **持久 chrome = 滚动浮起**:顶栏 AppBar 顶部平贴,内容滚动后加阴影+微提亮(surfaceContainer)。各页滚动容器不同,改用**捕获阶段** `scroll` 监听任意嵌套滚动源(比 MUI `useScrollTrigger` 更通用,无需逐页传 ref)。竖向导航 rail 不滚动浮起:`SettingsNav` 由 `surface` 改 `surfaceContainerLow`(tone10)以从 tone6 背景分离。
3. **hover 反馈 = 主题 elevation + 提亮**:卡片 hover 用 `boxShadow:6`(theme.shadows[6])并把背景提到 `surfaceContainerHigh`(tone17)——在暗色上"提亮"比黑阴影更可见。

### 改动文件
- `web/src/theme/md3.ts` — `background`/`surface` → `tone(dark?6:98)`(不再继承 legacy scheme 的 tone10)。
- `web/src/theme/theme.ts` — `background.paper` 与 `MuiCard` 填充 → `surfaceContainer`(tone12)。
- `web/src/components/common/AppTopBar.tsx` — `useScrollElevated()` 捕获滚动 → AppBar `boxShadow:6` + `surfaceContainer` 浮起。
- `web/src/components/notes/NoteCard.tsx`、`web/src/components/settings/CourseStatusCard.tsx` — hover `rgba(0,0,0,.18)` → `boxShadow:6` + `bgcolor:surfaceContainerHigh`。
- `web/src/components/settings/SettingsNav.tsx` — rail `surface` → `surfaceContainerLow`。

### 验证 — `web/scripts/_e2e_depth.mjs`
TDD:对 `:3000`(旧码)跑出 3 红 → 实现后对 `:3001` 跑出全绿,连跑两次稳定。
- ✅ 暗色 body(rgb 18,19,22)vs card(rgb 31,31,35)对比度 = **1.131**(>1.08;旧码 1.000)。
- ✅ AppBar 顶部无阴影 → 滚动后有阴影。
- ✅ NoteCard hover 背景 tone12(31,31,35)→ tone17(41,42,45)提亮。
- 暗+亮 × home/settings/notes/chats 截图脚本可重生成;实测浅色无回归。
