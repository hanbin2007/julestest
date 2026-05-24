// 视频在播放器盒内的「实际显示矩形」(object-fit:contain 的内容区)。
// 批注画布锚定到这个矩形而非整个播放器盒——否则非 16:9 视频被 letterbox 后，
// 以「盒」归一化存的笔迹合成回原始帧时会整体平移/缩放错位（iPad Safari 上 <video>
// 始终按比例 letterbox、不吃 object-fit:fill，故 contain 是显示端与合成端一致的几何）。
export interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// 把 (vw×vh) 等比缩放后居中放进 (boxW×boxH)。缺尺寸时退回整盒（=旧行为，安全兜底）。
export function videoContentRect(boxW: number, boxH: number, vw: number, vh: number): ContentRect {
  if (!vw || !vh || !boxW || !boxH) return { left: 0, top: 0, width: boxW, height: boxH };
  const scale = Math.min(boxW / vw, boxH / vh);
  const width = vw * scale;
  const height = vh * scale;
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}
