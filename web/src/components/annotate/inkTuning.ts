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
  pen: PenTuning;
  marker: PenTuning;
  minSampleDist: number; // 抽稀最小间距(px)
}

export const tuning: InkTuning = {
  posMinCutoff: 1.2,
  posBeta: 0.5,
  dCutoff: 1.0,
  pressMinCutoff: 2.0,
  pressBeta: 0.3,
  pen: { thinning: 0.6, smoothing: 0.5, streamline: 0.2, taperStart: 0, taperEnd: 2 },
  marker: { thinning: 0, smoothing: 0.5, streamline: 0.3, taperStart: 0, taperEnd: 0 },
  minSampleDist: 1.2,
};

// 调优页用的预设（名字 → 覆盖值）。生产不引用。
export const PRESETS: Record<string, Partial<InkTuning>> = {
  跟手优先: { posMinCutoff: 1.8, posBeta: 0.8, pen: { ...tuning.pen, streamline: 0.15, taperEnd: 2 } },
  平滑优先: { posMinCutoff: 0.6, posBeta: 0.3, pen: { ...tuning.pen, streamline: 0.35, taperEnd: 2.5 } },
  "Goodnotes-ish": { posMinCutoff: 1.0, posBeta: 0.5, pen: { ...tuning.pen, streamline: 0.25, taperStart: 0, taperEnd: 2.2 } },
};
