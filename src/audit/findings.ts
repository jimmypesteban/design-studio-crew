import type { Issue } from '../reviewer/checks.ts';
import { judge, type RawMeasure } from '../reviewer/checks.ts';
import { contrastRatio, parseHex, requiredRatio } from '../moon/contrast.ts';
import type { MoonTokens } from '../moon/tokens.ts';
import { nearestGrid, nearestRadius, nearestToken, nearestType } from './nearest.ts';
import { rgbOf } from '../moon/tokens.ts';

export type Category = 'quality' | 'qa' | 'moon' | 'visual';
/** 'universal' holds any page to the quality rules and reports Moon conformance. 'moon' also fails Moon rule breaks. */
export type Profile = 'universal' | 'moon';

export interface Finding {
  n: number;
  rule: string;
  category: Category;
  /** 1 fix first, 2 fix soon, 3 tidy up. */
  priority: 1 | 2 | 3;
  severity: 'fail' | 'warn';
  where: string;
  detail: string;
  fix: string;
  widths: number[];
  count: number;
  /** Selectors to draw a box around. */
  sels: string[];
  /** Plain note on where the finding came from, for example "measured" or "visual review". */
  source: 'measured' | 'visual';
  status?: 'new' | 'unchanged';
  waived?: { reason: string };
}

export interface Conformance {
  colour: number;
  type: number;
  radius: number;
  fonts: number;
  overall: number;
}

const RULES: Record<string, [Category, 1 | 2 | 3]> = {
  contrast: ['quality', 1],
  'horizontal-overflow': ['quality', 1],
  'content-clipped': ['quality', 1],
  'text-collision': ['quality', 1],
  'missing-label': ['quality', 1],
  'empty-control': ['quality', 1],
  'zoom-blocked': ['quality', 1],
  'missing-viewport': ['quality', 1],
  'missing-alt': ['quality', 2],
  'hit-target': ['quality', 2],
  'missing-lang': ['quality', 2],
  'text-too-small': ['quality', 2],
  'h1-count': ['quality', 3],
  'heading-skip': ['quality', 3],
  'generic-link-text': ['quality', 3],
  'body-font-small': ['quality', 3],
  'long-line': ['quality', 3],
  'missing-autocomplete': ['quality', 3],
  'contrast-unverified': ['quality', 3],
  'missing-title': ['qa', 2],
  'broken-image': ['qa', 1],
  'console-error': ['qa', 2],
  'failed-request': ['qa', 2],
  'audit-truncated': ['qa', 3],
  'off-palette': ['moon', 3],
  'off-scale-type': ['moon', 3],
  'off-brand-font': ['moon', 3],
  'off-scale-radius': ['moon', 3],
  'off-grid': ['moon', 3],
  'visual-hierarchy': ['visual', 3],
  'visual-spacing': ['visual', 3],
  'visual-contrast': ['visual', 2],
  'visual-other': ['visual', 3],
};
/** Plain fixes that make sense on any page. Moon specific wording is added only for the Moon profile. */
const GENERIC_FIX: Record<string, string> = {
  'horizontal-overflow': 'Remove fixed widths. Use max-width: 100%, wrapping flex or grid, and let content shrink on a phone.',
  'content-clipped': 'Let the box grow or wrap its content instead of hiding the overflow.',
  'text-collision': 'Give the elements room: stack them on narrow screens, or add spacing.',
  'missing-label': 'Give it a visible label tied to the field with for and id. Placeholder text is not a label.',
  'empty-control': 'Add visible text or an aria-label so assistive technology can name it.',
  'missing-alt': 'Add alt text that says what the image shows, or alt="" if it is decoration.',
  'hit-target': 'Make the tappable area at least 24 by 24px, and about 44px for main actions. Padding counts.',
  'missing-lang': 'Set lang on the html element, for example <html lang="en">.',
  'h1-count': 'Use exactly one h1 that names the page.',
};
const MOON_HINT: Record<string, string> = {
  'horizontal-overflow': ' In Moon: mo-grid or mo-row, and no fixed widths.',
  'hit-target': ' In Moon: a mo-btn of size sm or larger.',
  'missing-label': ' In Moon: the Input component with a label prop.',
};
const MOON_RULES = new Set(['off-palette', 'off-scale-type', 'off-brand-font', 'off-scale-radius', 'off-grid']);

export function ruleInfo(rule: string): [Category, 1 | 2 | 3] {
  return RULES[rule] ?? ['quality', 3];
}

/** Selectors a finding's `where` text names, so boxes can be drawn around them. */
export function selsFrom(where: string): string[] {
  return where
    .split(/;\s|\sand\s/)
    .map((w) => w.replace(/\s\("[^"]*"\)$/, '').trim())
    .filter((w) => /[a-z]/i.test(w));
}

export interface PageExtras {
  consoleErrors: string[];
  failedRequests: { url: string; status: string }[];
}

const GENERIC_LINK = /^(click here|here|read more|more|learn more|link|this|details|continue|go)$/i;

export function conformance(measure: RawMeasure, tokens: MoonTokens): Conformance {
  const pal = new Set(Object.values(tokens.colors).map((h) => h.toUpperCase()));
  const share = (entries: [string, number][], ok: (k: string) => boolean) => {
    const total = entries.reduce((a, [, c]) => a + c, 0);
    return total ? Math.round((entries.filter(([k]) => ok(k)).reduce((a, [, c]) => a + c, 0) / total) * 100) : 100;
  };
  const inv = measure.inventory;
  const colour = share(Object.entries(inv.colors), (k) => pal.has(k.toUpperCase()));
  const sizes = new Set(Object.values(tokens.fontSize).map((f) => Math.round(parseFloat(f.size) * 16 * 10) / 10));
  const type = share(Object.entries(inv.fontSizes), (k) => sizes.has(Math.round(Number(k) * 10) / 10));
  const radii = new Set(Object.values(tokens.radius).map((r) => (parseFloat(r) >= 1000 ? 'full' : String(parseFloat(r)))));
  const radius = share(Object.entries(inv.radii), (k) => radii.has(k));
  const fontNames = Object.keys(inv.fonts);
  const fonts = fontNames.length ? Math.round((fontNames.filter((f) => /^Source (Serif 4|Sans 3)$/.test(f)).length / fontNames.length) * 100) : 100;
  return { colour, type, radius, fonts, overall: Math.round((colour + type + radius + fonts) / 4) };
}

/** Turn what the browser measured into judged, prioritised findings with fixes. */
export function auditFindings(measures: RawMeasure[], tokens: MoonTokens, profile: Profile, extras: PageExtras): Finding[] {
  const out: Omit<Finding, 'n'>[] = [];
  const widest = measures[measures.length - 1]!;

  // 1. Everything the shared checks measure, except the Moon rules, which get their own treatment below.
  for (const i of judge(measures, tokens, 'audit')) {
    if (MOON_RULES.has(i.rule) || i.rule === 'contrast' || i.rule === 'text-too-small') continue;
    const [category, priority] = ruleInfo(i.rule);
    const f = fromIssue(i, category, priority, i.severity);
    if (GENERIC_FIX[i.rule]) f.fix = GENERIC_FIX[i.rule]! + (profile === 'moon' ? (MOON_HINT[i.rule] ?? '') : '');
    out.push(f);
  }

  // Contrast, with the nearest Moon text colour that actually passes on the measured background.
  const cSeen = new Map<string, Omit<Finding, 'n'>>();
  for (const m of measures) {
    for (const c of m.contrast) {
      if (c.ratio >= c.need) continue;
      const key = `${c.fg}|${c.bg}|${c.need}`;
      const hit = cSeen.get(key);
      if (hit) {
        hit.count += 1;
        if (!hit.widths.includes(m.vw)) hit.widths.push(m.vw);
        if (hit.sels.length < 6) hit.sels.push(c.sel);
        continue;
      }
      const near = nearestToken(tokens, c.fg, { bg: c.bg, need: c.need });
      const bgRgb = parseHex(c.bg);
      const best = ['mo-black', 'mo-white'].map((t) => ({ t, r: contrastRatio(rgbOf(tokens, t), bgRgb) })).sort((a, b) => b.r - a.r)[0]!;
      const fix = near.passes
        ? `Change the text to ${near.token} (${near.hex}), the closest Moon colour that passes on this background.`
        : `No Moon colour close to ${c.fg} reaches ${c.need}:1 on ${c.bg}. ${best.t} gives ${Math.round(best.r * 100) / 100}:1, so change the background or the text.`;
      const f: Omit<Finding, 'n'> = { rule: 'contrast', category: 'quality', priority: 1, severity: 'fail', where: `${c.sel} ("${c.sample}")`, detail: `${c.fg} on ${c.bg} measures ${c.ratio}:1 at ${c.px}px, needs ${c.need}:1.`, fix, widths: [m.vw], count: 1, sels: [c.sel], source: 'measured' };
      cSeen.set(key, f);
      out.push(f);
    }
  }
  // Small text is a quality rule on a real page, not only a brand rule.
  const small = new Map<string, { sel: string; px: number }>();
  const smallWidths = new Set<number>();
  for (const m of measures) for (const t of m.smallText) { small.set(t.sel, t); smallWidths.add(m.vw); }
  if (small.size) {
    const sizes = [...new Set([...small.values()].map((x) => x.px))].sort((a, b) => a - b);
    out.push({ rule: 'text-too-small', category: 'quality', priority: 2, severity: 'warn', where: [...small.keys()].slice(0, 3).join('; '), detail: `${small.size} piece${small.size === 1 ? '' : 's'} of text ${small.size === 1 ? 'is' : 'are'} under 12px (${sizes.join(', ')}px). That is hard to read for many people.`, fix: 'Make it at least 12px, and 14px or more for anything people need to read.', widths: [...smallWidths].sort((a, b) => a - b), count: small.size, sels: [...small.keys()].slice(0, 12), source: 'measured' });
  }

  // 2. Moon conformance, with the nearest Moon value for each thing that is off.
  const moonSev = profile === 'moon' ? 'fail' : 'warn';
  const seen = new Set<string>();
  const push = (key: string, f: Omit<Finding, 'n' | 'category' | 'priority' | 'severity' | 'source' | 'sels'> & { sel: string }) => {
    if (seen.has(key)) {
      const e = out.find((o) => (o as { _k?: string })._k === key);
      if (e) {
        e.count += 1;
        for (const w of f.widths) if (!e.widths.includes(w)) e.widths.push(w);
      }
      return;
    }
    seen.add(key);
    const [category, priority] = ruleInfo(f.rule);
    out.push({ ...f, category, priority: profile === 'moon' ? 2 : priority, severity: moonSev, source: 'measured', sels: [f.sel], _k: key } as never);
  };
  for (const m of measures) {
    for (const p of m.palette) {
      const bgRec = m.contrast.find((c) => c.sel === p.sel && c.fg.toUpperCase() === p.value.toUpperCase());
      const near = nearestToken(tokens, p.value, p.prop === 'color' && bgRec ? { bg: bgRec.bg, need: requiredRatio(bgRec.px, 400) } : undefined);
      const safe = near.passes === false ? ` None of the close Moon colours reaches the contrast this text needs on ${bgRec?.bg}, so change the surface too.` : '';
      push(`pal|${p.prop}|${p.value}`, {
        rule: 'off-palette', where: p.sel, widths: [m.vw], count: 1,
        detail: `${p.prop} ${p.value} is not a Moon colour. Closest is ${near.token} ${near.hex} (difference ${near.delta}).`,
        fix: `Use ${near.token} (${near.hex}).${safe}`,
        sel: p.sel,
      });
    }
    for (const p of m.type) {
      const n = nearestType(tokens, p.value);
      push(`type|${p.value}`, { rule: 'off-scale-type', where: p.sel, widths: [m.vw], count: 1, detail: `Font size ${p.value}px is not on the Moon type scale.`, fix: `Use ${n.names.join(' or ')} (${n.px}px).`, sel: p.sel });
    }
    for (const p of m.family) {
      push(`fam|${p.value}`, { rule: 'off-brand-font', where: p.sel, widths: [m.vw], count: 1, detail: `Font ${p.value} is not Source Serif 4 or Source Sans 3.`, fix: 'Use Source Serif 4 for headings and Source Sans 3 for body text.', sel: p.sel });
    }
    for (const p of m.radius) {
      const r = nearestRadius(tokens, p.value);
      push(`rad|${p.value}`, { rule: 'off-scale-radius', where: p.sel, widths: [m.vw], count: 1, detail: `Corner radius ${p.value}px is not on the Moon scale.`, fix: `Use ${r.token} (${r.px}px).`, sel: p.sel });
    }
    for (const p of m.grid) {
      const prop = p.prop.replace(/-(top|right|bottom|left)$/, '');
      push(`grid|${prop}|${p.value}`, { rule: 'off-grid', where: p.sel, widths: [m.vw], count: 1, detail: `${prop} of ${p.value}px is off the 4px grid.`, fix: `Use ${nearestGrid(p.value)}px.`, sel: p.sel });
    }
  }

  // 3. Page level facts
  const pg = widest.page;
  const add = (rule: string, severity: 'fail' | 'warn', where: string, detail: string, fix: string, sels: string[] = [], count = 1) => {
    const [category, priority] = ruleInfo(rule);
    out.push({ rule, category, priority, severity, where, detail, fix, widths: measures.map((m) => m.vw), count, sels, source: 'measured' });
  };
  if (pg) {
    if (!pg.viewportMeta) add('missing-viewport', 'fail', 'head', 'The page has no viewport meta tag, so phones show it zoomed out as a tiny desktop page.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
    else if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?(\s|,|$)/i.test(pg.viewportMeta)) add('zoom-blocked', 'fail', 'head', `The viewport tag blocks pinch zoom (${pg.viewportMeta}).`, 'Remove user-scalable=no and maximum-scale=1 so people can zoom.');
    if (!pg.title.trim()) add('missing-title', 'warn', 'head', 'The page has no title.', 'Add a short, specific <title>.');
    const h1s = pg.headings.filter((h) => h.level === 1).length;
    if (h1s === 0) add('h1-count', 'warn', 'page', 'There is no visible h1.', 'Add one h1 that names the page.');
    for (let i = 1; i < pg.headings.length; i++) {
      const prev = pg.headings[i - 1]!, cur = pg.headings[i]!;
      if (cur.level > prev.level + 1) add('heading-skip', 'warn', cur.sel, `A heading jumps from h${prev.level} to h${cur.level}.`, `Use h${prev.level + 1} here and use the size classes to style it.`, [cur.sel]);
    }
    const generic = pg.links.filter((l) => !l.text || GENERIC_LINK.test(l.text));
    if (generic.length) add('generic-link-text', 'warn', generic.slice(0, 3).map((l) => l.sel).join('; '), `${generic.length} link${generic.length === 1 ? '' : 's'} say things like "${generic[0]!.text || '(nothing)'}", which mean nothing out of context.`, 'Make the link text say where it goes.', generic.slice(0, 5).map((l) => l.sel), generic.length);
    for (const b of pg.brokenImages) add('broken-image', 'fail', b.sel, `An image did not load (${b.src}).`, 'Fix the image address or remove the image.', [b.sel]);
    if (pg.bodyFontPx && pg.bodyFontPx < 14) add('body-font-small', 'warn', 'body', `The base text size is ${pg.bodyFontPx}px.`, 'Use 16px (mo-body) as the base size.');
    for (const l of pg.longLines.slice(0, 5)) add('long-line', 'warn', l.sel, `Lines run about ${l.chars} characters, which is hard to follow. Aim for 45 to 90.`, 'Limit the text width, for example max-w-prose.', [l.sel]);
    if (pg.noAutocomplete.length) add('missing-autocomplete', 'warn', pg.noAutocomplete.slice(0, 3).map((f) => f.sel).join('; '), `${pg.noAutocomplete.length} personal detail field${pg.noAutocomplete.length === 1 ? ' has' : 's have'} no autocomplete attribute.`, 'Add autocomplete (email, name, new-password and so on) so browsers can fill them.', pg.noAutocomplete.slice(0, 5).map((f) => f.sel), pg.noAutocomplete.length);
  }
  if (widest.truncated) add('audit-truncated', 'warn', 'page', `The page has ${widest.truncated} elements. Only the first part was analysed.`, 'Audit a smaller page or a single screen for complete results.');
  for (const e of extras.consoleErrors.slice(0, 5)) add('console-error', 'warn', 'console', `Console error: ${e}`, 'Open the browser console and fix the error.');
  for (const r of extras.failedRequests.slice(0, 8)) add('failed-request', 'warn', r.url.slice(0, 80), `A request failed (${r.status}).`, 'Fix or remove the request.');

  const merged = collapse(out);
  const clean = merged.map((o) => {
    const { _k, ...rest } = o as typeof o & { _k?: string };
    void _k;
    return rest;
  });
  clean.sort((a, b) => a.priority - b.priority || (a.severity === b.severity ? 0 : a.severity === 'fail' ? -1 : 1) || a.rule.localeCompare(b.rule));
  return clean.map((f, i) => ({ ...f, n: i + 1 }));
}

function fromIssue(i: Issue, category: Category, priority: 1 | 2 | 3, severity: 'fail' | 'warn'): Omit<Finding, 'n'> {
  return { rule: i.rule, category, priority, severity, where: i.where, detail: i.detail, fix: i.fix, widths: i.widths, count: i.count, sels: selsFrom(i.where), source: 'measured' };
}


/** Many near identical findings are one finding with a list, so the report stays readable. */
function collapse(list: Omit<Finding, 'n'>[]): Omit<Finding, 'n'>[] {
  const groups: Record<string, string> = { 'off-grid': 'spacing values', 'off-scale-type': 'font sizes', 'off-scale-radius': 'corner radii', 'off-brand-font': 'fonts' };
  const out: Omit<Finding, 'n'>[] = [];
  const bucket = new Map<string, Omit<Finding, 'n'>[]>();
  for (const f of list) {
    if (groups[f.rule]) bucket.set(f.rule, [...(bucket.get(f.rule) ?? []), f]);
    else out.push(f);
  }
  for (const [rule, items] of bucket) {
    if (items.length === 1) {
      out.push(items[0]!);
      continue;
    }
    const first = items[0]!;
    const pairs = items.slice(0, 6).map((i) => `${i.detail.replace(/ (is|are) not.*$/, '').replace(/ is off the 4px grid\.?/, '')} -> ${i.fix.replace(/^Use /, '').replace(/\.$/, '')}`);
    out.push({
      ...first,
      detail: `${items.length} ${groups[rule]} are off the Moon ${rule === 'off-grid' ? '4px grid' : rule === 'off-brand-font' ? 'brand fonts' : 'scale'}. For example: ${pairs.join('; ')}.`,
      fix: `Replace each with its nearest Moon value, as listed. ${rule === 'off-grid' ? 'Round spacing to a multiple of 4px.' : ''}`.trim(),
      where: items.slice(0, 3).map((i) => i.where).join('; '),
      count: items.reduce((a, i) => a + i.count, 0),
      widths: [...new Set(items.flatMap((i) => i.widths))].sort((a, b) => a - b),
      sels: [...new Set(items.flatMap((i) => i.sels))].slice(0, 12),
    });
  }
  return out;
}
