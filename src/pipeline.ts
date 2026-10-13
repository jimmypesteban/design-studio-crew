import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseLead, type LeadPlan } from './agents/parse.ts';
import { auditStep, type AuditResult } from './audit/step.ts';
import { findTarget } from './audit/target.ts';
import { brandStep, type BrandResult } from './brand/step.ts';
import { handoffStep } from './handoff/step.ts';
import type { EventRow } from './db.ts';
import { createKit, DEFAULT_OPTIONS, StopJob, type Deps, type JobKit, type JobOptions } from './job.ts';
import { studioCss } from './moon/recipes.ts';
import { clean, slug } from './plain.ts';
import { contrastTableMarkdown, reportMarkdown } from './reviewer/index.ts';
import { uiStep, type UiResult } from './ui-step.ts';

export type { Deps, JobOptions } from './job.ts';
export { DEFAULT_OPTIONS } from './job.ts';

export interface JobResult {
  jobId: string;
  dir: string;
  status: 'done' | 'stopped' | 'not_built' | 'failed';
  kind?: string;
  reviewPassed?: boolean;
  overridden?: boolean;
  finalHtml?: string;
  handoff?: { pass: boolean; overridden: boolean };
  audit?: AuditResult;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function runJob(deps: Deps, brief: string, options: Partial<JobOptions> = {}): Promise<JobResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { cfg, store, llm, channel, tokens } = deps;
  const jobId = `job-${stamp()}-${slug(brief, 24)}-${crypto.randomBytes(2).toString('hex')}`;
  const dir = path.join(cfg.outDir, jobId);
  for (const sub of ['notes', 'attempts', 'final']) fs.mkdirSync(path.join(dir, sub), { recursive: true });

  store.createJob(jobId, brief, llm.mode);
  const kit = createKit(deps, jobId, dir, opts);
  kit.w('brief.md', `# Brief\n\n${clean(brief).trim()}\n`);

  let result: Partial<JobResult> = {};

  try {
    store.log(jobId, 'info', null, `Mode: ${llm.mode}, images: ${deps.images.name}. Cost cap $${cfg.maxUsd.toFixed(2)}.`);
    await channel.say(`Got it. Job ${jobId} started in ${llm.mode} mode. I will propose each step and wait for you.`);

    // 1. Studio Lead
    let plan: LeadPlan | undefined;
    const leadText = await kit.textStep('lead', 'Studio Lead route', (t) => {
      try {
        plan = parseLead(t);
      } catch {
        return t;
      }
      return `Kind: ${plan.kind}\nScreen: ${plan.screen_name}\nRoute: ${plan.route.join(', ') || 'none'}\nWhy: ${plan.summary}${plan.questions.length ? `\nQuestions: ${plan.questions.join(' ')}` : ''}`;
    });
    kit.notes.lead = leadText;
    plan = parseLead(leadText);
    store.setJob(jobId, { kind: plan.kind });
    store.log(jobId, 'route', 'lead', `Route: ${plan.kind} via ${plan.route.join(', ')}.`, plan);
    result.kind = plan.kind;

    if (plan.kind === 'unclear') {
      const msg = 'The brief is not clear enough to route. Send a fuller brief and I will try again.';
      await channel.say(msg);
      store.setJob(jobId, { status: 'not_built' });
      store.log(jobId, 'job_stopped', 'lead', msg);
      return finish('not_built');
    }

    if (plan.kind === 'audit') {
      const target = findTarget(brief, opts.attachments, cfg);
      if (!target) {
        throw new StopJob('I need something to audit. Send a web address, a screenshot, or the name of an HTML file in samples/ or out/.');
      }
      const audit = await auditStep(kit, target);
      result = { ...result, reviewPassed: audit.pass, audit };
      return finishDone();
    }

    let ui: UiResult | undefined;
    let brand: BrandResult | undefined;
    kit.notes.strategist = await kit.textStep('strategist', 'Strategy note', (t) => t);

    if (plan.kind === 'ui') {
      kit.notes.ux = await kit.textStep('ux', 'UX note', (t) => t);
      ui = await uiStep(kit, plan.screen_name);
      writeUiFinal(kit, ui);
      result = { ...result, reviewPassed: ui.report.pass, overridden: ui.overridden, finalHtml: path.join(dir, 'final', 'screen.html') };
    } else {
      brand = await brandStep(kit);
      result = { ...result, reviewPassed: brand.reviewPassed, overridden: brand.overridden };
    }

    // 2. Handoff: part of the route, or offered once the work is approved
    let doHandoff = plan.route.includes('handoff');
    if (!doHandoff && opts.offerHandoff) {
      const what = plan.kind === 'ui' ? 'a spec and React code that uses the real Moon components, checked by tools' : 'a production spec with sizes, naming, usage and alt text';
      const a = await channel.ask(`${plan.kind === 'ui' ? 'The screen is' : 'The assets are'} approved. Want the Handoff pack? It is ${what}.`, [
        { id: 'handoff', label: 'Yes, build the handoff pack' },
        { id: 'skip', label: 'No, finish here' },
      ]);
      doHandoff = a === 'handoff';
    }
    if (doHandoff) {
      const h = plan.kind === 'ui' ? await handoffStep(kit, { kind: 'ui', screenName: plan.screen_name, html: ui!.html, fragment: ui!.fragment, report: ui!.report }) : await handoffStep(kit, { kind: 'brand', result: brand! });
      result.handoff = h;
    }

    return finishDone();
  } catch (e) {
    if (e instanceof StopJob) {
      store.setJob(jobId, { status: 'stopped' });
      store.log(jobId, 'job_stopped', null, e.why);
      await channel.say(`Job stopped. ${e.why}`);
      return finish('stopped');
    }
    const msg = clean((e as Error).message);
    store.setJob(jobId, { status: 'failed' });
    store.log(jobId, 'job_stopped', null, `Failed: ${msg}`);
    await channel.say(`Something went wrong and the job stopped: ${msg}`);
    return finish('failed');
  }

  async function finishDone(): Promise<JobResult> {
    store.setJob(jobId, { status: 'done' });
    store.log(jobId, 'job_done', null, result.audit ? `Audit approved. The target ${result.audit.verdict === 'pass' ? 'passed' : result.audit.verdict === 'limited' ? 'got a limited check, which is not a pass' : `was rejected with ${result.audit.fails} to fix`}.` : `Approved. Review ${result.reviewPassed ? 'passed' : 'did not pass, approved by override'}.`);
    const ev = store.events(jobId);
    const count = (t: string) => ev.filter((x) => x.type === t).length;
    await channel.say(
      `Done. Files are in out/${jobId}/final/${result.audit ? 'audit/' : ''}. Reviewer rejections: ${count('review_reject')}. Your rejections: ${count('rejection')}. Fixes logged: ${count('fix')}. Cost: $${(store.getJob(jobId)?.cost_usd ?? 0).toFixed(2)}.`,
    );
    return finish('done');
  }

  function finish(status: JobResult['status']): JobResult {
    const job = store.getJob(jobId);
    kit.w('log.md', formatLog(job?.brief ?? brief, store.events(jobId)));
    kit.w('job.json', JSON.stringify({ job, steps: store.listSteps(jobId), events: store.events(jobId).length }, null, 2));
    return { jobId, dir, ...result, status };
  }
}

function writeUiFinal(kit: JobKit, ui: UiResult): void {
  const { tokens } = kit.deps;
  kit.w('final/screen.html', ui.html);
  kit.w('final/moon.css', studioCss(tokens));
  kit.w('final/review.md', reportMarkdown(ui.report));
  kit.w('final/review.json', JSON.stringify(ui.report, null, 2));
  kit.w('final/contrast-table.md', contrastTableMarkdown(tokens));
  for (const s of ui.report.screenshots) {
    kit.w(`final/shots/${path.basename(s)}`, fs.readFileSync(s));
  }
}

export function formatLog(brief: string, events: EventRow[]): string {
  const lines = ['# Job log', '', `Brief: ${clean(brief).replace(/\s+/g, ' ')}`, '', 'Every approval, rejection and fix, in order.', ''];
  for (const e of events) {
    const time = e.ts.slice(11, 19);
    lines.push(`- ${time} [${e.type}]${e.role ? ` ${e.role}:` : ''} ${e.message}`);
  }
  return lines.join('\n') + '\n';
}
