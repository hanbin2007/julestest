// 批注合成对齐的几何回归测试（仓库无测试框架，直接 `node web/scripts/annoFit.test.mjs` 跑）。
//
// 背景 bug：批注笔迹以「播放器盒」归一化存储，但 iPad Safari 把 <video> 按比例 letterbox
// 显示（object-fit:contain 行为），视频只占盒的子矩形。合成时按盒归一化坐标画到整张原始帧上
// → 整体平移/缩放错位（转 AI 助教时的「定位跑偏」）。
// 修复：把批注画布锚定到「视频内容区矩形」(contain-fit)，笔迹变成「帧」归一化，合成即对齐。
//
// 注意：下面的 videoContentRect 必须与 src/components/annotate/videoFit.ts 保持一致。
function videoContentRect(boxW, boxH, vw, vh) {
  if (!vw || !vh || !boxW || !boxH) return { left: 0, top: 0, width: boxW, height: boxH };
  const scale = Math.min(boxW / vw, boxH / vh);
  const width = vw * scale;
  const height = vh * scale;
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

let failures = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function check(name, cond) {
  console.log(cond ? `  ok  - ${name}` : `  FAIL- ${name}`);
  if (!cond) failures++;
}

// 场景：16:9 盒里放 4:3 视频（iPad letterbox 的典型情形）。
const boxW = 1280, boxH = 720;     // 播放器盒 16:9
const vw = 1280, vh = 960;         // 视频内在 4:3 → 左右出黑边
const frameW = 1280, frameH = 960; // 合成所用的原始帧（同源宽高比）

const rect = videoContentRect(boxW, boxH, vw, vh);
check("contain-fit 宽=960", approx(rect.width, 960));
check("contain-fit 高=720", approx(rect.height, 720));
check("contain-fit 左黑边=160", approx(rect.left, 160));
check("contain-fit 上=0", approx(rect.top, 0));

// 帧内某特征点（帧归一化 fx,fy），它在盒里实际显示（contain）的像素位置：
const fx = 0.25, fy = 0.5;
const dispX = rect.left + fx * rect.width;  // 用户实际看到/点到的位置
const dispY = rect.top + fy * rect.height;
const correctBakeX = fx * frameW;           // 该特征在帧上的正确像素 = 320
const correctBakeY = fy * frameH;           // = 480

// 旧（有 bug）：画布=整盒；坐标按盒归一化；合成 = 盒归一化 × 帧尺寸。
const oldBakeX = (dispX / boxW) * frameW;
check("旧路径横向跑偏（复现 bug）", !approx(oldBakeX, correctBakeX, 1));
console.log(`     旧合成 X=${oldBakeX.toFixed(1)} vs 正确 ${correctBakeX}（偏 ${(oldBakeX - correctBakeX).toFixed(1)}px）`);

// 新（修复）：画布=内容区矩形；坐标按内容区归一化；合成 = 帧归一化 × 帧尺寸。
const newBakeX = ((dispX - rect.left) / rect.width) * frameW;
const newBakeY = ((dispY - rect.top) / rect.height) * frameH;
check("新路径 X 精确", approx(newBakeX, correctBakeX));
check("新路径 Y 精确", approx(newBakeY, correctBakeY));

// 同比（16:9 视频 + 16:9 盒）→ 内容区=整盒，行为不变（无回归）。
const r2 = videoContentRect(1280, 720, 1280, 720);
check("同比 → 整盒（无回归）",
  approx(r2.left, 0) && approx(r2.top, 0) && approx(r2.width, 1280) && approx(r2.height, 720));

// 元数据未就绪 → 退回整盒兜底。
const r3 = videoContentRect(1280, 720, 0, 0);
check("无元数据 → 整盒兜底",
  approx(r3.left, 0) && approx(r3.width, 1280) && approx(r3.height, 720));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
