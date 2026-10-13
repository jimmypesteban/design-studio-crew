import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { parseUi } from '../src/agents/parse.ts';
import { buildRequest } from '../src/agents/registry.ts';
import { makeTools } from '../src/agents/tools.ts';
import type { AgentRequest, LLM, LLMResult, ToolRunner } from '../src/agents/types.ts';
import { loadConfig } from '../src/config.ts';
import { convertToReact } from '../src/handoff/convert.ts';
import { parseHandoff } from '../src/handoff/step.ts';
import { textParity, verifyReact } from '../src/handoff/verify.ts';
import { MockLLM } from '../src/llm/mock.ts';
import { loadMoonTokens, type MoonTokens } from '../src/moon/tokens.ts';
import { runJob } from '../src/pipeline.ts';
import { makeDeps } from './helpers.ts';

const cfg = loadConfig();
let tokens: MoonTokens;
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'handoff-test-'));
before(async () => {
  tokens = await loadMoonTokens(cfg.moonPath);
});

/** The clean markup the mock UI agent builds for a brief. */
async function fragmentFor(brief: string): Promise<string> {
  const ctx = { jobId: 'j', brief, attempt: 1, notes: {}, flaggedRules: [], seedFlaw: false, tokens, memory: [] };
  const res = await new MockLLM().run(buildRequest(cfg.agentsDir, 'ui', ctx), makeTools(tokens), 1);
  return parseUi(res.text).html;
}

const check = (name: string, tsx: string, fragment: string, componentName: string) =>
  verifyReact({ dir: path.join(tmp, name), moonPath: cfg.moonPath, chromePath: cfg.chromePath, tokens, tsx, componentName, expectedFragment: fragment, title: name });

// ---------- converter ----------

test('converter maps recipe classes to the real Moon components and props', () => {
  const html = `<div class="mo-container mo-section"><div class="mo-stack mo-gap-6">
    <h1 class="mo-h4">Hi <strong>there</strong>, friend</h1>
    <form class="mo-card" action="#" method="post"><div class="mo-card__body mo-stack mo-gap-4">
      <div class="mo-field"><label class="mo-label" for="email">Email</label><input class="mo-input" id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com"><span class="mo-help">We never share it.</span></div>
      <div class="mo-field"><label class="mo-label" for="pw">Password</label><input class="mo-input mo-input--error" id="pw" name="pw" type="password"><span class="mo-error">Too short</span></div>
      <label class="mo-check"><input type="checkbox" name="terms"><span class="mo-body-sm">I agree</span></label>
      <button class="mo-btn mo-btn--primary mo-btn--lg mo-btn--block" type="submit">Go</button></div></form>
    <div class="mo-card"><div class="mo-card__header"><h2 class="mo-h7">Title</h2></div><div class="mo-card__body">Body</div><div class="mo-card__footer"><a class="mo-btn mo-btn--outline mo-btn--sm" href="#x">More</a></div></div>
    <span class="mo-badge mo-badge--success">Done</span><span class="mo-badge mo-badge--neutral">Plain</span>
    <div class="mo-alert mo-alert--danger"><span><strong>Oops.</strong> Try again.</span></div>
    <div class="mo-progress" role="progressbar" aria-valuenow="40"><div class="mo-progress__bar" style="width:40%"></div></div>
    <span class="mo-avatar" aria-hidden="true">AR</span>
    <div class="mo-grid mo-grid--2 mo-gap-4"><p class="mo-muted">a</p></div>
  </div></div>`;
  const c = convertToReact(html, 'Sign up now');
  assert.equal(c.componentName, 'SignUpNow');
  assert.deepEqual(c.unmapped, []);
  assert.deepEqual(c.components, { Alert: 1, Avatar: 1, Badge: 2, Button: 2, Card: 2, Checkbox: 1, Container: 1, Input: 2, ProgressBar: 1 });
  const t = c.tsx;
  assert.match(t, /import \{ Alert, Avatar, Badge, Button, Card, Checkbox, Container, Input, ProgressBar \} from 'moon-design-system';/);
  assert.match(t, /<Input label="Email" helperText="We never share it\." id="email" name="email" type="email" autoComplete="email" placeholder="you@example\.com" \/>/);
  assert.match(t, /error="Too short"/);
  assert.match(t, /<Checkbox name="terms" label="I agree" \/>/);
  assert.match(t, /<Button variant="primary" size="lg" fullWidth type="submit">Go<\/Button>/);
  assert.match(t, /<Button asChild variant="outline" size="sm">/);
  assert.match(t, /<Card title="Title" footer=\{<>/);
  assert.match(t, /<Badge variant="success" size="sm">Done<\/Badge>/);
  assert.match(t, /<Badge size="sm">Plain<\/Badge>/); // neutral is Moon's default variant
  assert.match(t, /<Alert variant="danger">/);
  assert.match(t, /<ProgressBar value=\{40\} \/>/);
  assert.match(t, /<Avatar initials="AR" \/>/);
  assert.match(t, /<form action="#" method="post">/);
  assert.match(t, /<h1 className="font-heading text-mo-h4 font-bold">Hi <strong>there<\/strong>, friend<\/h1>/); // inline spacing survives
  assert.match(t, /grid-cols-\[repeat\(auto-fit,minmax\(min\(100%,360px\),1fr\)\)\]/);
  assert.equal(/grid-cols-\[repeat\(auto-fit,minmax\(min\(100%,260px\)/.test(t), false); // the wider variant replaces the base
  assert.ok(c.differences.some((d) => /Card renders its title as an h3/.test(d)));
  assert.equal(/[\u2014\u2013]/.test(t), false);
});

test('converter reports what it cannot map instead of guessing, and escapes JSX characters', () => {
  const c = convertToReact('<div class="mo-weird mo-stack"><p>Use {braces} &amp; &lt;tags&gt;</p></div>', 'x');
  assert.deepEqual(c.unmapped, ['mo-weird']);
  assert.match(c.tsx, /Use \{"\{"\}braces\{"\}"\} &amp; &lt;tags&gt;/);
  assert.equal(convertToReact('<p>hi</p>', '12 weeks!').componentName, 'Screen');
});

test('parseHandoff splits the written spec from optional code', () => {
  const a = parseHandoff('## Purpose\nx\n\n```tsx\nexport const A = 1;\n```');
  assert.equal(a.narrative, '## Purpose\nx');
  assert.equal(a.tsx, 'export const A = 1;\n');
  assert.equal(parseHandoff('## Purpose\nx').tsx, undefined);
});

// ---------- verification ----------

test('text parity finds missing words and tolerates extras from Moon components', () => {
  const ok = textParity('<p>Hello brave world</p>', '<div><a>Skip to content</a><p>Hello brave world</p><span>70%</span></div>');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.extra, ['70%']);
  const bad = textParity('<p>Hello brave world</p>', '<div><a>Skip to content</a><p>Hello world</p></div>');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ['brave']);
});

test('converted code for every screen type type checks, renders, keeps every word and holds up at three widths', async () => {
  const briefs: [string, string][] = [
    ['dashboard', 'A weekly progress screen for a student.'],
    ['auth', 'A sign up screen for students.'],
    ['signin', 'A log in screen for returning learners.'],
    ['catalog', 'A course catalog with search and level filters.'],
    ['landing', 'A welcome landing page for a learning app.'],
  ];
  for (const [name, brief] of briefs) {
    const fragment = await fragmentFor(brief);
    const conv = convertToReact(fragment, name);
    const v = await check(name, conv.tsx, fragment, conv.componentName);
    assert.equal(v.typecheck.ok, true, `${name} typecheck: ${v.typecheck.errors.join(' | ')}`);
    assert.equal(v.render.ok, true, `${name} render: ${v.render.errors.join(' | ')}`);
    assert.equal(v.parity.ok, true, `${name} parity: ${v.parity.errors.join(' | ')}`);
    assert.deepEqual(v.fidelityBlocking.map((i) => `${i.rule}: ${i.detail}`), [], `${name} layout`);
    assert.equal(v.pass, true);
    assert.equal(v.fidelity?.screenshots.length, 3);
    assert.deepEqual(conv.unmapped, [], name);
  }
});

test('verification catches broken code: a wrong prop, a lost word, and a layout that breaks on a phone', async () => {
  const fragment = await fragmentFor('A welcome landing page for a learning app.');
  const conv = convertToReact(fragment, 'Welcome');

  const wrongProp = await check('bad-prop', conv.tsx.replace('variant="highlight"', 'variant="neon"'), fragment, conv.componentName);
  assert.equal(wrongProp.typecheck.ok, false);
  assert.match(wrongProp.typecheck.errors.join(' '), /neon/);
  assert.equal(wrongProp.pass, false);
  assert.match(wrongProp.render.detail, /Skipped/);

  const lostWord = await check('lost-word', conv.tsx.replace('Learn a little every day', 'Learn every day'), fragment, conv.componentName);
  assert.equal(lostWord.parity.ok, false);
  assert.ok(lostWord.parity.missing.includes('little'));

  const widthBug = await check('wide', conv.tsx.replace('<main id="main">', '<main id="main">\n<div className="w-[600px] bg-mo-red p-4">Wide block</div>'), fragment, conv.componentName);
  assert.equal(widthBug.typecheck.ok, true);
  assert.equal(widthBug.parity.ok, true); // extra words are tolerated, only missing ones fail
  assert.equal(widthBug.pass, false);
  assert.ok(widthBug.fidelityBlocking.some((i) => i.rule === 'horizontal-overflow' && i.widths.includes(375)), JSON.stringify(widthBug.fidelityBlocking));
});

// ---------- the Handoff step in a job ----------

const SCREEN_BRIEF = 'A weekly progress screen for a student: streak, lessons done, next lesson, and a kind nudge.';

test('Handoff: offered after approval, verified, sent back once with a reason, then approved. Everything is logged and saved', async () => {
  const ctx = await makeDeps({ script: ['approve', 'approve', 'approve', 'approve', 'handoff', 'reject', 'Say which Moon components are used in the build notes.', 'approve'] });
  const res = await runJob(ctx.deps, SCREEN_BRIEF, { seedFlaw: false });
  assert.equal(res.status, 'done');
  assert.equal(res.handoff?.pass, true);
  assert.equal(res.handoff?.overridden, false);
  const text = ctx.channel.transcript.join('\n');
  assert.match(text, /Want the Handoff pack/);
  assert.match(text, /Verification: Type check pass, server render pass, text match pass, layout at 375, 768 and 1024 px pass/);

  const ev = ctx.store.events(res.jobId);
  assert.equal(ev.filter((e) => e.type === 'rejection' && e.role === 'handoff').length, 1);
  assert.ok(ev.some((e) => e.type === 'fix' && e.role === 'handoff'));
  assert.ok(ev.some((e) => e.type === 'review_pass' && e.role === 'handoff' && /Converter draft/.test(e.message)));

  for (const f of ['final/handoff/spec.md', 'final/handoff/Screen.tsx', 'final/handoff/verify.md', 'final/handoff/react-render.html', 'final/handoff/shots/width-375.png', 'attempts/handoff-0/Screen.tsx']) {
    assert.ok(fs.existsSync(path.join(res.dir, f)), `missing ${f}`);
  }
  const spec = fs.readFileSync(path.join(res.dir, 'final/handoff/spec.md'), 'utf8');
  for (const h of ['## Purpose', '## Components', '## Tokens used', '## Behaviour at each width', '## States', '## Differences from the approved screen', '## Verification', '## How to use it']) assert.ok(spec.includes(h), h);
  assert.match(spec, /Grid `[^`]+`: 1 column at 375 px, 2 columns at 768 px, 3 columns at 1024 px/);
  assert.match(spec, /Card renders its title as an h3/);
  assert.equal(/[\u2014\u2013]/.test(spec + text), false);
  const code = fs.readFileSync(path.join(res.dir, 'final/handoff/Screen.tsx'), 'utf8');
  assert.match(code, /from 'moon-design-system'/);
  assert.equal(/#[0-9a-fA-F]{6}\b/.test(code), false); // no raw colours in the code
});

test('Handoff: declining the offer finishes the job without a pack', async () => {
  const ctx = await makeDeps({ script: ['approve', 'approve', 'approve', 'approve', 'skip'] });
  const res = await runJob(ctx.deps, SCREEN_BRIEF, { seedFlaw: false });
  assert.equal(res.status, 'done');
  assert.equal(res.handoff, undefined);
  assert.equal(fs.existsSync(path.join(res.dir, 'final/handoff')), false);
});

test('Handoff: when the brief asks for code, it is part of the route and is not offered', async () => {
  const ctx = await makeDeps({ script: ['approve', 'approve', 'approve', 'approve', 'approve'] });
  const res = await runJob(ctx.deps, SCREEN_BRIEF + ' Give me the React code too.', { seedFlaw: false });
  assert.equal(res.status, 'done');
  assert.ok(res.handoff);
  assert.equal(ctx.channel.transcript.join('\n').includes('Want the Handoff pack'), false);
});

/** A Handoff agent that supplies code which does not compile. */
class BadCodeLLM implements LLM {
  mode = 'mock' as const;
  inner = new MockLLM();
  handoffCalls = 0;
  async run(req: AgentRequest, tools: ToolRunner, budget: number): Promise<LLMResult> {
    if (req.role === 'handoff' && req.ctx.handoffKind === 'ui') {
      this.handoffCalls++;
      const r = await this.inner.run(req, tools, budget);
      return { ...r, text: r.text + '\n\n```tsx\nimport { Button } from \'moon-design-system\';\nexport function Broken() { return <Button variant="neon">x</Button>; }\nexport default Broken;\n```' };
    }
    return this.inner.run(req, tools, budget);
  }
}

test('Handoff: agent code that fails verification is sent back with the errors, then the verified converter code is kept', async () => {
  const llm = new BadCodeLLM();
  const ctx = await makeDeps({ llm, script: ['approve', 'approve', 'approve', 'approve', 'handoff', 'approve'] });
  const res = await runJob(ctx.deps, SCREEN_BRIEF, { seedFlaw: false });
  assert.equal(res.status, 'done');
  assert.equal(res.handoff?.pass, true);
  assert.equal(llm.handoffCalls, 4); // the first try plus three fixes
  const ev = ctx.store.events(res.jobId);
  assert.equal(ev.filter((e) => e.type === 'review_reject' && e.role === 'handoff').length, 4);
  assert.ok(ev.some((e) => /Kept the verified converter code/.test(e.message)));
  const code = fs.readFileSync(path.join(res.dir, 'final/handoff/Screen.tsx'), 'utf8');
  assert.equal(code.includes('Broken'), false);
  assert.match(fs.readFileSync(path.join(res.dir, 'final/handoff/spec.md'), 'utf8'), /The converter version/);
});

test('Handoff for brand assets: checks every file, writes the asset spec, and logs the approval', async () => {
  const ctx = await makeDeps({ script: ['approve', 'approve', 'approve', 'approve', 'handoff', 'approve'] });
  const res = await runJob(ctx.deps, 'Autumn term campaign. Make 2 variations of a social post. The headline is "Learn a little every day".', { seedFlaw: false });
  assert.equal(res.status, 'done');
  assert.equal(res.handoff?.pass, true);
  const spec = fs.readFileSync(path.join(res.dir, 'final/handoff/asset-spec.md'), 'utf8');
  for (const h of ['## Usage', '## Production notes', '## Sizes', '## Files', '## Variations and alt text', '## Naming', '## Source and rights']) assert.ok(spec.includes(h), h);
  assert.equal((spec.match(/final\/assets\/[a-z-]+\/v\d\.png/g) ?? []).length, 10); // 2 variations x 5 sizes
  assert.match(spec, /placeholder art/);
  assert.equal(spec.includes('PROBLEM'), false);
  assert.equal(/[\u2014\u2013]/.test(spec), false);
});
