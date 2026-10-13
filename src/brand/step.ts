import fs from 'node:fs';
import path from 'node:path';
import { APPROVE, REJECT, STOP, type Button } from '../channel/types.ts';
import { StopJob, trim, type JobKit } from '../job.ts';
import { assetReportMarkdown, reviewAssets, screenshotHtml, type AssetItem, type AssetReview } from '../reviewer/index.ts';
import { composeAssetHtml, contactSheetHtml } from './compose.ts';
import { extFor, type ImageResult } from './images.ts';
import { imageNeeds, parsePlan, planSummary, validatePlan, type BrandPlan, type ImageNeed } from './plan.ts';
import { SIZE_BY_ID } from './sizes.ts';
import type { IssueLite } from '../agents/types.ts';

export interface BrandAsset {
  file: string; // relative to the job folder
  sizeId: string;
  variationId: string;
  width: number;
  height: number;
  bytes: number;
  reviewPassed: boolean;
}

export interface BrandResult {
  plan: BrandPlan;
  assets: BrandAsset[];
  reviews: AssetReview[];
  reviewPassed: boolean;
  overridden: boolean;
  imagesGenerated: number;
  estimatedImageUsd: number;
  provider: string;
  model: string;
}

const MAX_ATTEMPTS = 12;

export async function brandStep(kit: JobKit): Promise<BrandResult> {
  const { deps, opts } = kit;
  const { cfg, store, channel, tokens, images } = deps;
  const seq = kit.nextSeq();
  const n = String(seq).padStart(2, '0');

  const cache = new Map<string, { mime: string; data: Buffer; file: string; need: ImageNeed }>();
  let generated = 0;
  let attempt = 0;
  let autoFixes = 0;
  let humanRounds = 0;
  let feedback: string | undefined;
  let issues: IssueLite[] | undefined;
  let previousPlan: string | undefined;

  const retry = (why: string) => {
    if (++autoFixes > opts.maxAutoFixes) throw new StopJob(`The Brand agent could not produce a usable plan: ${why}`);
  };

  for (;;) {
    attempt++;
    if (attempt > MAX_ATTEMPTS) throw new StopJob('The Brand step went round too many times.');

    // 1. The agent proposes a plan
    const text = await kit.callAgent('brand', { ...kit.baseCtx(), attempt, feedback, issues, previousPlan });
    if (attempt > 1) {
      const why = issues?.length ? `the Reviewer's points (${[...new Set(issues.map((i) => i.rule))].join(', ')})` : `Jimmy's note`;
      store.log(kit.jobId, 'fix', 'brand', `Brand produced plan ${attempt} to answer ${why}.`, { attempt });
    }
    let parsed;
    try {
      parsed = parsePlan(text);
    } catch (e) {
      issues = [{ rule: 'plan-format', where: 'reply', detail: (e as Error).message, fix: 'Reply with a short note and the plan as JSON in one json fence.' }];
      store.log(kit.jobId, 'info', 'brand', `Could not read the plan: ${(e as Error).message}`);
      retry('unreadable plan');
      continue;
    }
    const { plan, note } = parsed;
    const errors = validatePlan(plan, tokens, cfg.maxImages);
    const planFile = kit.w(`attempts/brand-plan-${attempt}.json`, JSON.stringify(plan, null, 2));
    const noteFile = kit.w(`attempts/brand-${attempt}.md`, `# Brand note, attempt ${attempt}\n\n${note}\n`);
    if (errors.length) {
      store.log(kit.jobId, 'info', 'brand', `Plan ${attempt} did not pass the plan checks: ${errors.join(' | ')}`);
      issues = errors.map((e) => ({ rule: 'plan-invalid', where: 'plan', detail: e, fix: 'Revise the plan so it passes this check.' }));
      previousPlan = JSON.stringify(plan, null, 2);
      feedback = undefined;
      retry('plan checks');
      continue;
    }
    previousPlan = JSON.stringify(plan, null, 2);
    const stepId = store.addStep(kit.jobId, seq, 'brand', attempt, noteFile);
    store.log(kit.jobId, 'agent_note', 'brand', `Brand wrote plan ${attempt}.`);

    // 2. Approval before any image is made
    const needs = imageNeeds(plan, tokens);
    const missing = needs.filter((x) => !cache.has(x.key));
    const estUsd = missing.length * images.estUsd;
    if (missing.length) {
      const g = await kit.gate('brand', stepId, `${note}\n\n${planSummary(plan, needs, needs.length - missing.length, estUsd, images.name === 'mock' ? 'placeholder art (no cost)' : `${images.model}`)}`, {
        file: planFile,
        caption: `Plan ${attempt}`,
        buttons: [APPROVE, REJECT, STOP],
      });
      if (g.decision === 'reject') {
        feedback = g.reason;
        issues = undefined;
        store.remember('brand', 'jimmy-note', trim(g.reason ?? '', 120));
        if (++humanRounds > opts.maxHumanRounds) throw new StopJob('The Brand step was sent back too many times.');
        continue;
      }
      await kit.ensureBudget(estUsd, 'brand');

      // 3. Generate only what is missing
      const failures: { need: ImageNeed; res: Extract<ImageResult, { ok: false }> }[] = [];
      await channel.say(`Making ${missing.length} image${missing.length === 1 ? '' : 's'} with ${images.name === 'mock' ? 'placeholder art' : images.model}.`);
      for (const [i, need] of missing.entries()) {
        const res = await images.generate({ key: need.key, prompt: need.prompt, aspectRatio: need.ratio, theme: need.theme, index: i });
        if (!res.ok) {
          store.log(kit.jobId, 'info', 'brand', `Image ${need.key} failed (${res.kind}): ${res.message}`, { kind: res.kind, detail: res.detail });
          if (res.kind === 'filtered') {
            failures.push({ need, res });
            continue;
          }
          // Billing, key, config and exhausted retries need a person, not a rewrite.
          throw new StopJob(`Image generation stopped: ${res.message}${res.detail ? ` (${res.detail})` : ''}`);
        }
        const file = kit.w(`attempts/images/${need.key}.${extFor(res.mime)}`, res.data);
        cache.set(need.key, { mime: res.mime, data: res.data, file, need });
        generated++;
        if (images.estUsd > 0) kit.charge(images.estUsd, 'brand', `Generated image ${need.key}.`, { model: res.model });
      }
      if (failures.length) {
        issues = failures.map((f) => ({
          rule: 'image-filtered',
          where: f.need.variationId,
          detail: `The image model withheld the artwork for ${f.need.variationId} (${f.need.ratio}): ${f.res.message}`,
          fix: 'Rewrite that image_prompt in calmer, simpler words. Do not mention people, brands or anything sensitive.',
        }));
        feedback = undefined;
        await channel.say(`The image model withheld ${failures.length} image${failures.length === 1 ? '' : 's'}. Brand will reword the prompt and ask you again.`);
        retry('images were filtered');
        continue;
      }
    }

    // 4. Compose every asset and hold it to the standard
    const dirRel = `attempts/assets-${attempt}`;
    const items: AssetItem[] = [];
    for (const v of plan.variations) {
      for (const sizeId of plan.sizes) {
        const size = SIZE_BY_ID.get(sizeId)!;
        const need = needs.find((x) => x.variationId === v.id && x.ratio === size.genRatio)!;
        const img = cache.get(need.key)!;
        const htmlFile = kit.w(`${dirRel}/${sizeId}/${v.id}.html`, composeAssetHtml(tokens, plan, v, size, img));
        items.push({ id: `${sizeId}/${v.id}`, sizeId, htmlFile, pngFile: path.join(kit.dir, dirRel, sizeId, `${v.id}.png`) });
      }
    }
    const reviews = await reviewAssets({ items, tokens, chromePath: cfg.chromePath });
    kit.w(`attempts/brand-review-${attempt}.md`, assetReportMarkdown(reviews));
    kit.w(`attempts/brand-review-${attempt}.json`, JSON.stringify(reviews, null, 2));
    const failing = reviews.filter((r) => !r.pass);
    const allPass = failing.length === 0;

    if (!allPass) {
      const fails = failing.flatMap((r) => r.issues.filter((i) => i.severity === 'fail').map((i) => ({ r, i })));
      for (const { i } of fails) {
        kit.flagged.add(i.rule);
        store.remember('brand', i.rule, i.fix);
      }
      const rules = [...new Set(fails.map((f) => f.i.rule))];
      store.log(kit.jobId, 'review_reject', 'reviewer', `Rejected ${failing.length} of ${reviews.length} assets in attempt ${attempt}. Rules: ${rules.join(', ')}.`, { attempt, rules, assets: failing.map((r) => r.id) });
      store.decideStep(stepId, 'rejected', `${failing.length} assets failed: ${rules.join(', ')}`);
      await channel.say(
        `Reviewer rejected ${failing.length} of ${reviews.length} assets (attempt ${attempt}).\n` +
          fails.slice(0, 6).map((f) => `- ${f.r.id}: ${f.i.rule}. ${f.i.detail}\n  Fix: ${f.i.fix}`).join('\n'),
      );
      if (autoFixes < opts.maxAutoFixes) {
        autoFixes++;
        issues = fails.map((f) => ({ rule: f.i.rule, where: `${f.r.id}: ${f.i.where}`, detail: f.i.detail, fix: f.i.fix }));
        feedback = undefined;
        continue;
      }
    } else {
      const warns = reviews.reduce((a, r) => a + r.issues.length, 0);
      store.log(kit.jobId, 'review_pass', 'reviewer', `Passed all ${reviews.length} assets in attempt ${attempt}. ${warns} notes.`, { attempt });
    }

    // 5. Show Jimmy the sheet
    const sheetItems = items.map((it) => ({ label: it.id, file: path.relative(path.join(kit.dir, dirRel), it.pngFile) }));
    const sheetHtml = kit.w(`${dirRel}/contact-sheet.html`, contactSheetHtml('Contact sheet', sheetItems));
    const sheetPng = path.join(kit.dir, dirRel, 'contact-sheet.png');
    await screenshotHtml({ htmlFile: sheetHtml, pngFile: sheetPng, chromePath: cfg.chromePath, width: 1200 });
    await channel.sendFile(sheetPng, `All ${reviews.length} assets, attempt ${attempt}`);
    const body = `${note}\n\nReviewer: ${allPass ? `PASS, all ${reviews.length} assets` : `REJECTED, ${failing.length} of ${reviews.length} still fail`}.\nImages generated so far: ${generated}${images.estUsd > 0 ? ` (about $${(generated * images.estUsd).toFixed(2)})` : ''}.`;
    const buttons: Button[] = allPass ? [APPROVE, REJECT, STOP] : [REJECT, { id: 'override', label: 'Approve anyway' }, STOP];
    const g = await kit.gate('brand', stepId, body, { file: noteFile, caption: `Brand notes, attempt ${attempt}`, buttons });

    if (g.decision === 'reject') {
      feedback = g.reason;
      issues = undefined;
      autoFixes = 0;
      store.remember('brand', 'jimmy-note', trim(g.reason ?? '', 120));
      if (++humanRounds > opts.maxHumanRounds) throw new StopJob('The Brand step was sent back too many times.');
      continue;
    }

    // 6. Approved. Write the deliverables.
    const assets: BrandAsset[] = [];
    for (const r of reviews) {
      const [sizeId, variationId] = r.id.split('/') as [string, string];
      const rel = `final/assets/${sizeId}/${variationId}.png`;
      kit.w(rel, fs.readFileSync(r.pngFile));
      assets.push({ file: rel, sizeId, variationId, width: r.actual.width, height: r.actual.height, bytes: fs.statSync(r.pngFile).size, reviewPassed: r.pass });
    }
    for (const c of cache.values()) {
      if (needs.some((x) => x.key === c.need.key)) kit.w(`final/source-images/${path.basename(c.file)}`, fs.readFileSync(c.file));
    }
    kit.w('final/plan.json', JSON.stringify(plan, null, 2));
    kit.w('final/review.md', assetReportMarkdown(reviews));
    fs.copyFileSync(sheetPng, path.join(kit.dir, 'final', 'contact-sheet.png'));
    kit.w(
      'final/manifest.json',
      JSON.stringify(
        {
          job: kit.jobId,
          campaign: plan.campaign,
          message: plan.message,
          imageSource: { provider: images.name, model: images.model, imagesGenerated: generated, estimatedUsd: Math.round(generated * images.estUsd * 100) / 100, note: images.name === 'mock' ? 'Placeholder art, not final artwork.' : 'Generated by an image model. Confirm usage rights before publishing.' },
          reviewer: { passed: allPass, overridden: g.decision === 'override' },
          assets,
          variations: plan.variations.map((v) => ({ id: v.id, name: v.name, concept: v.concept, panel: v.panel, text: v.text, imagePrompt: v.image_prompt })),
        },
        null,
        2,
      ),
    );
    return {
      plan,
      assets,
      reviews,
      reviewPassed: allPass,
      overridden: g.decision === 'override',
      imagesGenerated: generated,
      estimatedImageUsd: generated * images.estUsd,
      provider: images.name,
      model: images.model,
    };
  }
}
