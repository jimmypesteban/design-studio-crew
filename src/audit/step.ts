import fs from 'node:fs';
import path from 'node:path';
import { APPROVE, REJECT, STOP, type Button } from '../channel/types.ts';
import { StopJob, trim, type JobKit } from '../job.ts';
import { clean } from '../plain.ts';
import { auditFindings, conformance, ruleInfo, type Finding, type Profile } from './findings.ts';
import { auditImage, imageFindings, type ImageAudit } from './image.ts';
import { auditPage, type PageAuditResult } from './page.ts';
import { factsData, factsText, fingerprint, fixListMarkdown, reportMarkdown, summarise, type AuditReport } from './report.ts';
import { allowedRoots, checkTarget, describeTarget, type AuditTarget } from './target.ts';

export interface AuditResult {
  pass: boolean;
  verdict: 'pass' | 'rejected' | 'limited';
  fails: number;
  warns: number;
  waived: number;
  findings: number;
  conformance: number | null;
  mode: 'page' | 'image';
}

interface Prior {
  fingerprints: string[];
  descriptions: Record<string, string>;
}

/** Which standard applies. Our own screens are held to Moon. Anything else gets the universal rules. */
function defaultProfile(t: AuditTarget, kit: JobKit): Profile {
  return t.type === 'file' && t.path.startsWith(fs.realpathSync(kit.deps.cfg.outDir)) ? 'moon' : 'universal';
}

function planText(t: AuditTarget, safety: string, profile: Profile, live: boolean): string {
  const lines = [`Target: ${describeTarget(t)}`, `Check: ${safety}`, `Standard: ${profile === 'moon' ? 'Moon strict (quality rules and Moon rules both block)' : 'Universal (quality rules block, Moon conformance is reported)'}`, ''];
  if (t.type === 'image') {
    lines.push('What I will do:', '- Analyse the colours in the picture against the Moon palette.', `- ${live ? 'Ask an agent for a visual review of the picture. Its findings are approximate and labelled.' : 'No visual review in mock mode.'}`, '', 'What a screenshot cannot tell me: contrast ratios, overflow, tap sizes, labels and spacing. Send a web address or the HTML for those.');
  } else {
    lines.push('What I will do:', '- Open the page once in a clean browser at 375, 768 and 1024 px.', '- Scroll it to load lazy content, then measure contrast, overflow, tap targets, labels, structure, images and Moon conformance.', '- Take screenshots and mark each finding on them.', '', 'What I will not do: click, type, sign in, accept cookies, submit forms or download anything. Private and internal addresses are refused.');
  }
  lines.push('', 'Say "send back" with a reason to change the standard, for example "treat it as a Moon screen".');
  return lines.join('\n');
}

export async function auditStep(kit: JobKit, target: AuditTarget): Promise<AuditResult> {
  const { deps, opts } = kit;
  const { cfg, store, channel, tokens, llm } = deps;
  const seq = kit.nextSeq();

  // 1. Safety check before anything is opened
  const safety = await checkTarget(target, { allowLoopback: cfg.auditAllowLocal, cfg });
  if (!safety.ok) {
    store.log(kit.jobId, 'info', 'reviewer', `Refused to audit: ${safety.reason}`);
    throw new StopJob(safety.reason);
  }

  // 2. Approve the plan before the browser touches the target
  let profile = defaultProfile(target, kit);
  let humanRounds = 0;
  const planStep = store.addStep(kit.jobId, seq, 'reviewer', 1, kit.w('attempts/audit-plan.md', `# Audit plan\n\n${clean(planText(target, safety.note, profile, llm.mode === 'live'))}\n`));
  for (;;) {
    const g = await kit.gate('reviewer', planStep, planText(target, safety.note, profile, llm.mode === 'live'), { buttons: [APPROVE, REJECT, STOP] });
    if (g.decision === 'approve') break;
    const why = (g.reason ?? '').toLowerCase();
    if (/moon|strict|our (own )?screen/.test(why) && !/universal|not moon/.test(why)) profile = 'moon';
    else if (/universal|any page|not moon|external|lenient/.test(why)) profile = 'universal';
    store.log(kit.jobId, 'fix', 'reviewer', `Audit plan changed. Standard is now ${profile}.`, { profile });
    if (++humanRounds > opts.maxHumanRounds) throw new StopJob('The audit plan was sent back too many times.');
  }

  // 3. Measure
  await kit.ensureBudget(llm.mode === 'live' && target.type === 'image' ? 0.1 : 0, 'reviewer');
  const waivers = store.waivers(target.key);
  const priorRow = store.lastAudit(target.key, kit.jobId);
  const prior = priorRow?.summary as Prior | undefined;
  const priorPrints = new Set(prior?.fingerprints ?? []);
  /** Waivers from earlier audits, and whether each finding is new since the last one. */
  const applyMeta = (list: Finding[]) => {
    for (const f of list) {
      const fp = fingerprint(f);
      const w = waivers.get(fp);
      if (w) f.waived = { reason: w };
      if (priorRow) f.status = priorPrints.has(fp) ? 'unchanged' : 'new';
    }
    return list;
  };
  const shotsDir = path.join(kit.dir, 'attempts', 'audit-1', 'shots');
  await channel.say(target.type === 'image' ? 'Analysing the screenshot.' : 'Opening the page and measuring it. This takes a few seconds.');

  let page: PageAuditResult | undefined;
  let img: ImageAudit | undefined;
  let findings: Finding[] = [];
  let conf: AuditReport['conformance'];
  let visual: AuditReport['visualReview'] = 'not run';

  if (target.type === 'image') {
    img = await auditImage({ file: target.path, tokens, chromePath: cfg.chromePath });
    const list: Omit<Finding, 'n'>[] = imageFindings(img, tokens, profile);
    if (llm.mode === 'live' && img.preview) {
      const text = await kit.callAgent('reviewer', { ...kit.baseCtx(), visualReview: true, images: [img.preview] });
      list.push(...parseVisual(text));
      visual = 'done';
    }
    findings = applyMeta(number(list));
  } else {
    const isFile = target.type === 'file';
    const roots = allowedRoots(cfg);
    page = await auditPage({
      url: isFile ? target.path : target.url,
      isFile,
      tokens,
      chromePath: cfg.chromePath,
      shotsDir,
      allowLoopback: cfg.auditAllowLocal,
      allowFile: (f) => roots.some((r) => f === r || f.startsWith(r + path.sep)),
      judge: (m, e) => {
        findings = applyMeta(auditFindings(m, tokens, profile, e));
        return findings;
      },
    });
    findings = page.findings;
    conf = conformance(page.measures[page.measures.length - 1]!, tokens);
  }

  const buildReport = (): AuditReport => {
    const sum = summarise(findings);
    const nowPrints = new Set(findings.map(fingerprint));
    return {
      target: { type: target.type, label: describeTarget(target), key: target.key },
      profile,
      mode: target.type === 'image' ? 'image' : 'page',
      checkedAt: new Date().toISOString(),
      widths: page ? page.measures.map((m) => m.vw) : [],
      findings,
      ...sum,
      pass: sum.fails === 0 && target.type !== 'image',
      verdict: sum.fails > 0 ? 'rejected' : target.type === 'image' ? 'limited' : 'pass',
      conformance: conf,
      image: img ? { width: img.width, height: img.height, bytes: img.bytes, colours: img.colours, paletteCloseness: img.paletteCloseness } : undefined,
      delta: priorRow
        ? {
            since: priorRow.ts,
            fixed: [...priorPrints].filter((p) => !nowPrints.has(p)).map((p) => prior?.descriptions?.[p] ?? p.split('|')[0]!),
            newCount: findings.filter((f) => f.status === 'new').length,
            unchanged: findings.filter((f) => f.status === 'unchanged').length,
          }
        : undefined,
      loadNotes: page?.loadNotes ?? [],
      fontsLoaded: page?.fontsLoaded,
      visualReview: visual,
      shots: page?.screenshots ?? [],
    };
  };

  // 5. Say what was found
  let report = buildReport();
  const topFails = findings.filter((f) => !f.waived && f.severity === 'fail');
  if (!report.pass) {
    store.log(kit.jobId, 'review_reject', 'reviewer', `Rejected ${report.target.label}. ${report.fails} to fix, ${report.warns} to note. Rules: ${[...new Set(topFails.map((f) => f.rule))].join(', ')}.`, { rules: [...new Set(topFails.map((f) => f.rule))] });
    for (const f of topFails) store.remember('reviewer', f.rule, f.fix.slice(0, 160));
    await channel.say(`Reviewer rejected it: ${report.fails} to fix, ${report.warns} to note.\n` + topFails.slice(0, 5).map((f) => `- ${f.rule}: ${trim(f.detail, 140)}\n  Fix: ${trim(f.fix, 140)}`).join('\n'));
  } else if (report.verdict === 'limited') {
    store.log(kit.jobId, 'info', 'reviewer', `Limited check of ${report.target.label}: nothing failed, but a screenshot cannot show contrast, layout or structure. Not a pass.`);
    await channel.say('Limited check, not a pass. Nothing failed on colour, but a screenshot cannot show contrast, overflow, tap sizes or labels. Send a web address or the HTML for a real check.');
  } else {
    store.log(kit.jobId, 'review_pass', 'reviewer', `Passed ${report.target.label}. ${report.warns} notes.`);
    await channel.say(`The Reviewer passed it. ${report.warns} notes.`);
  }

  // 6. The fix list, then the approval gate. Findings can be waived with a reason, and the fix list can be sent back.
  let attempt = 0;
  let feedback: string | undefined;
  let waiveRounds = 0;
  for (;;) {
    attempt++;
    if (attempt > 12) throw new StopJob('The audit step went round too many times.');
    report = buildReport();
    const text = await kit.callAgent('handoff', { ...kit.baseCtx(), attempt, feedback, handoffKind: 'audit', facts: factsText(report), factsData: factsData(report) });
    if (attempt > 1) store.log(kit.jobId, 'fix', 'handoff', `Handoff rewrote the fix list (attempt ${attempt}).`, { attempt });
    const narrative = text.replace(/```[a-z]*[\s\S]*?```/g, '').trim();
    const dir = `attempts/audit-${attempt}`;
    const reportFile = kit.w(`${dir}/report.md`, reportMarkdown(report));
    kit.w(`${dir}/report.json`, JSON.stringify(report, null, 2));
    const fixFile = kit.w(`${dir}/fix-list.md`, fixListMarkdown(report, narrative));
    const stepId = store.addStep(kit.jobId, seq, 'handoff', attempt, fixFile);
    store.log(kit.jobId, 'agent_note', 'handoff', `Handoff wrote fix list ${attempt}.`);

    const shot = report.shots.find((s) => s.width === 375) ?? report.shots[0];
    if (shot) await channel.sendFile(shot.annotated, `Findings marked on the page at ${shot.width} px`);
    await channel.sendFile(reportFile, 'Audit report');
    const buttons: Button[] = [APPROVE, ...(findings.some((f) => !f.waived) ? [{ id: 'waive', label: 'Waive some findings' }] : []), REJECT, STOP];
    const g = await kit.gate('handoff', stepId, `${narrative}\n\nResult: ${report.verdict === 'pass' ? 'PASS' : report.verdict === 'rejected' ? 'REJECTED' : 'LIMITED CHECK, NOT A PASS'}. ${report.fails} to fix, ${report.warns} to note${report.waived ? `, ${report.waived} waived` : ''}.`, { file: fixFile, caption: 'Fix list', buttons });

    if (g.decision === 'approve' || g.decision === 'override') break;
    if (g.decision === 'other' && g.id === 'waive') {
      if (++waiveRounds > 5) throw new StopJob('Too many rounds of waiving findings.');
      const reply = await channel.askText('Which findings should I waive? Reply with their numbers or rule names and a reason, for example: 12, long-line because they are deliberate.');
      const split = /\b(because|since|reason|as)\b|[:;]|\s-\s/i.exec(reply);
      const numPart = split ? reply.slice(0, split.index) : reply;
      const reason = (split ? reply.slice(split.index).replace(/^(\b(because|since|reason|as)\b|[:;]|\s-\s)\s*/i, '') : reply).trim() || 'Deliberate';
      const nums = new Set([...numPart.matchAll(/\d+/g)].map((m) => Number(m[0])));
      const rules = new Set([...numPart.matchAll(/[a-z][a-z-]+/gi)].map((m) => m[0].toLowerCase()));
      let done = 0;
      for (const f of findings) {
        if (!(nums.has(f.n) || rules.has(f.rule)) || f.waived) continue;
        f.waived = { reason };
        store.addWaiver(target.key, fingerprint(f), f.rule, reason, kit.jobId);
        store.log(kit.jobId, 'override', 'reviewer', `Jimmy waived finding ${f.n} (${f.rule}): ${reason}`, { n: f.n, rule: f.rule, reason });
        done++;
      }
      await channel.say(done ? `Waived ${done} finding${done === 1 ? '' : 's'}. They are logged and will not be repeated for this target.` : 'I did not find those among the open findings.');
      continue;
    }
    if (g.decision === 'reject') {
      feedback = g.reason;
      store.remember('handoff', 'jimmy-note', trim(g.reason ?? '', 120));
      if (++humanRounds > opts.maxHumanRounds) throw new StopJob('The fix list was sent back too many times.');
      continue;
    }
  }

  // 7. Final files and the record for next time
  const out = 'final/audit';
  const last = `attempts/audit-${attempt}`;
  for (const f of ['report.md', 'report.json', 'fix-list.md']) kit.w(`${out}/${f}`, fs.readFileSync(path.join(kit.dir, last, f)));
  for (const s of report.shots) {
    kit.w(`${out}/shots/${path.basename(s.plain)}`, fs.readFileSync(s.plain));
    kit.w(`${out}/shots/${path.basename(s.annotated)}`, fs.readFileSync(s.annotated));
  }
  store.saveAudit(kit.jobId, target.key, describeTarget(target), profile, {
    fingerprints: findings.map(fingerprint),
    descriptions: Object.fromEntries(findings.map((f) => [fingerprint(f), `${f.rule}: ${trim(f.detail, 90)}`])),
    counts: { fails: report.fails, warns: report.warns, waived: report.waived },
    conformance: report.conformance?.overall ?? null,
  });
  return { pass: report.pass, verdict: report.verdict, fails: report.fails, warns: report.warns, waived: report.waived, findings: findings.length, conformance: report.conformance?.overall ?? null, mode: report.mode };

  function number(list: Omit<Finding, 'n'>[]): Finding[] {
    return list
      .sort((a, b) => a.priority - b.priority || (a.severity === b.severity ? 0 : a.severity === 'fail' ? -1 : 1))
      .map((f, i) => ({ ...f, n: i + 1 }));
  }
}

/** What a visual review returns, turned into findings. They are approximate, never fail, and are labelled. */
export function parseVisual(text: string): Omit<Finding, 'n'>[] {
  const m = /```json\s*\n([\s\S]*?)```/i.exec(text);
  const raw = m?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let obj: { findings?: { rule?: string; area?: string; problem?: string; why?: string; fix?: string; confidence?: string }[] };
  try {
    obj = JSON.parse(raw) as typeof obj;
  } catch {
    return [];
  }
  return (obj.findings ?? [])
    .filter((f) => f.problem && f.fix && /^(high|medium)$/i.test(f.confidence ?? 'medium'))
    .slice(0, 8)
    .map((f) => {
      const rule = ['visual-hierarchy', 'visual-spacing', 'visual-contrast', 'visual-other'].includes(f.rule ?? '') ? f.rule! : 'visual-other';
      const [category, priority] = ruleInfo(rule);
      return {
        rule,
        category,
        priority,
        severity: 'warn' as const,
        where: clean(f.area ?? 'somewhere in the picture').slice(0, 80),
        detail: clean(`${f.problem}${f.why ? ` ${f.why}` : ''}`).slice(0, 300),
        fix: clean(f.fix!).slice(0, 300),
        widths: [],
        count: 1,
        sels: [],
        source: 'visual' as const,
      };
    });
}
