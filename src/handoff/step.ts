import fs from 'node:fs';
import path from 'node:path';
import type { IssueLite } from '../agents/types.ts';
import { pngSize } from '../reviewer/index.ts';
import type { ReviewReport } from '../reviewer/index.ts';
import { APPROVE, REJECT, STOP, type Button } from '../channel/types.ts';
import type { BrandResult } from '../brand/step.ts';
import { SIZE_BY_ID } from '../brand/sizes.ts';
import { StopJob, type JobKit } from '../job.ts';
import { convertToReact } from './convert.ts';
import { brandFactsText, brandSpecMarkdown, buildBrandFacts, buildUiFacts, factsText, uiSpecMarkdown } from './spec.ts';
import { verifyMarkdown, verifyReact, type VerifyReport } from './verify.ts';

export type HandoffInput =
  | { kind: 'ui'; screenName: string; html: string; fragment: string; report: ReviewReport }
  | { kind: 'brand'; result: BrandResult };

export interface HandoffResult {
  pass: boolean;
  overridden: boolean;
}

/** Split an agent reply into the written spec and optional replacement code. */
export function parseHandoff(text: string): { narrative: string; tsx?: string } {
  const m = /```tsx\s*\n([\s\S]*?)```/i.exec(text);
  return { narrative: text.replace(/```tsx[\s\S]*?```/i, '').trim(), tsx: m?.[1]?.trim() ? m[1].trim() + '\n' : undefined };
}

function verifySummary(v: VerifyReport): string {
  const mark = (ok: boolean) => (ok ? 'pass' : 'FAIL');
  return `Type check ${mark(v.typecheck.ok)}, server render ${mark(v.render.ok)}, text match ${mark(v.parity.ok)}, layout at 375, 768 and 1024 px ${v.fidelity ? mark(v.fidelityBlocking.length === 0) : 'not run'}. ${v.mooNotes.length} findings in Moon's own components.`;
}

function problems(v: VerifyReport): IssueLite[] {
  const out: IssueLite[] = [];
  for (const e of v.typecheck.errors) out.push({ rule: 'typecheck', where: 'Screen.tsx', detail: e, fix: 'Fix the type error using the real Moon prop types.' });
  for (const e of v.render.errors) out.push({ rule: 'render', where: 'Screen.tsx', detail: e, fix: 'Make the code render on the server.' });
  for (const e of v.parity.errors) out.push({ rule: 'text-missing', where: 'Screen.tsx', detail: e, fix: 'Put every word of the approved screen back.' });
  for (const i of v.fidelityBlocking) out.push({ rule: i.rule, where: i.where, detail: i.detail, fix: i.fix });
  return out;
}

export async function handoffStep(kit: JobKit, input: HandoffInput): Promise<HandoffResult> {
  return input.kind === 'ui' ? uiHandoff(kit, input) : brandHandoff(kit, input.result);
}

async function uiHandoff(kit: JobKit, input: Extract<HandoffInput, { kind: 'ui' }>): Promise<HandoffResult> {
  const { deps, opts } = kit;
  const { cfg, store, channel, tokens } = deps;
  const seq = kit.nextSeq();
  const conv = convertToReact(input.fragment, input.screenName);
  const verifyDir = (n: number) => path.join(kit.dir, 'attempts', `handoff-${n}`);
  const verify = (n: number, tsx: string) =>
    verifyReact({ dir: verifyDir(n), moonPath: cfg.moonPath, chromePath: cfg.chromePath, tokens, tsx, componentName: conv.componentName, expectedFragment: input.fragment, title: input.screenName });

  await channel.say('Handoff: converting the approved screen to Moon React code and checking it. This takes a few seconds.');
  let code = conv.tsx;
  let codeSource = 'Generated from the approved screen by the converter, then verified.';
  let v = await verify(0, conv.tsx);
  store.log(kit.jobId, v.pass ? 'review_pass' : 'review_reject', 'handoff', `Converter draft: ${verifySummary(v)}`);
  const draftPassed = v.pass;
  const facts = buildUiFacts(tokens, input.screenName, conv, input.report, kit.notes.ux, v);

  let attempt = 0;
  let autoFixes = 0;
  let humanRounds = 0;
  let feedback: string | undefined;
  let issues: IssueLite[] | undefined = draftPassed ? undefined : problems(v);
  let previousCode: string | undefined = draftPassed ? undefined : conv.tsx;

  for (;;) {
    attempt++;
    if (attempt > 10) throw new StopJob('The Handoff step went round too many times.');
    const text = await kit.callAgent('handoff', {
      ...kit.baseCtx(),
      attempt,
      feedback,
      issues,
      handoffKind: 'ui',
      facts: factsText(facts, v),
      factsData: facts,
      draftCode: conv.tsx,
      previousCode,
    });
    if (attempt > 1) store.log(kit.jobId, 'fix', 'handoff', `Handoff produced attempt ${attempt}.`, { attempt });
    const parsed = parseHandoff(text);

    // If the agent supplied code, it has to earn its place by passing the same checks.
    let candidate = code;
    let verified = v;
    if (parsed.tsx && parsed.tsx !== code) {
      candidate = parsed.tsx;
      verified = await verify(attempt, candidate);
      if (!verified.pass) {
        store.log(kit.jobId, 'review_reject', 'handoff', `Agent code failed verification: ${verifySummary(verified)}`, { attempt });
        await channel.say(`Handoff code from the agent did not pass verification. ${verifySummary(verified)}`);
        if (autoFixes < opts.maxAutoFixes) {
          autoFixes++;
          issues = problems(verified);
          previousCode = candidate;
          feedback = undefined;
          continue;
        }
        if (draftPassed) {
          store.log(kit.jobId, 'info', 'handoff', 'Kept the verified converter code because the agent code kept failing.');
          candidate = conv.tsx;
          verified = await verify(attempt, conv.tsx);
          codeSource = 'The converter version. The agent proposed changes that failed verification, so they were not used.';
        }
      } else {
        codeSource = 'Revised by the Handoff agent and verified.';
      }
    }
    code = candidate;
    v = verified;
    issues = undefined;
    previousCode = undefined;

    const spec = uiSpecMarkdown({ jobId: kit.jobId, facts: { ...facts, mooNotes: v.mooNotes.length }, narrative: parsed.narrative, verify: v, codeSource, moonImport: 'moon-design-system' });
    const dir = `attempts/handoff-pack-${attempt}`;
    const specFile = kit.w(`${dir}/spec.md`, spec);
    const codeFile = kit.w(`${dir}/Screen.tsx`, code);
    kit.w(`${dir}/verify.md`, verifyMarkdown(v));
    const stepId = store.addStep(kit.jobId, seq, 'handoff', attempt, specFile);
    store.log(kit.jobId, 'agent_note', 'handoff', `Handoff wrote pack ${attempt}.`);

    const shot = v.fidelity?.screenshots[0];
    if (shot) await channel.sendFile(shot, 'The React code rendered with real Moon styling, at 375 px');
    await channel.sendFile(codeFile, 'Screen.tsx');
    const buttons: Button[] = v.pass ? [APPROVE, REJECT, STOP] : [REJECT, { id: 'override', label: 'Approve anyway' }, STOP];
    const g = await kit.gate('handoff', stepId, `${parsed.narrative}\n\nVerification: ${verifySummary(v)}`, { file: specFile, caption: 'Handoff spec', buttons });

    if (g.decision !== 'reject') {
      const out = 'final/handoff';
      kit.w(`${out}/spec.md`, spec);
      kit.w(`${out}/Screen.tsx`, code);
      kit.w(`${out}/verify.md`, verifyMarkdown(v));
      if (v.renderHtmlFile) kit.w(`${out}/react-render.html`, fs.readFileSync(v.renderHtmlFile));
      for (const s of v.fidelity?.screenshots ?? []) kit.w(`${out}/shots/${path.basename(s)}`, fs.readFileSync(s));
      return { pass: v.pass, overridden: g.decision === 'override' };
    }
    feedback = g.reason;
    store.remember('handoff', 'jimmy-note', (g.reason ?? '').slice(0, 120));
    if (++humanRounds > opts.maxHumanRounds) throw new StopJob('The Handoff step was sent back too many times.');
    autoFixes = 0;
  }
}

async function brandHandoff(kit: JobKit, result: BrandResult): Promise<HandoffResult> {
  const { deps, opts } = kit;
  const { store } = deps;
  const seq = kit.nextSeq();
  const check = (file: string) => {
    const abs = path.join(kit.dir, file);
    if (!fs.existsSync(abs)) return { ok: false, bytes: 0 };
    const [sizeId] = path.relative('final/assets', file).split(path.sep);
    const want = SIZE_BY_ID.get(sizeId ?? '');
    const got = pngSize(abs);
    return { ok: !!want && got.width === want.width && got.height === want.height, bytes: fs.statSync(abs).size };
  };
  const facts = buildBrandFacts(result, check);
  const allOk = facts.files.every((f) => f.ok);
  store.log(kit.jobId, allOk ? 'review_pass' : 'review_reject', 'handoff', `Checked ${facts.files.length} files: ${allOk ? 'all present and the exact size' : 'some are missing or the wrong size'}.`);

  let attempt = 0;
  let humanRounds = 0;
  let feedback: string | undefined;
  for (;;) {
    attempt++;
    if (attempt > 10) throw new StopJob('The Handoff step went round too many times.');
    const text = await kit.callAgent('handoff', { ...kit.baseCtx(), attempt, feedback, handoffKind: 'brand', facts: brandFactsText(facts), factsData: { ...facts, provider: result.provider } });
    if (attempt > 1) store.log(kit.jobId, 'fix', 'handoff', `Handoff produced attempt ${attempt}.`, { attempt });
    const narrative = parseHandoff(text).narrative;
    const spec = brandSpecMarkdown({ jobId: kit.jobId, facts, narrative });
    const specFile = kit.w(`attempts/handoff-pack-${attempt}/asset-spec.md`, spec);
    const stepId = store.addStep(kit.jobId, seq, 'handoff', attempt, specFile);
    store.log(kit.jobId, 'agent_note', 'handoff', `Handoff wrote asset spec ${attempt}.`);
    const buttons: Button[] = allOk ? [APPROVE, REJECT, STOP] : [REJECT, { id: 'override', label: 'Approve anyway' }, STOP];
    const g = await kit.gate('handoff', stepId, `${narrative}\n\nChecked ${facts.files.length} files: ${allOk ? 'all present and the exact pixel size' : 'PROBLEMS found, see the spec'}.`, { file: specFile, caption: 'Asset spec', buttons });
    if (g.decision !== 'reject') {
      kit.w('final/handoff/asset-spec.md', spec);
      return { pass: allOk, overridden: g.decision === 'override' };
    }
    feedback = g.reason;
    store.remember('handoff', 'jimmy-note', (g.reason ?? '').slice(0, 120));
    if (++humanRounds > opts.maxHumanRounds) throw new StopJob('The Handoff step was sent back too many times.');
  }
}
