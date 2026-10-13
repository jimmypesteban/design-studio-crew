import { safeTextOn, type MoonTokens } from '../moon/tokens.ts';

export type Severity = 'fail' | 'warn';

export interface Issue {
  rule: string;
  severity: Severity;
  widths: number[];
  where: string;
  detail: string;
  fix: string;
  count: number;
}

/** What analyze.browser.js returns for one viewport width. */
export interface RawMeasure {
  vw: number;
  docScrollWidth: number;
  elements: number;
  textElements: number;
  overflow: { sel: string; right: number; over: number; width: number }[];
  clipped: { sel: string; scroll: number; client: number }[];
  textOverflow: { sel: string; scroll: number; client: number }[];
  hit: { sel: string; w: number; h: number }[];
  collisions: { a: string; b: string; area: number }[];
  contrast: { sel: string; sample: string; fg: string; bg: string; ratio: number; need: number; px: number }[];
  unverified: { sel: string; reason: string }[];
  palette: { sel: string; prop: string; value: string }[];
  type: { sel: string; value: number }[];
  family: { sel: string; value: string }[];
  radius: { sel: string; value: number }[];
  grid: { sel: string; prop: string; value: number }[];
  classes: { sel: string; cls: string }[];
  a11y: { rule: string; sel: string }[];
  vh: number;
  overflowY: { sel: string; over: number; edge: string }[];
  vOverflow: { sel: string; scroll: number; client: number }[];
  unsafe: { sel: string; x: number; y: number }[];
  tooSmall: { sel: string; px: number; min: number }[];
  images: { sel: string; drift: number; w: number; h: number }[];
  grids: { sel: string; cols: number }[];
  inventory: { colors: Record<string, number>; fontSizes: Record<string, number>; radii: Record<string, number>; fonts: Record<string, number> };
  /** Page position of each element the analyzer described, keyed by its selector text. Audit mode only. */
  rects: Record<string, [number, number, number, number]>;
  smallText: { sel: string; px: number }[];
  /** How many elements the page had when it was over the cap. 0 means all were analysed. */
  truncated: number;
  page: {
    title: string;
    lang: string;
    viewportMeta: string | null;
    bodyFontPx: number;
    headings: { level: number; text: string; sel: string }[];
    links: { text: string; sel: string }[];
    brokenImages: { sel: string; src: string }[];
    longLines: { sel: string; chars: number }[];
    noAutocomplete: { sel: string; type: string }[];
  } | null;
}

export type JudgeMode = 'screen' | 'react' | 'asset' | 'audit';

/** Palette drift above this (average RGB distance to the nearest Moon colour) earns a note. */
export const DRIFT_NOTE = 80;

function tokenNameByHex(t: MoonTokens): Map<string, string> {
  const m = new Map<string, string>();
  const names = Object.keys(t.colors).sort((a, b) => a.length - b.length);
  for (const n of names) {
    const hex = t.colors[n]!;
    if (!m.has(hex)) m.set(hex, n);
  }
  return m;
}

/** Turn raw page measurements into judged, de-duplicated issues with fixes. */
export function judge(measures: RawMeasure[], t: MoonTokens, mode: JudgeMode = 'screen'): Issue[] {
  const names = tokenNameByHex(t);
  const issues = new Map<string, Issue>();
  const typeSizes = [...new Set(Object.values(t.fontSize).map((f) => `${parseFloat(f.size) * 16}px`))].join(', ');

  const add = (
    key: string,
    base: Omit<Issue, 'widths' | 'count'>,
    width: number,
  ) => {
    const hit = issues.get(key);
    if (hit) {
      hit.count += 1;
      if (!hit.widths.includes(width)) hit.widths.push(width);
    } else {
      issues.set(key, { ...base, widths: [width], count: 1 });
    }
  };

  for (const m of measures) {
    const w = m.vw;

    for (const c of m.contrast) {
      if (c.ratio >= c.need) continue;
      const fgName = names.get(c.fg);
      const bgName = names.get(c.bg);
      const safe = bgName ? safeTextOn(t, c.bg).slice(0, 3).join(', ') : '';
      const fix = bgName
        ? `Use a text token that passes on ${bgName}: ${safe || 'none of the tested tokens pass, change the surface'}.`
        : 'The surface is not a plain Moon token. Put the text on a solid Moon surface token.';
      add(
        `contrast|${c.fg}|${c.bg}|${c.need}`,
        {
          rule: 'contrast',
          severity: 'fail',
          where: `${c.sel} ("${c.sample}")`,
          detail: `${fgName ?? c.fg} on ${bgName ?? c.bg} measures ${c.ratio}:1 at ${c.px}px, needs ${c.need}:1.`,
          fix,
        },
        w,
      );
    }
    for (const u of m.unverified) {
      add(`unverified|${u.sel}`, { rule: 'contrast-unverified', severity: 'warn', where: u.sel, detail: `Contrast could not be measured: ${u.reason}.`, fix: 'Put text on a solid Moon surface token so it can be checked.' }, w);
    }

    if (m.overflow.length) {
      const top = [...m.overflow].sort((a, b) => b.over - a.over).slice(0, 3);
      add(
        `overflow|${w}`,
        {
          rule: 'horizontal-overflow',
          severity: 'fail',
          where: top.map((o) => o.sel).join('; '),
          detail: `Content runs ${top[0]!.over}px past the ${w}px screen edge${m.docScrollWidth > w + 1 ? ' and the page scrolls sideways' : ' and is cut off'}. Widest offender is ${top[0]!.width}px wide.`,
          fix: 'Remove fixed widths. Use max-width:100%, the mo-grid helper, or let rows wrap with mo-row.',
        },
        w,
      );
    }
    for (const c of m.clipped) {
      add(`clipped|${c.sel}`, { rule: 'content-clipped', severity: 'fail', where: c.sel, detail: `Content is ${c.scroll}px wide inside a ${c.client}px box with overflow hidden, so part of it is cut off.`, fix: 'Let the box grow or wrap its content instead of hiding the overflow.' }, w);
    }
    for (const c of m.textOverflow) {
      add(`textoverflow|${c.sel}`, { rule: 'content-clipped', severity: 'fail', where: c.sel, detail: `Text is ${c.scroll}px wide in a ${c.client}px box and spills out.`, fix: 'Allow the text to wrap, or give the box room.' }, w);
    }
    for (const o of m.overflowY) {
      add(`oy|${o.edge}|${o.sel}`, { rule: 'content-cut-off', severity: 'fail', where: o.sel, detail: `Content runs ${o.over}px past the ${o.edge} edge of the ${w} by ${m.vh} asset.`, fix: 'Use a smaller type class for this size, shorten the copy, or give the panel more room.' }, w);
    }
    for (const o of m.vOverflow) {
      add(`ov|${o.sel}`, { rule: 'content-cut-off', severity: 'fail', where: o.sel, detail: `Content is ${o.scroll}px tall inside a ${o.client}px box and spills out of it.`, fix: 'Use a smaller type class for this size or shorten the copy.' }, w);
    }
    for (const o of m.unsafe) {
      add(`unsafe|${o.sel}`, { rule: 'outside-safe-zone', severity: 'fail', where: o.sel, detail: `Text sits inside the keep-clear margin (${o.x}px sides, ${o.y}px top and bottom).`, fix: 'Move the panel inward so the platform interface cannot cover the text.' }, w);
    }
    for (const o of m.tooSmall) {
      add(`small|${o.px}|${o.sel}`, { rule: 'text-too-small', severity: 'fail', where: o.sel, detail: `Text is ${o.px}px on a ${w} px wide asset. It must be at least ${o.min}px, which is 2 percent of the short side, to read at feed size.`, fix: 'Use a larger Moon type class for this size.' }, w);
    }
    for (const im of m.images) {
      if (im.drift > DRIFT_NOTE) {
        add(`drift|${im.sel}`, { rule: 'image-palette-drift', severity: 'warn', where: im.sel, detail: `The artwork averages ${im.drift} away from the nearest Moon colour (note above ${DRIFT_NOTE}).`, fix: 'Regenerate with a prompt that names the Moon colours, or accept the artwork if the mood is right.' }, w);
      }
    }
    for (const h of mode === 'asset' ? [] : m.hit) {
      add(`hit|${h.sel}`, { rule: 'hit-target', severity: 'fail', where: h.sel, detail: `Tap target is ${h.w} by ${h.h}px, under the 24px minimum.`, fix: 'Use a mo-btn size of sm or larger, or add padding.' }, w);
    }
    for (const c of m.collisions) {
      add(`collide|${c.a}|${c.b}`, { rule: 'text-collision', severity: 'fail', where: `${c.a} and ${c.b}`, detail: `Two pieces of text overlap by about ${c.area} square px.`, fix: 'Give the elements room: stack them on narrow screens with mo-stack, or add gap.' }, w);
    }

    for (const p of m.palette) {
      add(`palette|${p.prop}|${p.value}`, { rule: 'off-palette', severity: 'fail', where: p.sel, detail: `${p.prop} ${p.value} is not a Moon colour token.`, fix: 'Use a Moon class or a var(--mo-...) token. Raw hex values are not allowed.' }, w);
    }
    for (const p of m.type) {
      add(`type|${p.value}`, { rule: 'off-scale-type', severity: 'fail', where: p.sel, detail: `Font size ${p.value}px is not on the Moon type scale (${typeSizes}).`, fix: 'Use a mo-h1 to mo-h7, mo-body, mo-body-sm or mo-annotation class.' }, w);
    }
    for (const p of m.family) {
      add(`family|${p.value}`, { rule: 'off-brand-font', severity: 'fail', where: p.sel, detail: `Font ${p.value} is not Source Serif 4 or Source Sans 3.`, fix: 'Use the font-family from the Moon classes. Do not set a font by hand.' }, w);
    }
    for (const p of m.radius) {
      add(`radius|${p.value}`, { rule: 'off-scale-radius', severity: 'fail', where: p.sel, detail: `Corner radius ${p.value}px is not 12, 16, 24 or full.`, fix: 'Use the radius that comes with the Moon component class.' }, w);
    }
    for (const p of m.grid) {
      const prop = p.prop.replace(/-(top|right|bottom|left)$/, '');
      add(`grid|${prop}|${p.value}`, { rule: 'off-grid', severity: 'fail', where: p.sel, detail: `${prop} of ${p.value}px is off the 4px spacing grid.`, fix: 'Use a mo-gap, mo-pad or mo-mt helper.' }, w);
    }
    for (const p of m.classes) {
      add(`class|${p.cls}`, { rule: 'unknown-class', severity: 'fail', where: p.sel, detail: `Class "${p.cls}" is not part of the Moon recipes.`, fix: 'Use only classes from the allowed list, or ask for a new component to be added to the system first.' }, w);
    }
    for (const a of m.a11y) {
      const copy: Record<string, [Severity, string, string]> = {
        'missing-alt': ['fail', 'Image has no alt text.', 'Add alt text, or alt="" if the image is decoration.'],
        'missing-label': ['fail', 'Form field has no label.', 'Wrap it in a mo-field with a mo-label tied to the field.'],
        'empty-control': ['fail', 'Button or link has no accessible name.', 'Add visible text or an aria-label.'],
        'missing-lang': ['fail', 'The page has no language set.', 'Set lang on the html element.'],
        'h1-count': ['warn', `There should be exactly one h1 (${a.sel}).`, 'Use one h1 for the page title.'],
      };
      const c = copy[a.rule];
      if (c && !(mode === 'asset' && a.rule === 'h1-count')) add(`a11y|${a.rule}|${a.sel}`, { rule: a.rule, severity: c[0], where: a.sel, detail: c[1], fix: c[2] }, w);
    }
  }

  const order = (i: Issue) => (i.severity === 'fail' ? 0 : 1);
  return [...issues.values()].sort((a, b) => order(a) - order(b) || a.rule.localeCompare(b.rule));
}
