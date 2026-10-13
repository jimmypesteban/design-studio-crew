import type { BrandResult } from '../brand/step.ts';
import { SIZE_BY_ID } from '../brand/sizes.ts';
import type { MoonTokens } from '../moon/tokens.ts';
import { clean } from '../plain.ts';
import type { ReviewReport } from '../reviewer/index.ts';
import type { ConvertResult } from './convert.ts';
import type { VerifyReport } from './verify.ts';

function nameByHex(t: MoonTokens): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of Object.keys(t.colors).sort((a, b) => a.length - b.length)) if (!m.has(t.colors[n]!)) m.set(t.colors[n]!, n);
  return m;
}

export interface UiFacts {
  screenName: string;
  components: Record<string, number>;
  unmapped: string[];
  differences: string[];
  states: string[];
  colours: { token: string; hex: string; count: number }[];
  type: { px: number; classes: string[]; count: number }[];
  radii: { px: string; token: string; count: number }[];
  grids: { where: string; byWidth: Record<number, number> }[];
  mooNotes: number;
}

/** The UX note's States section, as bullets. */
export function statesFrom(uxNote: string | undefined): string[] {
  if (!uxNote) return [];
  const m = /##\s*States\s*\n([\s\S]*?)(?:\n##\s|$)/i.exec(uxNote);
  return m ? m[1]!.split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean) : [];
}

export function buildUiFacts(t: MoonTokens, screenName: string, conv: ConvertResult, report: ReviewReport, uxNote: string | undefined, verify: VerifyReport): UiFacts {
  const names = nameByHex(t);
  const colours = Object.entries(report.inventory.colors)
    .map(([hex, count]) => ({ hex, token: names.get(hex) ?? 'not a token', count }))
    .sort((a, b) => b.count - a.count);
  const sizeNames = new Map<number, string[]>();
  for (const [n, v] of Object.entries(t.fontSize)) {
    const px = Math.round(parseFloat(v.size) * 16 * 10) / 10;
    sizeNames.set(px, [...(sizeNames.get(px) ?? []), n]);
  }
  const type = Object.entries(report.inventory.fontSizes)
    .map(([px, count]) => ({ px: Number(px), count, classes: sizeNames.get(Number(px)) ?? [] }))
    .sort((a, b) => b.px - a.px);
  const radii = Object.entries(report.inventory.radii).map(([px, count]) => ({
    px,
    count,
    token: px === 'full' ? 'mo-full' : (Object.entries(t.radius).find(([, v]) => parseFloat(v) === Number(px))?.[0] ?? 'off scale'),
  }));
  const byGrid = new Map<string, Record<number, number>>();
  for (const g of report.grids) byGrid.set(g.sel, { ...(byGrid.get(g.sel) ?? {}), [g.width]: g.cols });
  const grids = [...byGrid.entries()].map(([where, byWidth]) => ({ where, byWidth }));
  return {
    screenName,
    components: conv.components,
    unmapped: conv.unmapped,
    differences: conv.differences,
    states: statesFrom(uxNote),
    colours,
    type,
    radii,
    grids,
    mooNotes: verify.mooNotes.length,
  };
}

export function factsText(f: UiFacts, verify: VerifyReport): string {
  return [
    `Screen: ${f.screenName}`,
    `Moon components used: ${Object.entries(f.components).map(([k, v]) => `${k} x${v}`).join(', ')}`,
    `Colour tokens used: ${f.colours.map((c) => c.token).join(', ')}`,
    `Type sizes used: ${f.type.map((x) => `${x.px}px (${x.classes.join('/')})`).join(', ')}`,
    `Grid columns by width: ${f.grids.map((g) => `${Object.entries(g.byWidth).map(([w, c]) => `${c} at ${w}`).join(', ')}`).join(' | ') || 'none'}`,
    `States from the UX note: ${f.states.join(' | ') || 'none given'}`,
    `Differences between the approved screen and the Moon components: ${f.differences.join(' | ') || 'none'}`,
    `Verification of the React draft: type check ${verify.typecheck.ok ? 'pass' : 'FAIL'}, render ${verify.render.ok ? 'pass' : 'FAIL'}, text match ${verify.parity.ok ? 'pass' : 'FAIL'}, layout at three widths ${verify.fidelityBlocking.length ? 'FAIL' : 'pass'}, ${f.mooNotes} findings in Moon components.`,
  ].join('\n');
}

function table(rows: string[][], header: string[]): string {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function uiSpecMarkdown(a: { jobId: string; facts: UiFacts; narrative: string; verify: VerifyReport; codeSource: string; moonImport: string }): string {
  const { facts: f, verify: v } = a;
  const L: string[] = [];
  L.push(`# ${f.screenName}: handoff spec`, '', `Job: ${a.jobId}`, '', 'Files in this pack: `Screen.tsx` (the code), `spec.md` (this file), `verify.md` (what was checked), `react-render.html` and `shots/` (the code rendered with Moon styling).', '');
  L.push(a.narrative.trim(), '');
  L.push('## Components', '', table(Object.entries(f.components).map(([k, n]) => [k, String(n)]), ['Moon component', 'Used']), '');
  if (f.unmapped.length) L.push(`Written as utility classes, with no Moon component equivalent: ${f.unmapped.join(', ')}.`, '');
  L.push('## Tokens used', '');
  L.push(table(f.colours.map((c) => [c.token, c.hex, String(c.count)]), ['Colour token', 'Value', 'Uses']), '');
  L.push(table(f.type.map((x) => [`${x.px}px`, x.classes.join(', ') || 'off scale', String(x.count)]), ['Type size', 'Moon type tokens', 'Uses']), '');
  L.push(table(f.radii.map((r) => [r.token, r.px === 'full' ? 'full' : `${r.px}px`, String(r.count)]), ['Radius token', 'Value', 'Uses']), '');
  L.push('## Behaviour at each width', '');
  if (f.grids.length) {
    for (const g of f.grids) L.push(`- Grid \`${g.where}\`: ${Object.entries(g.byWidth).map(([w, c]) => `${c} column${c === 1 ? '' : 's'} at ${w} px`).join(', ')}.`);
  } else L.push('- Single column layout, no grids.');
  L.push('- Page margins follow the Moon Container at every width.', '');
  L.push('## States', '');
  if (f.states.length) L.push(...f.states.map((s) => `- ${s}`));
  else L.push('- None were given in the UX note.');
  L.push('');
  L.push('## Differences from the approved screen', '', 'The approved screen was built from Moon recipes. The code uses the real Moon components. They differ here:', '');
  L.push(...(f.differences.length ? f.differences.map((d) => `- ${d}`) : ['- None.']), '');
  L.push('## Verification', '');
  L.push(`- Type check against Moon: ${v.typecheck.ok ? 'pass' : 'FAIL'}`);
  L.push(`- Server render with react-dom: ${v.render.ok ? 'pass' : 'FAIL'}`);
  L.push(`- Every word of the approved screen is in the output: ${v.parity.ok ? 'pass' : 'FAIL'}`);
  L.push(`- Layout and structure at 375, 768 and 1024 px: ${v.fidelity ? (v.fidelityBlocking.length ? 'FAIL' : 'pass') : 'not run'}`);
  L.push(`- Code source: ${a.codeSource}`, '');
  L.push(`### Findings in Moon's own components`, '');
  L.push(...(v.mooNotes.length ? v.mooNotes.map((i) => `- ${i.rule}: ${i.detail}`) : ['- None raised for the components on this screen.']), '');
  L.push('## How to use it', '', `1. Import from \`${a.moonImport}\`, the Moon package. The code imports only exported Moon components.`, '2. Your app needs Moon\'s Tailwind preset (`tailwind-preset`) so classes such as `text-mo-h4` and `bg-mo-grey-2` exist.', '3. Load Source Serif 4 and Source Sans 3, and define `font-heading` and `font-body` as Moon does.', '4. Wire the static links and buttons to real routes and handlers.');
  return clean(L.join('\n')) + '\n';
}

export interface BrandFacts {
  campaign: string;
  provider: string;
  sizes: { id: string; label: string; channel: string; width: number; height: number; safe: { x: number; y: number }; headline: string }[];
  variations: { id: string; name: string; concept: string; panel: string; text: string }[];
  files: { file: string; bytes: number; ok: boolean }[];
  message: { headline: string; subline: string; cta: string };
}

export function buildBrandFacts(r: BrandResult, check: (file: string) => { ok: boolean; bytes: number }): BrandFacts {
  return {
    campaign: r.plan.campaign,
    provider: r.provider,
    message: r.plan.message,
    sizes: r.plan.sizes.map((id) => {
      const s = SIZE_BY_ID.get(id)!;
      return { id, label: s.label, channel: s.channel, width: s.width, height: s.height, safe: s.safe, headline: r.plan.type_overrides?.[id] ?? s.headline };
    }),
    variations: r.plan.variations.map((v) => ({ id: v.id, name: v.name, concept: v.concept, panel: v.panel, text: v.text })),
    files: r.assets.map((a) => ({ file: a.file, ...check(a.file) })),
  };
}

export function brandFactsText(f: BrandFacts): string {
  return [
    `Campaign: ${f.campaign}`,
    `Artwork source: ${f.provider === 'mock' ? 'placeholder art from the studio, not final artwork' : f.provider}`,
    `Words: "${f.message.headline}" / "${f.message.subline}" / button "${f.message.cta}"`,
    `Sizes: ${f.sizes.map((s) => `${s.id} ${s.width}x${s.height} (${s.channel}), keep text ${s.safe.x}px from the sides and ${s.safe.y}px from top and bottom`).join('; ')}`,
    `Variations: ${f.variations.map((v) => `${v.id} ${v.name}: ${v.concept} (panel ${v.panel}, text ${v.text})`).join('; ')}`,
    `Files: ${f.files.length} PNG files, all present and the right size: ${f.files.every((x) => x.ok) ? 'yes' : 'NO'}`,
  ].join('\n');
}

export function brandSpecMarkdown(a: { jobId: string; facts: BrandFacts; narrative: string }): string {
  const f = a.facts;
  const L: string[] = [`# ${f.campaign}: asset handoff spec`, '', `Job: ${a.jobId}`, '', a.narrative.trim(), ''];
  L.push('## Sizes', '', table(f.sizes.map((s) => [s.id, s.label, `${s.width} by ${s.height}`, s.channel, `${s.safe.x} / ${s.safe.y}`, s.headline]), ['Id', 'Name', 'Pixels', 'Channel', 'Safe zone x / y', 'Headline type']), '');
  L.push('## Files', '', table(f.files.map((x) => [x.file, `${Math.round(x.bytes / 1024)} KB`, x.ok ? 'checked' : 'PROBLEM']), ['File', 'Size', 'Status']), '');
  L.push('## Variations and alt text', '', table(f.variations.map((v) => [v.id, v.name, `${v.panel} / ${v.text}`, `${f.campaign}: ${v.concept} Text reads "${f.message.headline}".`]), ['Id', 'Name', 'Panel / text', 'Suggested alt text']), '');
  L.push('## Words on every asset', '', `- Headline: ${f.message.headline}`, `- Subline: ${f.message.subline}`, `- Button: ${f.message.cta}`, '');
  L.push('## Naming', '', 'Files are named `assets/<size id>/<variation id>.png`. Keep that pattern when you export new rounds so the manifest stays valid.', '');
  L.push('## Source and rights', '', f.provider === 'mock' ? 'The artwork in this pack is placeholder art drawn by the studio in Moon colours. Replace it before publishing.' : 'The artwork was generated by an image model. Confirm the model terms and usage rights before publishing, and keep `source-images/` with the pack.', '');
  return clean(L.join('\n')) + '\n';
}
