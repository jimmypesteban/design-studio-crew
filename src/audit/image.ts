import fs from 'node:fs';
import type { MoonTokens } from '../moon/tokens.ts';
import { launch } from '../reviewer/index.ts';
import type { Finding, Profile } from './findings.ts';
import { nearestToken } from './nearest.ts';

export interface ImageColour {
  hex: string;
  share: number;
  nearest: string;
  nearestHex: string;
  delta: number;
}

export interface ImageAudit {
  width: number;
  height: number;
  bytes: number;
  colours: ImageColour[];
  /** Share of pixels within a small distance of some Moon colour, 0 to 100. */
  paletteCloseness: number;
  /** A downscaled JPEG for a vision review. Never written to the log. */
  preview: { mime: 'image/jpeg'; data: string } | null;
}

/** A pixel this close to a Moon colour reads as that colour to the eye. */
export const NEAR_DELTA = 12;

const SCRIPT = `(async (src) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const scale = Math.min(1, 256 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const bins = new Map();
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const key = (d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3);
    const b = bins.get(key) || { c: 0, r: 0, g: 0, b: 0 };
    b.c++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2];
    bins.set(key, b); n++;
  }
  const top = [...bins.values()].sort((a, b) => b.c - a.c).slice(0, 40).map((b) => ({ r: Math.round(b.r / b.c), g: Math.round(b.g / b.c), b: Math.round(b.b / b.c), share: b.c / n }));
  const vs = Math.min(1, 1568 / Math.max(W, H));
  const v = document.createElement('canvas'); v.width = Math.round(W * vs); v.height = Math.round(H * vs);
  const vg = v.getContext('2d'); vg.fillStyle = '#fff'; vg.fillRect(0, 0, v.width, v.height); vg.drawImage(img, 0, 0, v.width, v.height);
  return { W, H, top, preview: v.toDataURL('image/jpeg', 0.85).split(',')[1] };
})`;

const toHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

export async function auditImage(opts: { file: string; tokens: MoonTokens; chromePath: string }): Promise<ImageAudit> {
  const buf = fs.readFileSync(opts.file);
  const mime = buf.subarray(1, 4).toString('ascii') === 'PNG' ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : 'image/webp';
  const browser = await launch(opts.chromePath);
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    const res = (await page.evaluate(`${SCRIPT}(${JSON.stringify(`data:${mime};base64,${buf.toString('base64')}`)})`)) as {
      W: number;
      H: number;
      top: { r: number; g: number; b: number; share: number }[];
      preview: string;
    };
    const colours: ImageColour[] = [];
    for (const t of res.top) {
      const hex = toHex(t.r, t.g, t.b);
      const near = nearestToken(opts.tokens, hex);
      const existing = colours.find((c) => c.nearest === near.token && Math.abs(c.delta - near.delta) < 6);
      if (existing) existing.share += t.share;
      else colours.push({ hex, share: t.share, nearest: near.token, nearestHex: near.hex, delta: near.delta });
    }
    colours.sort((a, b) => b.share - a.share);
    const closeness = colours.filter((c) => c.delta <= NEAR_DELTA).reduce((a, c) => a + c.share, 0);
    return {
      width: res.W,
      height: res.H,
      bytes: buf.length,
      colours: colours.slice(0, 12).map((c) => ({ ...c, share: Math.round(c.share * 1000) / 10 })),
      paletteCloseness: Math.round(Math.min(1, closeness) * 100),
      preview: { mime: 'image/jpeg', data: res.preview },
    };
  } finally {
    await browser.close();
  }
}

/** What can honestly be said from pixels alone. Everything else is listed as not checked. */
export function imageFindings(a: ImageAudit, tokens: MoonTokens, profile: Profile): Omit<Finding, 'n'>[] {
  void tokens;
  const sev = profile === 'moon' ? 'fail' : 'warn';
  return a.colours
    .filter((c) => c.share >= 3 && c.delta > NEAR_DELTA)
    .map((c) => ({
      rule: 'off-palette',
      category: 'moon' as const,
      priority: (profile === 'moon' ? 2 : 3) as 2 | 3,
      severity: sev as 'fail' | 'warn',
      where: `${c.share}% of the pixels`,
      detail: `About ${c.share}% of the picture is ${c.hex}, which is not a Moon colour. Closest is ${c.nearest} ${c.nearestHex} (difference ${c.delta}).`,
      fix: `Use ${c.nearest} (${c.nearestHex}) for that area.`,
      widths: [a.width],
      count: 1,
      sels: [],
      source: 'measured' as const,
    }));
}

export const NOT_CHECKED_FROM_PIXELS = [
  'Contrast ratios of text',
  'Overflow, clipping and text collisions',
  'Tap target sizes',
  'Labels, alt text and structure',
  'Spacing, type scale and corner radius',
];

export function deviceGuess(w: number, h: number): string {
  const short = Math.min(w, h);
  for (const scale of [1, 2, 3]) {
    const css = short / scale;
    if (css >= 320 && css <= 440) return `a phone capture, about ${Math.round(css)} CSS px wide at ${scale}x`;
    if (css >= 700 && css <= 840) return `a tablet capture, about ${Math.round(css)} CSS px wide at ${scale}x`;
  }
  return `${w} by ${h} px`;
}

