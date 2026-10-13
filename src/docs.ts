import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';
import { FONTS_DIR, fontFaceCss } from './moon/fonts.ts';
import { tokensCss, type MoonTokens } from './moon/tokens.ts';

/**
 * docs/index.html is docs/src/page.template with three things filled in from the source of truth:
 * the Moon tokens, the bundled font files (served from docs/fonts), and any token named in the
 * icon, so nothing on the page is typed in by hand twice.
 */
interface Pin {
  rule: string;
  detail: string;
  fix: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Hotspots {
  image: string;
  width: number;
  height: number;
  pins: Pin[];
}

const TITLES: Record<string, string> = {
  contrast: 'Text too faint to read',
  'heading-skip': 'Heading order jumps',
  'broken-image': 'An image does not load',
  'long-line': 'Lines far too long',
  'missing-label': 'A field with no label',
  'hit-target': 'A tap target that is too small',
  'horizontal-overflow': 'Content running off the edge',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Finding text can contain a local path from the machine that ran the audit. It must never reach a public page. */
export const scrubPaths = (s: string) => s.replace(/file:\/\/\/[^\s)]*\//g, '').replace(/\/(?:Users|home|private|var)\/[^\s)]*\//g, '');

/** Corner choices for each pin, keeping them apart on the smallest screen. */
export function placePins(pins: Pin[], refW = 320, refH = 281, minGap = 36): { p: Pin; x: number; y: number }[] {
  const placed: { p: Pin; x: number; y: number }[] = [];
  for (const p of pins) {
    const corners = [
      [p.x, p.y],
      [Math.min(98, p.x + p.w), p.y],
      [p.x, Math.min(98, p.y + p.h)],
      [Math.min(98, p.x + p.w), Math.min(98, p.y + p.h)],
    ] as const;
    const far = (x: number, y: number) => placed.every((q) => Math.hypot(((x - q.x) / 100) * refW, ((y - q.y) / 100) * refH) >= minGap);
    let spot: readonly [number, number] | undefined = corners.find(([cx, cy]) => far(cx, cy));
    // Crowded findings: slide the pin down its box edge in steps until it is clear.
    for (let k = 1; !spot && k <= 12; k++) {
      const dy = ((k * minGap) / refH) * 100;
      spot = corners.map(([cx, cy]) => [cx, Math.min(98, cy + dy)] as const).find(([cx, cy]) => far(cx, cy));
    }
    const [x, y] = spot ?? corners[0];
    placed.push({ p, x, y });
  }
  return placed;
}

export function hotspotHtml(h: Hotspots) {
  const pins = h.pins;
  return {
    boxes: pins.map((p) => `<span class="box" style="left:${p.x}%;top:${p.y}%;width:${p.w}%;height:${p.h}%" aria-hidden="true"></span>`).join('\n            '),
    // Each pin sits on a corner of its box. At the smallest screen (a laptop image about 320px wide) the first corner
    // that keeps it at least 36px from every earlier pin wins, so pins never overlap.
    pins: placePins(pins)
      .map(({ p, x, y }, i) => `<button type="button" class="pin" style="left:${x}%;top:${y}%" aria-label="Finding ${i + 1}: ${esc(TITLES[p.rule] ?? p.rule)}">${i + 1}</button>`)
      .join('\n            '),
    list: pins
      .map(
        (p, i) =>
          `<li class="card find"><span class="rule">Finding ${i + 1} of ${pins.length}</span><h3 class="h3">${esc(TITLES[p.rule] ?? p.rule)}</h3><p>${esc(scrubPaths(p.detail))}</p><p class="small"><b>The fix:</b> ${esc(scrubPaths(p.fix))}</p></li>`,
      )
      .join('\n        '),
  };
}

export function renderDocs(tokens: MoonTokens): string {
  const src = fs.readFileSync(path.join(ROOT, 'docs', 'src', 'page.template'), 'utf8');
  for (const marker of ['/*MOON_TOKENS*/', '/*MOON_FONTS*/']) {
    if (!src.includes(marker)) throw new Error(`docs/src/page.template has no ${marker} placeholder.`);
  }
  const hot = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'src', 'hotspots.json'), 'utf8')) as Hotspots;
  const parts = hotspotHtml(hot);
  return src
    .replace('/*HOT_IMAGE*/', hot.image)
    .replace('/*HOT_BOXES*/', parts.boxes)
    .replace('/*HOT_PINS*/', parts.pins)
    .replace('/*HOT_LIST*/', parts.list)
    .replace('/*MOON_FONTS*/', fontFaceCss({ embed: false, baseUrl: 'fonts' }))
    .replace('/*MOON_TOKENS*/', tokensCss(tokens).trim())
    .replace(/%7B%7B(mo-[a-z0-9-]+)%7D%7D/g, (_m, name: string) => {
      const hex = tokens.colors[name];
      if (!hex) throw new Error(`Unknown Moon token in docs source: ${name}`);
      return '%23' + hex.slice(1);
    });
}

export function copyDocFonts(): void {
  const out = path.join(ROOT, 'docs', 'fonts');
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(FONTS_DIR).filter((x) => x.endsWith('.woff2') || x.startsWith('LICENSE'))) {
    fs.copyFileSync(path.join(FONTS_DIR, f), path.join(out, f));
  }
}
