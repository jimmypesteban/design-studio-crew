import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser } from 'puppeteer-core';
import { SIZE_BY_ID } from '../brand/sizes.ts';
import { assetCss } from '../moon/assetcss.ts';
import { allowedClasses, recipesCss } from '../moon/recipes.ts';
import { contrastTable, paletteRgbSet, type MoonTokens } from '../moon/tokens.ts';
import { judge, type Issue, type JudgeMode, type RawMeasure } from './checks.ts';

export const SWEEP_WIDTHS = [375, 768, 1024];

export interface ReviewReport {
  pass: boolean;
  mode: 'screen' | 'react';
  checkedAt: string;
  htmlFile: string;
  widths: number[];
  fontsLoaded: boolean;
  elementsChecked: number;
  textChecked: number;
  issues: Issue[];
  fails: number;
  warns: number;
  screenshots: string[];
  rulesRun: string[];
  /** Colours, type sizes and radii actually used, from the widest page. */
  inventory: RawMeasure['inventory'];
  /** Grid column counts at each width. */
  grids: { sel: string; cols: number; width: number }[];
}

export const RULES_RUN = [
  'contrast (WCAG AA, measured on rendered text)',
  'width sweep at 375, 768 and 1024',
  'no horizontal overflow or cut-off content',
  'text does not land on text',
  'tap targets at least 24px',
  'colours only from Moon tokens',
  'type sizes and fonts only from Moon',
  'corner radius only from the Moon scale',
  'spacing on the 4px grid',
  'only Moon component classes',
  'alt text, field labels, control names, page language',
];

export const ASSET_RULES_RUN = [
  'contrast (WCAG AA, measured on the rendered text over its panel)',
  'exact pixel size of the finished image',
  'nothing runs past any edge, nothing is cut off',
  'text stays inside the platform safe zone',
  'text does not land on text',
  'text is at least 2 percent of the short side, so it reads at feed size',
  'colours only from Moon tokens',
  'type sizes and fonts only from Moon',
  'only Moon asset classes',
  'artwork stays near the Moon palette (a note, not a block)',
];

export const analyzerSource = fs.readFileSync(new URL('./analyze.browser.js', import.meta.url), 'utf8');

export function baseParams(tokens: MoonTokens) {
  return {
    palette: [...paletteRgbSet(tokens)],
    typePx: [...new Set(Object.values(tokens.fontSize).map((f) => Math.round(parseFloat(f.size) * 160) / 10))],
    radii: Object.values(tokens.radius).map((r) => parseFloat(r)).filter((n) => n < 1000),
  };
}

export async function launch(chromePath: string): Promise<Browser> {
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Chrome not found at ${chromePath}. Set CHROME_PATH to your Chrome executable.`);
  }
  return puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
  });
}

async function measure(
  browser: Browser,
  htmlFile: string,
  width: number,
  height: number,
  params: object,
): Promise<{ raw: RawMeasure; fontsLoaded: boolean; shot: (file: string, full: boolean) => Promise<void>; close: () => Promise<void> }> {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  try {
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load', timeout: 12000 });
  } catch {
    // Fonts can be slow or offline. The check still runs on fallback fonts and says so.
  }
  const fontsLoaded = await page
    .evaluate(
      `Promise.race([document.fonts.ready.then(() => document.fonts.check('16px "Source Sans 3"')), new Promise((r) => setTimeout(() => r(false), 2500))])`,
    )
    .then(Boolean)
    .catch(() => false);
  const raw = (await page.evaluate(`(${analyzerSource})(${JSON.stringify(params)})`)) as RawMeasure;
  return {
    raw,
    fontsLoaded,
    shot: async (file, full) => {
      if (full) await page.screenshot({ path: file, fullPage: true });
      else await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height } });
    },
    close: () => page.close(),
  };
}

export interface ReviewOptions {
  htmlFile: string;
  tokens: MoonTokens;
  chromePath: string;
  shotsDir: string;
  widths?: number[];
  /** 'react' reviews Moon's own React components, so the class vocabulary check is off. */
  mode?: 'screen' | 'react';
}

export async function reviewScreen(opts: ReviewOptions): Promise<ReviewReport> {
  const widths = opts.widths ?? SWEEP_WIDTHS;
  const mode = opts.mode ?? 'screen';
  fs.mkdirSync(opts.shotsDir, { recursive: true });
  const params = {
    ...baseParams(opts.tokens),
    mode,
    allowedClasses: mode === 'screen' ? allowedClasses(recipesCss(opts.tokens)) : null,
  };

  const browser = await launch(opts.chromePath);
  const measures: RawMeasure[] = [];
  const shots: string[] = [];
  let fontsLoaded = false;
  try {
    for (const width of widths) {
      const m = await measure(browser, opts.htmlFile, width, 900, params);
      measures.push(m.raw);
      fontsLoaded = m.fontsLoaded;
      const shot = path.join(opts.shotsDir, `width-${width}.png`);
      await m.shot(shot, true);
      shots.push(shot);
      await m.close();
    }
  } finally {
    await browser.close();
  }

  const issues = judge(measures, opts.tokens, mode);
  const fails = issues.filter((i) => i.severity === 'fail').length;
  const widest = measures[measures.length - 1]!;
  return {
    pass: fails === 0,
    mode,
    checkedAt: new Date().toISOString(),
    htmlFile: opts.htmlFile,
    widths,
    fontsLoaded,
    elementsChecked: Math.max(...measures.map((m) => m.elements)),
    textChecked: Math.max(...measures.map((m) => m.textElements)),
    issues,
    fails,
    warns: issues.length - fails,
    screenshots: shots,
    rulesRun: RULES_RUN,
    inventory: widest.inventory,
    grids: measures.flatMap((m) => m.grids.map((g) => ({ ...g, width: m.vw }))),
  };
}

// ---------- Brand assets: one fixed size per page ----------

export interface AssetItem {
  id: string;
  sizeId: string;
  htmlFile: string;
  pngFile: string;
}

export interface AssetReview {
  id: string;
  sizeId: string;
  pass: boolean;
  issues: Issue[];
  pngFile: string;
  width: number;
  height: number;
  /** Pixel size actually written to the PNG. */
  actual: { width: number; height: number };
}

export function pngSize(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG.`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Render every asset at its exact size, write the PNG, and hold it to the standard. */
export async function reviewAssets(opts: { items: AssetItem[]; tokens: MoonTokens; chromePath: string }): Promise<AssetReview[]> {
  const params = {
    ...baseParams(opts.tokens),
    mode: 'asset',
    allowedClasses: [...allowedClasses(recipesCss(opts.tokens)), ...allowedClasses(assetCss(opts.tokens))],
  };
  const browser = await launch(opts.chromePath);
  const out: AssetReview[] = [];
  try {
    for (const item of opts.items) {
      const size = SIZE_BY_ID.get(item.sizeId);
      if (!size) throw new Error(`Unknown size ${item.sizeId}.`);
      const m = await measure(browser, item.htmlFile, size.width, size.height, { ...params, safe: size.safe });
      fs.mkdirSync(path.dirname(item.pngFile), { recursive: true });
      await m.shot(item.pngFile, false);
      await m.close();
      const issues = judge([m.raw], opts.tokens, 'asset');
      const actual = pngSize(item.pngFile);
      if (actual.width !== size.width || actual.height !== size.height) {
        issues.unshift({
          rule: 'wrong-size',
          severity: 'fail',
          widths: [size.width],
          where: item.id,
          detail: `The image is ${actual.width} by ${actual.height} but ${size.label} must be ${size.width} by ${size.height}.`,
          fix: 'Render the asset at its exact size.',
          count: 1,
        });
      }
      if (!m.fontsLoaded) {
        issues.push({
          rule: 'fonts-not-loaded',
          severity: 'fail',
          widths: [size.width],
          where: item.id,
          detail: 'The bundled brand fonts did not load, so this image used fallback fonts.',
          fix: 'Check that assets/fonts has both font files, then render again. Do not ship this image.',
          count: 1,
        });
      }
      out.push({
        id: item.id,
        sizeId: item.sizeId,
        pass: !issues.some((i) => i.severity === 'fail'),
        issues,
        pngFile: item.pngFile,
        width: size.width,
        height: size.height,
        actual,
      });
    }
  } finally {
    await browser.close();
  }
  return out;
}

/** Render any local HTML file to a full-page PNG. Used for contact sheets. */
/** `exactWidth` crops to the viewport width, as a phone screenshot would be, instead of the page's full scroll width. */
export async function screenshotHtml(opts: { htmlFile: string; pngFile: string; chromePath: string; width: number; exactWidth?: boolean }): Promise<void> {
  const browser = await launch(opts.chromePath);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: 800, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(opts.htmlFile).href, { waitUntil: 'load', timeout: 15000 });
    fs.mkdirSync(path.dirname(opts.pngFile), { recursive: true });
    if (opts.exactWidth) {
      const height = Math.min(8000, Number(await page.evaluate('document.documentElement.scrollHeight')));
      await page.screenshot({ path: opts.pngFile, clip: { x: 0, y: 0, width: opts.width, height }, captureBeyondViewport: true });
    } else await page.screenshot({ path: opts.pngFile, fullPage: true });
  } finally {
    await browser.close();
  }
}

/** Plain-language report for the job folder and for Telegram. */
export function reportMarkdown(r: ReviewReport): string {
  const lines: string[] = [];
  lines.push(`# Reviewer report`);
  lines.push('');
  lines.push(`Result: ${r.pass ? 'PASS' : 'REJECTED'} (${r.fails} to fix, ${r.warns} to note)`);
  lines.push(`Checked ${r.elementsChecked} elements and ${r.textChecked} text items at ${r.widths.join(', ')} px.`);
  lines.push(`Brand fonts ${r.fontsLoaded ? 'loaded' : 'did not load, so widths were measured on fallback fonts'}.`);
  lines.push('');
  if (!r.issues.length) lines.push('No problems found.');
  for (const i of r.issues) {
    lines.push(`## ${i.severity === 'fail' ? 'Fix' : 'Note'}: ${i.rule}`);
    lines.push(`- Where: ${i.where}`);
    lines.push(`- Problem: ${i.detail}`);
    lines.push(`- Fix: ${i.fix}`);
    lines.push(`- Seen at: ${i.widths.sort((a, b) => a - b).join(', ')} px`);
    lines.push('');
  }
  lines.push('## Checks that ran');
  for (const rule of r.rulesRun) lines.push(`- ${rule}`);
  return lines.join('\n') + '\n';
}

export function assetReportMarkdown(reviews: AssetReview[]): string {
  const fails = reviews.filter((r) => !r.pass).length;
  const lines = ['# Reviewer report for brand assets', '', `Result: ${fails === 0 ? 'PASS' : 'REJECTED'}. ${reviews.length - fails} of ${reviews.length} assets pass.`, ''];
  for (const r of reviews) {
    lines.push(`## ${r.id}: ${r.pass ? 'pass' : 'rejected'} (${r.actual.width} by ${r.actual.height})`);
    if (!r.issues.length) lines.push('No problems found.');
    for (const i of r.issues) {
      lines.push(`- ${i.severity === 'fail' ? 'Fix' : 'Note'} ${i.rule}: ${i.detail} Where: ${i.where}. Fix: ${i.fix}`);
    }
    lines.push('');
  }
  lines.push('## Checks that ran');
  for (const rule of ASSET_RULES_RUN) lines.push(`- ${rule}`);
  return lines.join('\n') + '\n';
}

export function contrastTableMarkdown(t: MoonTokens): string {
  const rows = contrastTable(t);
  const bgs = [...new Set(rows.map((r) => r.bg))];
  const out = ['# Contrast table from Moon tokens', '', 'Only pairs that pass 4.5:1 (normal text) are listed as safe.', ''];
  for (const bg of bgs) {
    const ok = rows.filter((r) => r.bg === bg && r.normalText).map((r) => `${r.fg} (${r.ratio})`);
    out.push(`- On ${bg}: ${ok.length ? ok.join(', ') : 'nothing passes'}`);
  }
  return out.join('\n') + '\n';
}
