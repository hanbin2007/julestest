// TDD 单元: StorageStrip 标签不再让"缩略图字节"被误读为含在"缓存"里(#12)。
// Task 6 已物理隔离: buffer.bytes=播放桶 seg_cache.size, thumb.bytes=独立 thumb_seg_cache.size,
// 两者互不重叠。因此修复口径是【改标签】: 把含糊的 "缓存" 改成明确的 "缓存(播放)",
// 与单列 "缩略图" 并列, 让用户不再把缩略图当成已经算进"缓存"里。
//
// 这是纯展示组件, 无 Python; 本脚本对 detailLabel 文案做确定性断言(失败信号: 标签退回 "缓存 ...").
// 截图留证(smoke.mjs)按计划放整合阶段。
//
// 运行: node web/scripts/_e2e_storage_strip_labels.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "src", "components", "settings", "StorageStrip.tsx");

// 从源码里抽出纯逻辑函数 storageStripLabels 的实现求值(无需 transpile React/JSX):
// 该函数只依赖 fmtBytes(传入), 返回 { cacheLabel, detail } 文案, 便于无浏览器断言。
const src = readFileSync(srcPath, "utf8");

// 抓取从 "export function storageStripLabels" 到该函数 return 语句后的闭合 "}".
// 注意: 形参类型字面量里也有第 0 列的 "}", 不能用首个 "\n}" 当函数尾; 用 return 行锚定。
const start = src.indexOf("export function storageStripLabels");
if (start < 0) {
  console.error("FAIL: StorageStrip.tsx 缺少可测的纯函数 storageStripLabels(...) 导出");
  process.exit(1);
}
const retIdx = src.indexOf("return { cacheLabel, detail }", start);
if (retIdx < 0) {
  console.error("FAIL: storageStripLabels 必须 return { cacheLabel, detail }");
  process.exit(1);
}
const close = src.indexOf("\n}", retIdx);
const raw = src.slice(start, close + 2);

// 把 TS 形参对象类型注解 + 返回类型注解整段替换掉, 只留 JS 形参与函数体。
// 形如: ({ ...fields }: { ...types }): { ...ret } {  ->  ({ ...fields }) {
const body = raw
  .replace(/^export function/, "function")
  // 从形参解构的 "}" 后, 跨过 ": { ...类型... }" 与 ": { ...返回... }", 直到函数体 "{"
  .replace(/\}:\s*\{[\s\S]*?\}\):\s*\{[^}]*\}\s*\{/, "}) {");

// eslint-disable-next-line no-new-func
const fn = new Function(`${body}; return storageStripLabels;`)();

const fmtBytes = (n) => `${n}B`;
const out = fn({ bufferBytes: 100, bufferLimit: 1000, thumbBytes: 30, fmtBytes });

let failed = false;
function check(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed = true; }
  else console.log("ok:", msg);
}

// 1) 播放缓存标签必须明确标注"(播放)", 不能是裸"缓存"(否则用户以为含缩略图)。
check(/缓存\s*\(\s*播放\s*\)/.test(out.cacheLabel),
  `cacheLabel 含"缓存(播放)" 明确化, 实际="${out.cacheLabel}"`);
// 2) detail 文案里缩略图单列存在, 且与播放缓存并列(不混算)。
check(out.detail.includes("缩略图") && out.detail.includes("30B"),
  `detail 单列缩略图 30B, 实际="${out.detail}"`);
check(out.detail.includes("100B") && out.detail.includes("1000B"),
  `detail 播放缓存 100B/1000B, 实际="${out.detail}"`);
// 3) 播放数值不得是 buffer+thumb 的混算(130B 不应出现, 证明没把缩略图算进缓存)。
check(!out.detail.includes("130B"),
  `detail 不把缩略图算进缓存(不出现 130B), 实际="${out.detail}"`);

if (failed) { console.error("\nSTORAGE STRIP LABELS: RED"); process.exit(1); }
console.log("\nSTORAGE STRIP LABELS: GREEN");
