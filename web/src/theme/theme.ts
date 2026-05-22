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
    radius: { xs: number; sm: number; md: number; lg: number; xl: number };
  }
  interface ThemeOptions {
    radius?: { xs: number; sm: number; md: number; lg: number; xl: number };
  }
}

function schemePalette(t: Md3Tokens) {
  return {
    primary: { main: t.primary, contrastText: t.onPrimary },
    secondary: { main: t.secondary, contrastText: t.onSecondary },
    error: { main: t.error, contrastText: t.onError },
    success: { main: SUCCESS, contrastText: "#06291b" },
    background: { default: t.background, paper: t.surfaceContainerLow },
    text: { primary: t.onSurface, secondary: t.onSurfaceVariant },
    divider: t.outlineVariant,
    md3: t,
  };
}

export function buildTheme(seed: string = SEED) {
  const { light, dark } = md3FromSeed(seed);
  const radius = { xs: 4, sm: 8, md: 12, lg: 16, xl: 28 };

  return createTheme({
    cssVariables: { colorSchemeSelector: "class" },
    defaultColorScheme: "dark",
    colorSchemes: {
      light: { palette: schemePalette(light) },
      dark: { palette: schemePalette(dark) },
    },
    radius,
    shape: { borderRadius: radius.md },
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
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundImage: "none",
            "&.MuiPaper-rounded": { borderRadius: theme.radius.lg },
          }),
        },
      },
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: theme.radius.lg,
            backgroundColor: (theme.vars ?? theme).palette.md3.surfaceContainerLow,
            border: `1px solid ${(theme.vars ?? theme).palette.md3.outlineVariant}`,
          }),
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 999, paddingInline: 18, paddingBlock: 8 },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: 999,
            fontWeight: 600,
            backgroundColor: (theme.vars ?? theme).palette.md3.surfaceContainerHighest,
            color: (theme.vars ?? theme).palette.md3.onSurfaceVariant,
          }),
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
          root: { borderRadius: 999, height: 8 },
          bar: { borderRadius: 999 },
        },
      },
      MuiTooltip: {
        styleOverrides: { tooltip: ({ theme }) => ({ borderRadius: theme.radius.sm }) },
      },
      MuiOutlinedInput: {
        styleOverrides: { root: ({ theme }) => ({ borderRadius: theme.radius.xl }) },
      },
    },
  });
}

export const theme = buildTheme();
