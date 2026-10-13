import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';

/**
 * The two Moon brand fonts, bundled in assets/fonts so every screen, asset and audit renders with
 * the real fonts and no network. Family names match Moon's token font stacks exactly.
 */
const FILES = [
  { family: 'Source Sans 3', file: 'source-sans-3-latin-wght-normal.woff2' },
  { family: 'Source Serif 4', file: 'source-serif-4-latin-wght-normal.woff2' },
];

export const FONTS_DIR = path.join(ROOT, 'assets', 'fonts');
const cache = new Map<string, string>();

function dataUrl(file: string): string {
  const hit = cache.get(file);
  if (hit) return hit;
  const p = path.join(FONTS_DIR, file);
  if (!fs.existsSync(p)) throw new Error(`Font file missing: ${p}. See assets/fonts/README.md.`);
  const url = `data:font/woff2;base64,${fs.readFileSync(p).toString('base64')}`;
  cache.set(file, url);
  return url;
}

/**
 * @font-face rules. `embed` puts the fonts inside the CSS as data, so a saved page is one
 * self-contained file. Otherwise `baseUrl` is where the font files will be served from.
 */
export function fontFaceCss(opts: { embed: true } | { embed: false; baseUrl: string } = { embed: true }): string {
  return FONTS.map(({ family, file }) => {
    const src = opts.embed ? dataUrl(file) : `${opts.baseUrl.replace(/\/$/, '')}/${file}`;
    return `@font-face{font-family:"${family}";font-style:normal;font-weight:200 900;font-display:block;src:url(${src}) format("woff2")}`;
  }).join('\n');
}
const FONTS = FILES;
