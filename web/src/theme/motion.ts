import type { Theme } from "@mui/material/styles";

// 统一动效 token —— 克制、跟手、不弹。所有过渡时长/缓动从这里取,杜绝各组件手写、漏属性、节奏不齐。
// 时长(ms):short=微交互(hover/底色/选中) · base=卡片悬停 · long=进度/较大位移。基准 150–250ms。
export const DUR = { short: 150, base: 180, long: 220 } as const;
// MD3 standard easing(进出都平滑,无回弹)。
export const EASE = "cubic-bezier(0.2, 0, 0, 1)";

// 卡片 / 可点卡的统一悬停反馈:**不位移(无 translateY)**,仅背景提亮 + 轻阴影,全部平滑过渡。
// 用法: sx={(t) => ({ ...hoverElevate(t), /* 其它样式 */ })}
export function hoverElevate(t: Theme) {
  return {
    transition: t.transitions.create(["background-color", "box-shadow"], {
      duration: DUR.base,
      easing: EASE,
    }),
    "&:hover": {
      backgroundColor: (t.vars ?? t).palette.md3.surfaceContainerHigh,
      boxShadow: t.shadows[6],
    },
  };
}

// 通用:给状态变化(底色/文字色/描边)加统一过渡。用于 nav pill、可点行、流式描边等。
export function smoothColors(
  t: Theme,
  props: string[] = ["background-color", "color"],
  duration: number = DUR.short,
) {
  return t.transitions.create(props, { duration, easing: EASE });
}
