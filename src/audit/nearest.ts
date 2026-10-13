import { contrastRatio, parseHex, type RGB } from '../moon/contrast.ts';
import type { MoonTokens } from '../moon/tokens.ts';

/** CIE Lab, so "nearest colour" means nearest to the eye and not nearest in RGB numbers. */
export function toLab(rgb: RGB): [number, number, number] {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(rgb[0]), lin(rgb[1]), lin(rgb[2])];
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function deltaE(a: RGB, b: RGB): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

export interface Nearest {
  token: string;
  hex: string;
  delta: number;
  /** Set when a background was given: does this token reach the contrast the text needs on it. */
  passes?: boolean;
}

function uniqueTokens(t: MoonTokens): [string, string][] {
  const seen = new Map<string, string>();
  for (const n of Object.keys(t.colors).sort((a, b) => a.length - b.length)) if (!seen.has(t.colors[n]!)) seen.set(t.colors[n]!, n);
  return [...seen.entries()].map(([hex, name]) => [name, hex]);
}

/**
 * The Moon colour closest to `hex`. With `on` (the background) and `need` (the contrast
 * the text must reach), it prefers the closest token that also passes, because a
 * suggestion that fixes the palette and breaks readability is not a fix.
 */
export function nearestToken(t: MoonTokens, hex: string, on?: { bg: string; need: number }): Nearest {
  const target = parseHex(hex);
  const ranked = uniqueTokens(t)
    .map(([token, h]) => ({ token, hex: h, delta: Math.round(deltaE(target, parseHex(h)) * 10) / 10 }))
    .sort((a, b) => a.delta - b.delta);
  if (!on) return ranked[0]!;
  const bg = parseHex(on.bg);
  const withPass = ranked.map((r) => ({ ...r, passes: contrastRatio(parseHex(r.hex), bg) >= on.need }));
  return withPass.find((r) => r.passes) ?? withPass[0]!;
}

export function nearestType(t: MoonTokens, px: number): { names: string[]; px: number } {
  const sizes = new Map<number, string[]>();
  for (const [n, v] of Object.entries(t.fontSize)) {
    const p = Math.round(parseFloat(v.size) * 16 * 10) / 10;
    sizes.set(p, [...(sizes.get(p) ?? []), n]);
  }
  const best = [...sizes.keys()].sort((a, b) => Math.abs(a - px) - Math.abs(b - px))[0]!;
  return { names: sizes.get(best)!, px: best };
}

export function nearestRadius(t: MoonTokens, px: number): { token: string; px: number } {
  const all = Object.entries(t.radius).filter(([, v]) => parseFloat(v) < 1000).map(([k, v]) => ({ token: k, px: parseFloat(v) }));
  return all.sort((a, b) => Math.abs(a.px - px) - Math.abs(b.px - px))[0]!;
}

export const nearestGrid = (px: number) => Math.max(4, Math.round(px / 4) * 4);
