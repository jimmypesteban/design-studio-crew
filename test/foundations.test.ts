import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { composite, contrastRatio, parseHex, requiredRatio, toHex } from '../src/moon/contrast.ts';
import { allowedClasses, recipesCss, studioCss } from '../src/moon/recipes.ts';
import { contrastTable, loadMoonTokens, safeTextOn } from '../src/moon/tokens.ts';
import { clean, plain, scrub, slug } from '../src/plain.ts';
import { loadConfig, ROOT } from '../src/config.ts';
import { Store } from '../src/db.ts';

const cfg = loadConfig();

test('contrast math matches known answers', () => {
  // Black on white is exactly 21:1 and white on white is 1:1. These are the
  // known answers every contrast tool must reproduce before it is trusted.
  assert.equal(Math.round(contrastRatio(parseHex('#000000'), parseHex('#FFFFFF')) * 100) / 100, 21);
  assert.equal(contrastRatio(parseHex('#FFFFFF'), parseHex('#FFFFFF')), 1);
  // A published reference pair: #767676 on white is 4.54:1, the lightest grey that passes AA.
  const r = contrastRatio(parseHex('#767676'), parseHex('#FFFFFF'));
  assert.ok(r > 4.5 && r < 4.6, `got ${r}`);
  assert.equal(toHex(parseHex('#abc')), '#AABBCC');
  assert.equal(requiredRatio(14, 400), 4.5);
  assert.equal(requiredRatio(24, 400), 3);
  assert.equal(requiredRatio(19, 700), 3);
  assert.deepEqual(composite([0, 0, 0], 0.5, [255, 255, 255]).map(Math.round), [128, 128, 128]);
});

test('Moon tokens load from the real repo', async () => {
  const t = await loadMoonTokens(cfg.moonPath);
  assert.equal(t.colors['mo-red'], '#B82431');
  assert.equal(t.colors['mo-red-6'], '#B82431');
  assert.equal(t.colors['mo-grey-2'], '#F5F4F0');
  assert.ok(Object.keys(t.colors).length > 100);
  assert.equal(t.radius['mo-sm'], '12px');
  await assert.rejects(() => loadMoonTokens('/nowhere/moon'), /MOON_PATH/);
});

test('every var(--...) in the recipes is defined by the tokens', async () => {
  const t = await loadMoonTokens(cfg.moonPath);
  const css = studioCss(t);
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = [...recipesCss(t).matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!);
  const missing = [...new Set(used)].filter((u) => !defined.has(u));
  assert.deepEqual(missing, []);
});

test('recipes contain no raw colours', async () => {
  const t = await loadMoonTokens(cfg.moonPath);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(recipesCss(t)), false);
  assert.ok(allowedClasses(recipesCss(t)).includes('mo-btn--primary'));
});

test('the contrast table agrees with the numbers Moon documents', async () => {
  const t = await loadMoonTokens(cfg.moonPath);
  const row = (fg: string, bg: string) => contrastTable(t).find((r) => r.fg === fg && r.bg === bg)!;
  assert.equal(row('mo-white', 'mo-blue').normalText, false); // secondary button label fails AA
  assert.equal(row('mo-white', 'mo-red').normalText, true); // primary button label passes
  assert.ok(safeTextOn(t, 'mo-grey-2').includes('mo-black'));
});

test('plain() removes em dashes and en dashes and scrub() removes secrets', () => {
  const dirty = 'one \u2014 two \u2013 three, 5\u20139';
  const out = plain(dirty);
  assert.equal(/[\u2014\u2013]/.test(out), false);
  assert.ok(out.includes('5 to 9'));
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-secret-value';
  assert.equal(scrub('key is sk-ant-test-secret-value ok').includes('sk-ant'), false);
  assert.equal(clean('a \u2014 sk-ant-test-secret-value').includes('sk-ant'), false);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(slug('Hello, World! A very long title that keeps going and going', 20).length <= 20, true);
});

test('store logs, steps, memory and cost', () => {
  const s = new Store(':memory:');
  s.createJob('j1', 'brief \u2014 text', 'mock');
  s.log('j1', 'rejection', 'ui', 'bad \u2014 thing', { a: 1 });
  s.addCost('j1', 0.25);
  const id = s.addStep('j1', 1, 'ui', 1, null);
  s.decideStep(id, 'rejected', 'reason');
  s.remember('ui', 'contrast', 'use mo-muted');
  s.remember('ui', 'contrast', 'use mo-muted');
  assert.equal(s.getJob('j1')?.cost_usd, 0.25);
  assert.equal(s.events('j1').length, 2);
  assert.equal(s.events('j1').some((e) => /[\u2014\u2013]/.test(e.message)), false);
  assert.equal(s.recall('ui')[0]?.count, 2);
  assert.equal(s.listSteps('j1')[0]?.status, 'rejected');
});

test('no em dashes or en dashes anywhere in the project files', () => {
  const skip = new Set(['node_modules', 'out', 'data', '.git']);
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|md|json|css|html|example)$/.test(e.name) || e.name === '.gitignore') {
        if (/[\u2014\u2013]/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(ROOT, p));
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);
});

test('no secrets in the source files, .env stays ignored, example values are empty', () => {
  const skip = new Set(['node_modules', 'out', 'data', '.git', '.env']);
  const patterns = [/sk-ant-[A-Za-z0-9_-]{20,}/, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, /AIza[0-9A-Za-z_-]{35}/];
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const text = fs.readFileSync(p, 'utf8');
        if (patterns.some((re) => re.test(text))) hits.push(path.relative(ROOT, p));
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);

  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const k of ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY']) {
    assert.match(example, new RegExp(`^${k}=$`, 'm'));
  }
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.env$/m);
});
