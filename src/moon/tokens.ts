import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { contrastRatio, parseHex, type RGB } from './contrast.ts';

/** The shape of Moon's tokens.mjs exports that the studio relies on. */
interface RawTokens {
  colors: Record<string, string | Record<string, string>>;
  fontFamily: Record<string, string[]>;
  fontSize: Record<string, [string, { lineHeight: string }]>;
  spacing: Record<string, string>;
  borderRadius: Record<string, string>;
  boxShadow: Record<string, string>;
  breakpoints: Record<string, string>;
  container: { margin: Record<string, string>; maxWidth: Record<string, string> };
}

export interface MoonTokens {
  source: string;
  colors: Record<string, string>; // 'mo-red-6' -> '#B82431'
  fontFamily: Record<string, string[]>;
  fontSize: Record<string, { size: string; lineHeight: string }>;
  spacing: Record<string, string>;
  radius: Record<string, string>;
  shadow: Record<string, string>;
  breakpoints: Record<string, string>;
  container: RawTokens['container'];
}

const cache = new Map<string, MoonTokens>();

/**
 * Read the real tokens from the Moon repo. Nothing is copied into this project,
 * so the studio can never drift from the system it is meant to enforce.
 */
export async function loadMoonTokens(moonPath: string): Promise<MoonTokens> {
  const hit = cache.get(moonPath);
  if (hit) return hit;
  const file = path.join(moonPath, 'tokens.mjs');
  if (!fs.existsSync(file)) {
    throw new Error(
      `Cannot find Moon tokens at ${file}. Set MOON_PATH to the moon-design-system folder.`,
    );
  }
  const raw = (await import(pathToFileURL(file).href)) as RawTokens;

  const colors: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw.colors)) {
    if (typeof value === 'string') colors[name] = value.toUpperCase();
    else
      for (const [step, hex] of Object.entries(value)) {
        colors[step === 'DEFAULT' ? name : `${name}-${step}`] = hex.toUpperCase();
      }
  }

  const fontSize: MoonTokens['fontSize'] = {};
  for (const [name, [size, meta]] of Object.entries(raw.fontSize)) {
    fontSize[name] = { size, lineHeight: meta.lineHeight };
  }

  const tokens: MoonTokens = {
    source: file,
    colors,
    fontFamily: raw.fontFamily,
    fontSize,
    spacing: raw.spacing,
    radius: raw.borderRadius,
    shadow: raw.boxShadow,
    breakpoints: raw.breakpoints,
    container: raw.container,
  };
  cache.set(moonPath, tokens);
  return tokens;
}

/** CSS custom properties for every token. Names drop the mo- prefix inside --mo-*. */
export function tokensCss(t: MoonTokens): string {
  const lines: string[] = [];
  for (const [name, hex] of Object.entries(t.colors)) lines.push(`  --${name}: ${hex};`);
  lines.push(`  --font-heading: ${t.fontFamily.heading?.join(', ')};`);
  lines.push(`  --font-body: ${t.fontFamily.body?.join(', ')};`);
  for (const [name, v] of Object.entries(t.fontSize)) {
    lines.push(`  --${name}-size: ${v.size};`);
    lines.push(`  --${name}-lh: ${v.lineHeight};`);
  }
  for (const [name, v] of Object.entries(t.spacing)) lines.push(`  --${name}: ${v};`);
  for (const [name, v] of Object.entries(t.radius)) lines.push(`  --radius-${name}: ${v};`);
  for (const [name, v] of Object.entries(t.shadow)) lines.push(`  --shadow-${name}: ${v};`);
  return `:root {\n${lines.join('\n')}\n}\n`;
}

export function rgbOf(t: MoonTokens, name: string): RGB {
  const hex = t.colors[name];
  if (!hex) throw new Error(`Unknown Moon colour token: ${name}`);
  return parseHex(hex);
}

/** Every distinct RGB value in the palette, for the off-palette check. */
export function paletteRgbSet(t: MoonTokens): Set<string> {
  return new Set(Object.values(t.colors).map((h) => parseHex(h).join(',')));
}

export interface ContrastPair {
  fg: string;
  bg: string;
  ratio: number;
  normalText: boolean; // 4.5 or better
  largeText: boolean; // 3 or better
}

const TEXT_CANDIDATES = [
  'mo-black', 'mo-white', 'mo-grey-1', 'mo-grey-7', 'mo-grey-8', 'mo-grey-9', 'mo-grey-5',
  'mo-red', 'mo-red-7', 'mo-red-8', 'mo-blue', 'mo-blue-8', 'mo-green-8', 'mo-forest', 'mo-purple',
  'mo-ocean', 'mo-orange-8', 'mo-yellow-8',
];
const SURFACES = ['mo-grey-1', 'mo-grey-2', 'mo-grey-3', 'mo-black', 'mo-red', 'mo-yellow', 'mo-forest', 'mo-ocean', 'mo-purple', 'mo-blue', 'mo-red-1'];

/** The lookup the UI agent and the Reviewer both use, computed from the real tokens. */
export function contrastTable(t: MoonTokens): ContrastPair[] {
  const out: ContrastPair[] = [];
  for (const bg of SURFACES) {
    for (const fg of TEXT_CANDIDATES) {
      if (fg === bg) continue;
      const ratio = contrastRatio(rgbOf(t, fg), rgbOf(t, bg));
      out.push({ fg, bg, ratio: Math.round(ratio * 100) / 100, normalText: ratio >= 4.5, largeText: ratio >= 3 });
    }
  }
  return out;
}

/** Text tokens that pass 4.5:1 on a given surface, best first. Accepts a token name or a hex value. */
export function safeTextOn(t: MoonTokens, bg: string): string[] {
  const bgRgb = bg.startsWith('#') ? parseHex(bg) : rgbOf(t, bg);
  return TEXT_CANDIDATES.map((fg) => ({ fg, ratio: contrastRatio(rgbOf(t, fg), bgRgb) }))
    .filter((p) => p.ratio >= 4.5)
    .sort((a, b) => b.ratio - a.ratio)
    .map((p) => p.fg);
}
