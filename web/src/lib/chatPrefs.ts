// AI 助教的客户端可用配置：默认系统提示词 + 思考等级。
// 不引入任何服务端依赖（claude.ts 含 fs/SDK，是服务端专用），故单列此文件，
// 让 SettingsView / ChatPanel（客户端）与 claude.ts（服务端）共用同一份真相。

// 思考等级：对应 Agent SDK 的 effort（low|medium|high|xhigh），xhigh 仅 Opus 4.7。
export type ChatEffort = "low" | "medium" | "high" | "xhigh";

export const DEFAULT_EFFORT: ChatEffort = "high"; // 与 SDK 默认一致

export const EFFORT_LEVELS: { value: ChatEffort; label: string; hint: string }[] = [
  { value: "low", label: "快速", hint: "几乎不思考，答得最快" },
  { value: "medium", label: "标准", hint: "适度思考" },
  { value: "high", label: "深入", hint: "深度推理（默认）" },
  { value: "xhigh", label: "极致", hint: "比深入更彻底，最慢" },
];

// 用户可在「设置 / AI 助教」里覆盖。课程/讲标题等上下文由服务端另行追加，不在此处。
export const DEFAULT_SYSTEM_PROMPT = [
  "你是一位耐心、严谨的中文理科助教（数学 / 物理 / 化学 / 生物等）。",
  "学生可能发来课程画面截图或他在画面上的批注（圈画、标注、写的步骤）。请：",
  "- 先看懂图里的题目 / 图形 / 公式，必要时先复述你的理解再作答；",
  "- 讲清思路与每一步推导，而不是只丢最终答案；",
  "- 用简洁的中文；公式用 LaTeX（行内 $...$，独立公式 $$...$$）；",
  "- 信息不足时，先指出缺什么，再在合理假设下给出解法。",
].join("\n");

export const SYSTEM_PROMPT_MAX = 8192; // 系统提示词长度上限（字节级近似，按字符数限制）
