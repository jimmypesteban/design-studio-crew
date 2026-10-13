import { clean } from '../plain.ts';
import type { Conformance, Finding, Profile } from './findings.ts';
import type { ImageAudit } from './image.ts';
import { deviceGuess, NOT_CHECKED_FROM_PIXELS } from './image.ts';

export interface AuditReport {
  target: { type: 'url' | 'file' | 'image'; label: string; key: string };
  profile: Profile;
  mode: 'page' | 'image';
  checkedAt: string;
  widths: number[];
  findings: Finding[];
  /** Un-waived failures. */
  fails: number;
  warns: number;
  waived: number;
  pass: boolean;
  /** A screenshot can be rejected but never passed, because pixels cannot prove contrast, layout or structure. */
  verdict: 'pass' | 'rejected' | 'limited';
  conformance?: Conformance;
  image?: Omit<ImageAudit, 'preview'>;
  /** Compared with the last audit of the same target. */
  delta?: { since: string; fixed: string[]; newCount: number; unchanged: number };
  loadNotes: string[];
  fontsLoaded?: boolean;
  visualReview: 'done' | 'not run';
  shots: { width: number; plain: string; annotated: string }[];
}

export const fingerprint = (f: Pick<Finding, 'rule' | 'where'>) => `${f.rule}|${f.where.slice(0, 120)}`;

export function summarise(findings: Finding[]) {
  const live = findings.filter((f) => !f.waived);
  return {
    fails: live.filter((f) => f.severity === 'fail').length,
    warns: live.filter((f) => f.severity === 'warn').length,
    waived: findings.filter((f) => f.waived).length,
  };
}

const PRIORITY = { 1: 'Fix first', 2: 'Fix soon', 3: 'Tidy up' } as const;
const CATEGORY = { quality: 'Quality', qa: 'Page health', moon: 'Moon conformance', visual: 'Visual review' } as const;

function findingBlock(f: Finding, shotsNote: boolean): string[] {
  const out = [`### ${f.n}. ${f.rule} (${CATEGORY[f.category]}, ${f.severity === 'fail' ? 'must fix' : 'should fix'}${f.status === 'new' ? ', new since last audit' : ''})`];
  out.push(`- Where: ${f.where}${f.count > 1 ? ` (${f.count} places)` : ''}`);
  out.push(`- Problem: ${f.detail}`);
  out.push(`- Fix: ${f.fix}`);
  if (f.widths.length) out.push(`- Seen at: ${f.widths.join(', ')} px`);
  if (shotsNote && f.sels.length) out.push(`- Marked ${f.n} in the annotated screenshots.`);
  if (f.source === 'visual') out.push('- This came from a visual review. It is approximate and was not measured.');
  return out;
}

export function reportMarkdown(r: AuditReport): string {
  const L: string[] = [`# Audit report: ${r.target.label}`, ''];
  L.push(`Result: ${r.verdict === 'pass' ? 'PASS' : r.verdict === 'rejected' ? 'REJECTED' : 'LIMITED CHECK, NOT A PASS'}. ${r.fails} to fix, ${r.warns} to note${r.waived ? `, ${r.waived} waived` : ''}.`);
  if (r.verdict === 'limited') L.push('Nothing failed, but only colours could be checked from a screenshot. This is not evidence that the screen is good. Send a web address or the HTML for a real check.');
  L.push(`Standard: ${r.profile === 'moon' ? 'Moon strict. Quality rules and Moon rules both block.' : 'Universal. Quality rules block. Moon conformance is reported but does not block.'}`);
  L.push(`Method: ${r.mode === 'page' ? `opened read only at ${r.widths.join(', ')} px and measured in Chrome. Nothing was clicked, typed or sent.` : 'pixel analysis of the screenshot' + (r.visualReview === 'done' ? ' plus a visual review by an agent.' : '. No visual review was run.')}`);
  if (r.mode === 'page') L.push(`Brand fonts ${r.fontsLoaded ? 'loaded' : 'could not be confirmed'} for the measurement.`);
  for (const n of r.loadNotes) L.push(`Note: ${n}`);
  L.push('');
  const byCat = (c: string) => r.findings.filter((f) => f.category === c && !f.waived).length;
  L.push('## Summary', '', '| Area | Findings |', '| --- | --- |');
  for (const c of ['quality', 'qa', 'moon', 'visual'] as const) if (byCat(c) || c !== 'visual') L.push(`| ${CATEGORY[c]} | ${byCat(c)} |`);
  L.push('');
  if (r.conformance) {
    const c = r.conformance;
    L.push('## Moon conformance', '', `Overall ${c.overall} percent. Colours ${c.colour}, type sizes ${c.type}, corner radii ${c.radius}, fonts ${c.fonts}. Each is the share of what the page uses that is on the Moon system.`, '');
  }
  if (r.image) {
    L.push('## What the screenshot shows', '', `- Size: ${deviceGuess(r.image.width, r.image.height)} (${r.image.width} by ${r.image.height}, ${Math.round(r.image.bytes / 1024)} KB).`, `- ${r.image.paletteCloseness} percent of the pixels are within a small distance of a Moon colour.`, '');
    L.push('| Colour | Share | Closest Moon colour | Difference |', '| --- | --- | --- | --- |');
    for (const c of r.image.colours.slice(0, 8)) L.push(`| ${c.hex} | ${c.share}% | ${c.nearest} ${c.nearestHex} | ${c.delta} |`);
    L.push('', '### Not checked from a screenshot', '', ...NOT_CHECKED_FROM_PIXELS.map((x) => `- ${x}`), '', 'Send a web address or the HTML file for measured results on these.', '');
  }
  if (r.delta) {
    L.push('## Since the last audit of this target', '', `Last audited ${r.delta.since.slice(0, 10)}. Fixed: ${r.delta.fixed.length}. New: ${r.delta.newCount}. Still there: ${r.delta.unchanged}.`);
    for (const f of r.delta.fixed.slice(0, 12)) L.push(`- Fixed: ${f}`);
    L.push('');
  }
  const live = r.findings.filter((f) => !f.waived);
  if (!live.length) L.push('## Findings', '', 'No problems found.', '');
  for (const p of [1, 2, 3] as const) {
    const items = live.filter((f) => f.priority === p);
    if (!items.length) continue;
    L.push(`## Priority ${p}: ${PRIORITY[p]}`, '');
    for (const f of items) L.push(...findingBlock(f, r.mode === 'page'), '');
  }
  const waived = r.findings.filter((f) => f.waived);
  if (waived.length) {
    L.push('## Waived', '', 'These were accepted as deliberate. Each waiver is logged with its reason.', '');
    for (const f of waived) L.push(`- ${f.n}. ${f.rule} at ${f.where}. Reason: ${f.waived!.reason}`);
    L.push('');
  }
  return clean(L.join('\n')) + '\n';
}

/** A checklist an engineer or designer can work down, in the order that helps people most. */
export function fixListMarkdown(r: AuditReport, narrative: string): string {
  const L: string[] = [`# Fix list: ${r.target.label}`, '', narrative.trim(), ''];
  const live = r.findings.filter((f) => !f.waived);
  for (const p of [1, 2, 3] as const) {
    const items = live.filter((f) => f.priority === p);
    if (!items.length) continue;
    L.push(`## ${PRIORITY[p]}`, '');
    for (const f of items) L.push(`- [ ] **${f.n}. ${f.rule}**${f.count > 1 ? ` (${f.count} places)` : ''}: ${f.fix} _${f.detail.replace(/\s+/g, ' ')}_`);
    L.push('');
  }
  const colours = live.filter((f) => f.rule === 'off-palette' && /Use (mo-[a-z0-9-]+) \((#[0-9A-F]{6})\)/.test(f.fix));
  if (colours.length) {
    L.push('## Colour map', '', '| From | To (Moon token) |', '| --- | --- |');
    for (const f of colours) {
      const from = /(#[0-9A-F]{6}) is not a Moon colour/.exec(f.detail)?.[1] ?? '?';
      const to = /Use (mo-[a-z0-9-]+) \((#[0-9A-F]{6})\)/.exec(f.fix)!;
      L.push(`| ${from} | ${to[1]} ${to[2]} |`);
    }
    L.push('');
  }
  if (!live.length) L.push('Nothing to fix.', '');
  L.push('Run the audit again after the fixes. The next report shows what was fixed and what is new.', '');
  return clean(L.join('\n')) + '\n';
}

/** Counts only. The agent that writes the fix list never sees raw text from the audited page. */
export function factsData(r: AuditReport) {
  const live = r.findings.filter((f) => !f.waived);
  const byRule = new Map<string, { n: number; p: number; cat: string }>();
  for (const f of live) byRule.set(f.rule, { n: (byRule.get(f.rule)?.n ?? 0) + 1, p: Math.min(byRule.get(f.rule)?.p ?? 9, f.priority), cat: f.category });
  return {
    kind: 'audit' as const,
    mode: r.mode,
    profile: r.profile,
    pass: r.pass,
    verdict: r.verdict,
    fails: r.fails,
    warns: r.warns,
    waived: r.waived,
    p1: live.filter((f) => f.priority === 1).length,
    p2: live.filter((f) => f.priority === 2).length,
    p3: live.filter((f) => f.priority === 3).length,
    conformance: r.conformance ?? null,
    topRules: [...byRule.entries()].sort((a, b) => a[1].p - b[1].p || b[1].n - a[1].n).slice(0, 5).map(([rule, v]) => ({ rule, count: v.n, priority: v.p, category: v.cat })),
    delta: r.delta ? { fixed: r.delta.fixed.length, new: r.delta.newCount, unchanged: r.delta.unchanged } : null,
  };
}

export function factsText(r: AuditReport): string {
  const f = factsData(r);
  return [
    `Audit of a ${r.mode === 'page' ? 'web page, measured in Chrome' : 'screenshot, pixel analysis only'}. Standard: ${f.profile}.`,
    `Result: ${f.verdict === 'limited' ? 'limited check, not a pass' : f.pass ? 'pass' : 'rejected'}. ${f.fails} must fix, ${f.warns} should fix, ${f.waived} waived. By priority: ${f.p1} first, ${f.p2} soon, ${f.p3} tidy up.`,
    f.conformance ? `Moon conformance: ${f.conformance.overall} percent (colours ${f.conformance.colour}, type ${f.conformance.type}, radius ${f.conformance.radius}, fonts ${f.conformance.fonts}).` : 'Moon conformance was not measured.',
    `Most important rules: ${f.topRules.map((t) => `${t.rule} x${t.count} (priority ${t.priority})`).join(', ') || 'none'}.`,
    f.delta ? `Since the last audit: ${f.delta.fixed} fixed, ${f.delta.new} new, ${f.delta.unchanged} unchanged.` : 'No earlier audit of this target.',
  ].join('\n');
}
