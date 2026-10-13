import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { wrapScreen } from '../src/moon/recipes.ts';
import { loadMoonTokens, type MoonTokens } from '../src/moon/tokens.ts';
import { reviewScreen } from '../src/reviewer/index.ts';

const cfg = loadConfig();
let tokens: MoonTokens;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-test-'));

before(async () => {
  tokens = await loadMoonTokens(cfg.moonPath);
});

async function review(name: string, main: string) {
  const file = path.join(tmp, `${name}.html`);
  fs.writeFileSync(file, wrapScreen(tokens, name, main));
  return reviewScreen({ htmlFile: file, tokens, chromePath: cfg.chromePath, shotsDir: path.join(tmp, `shots-${name}`) });
}
const rules = (r: Awaited<ReturnType<typeof review>>) => new Set(r.issues.filter((i) => i.severity === 'fail').map((i) => i.rule));

test('a page using every passing recipe is accepted at all three widths', async () => {
  const r = await review(
    'golden',
    `<div class="mo-container mo-section"><div class="mo-stack mo-gap-6">
      <h1 class="mo-h3">Kitchen sink</h1>
      <p class="mo-body mo-muted">Muted text on the canvas.</p>
      <div class="mo-row mo-gap-2">
        <a class="mo-btn mo-btn--primary" href="#a">Primary</a><a class="mo-btn mo-btn--highlight" href="#a">Highlight</a>
        <a class="mo-btn mo-btn--accent" href="#a">Accent</a><a class="mo-btn mo-btn--ghost" href="#a">Ghost</a>
        <a class="mo-btn mo-btn--outline" href="#a">Outline</a><a class="mo-btn mo-btn--soft" href="#a">Soft</a><a class="mo-btn mo-btn--info" href="#a">Info</a>
      </div>
      <div class="mo-row mo-gap-2"><span class="mo-badge mo-badge--neutral">Neutral</span><span class="mo-badge mo-badge--success">Success</span><span class="mo-badge mo-badge--warning">Warning</span><span class="mo-badge mo-badge--danger">Danger</span><span class="mo-badge mo-badge--info">Info</span></div>
      <div class="mo-alert mo-alert--success">Success alert</div><div class="mo-alert mo-alert--warning">Warning alert</div>
      <div class="mo-alert mo-alert--danger">Danger alert</div><div class="mo-alert mo-alert--info">Info alert</div>
      <div class="mo-card"><div class="mo-card__header"><h2 class="mo-h7">Card</h2></div><div class="mo-card__body mo-stack mo-gap-4">
        <div class="mo-field"><label class="mo-label" for="x">Label</label><input id="x" class="mo-input" type="text"><span class="mo-help">Help text</span></div>
        <div class="mo-field"><label class="mo-label" for="y">With error</label><input id="y" class="mo-input mo-input--error" type="text"><span class="mo-error">Error text</span></div>
        <label class="mo-check"><input type="checkbox"><span class="mo-body-sm">Check me</span></label></div></div>
      <section class="mo-surface-dark mo-pad-6"><p class="mo-body">On the dark surface</p></section>
      <section class="mo-surface-brand mo-pad-6"><p class="mo-body">On the brand surface</p></section>
      <div class="mo-grid mo-gap-4"><div class="mo-card mo-pad-4">One</div><div class="mo-card mo-pad-4">Two</div><div class="mo-card mo-pad-4">Three</div></div>
    </div></div>`,
  );
  assert.deepEqual([...rules(r)], [], JSON.stringify(r.issues, null, 1));
  assert.equal(r.pass, true);
  assert.deepEqual(r.widths, [375, 768, 1024]);
  assert.equal(r.screenshots.length, 3);
  assert.ok(r.screenshots.every((s) => fs.statSync(s).size > 2000));
});

test('Moon secondary and tertiary buttons are rejected on contrast with the measured ratio', async () => {
  const r = await review(
    'moon-buttons',
    `<div class="mo-container mo-section"><h1 class="mo-h4">Buttons</h1>
     <a class="mo-btn mo-btn--secondary" href="#a">Secondary</a> <a class="mo-btn mo-btn--tertiary" href="#a">Tertiary</a></div>`,
  );
  assert.equal(r.pass, false);
  const contrast = r.issues.filter((i) => i.rule === 'contrast');
  assert.equal(contrast.length, 2);
  assert.ok(contrast.some((c) => /2\.91:1/.test(c.detail)), contrast.map((c) => c.detail).join(' | '));
  assert.ok(contrast.some((c) => /3\.95:1/.test(c.detail)));
});

test('a bad page is rejected with the right rule names, reasons and fixes', async () => {
  const r = await review(
    'bad',
    `<div class="mo-container mo-section">
      <div style="width:520px;background:#3b82f6;color:#fff;padding:7px;border-radius:6px;font-size:13px">Fixed width, raw hex</div>
      <p class="mo-body" style="color:var(--mo-grey-5)">Faint helper text</p>
      <span class="my-custom-class">Unknown class</span>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <input type="text">
      <h1 class="mo-h4">One</h1><h1 class="mo-h4">Two</h1>
    </div>`,
  );
  const got = rules(r);
  for (const rule of ['contrast', 'horizontal-overflow', 'off-palette', 'off-grid', 'off-scale-radius', 'off-scale-type', 'unknown-class', 'missing-alt', 'missing-label']) {
    assert.ok(got.has(rule), `expected ${rule}, got ${[...got].join(', ')}`);
  }
  const overflow = r.issues.find((i) => i.rule === 'horizontal-overflow')!;
  assert.deepEqual(overflow.widths, [375]); // 520px only overflows the phone
  assert.match(overflow.detail, /\d+px past the 375px/);
  assert.ok(r.issues.every((i) => i.fix.length > 10));
  assert.ok(r.issues.some((i) => i.rule === 'h1-count' && i.severity === 'warn'));
});

test('hiding overflow on the body does not hide the problem', async () => {
  const r = await review(
    'hidden-overflow',
    `<div class="mo-container mo-section"><div style="min-width:600px" class="mo-card mo-pad-4">Wide card</div></div>
     <style>html,body{overflow-x:hidden}</style>`,
  );
  assert.ok(rules(r).has('horizontal-overflow'));
});

test('tiny tap targets and overlapping text are caught', async () => {
  const r = await review(
    'hit-collide',
    `<div class="mo-container mo-section">
      <h1 class="mo-h4">Tap</h1>
      <button class="mo-btn mo-btn--primary" style="min-height:0;padding:2px 4px;height:16px" type="button">x</button>
      <div style="position:relative;height:40px"><p class="mo-body" style="position:absolute;left:0;top:0">First line of text</p><p class="mo-body" style="position:absolute;left:4px;top:6px">Second line of text</p></div>
    </div>`,
  );
  const got = rules(r);
  assert.ok(got.has('hit-target'), [...got].join(','));
  assert.ok(got.has('text-collision'), [...got].join(','));
});

test('clipped content is a defect, unless it is decorative and hidden from assistive technology', async () => {
  const strip = (aria: string) =>
    `<div class="mo-container mo-section"><h1 class="mo-h4">Marquee</h1>
     <div ${aria} style="overflow:hidden;width:100%"><div style="display:flex;width:max-content"><span class="mo-body">Screens, brand assets, audits and handoff, again and again and again and again and again and again and again</span></div></div></div>`;
  const decorative = await review('marquee-decorative', strip('aria-hidden="true"'));
  assert.equal(rules(decorative).has('content-clipped'), false, JSON.stringify(decorative.issues));
  const real = await review('marquee-real', strip(''));
  assert.ok(rules(real).has('content-clipped'), 'the same clipping on real content is still rejected');
});
