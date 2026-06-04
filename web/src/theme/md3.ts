import {
  argbFromHex,
  hexFromArgb,
  themeFromSourceColor,
  type Theme as McuTheme,
} from "@material/material-color-utilities";

// 默认种子色（沿用旧 UI 的强调蓝）
export const SEED = "#4f8cff";
// 品牌成功绿（MD3 无语义 success，单独保留）
export const SUCCESS = "#3ecf8e";

export interface Md3Tokens {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  tertiary: string;
  onTertiary: string;
  tertiaryContainer: string;
  onTertiaryContainer: string;
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;
  background: string;
  onBackground: string;
  surface: string;
  onSurface: string;
  surfaceVariant: string;
  onSurfaceVariant: string;
  outline: string;
  outlineVariant: string;
  inverseSurface: string;
  inverseOnSurface: string;
  inversePrimary: string;
  surfaceDim: string;
  surfaceBright: string;
  surfaceContainerLowest: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;
}

const H = (argb: number) => hexFromArgb(argb);

/* eslint-disable @typescript-eslint/no-explicit-any */
function tokensFromScheme(scheme: any, neutral: any, dark: boolean): Md3Tokens {
  const tone = (l: number) => H(neutral.tone(l));
  return {
    primary: H(scheme.primary),
    onPrimary: H(scheme.onPrimary),
    primaryContainer: H(scheme.primaryContainer),
    onPrimaryContainer: H(scheme.onPrimaryContainer),
    secondary: H(scheme.secondary),
    onSecondary: H(scheme.onSecondary),
    secondaryContainer: H(scheme.secondaryContainer),
    onSecondaryContainer: H(scheme.onSecondaryContainer),
    tertiary: H(scheme.tertiary),
    onTertiary: H(scheme.onTertiary),
    tertiaryContainer: H(scheme.tertiaryContainer),
    onTertiaryContainer: H(scheme.onTertiaryContainer),
    error: H(scheme.error),
    onError: H(scheme.onError),
    errorContainer: H(scheme.errorContainer),
    onErrorContainer: H(scheme.onErrorContainer),
    // 暗色:不沿用 legacy scheme(它把 background/surface 都给了 tone10,与 surfaceContainerLow 撞色→层次塌陷)。
    // 改用 neutral tone 6,让容器层(tone10/12…)能从背景上"浮"起来;浅色保持 tone98(MD3 规范)。
    background: tone(dark ? 6 : 98),
    onBackground: H(scheme.onBackground),
    surface: tone(dark ? 6 : 98),
    onSurface: H(scheme.onSurface),
    surfaceVariant: H(scheme.surfaceVariant),
    onSurfaceVariant: H(scheme.onSurfaceVariant),
    outline: H(scheme.outline),
    outlineVariant: H(scheme.outlineVariant),
    inverseSurface: H(scheme.inverseSurface),
    inverseOnSurface: H(scheme.inverseOnSurface),
    inversePrimary: H(scheme.inversePrimary),
    // MD3 较新的 surface 层级（legacy Scheme 不含），由 neutral 调色板 tone 推导
    surfaceDim: tone(dark ? 6 : 87),
    surfaceBright: tone(dark ? 24 : 98),
    surfaceContainerLowest: tone(dark ? 4 : 100),
    surfaceContainerLow: tone(dark ? 10 : 96),
    surfaceContainer: tone(dark ? 12 : 94),
    surfaceContainerHigh: tone(dark ? 17 : 92),
    surfaceContainerHighest: tone(dark ? 22 : 90),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function md3FromSeed(seedHex: string): { light: Md3Tokens; dark: Md3Tokens } {
  const t: McuTheme = themeFromSourceColor(argbFromHex(seedHex));
  const neutral = (t.palettes as any).neutral;
  return {
    light: tokensFromScheme((t.schemes as any).light, neutral, false),
    dark: tokensFromScheme((t.schemes as any).dark, neutral, true),
  };
}
