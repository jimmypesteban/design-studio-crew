import path from 'node:path';
import { parseUi } from './agents/parse.ts';
import type { IssueLite } from './agents/types.ts';
import { APPROVE, REJECT, STOP } from './channel/types.ts';
import { StopJob, trim, type JobKit } from './job.ts';
import { wrapScreen } from './moon/recipes.ts';
import { reportMarkdown, reviewScreen, type ReviewReport } from './reviewer/index.ts';

export interface UiResult {
  html: string;
  /** The inside of <main>, as the UI agent wrote it. */
  fragment: string;
  report: ReviewReport;
  overridden: boolean;
}

/** The UI agent builds, the Reviewer checks, and Jimmy approves. */
export async function uiStep(kit: JobKit, screenName: string): Promise<UiResult> {
  const { deps, opts } = kit;
  const { cfg, store, channel, tokens } = deps;
  const seq = kit.nextSeq();
  let attempt = 0;
  let autoFixes = 0;
  let humanRounds = 0;
  let feedback: string | undefined;
  let issues: IssueLite[] | undefined;

  for (;;) {
    attempt++;
    if (attempt > 12) throw new StopJob('The UI step went round too many times.');
    const text = await kit.callAgent('ui', { ...kit.baseCtx(), attempt, feedback, issues });
    if (attempt > 1) {
      const why = issues?.length ? `the Reviewer's points (${[...new Set(issues.map((i) => i.rule))].join(', ')})` : `Jimmy's note`;
      store.log(kit.jobId, 'fix', 'ui', `UI produced attempt ${attempt} to answer ${why}.`, { attempt });
    }

    let ui;
    try {
      ui = parseUi(text);
    } catch (e) {
      issues = [{ rule: 'format', where: 'reply', detail: (e as Error).message, fix: 'Reply with the note, then the markup in one html fence.' }];
      store.log(kit.jobId, 'review_reject', 'reviewer', `Could not read the UI reply: ${(e as Error).message}`);
      if (++autoFixes > opts.maxAutoFixes) throw new StopJob('The UI agent kept returning an unreadable reply.');
      continue;
    }

    const html = wrapScreen(tokens, screenName, ui.html);
    const htmlFile = kit.w(`attempts/ui-${attempt}.html`, html);
    const noteFile = kit.w(`attempts/ui-${attempt}.md`, `# UI note, attempt ${attempt}\n\n${ui.note}\n`);
    const stepId = store.addStep(kit.jobId, seq, 'ui', attempt, noteFile);
    store.log(kit.jobId, 'agent_note', 'ui', `UI built attempt ${attempt}.`);

    const report = await reviewScreen({
      htmlFile,
      tokens,
      chromePath: cfg.chromePath,
      shotsDir: path.join(kit.dir, 'attempts', `shots-${attempt}`),
    });
    kit.w(`attempts/review-${attempt}.md`, reportMarkdown(report));
    kit.w(`attempts/review-${attempt}.json`, JSON.stringify(report, null, 2));

    const fails = report.issues.filter((i) => i.severity === 'fail');
    if (!report.pass) {
      for (const f of fails) {
        kit.flagged.add(f.rule);
        store.remember('ui', f.rule, f.fix);
      }
      const summary = fails.map((f) => `${f.rule}: ${f.detail}`).join(' | ');
      store.log(kit.jobId, 'review_reject', 'reviewer', `Rejected attempt ${attempt}. ${summary}`, {
        attempt,
        rules: [...new Set(fails.map((f) => f.rule))],
      });
      store.decideStep(stepId, 'rejected', summary);
      await channel.say(
        `Reviewer rejected UI attempt ${attempt} (${fails.length} to fix).\n` +
          fails.slice(0, 6).map((f) => `- ${f.rule}: ${f.detail}\n  Fix: ${f.fix}`).join('\n'),
      );
      if (autoFixes < opts.maxAutoFixes) {
        autoFixes++;
        issues = fails.map((f) => ({ rule: f.rule, where: f.where, detail: f.detail, fix: f.fix }));
        feedback = undefined;
        continue;
      }
    } else {
      store.log(kit.jobId, 'review_pass', 'reviewer', `Passed attempt ${attempt}. ${report.warns} notes, ${report.elementsChecked} elements checked.`, { attempt });
    }

    const shot375 = report.screenshots[0];
    const body = `${ui.note}\n\nReviewer: ${report.pass ? 'PASS' : `REJECTED, ${fails.length} problems remain`}. Checked ${report.elementsChecked} elements at ${report.widths.join(', ')} px.`;
    if (shot375) await channel.sendFile(shot375, `Attempt ${attempt} at 375 px`);
    const buttons = report.pass ? [APPROVE, REJECT, STOP] : [REJECT, { id: 'override', label: 'Approve anyway' }, STOP];
    const g = await kit.gate('ui', stepId, body, { file: htmlFile, caption: `Screen, attempt ${attempt}`, buttons });

    if (g.decision === 'approve') return { html, fragment: ui.html, report, overridden: false };
    if (g.decision === 'override') return { html, fragment: ui.html, report, overridden: true };

    feedback = g.reason;
    if (++humanRounds > opts.maxHumanRounds) throw new StopJob('The UI step was sent back too many times.');
    store.remember('ui', 'jimmy-note', trim(g.reason ?? '', 120));
    autoFixes = 0;
    issues = undefined;
  }
}
