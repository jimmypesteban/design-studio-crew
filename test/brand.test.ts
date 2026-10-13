import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { composeAssetHtml } from '../src/brand/compose.ts';
import { generateImage, RateGate } from '../src/brand/gemini.ts';
import { GeminiImages, MockImages, type ImageProvider, type ImageRequest, type ImageResult } from '../src/brand/images.ts';
import { imageNeeds, parsePlan, validatePlan, type BrandPlan } from '../src/brand/plan.ts';
import { SIZE_BY_ID, SIZES } from '../src/brand/sizes.ts';
import { loadConfig } from '../src/config.ts';
import { paletteRgbSet, loadMoonTokens, type MoonTokens } from '../src/moon/tokens.ts';
import { runJob } from '../src/pipeline.ts';
import { pngSize, reviewAssets } from '../src/reviewer/index.ts';
import { makeDeps } from './helpers.ts';
import { parseHex } from '../src/moon/contrast.ts';

const cfg = loadConfig();
let tokens: MoonTokens;
before(async () => {
  tokens = await loadMoonTokens(cfg.moonPath);
});

const BRIEF = 'Autumn term campaign for a learning app. Make 3 variations of a social post in the standard sizes. The headline is "Learn a little every day".';
const GOOD: BrandPlan = {
  campaign: 'Autumn',
  message: { headline: 'Learn a little every day', subline: 'Short lessons that fit a busy week.', cta: 'Start learning' },
  variations: [
    { id: 'v1', name: 'Sunrise', theme: 'sunrise', concept: 'Warm hills.', image_prompt: 'Warm sunrise over hills.', palette: ['mo-yellow-2'], panel: 'mo-grey-1', text: 'mo-black', cta_variant: 'primary' },
    { id: 'v2', name: 'Forest', theme: 'forest', concept: 'Green hills.', image_prompt: 'Green hills.', palette: ['mo-green-2'], panel: 'mo-forest', text: 'mo-white', cta_variant: 'highlight' },
  ],
  sizes: ['ig-square', 'link-landscape', 'banner-wide'],
};

// ---------- plan ----------

test('a good plan validates and sizes that share a ratio share an image', () => {
  assert.deepEqual(validatePlan(GOOD, tokens, 12), []);
  const needs = imageNeeds(GOOD, tokens);
  // 2 variations x 2 ratios (1:1 and 16:9). link-landscape and banner-wide share the 16:9 image.
  assert.equal(needs.length, 4);
  assert.equal(new Set(needs.map((n) => n.key)).size, 4);
});

test('changing an image prompt changes its key, changing layout does not', () => {
  const a = imageNeeds(GOOD, tokens).map((n) => n.key);
  const layoutOnly = imageNeeds({ ...GOOD, type_overrides: { 'banner-wide': 'mo-h6' }, variations: GOOD.variations.map((v) => ({ ...v, text: 'mo-ocean' })) }, tokens).map((n) => n.key);
  assert.deepEqual(a, layoutOnly);
  const edited = imageNeeds({ ...GOOD, variations: [GOOD.variations[0]!, { ...GOOD.variations[1]!, image_prompt: 'A calmer green hill.' }] }, tokens).map((n) => n.key);
  assert.equal(edited.filter((k) => !a.includes(k)).length, 2); // only v2's two ratios are new
});

test('every plan rule is enforced with a plain reason', () => {
  const bad: BrandPlan = {
    ...GOOD,
    message: { headline: 'x'.repeat(41), subline: 'y'.repeat(91), cta: '' },
    variations: [
      { ...GOOD.variations[0]!, id: 'V 1', panel: 'mo-not-real', cta_variant: 'secondary', image_prompt: '' },
      { ...GOOD.variations[0]!, id: 'dup' },
      { ...GOOD.variations[0]!, id: 'dup' },
    ],
    sizes: ['ig-square', 'huge'],
    type_overrides: { 'ig-square': 'mo-h1', nope: 'mo-h2' },
  };
  const errs = validatePlan(bad, tokens, 12).join(' | ');
  for (const s of ['headline is 41', 'subline is 91', 'button text must be', 'lowercase letters', 'not a Moon colour token', 'must be one of primary', 'no image prompt', 'used twice', 'Unknown size "huge"', 'Type override "mo-h1"', 'unknown size "nope"']) {
    assert.ok(errs.includes(s), `missing: ${s}\n${errs}`);
  }
  assert.match(validatePlan(GOOD, tokens, 3).join(' '), /needs 4 images and the most one job may generate is 3/);
});

test('parsePlan reads a fenced plan and rejects nonsense', () => {
  const { plan, note } = parsePlan('Some note.\n\n```json\n' + JSON.stringify(GOOD) + '\n```');
  assert.equal(plan.variations.length, 2);
  assert.equal(note, 'Some note.');
  assert.throws(() => parsePlan('no plan here'), /readable plan/);
});

// ---------- Gemini client ----------

function reply(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const OK_BODY = { modelVersion: 'gemini-test', candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') } }] } }] };
const noGate = new RateGate(1000);

test('gemini: the key goes in a header, never the URL, and a good reply yields the image', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const res = await generateImage({ prompt: 'a hill', aspectRatio: '16:9' }, {
    model: 'gemini-test', apiKey: 'AIza-test-secret-key-value', gate: noGate,
    fetch: async (url, init) => { seen = { url: String(url), init: init! }; return new Response(JSON.stringify(OK_BODY)); },
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.toString(), 'PNGDATA');
    assert.equal(res.mime, 'image/png');
  }
  assert.equal(seen!.url.includes('AIza'), false);
  assert.equal((seen!.init.headers as Record<string, string>)['x-goog-api-key'], 'AIza-test-secret-key-value');
  assert.match(String(seen!.init.body), /"aspectRatio":"16:9"/);
  assert.match(String(seen!.init.body), /"responseModalities":\["TEXT","IMAGE"\]/);
});

test('gemini: every failure is sorted into a plain kind and never leaks the key', async () => {
  const key = 'AIza-test-secret-key-value';
  const call = (f: typeof fetch, apiKey: string | undefined = key) => generateImage({ prompt: 'p', aspectRatio: '1:1' }, { model: 'm', apiKey, fetch: f, gate: noGate });
  const kinds: [string, Awaited<ReturnType<typeof call>>][] = [
    ['billing', await call(reply(402, { error: { message: `Your prepayment credits are depleted. key ${key}` } }) as never)],
    ['billing', await call(reply(429, { error: { message: 'quota exceeded, free_tier_requests, limit: 0' } }) as never)],
    ['rate_limited', await call(reply(429, { error: { message: 'slow down' } }) as never)],
    ['auth', await call(reply(403, { error: { message: 'API key not valid' } }) as never)],
    ['filtered', await call(reply(400, { error: { message: 'blocked by safety policy' } }) as never)],
    ['filtered', await call(reply(200, { promptFeedback: { blockReason: 'SAFETY' } }) as never)],
    ['filtered', await call(reply(200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }) as never)],
    ['config', await call(reply(404, { error: { message: 'model not found' } }) as never)],
    ['upstream', await call(reply(500, { error: { message: 'boom' } }) as never)],
    ['upstream', await call(reply(200, { candidates: [{ content: { parts: [{ text: 'no image' }] } }] }) as never)],
    ['timeout', await call((async () => { throw new DOMException('t', 'TimeoutError'); }) as never)],
    ['network', await call((async () => { throw new Error(`connect failed ${key}`); }) as never)],
    ['config', await call(reply(200, OK_BODY) as never, '')],
    ['invalid_input', await generateImage({ prompt: 'x'.repeat(801), aspectRatio: '1:1' }, { model: 'm', apiKey: key, fetch: reply(200, OK_BODY) as never, gate: noGate })],
  ];
  for (const [kind, r] of kinds) {
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, kind, JSON.stringify(r));
      assert.equal(JSON.stringify(r).includes('secret-key-value'), false, 'the key leaked');
    }
  }
});

test('gemini: the rate gate waits instead of failing', async () => {
  let t = 0;
  const slept: number[] = [];
  const gate = new RateGate(2, 1000, () => t, async (ms) => { slept.push(ms); t += ms; });
  await gate.wait();
  await gate.wait();
  await gate.wait(); // third call in the same window has to wait
  assert.equal(slept.length, 1);
  assert.ok(slept[0]! >= 1000);
});

test('GeminiImages retries a transient failure once, and never retries a filtered one', async () => {
  let calls = 0;
  const flaky: typeof fetch = async () => (++calls === 1 ? new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }) : new Response(JSON.stringify(OK_BODY)));
  const ok = await new GeminiImages('m', 0.05, { fetch: flaky, apiKey: 'k-test-key-123', gate: noGate, retryDelayMs: 0 }).generate({ key: 'k', prompt: 'p', aspectRatio: '1:1', theme: 't', index: 0 });
  assert.equal(ok.ok, true);
  assert.equal(calls, 2);

  calls = 0;
  const filtered: typeof fetch = async () => (calls++, new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })));
  const no = await new GeminiImages('m', 0.05, { fetch: filtered, apiKey: 'k-test-key-123', gate: noGate, retryDelayMs: 0 }).generate({ key: 'k', prompt: 'p', aspectRatio: '1:1', theme: 't', index: 0 });
  assert.equal(no.ok, false);
  assert.equal(calls, 1);
});

test('placeholder art uses only Moon colours', async () => {
  const img = await new MockImages(tokens).generate({ key: 'k', prompt: 'p', aspectRatio: '16:9', theme: 'sunrise', index: 0 });
  assert.ok(img.ok);
  if (!img.ok) return;
  const hexes = [...img.data.toString().matchAll(/(?:stop-color|fill)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]!);
  assert.ok(hexes.length >= 4);
  const pal = paletteRgbSet(tokens);
  for (const h of hexes) assert.ok(pal.has(parseHex(h).join(',')), `${h} is not a Moon colour`);
});

// ---------- composed assets and the Reviewer ----------

async function review(plan: BrandPlan, image?: { mime: string; data: Buffer }) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'asset-test-'));
  const img = image ?? (await new MockImages(tokens).generate({ key: 'k', prompt: 'p', aspectRatio: '1:1', theme: 'sunrise', index: 0 }));
  assert.ok('data' in img);
  const items = plan.variations.flatMap((v) =>
    plan.sizes.map((sizeId) => {
      const html = path.join(tmp, sizeId, `${v.id}.html`);
      fs.mkdirSync(path.dirname(html), { recursive: true });
      fs.writeFileSync(html, composeAssetHtml(tokens, plan, v, SIZE_BY_ID.get(sizeId)!, img as { mime: string; data: Buffer }));
      return { id: `${sizeId}/${v.id}`, sizeId, htmlFile: html, pngFile: path.join(tmp, sizeId, `${v.id}.png`) };
    }),
  );
  return reviewAssets({ items, tokens, chromePath: cfg.chromePath });
}

test('a good plan passes at every size and writes PNGs at the exact pixel size', async () => {
  const all: BrandPlan = { ...GOOD, sizes: SIZES.map((s) => s.id) };
  const out = await review(all);
  assert.equal(out.length, 10);
  for (const r of out) {
    assert.deepEqual(r.issues.filter((i) => i.severity === 'fail'), [], `${r.id}: ${JSON.stringify(r.issues)}`);
    const want = SIZE_BY_ID.get(r.sizeId)!;
    assert.deepEqual(pngSize(r.pngFile), { width: want.width, height: want.height });
  }
});

test('low contrast, an oversized headline and text in the safe zone are all rejected with numbers', async () => {
  const bad: BrandPlan = {
    ...GOOD,
    variations: [{ ...GOOD.variations[0]!, text: 'mo-grey-5' }],
    sizes: ['display-medium'],
    type_overrides: { 'display-medium': 'mo-h2' },
  };
  const [r] = await review(bad);
  const rules = new Set(r!.issues.filter((i) => i.severity === 'fail').map((i) => i.rule));
  for (const rule of ['contrast', 'content-cut-off', 'outside-safe-zone']) assert.ok(rules.has(rule), `${rule} missing: ${[...rules]}`);
  assert.match(r!.issues.find((i) => i.rule === 'contrast')!.detail, /2\.3:1/);
  assert.match(r!.issues.find((i) => i.rule === 'content-cut-off')!.detail, /\d+px past the top edge/);
  assert.equal(r!.pass, false);
});

test('text that is too small for its canvas is rejected with the number it needs', async () => {
  const tiny: BrandPlan = { ...GOOD, variations: [GOOD.variations[0]!], sizes: ['ig-square'], type_overrides: { 'ig-square': 'mo-h7' } };
  // The headline override makes the headline 20px, and the subline is swapped for 14px text.
  const html = composeAssetHtml(tokens, tiny, tiny.variations[0]!, SIZE_BY_ID.get('ig-square')!, { mime: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" width="4" height="4"><rect width="4" height="4" fill="#F5F4F0"/></svg>') })
    .replace('class="mo-h6"', 'class="mo-body-sm"');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'small-test-'));
  const htmlFile = path.join(dir, 'a.html');
  fs.writeFileSync(htmlFile, html);
  const [r] = await reviewAssets({ items: [{ id: 'ig-square/v1', sizeId: 'ig-square', htmlFile, pngFile: path.join(dir, 'a.png') }], tokens, chromePath: cfg.chromePath });
  const small = r!.issues.find((i) => i.rule === 'text-too-small');
  assert.ok(small, JSON.stringify(r!.issues));
  assert.match(small!.detail, /\d+px on a 1080 px wide asset.*at least 21\.6px/);
  assert.ok(r!.issues.filter((i) => i.rule === 'text-too-small').length >= 2); // the headline override and the shrunk subline
});

test('artwork far from the Moon palette earns a note, not a block', async () => {
  const lime = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="#00FF00"/></svg>');
  const [r] = await review({ ...GOOD, variations: [GOOD.variations[0]!], sizes: ['ig-square'] }, { mime: 'image/svg+xml', data: lime });
  const drift = r!.issues.find((i) => i.rule === 'image-palette-drift');
  assert.ok(drift, JSON.stringify(r!.issues));
  assert.equal(drift!.severity, 'warn');
  assert.equal(r!.pass, true);
});

// ---------- the Brand step in a job ----------

/** Records when each image is requested, relative to what Jimmy had been shown and had approved. */
class SpyImages implements ImageProvider {
  name = 'mock' as const;
  model = 'spy';
  calls: ImageRequest[] = [];
  firstCallTranscriptLength = -1;
  inner: MockImages;
  constructor(tokens: MoonTokens, public estUsd = 0, private onCall?: () => void, private override?: (r: ImageRequest) => ImageResult | undefined) {
    this.inner = new MockImages(tokens);
  }
  async generate(req: ImageRequest): Promise<ImageResult> {
    if (!this.calls.length) this.onCall?.();
    this.calls.push(req);
    return this.override?.(req) ?? this.inner.generate(req);
  }
}

test('Brand: nothing is generated until the plan is approved, layout fixes reuse images, and only changed prompts cost new ones', async () => {
  let spy!: SpyImages;
  const ctx = await makeDeps({ script: ['approve', 'approve', 'approve', 'reject', 'Make the second variation calmer and less busy.', 'approve', 'approve'] });
  spy = new SpyImages(tokens, 0, () => (spy.firstCallTranscriptLength = ctx.channel.transcript.length));
  ctx.deps.images = spy;
  const res = await runJob(ctx.deps, BRIEF, { offerHandoff: false });
  assert.equal(res.status, 'done');
  assert.equal(res.kind, 'brand');

  // The plan was shown and approved before the first image was requested
  const before = ctx.channel.transcript.slice(0, spy.firstCallTranscriptLength).join('\n');
  assert.match(before, /Brand proposes/);
  assert.match(before, /Nothing is generated until you approve/);
  assert.match(before, /Images to generate: 12 new/);
  const planAt = before.lastIndexOf('Brand proposes');
  assert.match(before.slice(planAt), /Jimmy pressed: Approve/);

  // 12 images first. The Reviewer's layout fix made none. Jimmy's note changed one variation's prompt: 4 new images.
  assert.equal(spy.calls.length, 16);
  assert.equal(new Set(spy.calls.map((c) => c.key)).size, 16);

  const ev = ctx.store.events(res.jobId).map((e) => e.type);
  assert.equal(ev.filter((t) => t === 'review_reject').length, 1);
  assert.equal(ev.filter((t) => t === 'rejection').length, 1);
  assert.equal(ev.filter((t) => t === 'fix').length, 2);
  assert.equal(ev.filter((t) => t === 'approval').length, 5); // route, strategy, plan, new images, final

  // Deliverables
  const manifest = JSON.parse(fs.readFileSync(path.join(res.dir, 'final/manifest.json'), 'utf8'));
  assert.equal(manifest.assets.length, 15);
  assert.equal(manifest.reviewer.passed, true);
  assert.equal(manifest.imageSource.provider, 'mock');
  assert.match(manifest.imageSource.note, /Placeholder/);
  for (const a of manifest.assets) {
    const want = SIZE_BY_ID.get(a.sizeId)!;
    assert.deepEqual(pngSize(path.join(res.dir, a.file)), { width: want.width, height: want.height });
  }
  for (const f of ['final/contact-sheet.png', 'final/plan.json', 'final/review.md', 'attempts/brand-review-1.md']) assert.ok(fs.existsSync(path.join(res.dir, f)), f);
  assert.match(fs.readFileSync(path.join(res.dir, 'attempts/brand-review-1.md'), 'utf8'), /REJECTED/);
  assert.equal(/[\u2014\u2013]/.test([...ctx.channel.transcript, fs.readFileSync(path.join(res.dir, 'log.md'), 'utf8')].join('\n')), false);
  assert.ok(ctx.store.recall('brand').some((m) => m.key === 'contrast'));
});

test('Brand: stopping at the plan gate generates nothing', async () => {
  const ctx = await makeDeps({ script: ['approve', 'approve', 'stop'] });
  const spy = new SpyImages(tokens);
  ctx.deps.images = spy;
  const res = await runJob(ctx.deps, BRIEF, { offerHandoff: false });
  assert.equal(res.status, 'stopped');
  assert.equal(spy.calls.length, 0);
});

test('Brand: the image cap rejects an oversized plan before anything is generated', async () => {
  const ctx = await makeDeps({ script: ['approve', 'approve'], maxImages: 6 });
  const spy = new SpyImages(tokens);
  ctx.deps.images = spy;
  const res = await runJob(ctx.deps, BRIEF, { offerHandoff: false });
  assert.equal(res.status, 'stopped');
  assert.equal(spy.calls.length, 0);
  assert.ok(ctx.store.events(res.jobId).some((e) => e.type === 'info' && /needs 12 images and the most one job may generate is 6/.test(e.message)));
});

test('Brand: the cost cap asks before images are made and stops cleanly', async () => {
  const ctx = await makeDeps({ script: ['approve', 'approve', 'approve', 'stop'], maxUsd: 1 });
  const spy = new SpyImages(tokens, 0.5); // 12 images would be about $6
  ctx.deps.images = spy;
  const res = await runJob(ctx.deps, BRIEF, { offerHandoff: false });
  assert.equal(res.status, 'stopped');
  assert.equal(spy.calls.length, 0);
  assert.ok(ctx.store.events(res.jobId).some((e) => e.type === 'cost_cap'));
  assert.ok(ctx.channel.transcript.join('\n').includes('Estimated cost: $6.00'));
});

test('Brand: images are charged to the job and logged when a provider has a price', async () => {
  const ctx = await makeDeps({ script: ['approve', 'approve', 'approve', 'approve'], maxUsd: 10 });
  ctx.deps.images = new SpyImages(tokens, 0.05);
  const res = await runJob(ctx.deps, BRIEF, { offerHandoff: false, seedFlaw: false });
  assert.equal(res.status, 'done');
  assert.ok(Math.abs((ctx.store.getJob(res.jobId)?.cost_usd ?? 0) - 12 * 0.05) < 1e-9);
  assert.equal(ctx.store.events(res.jobId).filter((e) => e.type === 'cost').length, 12);
});

test('Brand: a billing failure stops the job in plain words, a filtered image sends the prompt back', async () => {
  const billing = await makeDeps({ script: ['approve', 'approve', 'approve'] });
  billing.deps.images = new SpyImages(tokens, 0, undefined, () => ({ ok: false, kind: 'billing', message: 'Out of prepaid Gemini credits.' }));
  const r1 = await runJob(billing.deps, BRIEF, { offerHandoff: false });
  assert.equal(r1.status, 'stopped');
  assert.match(billing.channel.transcript.join('\n'), /Out of prepaid Gemini credits/);

  const filtered = await makeDeps({ script: ['approve', 'approve', 'approve', 'approve', 'approve', 'approve', 'approve'] });
  filtered.deps.images = new SpyImages(tokens, 0, undefined, (r) => (r.key.startsWith('v1-') ? { ok: false, kind: 'filtered', message: 'Blocked by the safety filters.' } : undefined));
  const r2 = await runJob(filtered.deps, BRIEF, { offerHandoff: false });
  assert.equal(r2.status, 'stopped'); // the mock agent never rewords the prompt, so it gives up after its retries
  assert.match(filtered.channel.transcript.join('\n'), /withheld .* image/);
  assert.ok(filtered.store.events(r2.jobId).some((e) => /image-filtered|failed \(filtered\)/.test(e.message)));
});
