// 墨迹手感参数——单一可变真源。生产组件只读这里的默认值；/ink-tune 调优页在 iPad 上实时改它做 A/B。
// 定稿后把「赢的值」写回本文件默认即可（并删掉调优页）。renderEngine/AnnotationLayer 在绘制时即时读取，
// 故改了值强制重绘就生效（不依赖 React 重渲染）。

export interface PenTuning {
  thinning: number; // 压感对线宽的影响
  smoothing: number; // perfect-freehand 轮廓柔化
  streamline: number; // 输入流线化（与 One Euro 叠加，建议低，主要靠 One Euro 去抖）
  taperStart: number; // 起锋长度 = size × 此系数（0 = 钝圆头）
  taperEnd: number; // 出锋长度 = size × 此系数（>0 收尖）
}

export interface InkTuning {
  // One Euro 位置防抖
  posMinCutoff: number; // 越小→慢速去抖越狠
  posBeta: number; // 越大→快速越跟手（降延迟）
  dCutoff: number;
  // One Euro 压感平滑
  pressMinCutoff: number;
  pressBeta: number;
  cornerStrength: number; // 大拐角防出轨：0=纯滤波(会抹圆拐角)，1=拐角处完全跟原始点(最尖)
  pen: PenTuning;
  marker: PenTuning;
  minSampleDist: number; // 抽稀最小间距(px)
}

// 默认值 = 用户在 /ink-tune 上 iPad 实测敲定的（2026-05-24，最终）。cornerStrength 用户未导出(复制曾有 bug)，
// 角已反馈 OK，保留 0.7。minSampleDist=0.10 为用户定稿（采样很密，几乎不抽稀）。
export const tuning: InkTuning = {
  posMinCutoff: 4,
  posBeta: 0.95,
  dCutoff: 1.0,
  pressMinCutoff: 1.5,
  pressBeta: 0.3,
  cornerStrength: 0.7,
  pen: { thinning: 0.6, smoothing: 0.5, streamline: 0.58, taperStart: 0, taperEnd: 2.5 },
  marker: { thinning: 0, smoothing: 0.5, streamline: 0.25, taperStart: 0, taperEnd: 0 },
  minSampleDist: 0.1,
};
