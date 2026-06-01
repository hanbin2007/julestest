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

// 默认值 = 用户在 /ink-tune 上 iPad 实测敲定的（2026-05-30，最终）。经服务端同步从设备 localStorage 取回
// (iPad 非 HTTPS 源无 navigator.clipboard，复制不可用，改走 /api/inktune 落盘读取)。marker 用户未调，保持原样。
export const tuning: InkTuning = {
  posMinCutoff: 10,
  posBeta: 0.69,
  dCutoff: 5,
  pressMinCutoff: 0.1,
  pressBeta: 0.91,
  cornerStrength: 0.49,
  pen: { thinning: 0.37, smoothing: 0, streamline: 0.58, taperStart: 0.2, taperEnd: 2.5 },
  marker: { thinning: 0, smoothing: 0.5, streamline: 0.25, taperStart: 0, taperEnd: 0 },
  minSampleDist: 0.05,
};
