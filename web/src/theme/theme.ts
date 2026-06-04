"use client";
import { createTheme } from "@mui/material/styles";
import { md3FromSeed, SEED, SUCCESS, type Md3Tokens } from "./md3";

// 把 MD3 容器等额外令牌挂到 palette.md3
declare module "@mui/material/styles" {
  interface Palette {
    md3: Md3Tokens;
  }
  interface PaletteOptions {
    md3?: Md3Tokens;
  }
  interface Theme {
    radius: { xs: string; sm: string; md: string; lg: string; full: string };
  }
  interface ThemeOptions {
    radius?: { xs: string; sm: string; md: string; lg: string; full: string };
  }
}

// 统一的告警琥珀（MD3 无 warning 语义，固定一个克制的琥珀，避免 MUI 默认色混入）
const WARNING = "#e0a33e";

function schemePalette(t: Md3Tokens) {
  return {
    primary: { main: t.primary, contrastText: t.onPrimary },
    secondary: { main: t.secondary, contrastText: t.onSecondary },
    error: { main: t.error, contrastText: t.onError },
    success: { main: SUCCESS, contrastText: "#06291b" },
    // info 走 MD3 tertiary、warning 走统一琥珀——不再落到 MUI 默认的蓝/琥珀
    warning: { main: WARNING, contrastText: "#2a1d00" },
    info: { main: t.tertiary, contrastText: t.onTertiary },
    background: { default: t.background, paper: t.surfaceContainer },
    text: { primary: t.onSurface, secondary: t.onSurfaceVariant },
    divider: t.outlineVariant,
    md3: t,
  };
}

export function buildTheme(seed: string = SEED) {
  const { light, dark } = md3FromSeed(seed);
  // 圆角刻度（柔和阶梯，内小外大）：行/小控件 8 · 卡片/输入/面板 12 · 大面板(播放器/对话框) 20 · 胶囊 999 · 极小(kbd) 4。
  // 用「字符串 px」：在 styleOverrides 里是字面 CSS，在 sx 里也原样透传——绕开 MUI 对 sx 数字 borderRadius 会 ×shape.borderRadius 的放大。
  // ⚠️ sx 里禁用裸数字 borderRadius（会被 ×12）；统一写 (t) => t.radius.X。
  // 间距刻度（MUI ×8 基数）：0.5=4 / 1=8 / 1.5=12 / 2=16 / 3=24；勿用 0.25 / 0.75 / 1.2。
  const radius = { xs: "4px", sm: "8px", md: "12px", lg: "20px", full: "999px" };

  return createTheme({
    cssVariables: { colorSchemeSelector: "class" },
    defaultColorScheme: "dark",
    colorSchemes: {
      light: { palette: schemePalette(light) },
      dark: { palette: schemePalette(dark) },
    },
    radius,
    shape: { borderRadius: 12 },
    typography: {
      fontFamily:
        '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif',
      h1: { fontSize: "2.5rem", fontWeight: 700, letterSpacing: "-0.5px" },
      h2: { fontSize: "2rem", fontWeight: 700, letterSpacing: "-0.3px" },
      h3: { fontSize: "1.6rem", fontWeight: 700 },
      h4: { fontSize: "1.4rem", fontWeight: 700 },
      h5: { fontSize: "1.3rem", fontWeight: 700 },
      h6: { fontSize: "1.05rem", fontWeight: 700 },
      subtitle1: { fontWeight: 600 },
      button: { textTransform: "none", fontWeight: 600 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          "::-webkit-scrollbar": { width: 10, height: 10 },
          "::-webkit-scrollbar-thumb": {
            background: "rgba(140,150,170,.35)",
            borderRadius: 8,
            border: "2px solid transparent",
            backgroundClip: "padding-box",
          },
          "::-webkit-scrollbar-thumb:hover": { background: "rgba(140,150,170,.55)" },
        },
      },
      MuiPaper: {
        // 仅去掉 MUI 的 elevation 渐隐；不在此统一改圆角——
        // Card 由 MuiCard 定 12，Dialog 由各自 PaperProps 定 20，Menu/Popover 落在 shape(12)。
        styleOverrides: { root: { backgroundImage: "none" } },
      },
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: theme.radius.md,
            backgroundColor: (theme.vars ?? theme).palette.md3.surfaceContainer,
            border: `1px solid ${(theme.vars ?? theme).palette.md3.outlineVariant}`,
          }),
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: ({ theme }) => ({ borderRadius: theme.radius.full, paddingInline: 18, paddingBlock: 8 }),
        },
      },
      MuiChip: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: theme.radius.full,
            fontWeight: 600,
            backgroundColor: (theme.vars ?? theme).palette.md3.surfaceContainerHighest,
            color: (theme.vars ?? theme).palette.md3.onSurfaceVariant,
          }),
          // outlined：真正透明 + MD3 outlineVariant 描边（彩色 outlined 由各自 color 覆盖描边/文字）
          outlined: ({ theme }) => ({
            backgroundColor: "transparent",
            borderColor: (theme.vars ?? theme).palette.md3.outlineVariant,
          }),
          // 胶囊两端会吃掉横向空间，小 Chip 多给点 label 内边距，文字不贴边
          labelSmall: { paddingLeft: 11, paddingRight: 11 },
          // 图标别贴左缘、也别紧挨文字；缩小一点给 22px 高的小 Chip 留呼吸
          iconSmall: { marginLeft: 8, marginRight: -1, fontSize: 16 },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: ({ theme }) => ({
            backgroundColor: (theme.vars ?? theme).palette.md3.surfaceContainerLow,
            backgroundImage: "none",
            borderRight: `1px solid ${(theme.vars ?? theme).palette.md3.outlineVariant}`,
          }),
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0, color: "default" },
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: (theme.vars ?? theme).palette.md3.surface,
            backgroundImage: "none",
            borderBottom: `1px solid ${(theme.vars ?? theme).palette.md3.outlineVariant}`,
          }),
        },
      },
      MuiLinearProgress: {
        styleOverrides: {
          root: ({ theme }) => ({ borderRadius: theme.radius.full, height: 8 }),
          bar: ({ theme }) => ({ borderRadius: theme.radius.full }),
        },
      },
      MuiTooltip: {
        styleOverrides: { tooltip: ({ theme }) => ({ borderRadius: theme.radius.sm }) },
      },
      MuiOutlinedInput: {
        styleOverrides: { root: ({ theme }) => ({ borderRadius: theme.radius.md }) },
      },
    },
  });
}

export const theme = buildTheme();
