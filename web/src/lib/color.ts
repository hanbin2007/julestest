import { buildTheme } from "@/theme/theme";
import type { Theme } from "@mui/material/styles";

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** 由任意字符串稳定地哈希出一个悦目的种子色（每门课不同的强调色）。 */
export function hashSeed(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hslToHex(hue, 0.62, 0.6);
}

const themeCache = new Map<string, Theme>();
export function themeForSeed(seed: string): Theme {
  let t = themeCache.get(seed);
  if (!t) {
    t = buildTheme(seed);
    themeCache.set(seed, t);
  }
  return t;
}
