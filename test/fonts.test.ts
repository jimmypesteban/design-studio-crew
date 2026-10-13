import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { before, test } from 'node:test';
import { composeAssetHtml } from '../src/brand/compose.ts';
import { SIZE_BY_ID } from '../src/brand/sizes.ts';
import { loadConfig } from '../src/config.ts';
import { fontFaceCss, FONTS_DIR } from '../src/moon/fonts.ts';
import { wrapScreen } from '../src/moon/recipes.ts';
import { loadMoonTokens, type MoonTokens } from '../src/moon/tokens.ts';
import { launch, reviewScreen } from '../src/reviewer/index.ts';

const cfg = loadConfig();
let tokens: MoonTokens;
before(async () => {
  tokens = await loadMoonTokens(cfg.moonPath);
});

test('the brand fonts are bundled with their licences, and the family names match the Moon font stacks', () => {
  for (const f of ['source-sans-3-latin-wght-normal.woff2', 'source-serif-4-latin-wght-normal.woff2', 'LICENSE-source-sans-3.txt', 'LICENSE-source-serif-4.txt']) {
    assert.ok(fs.statSync(path.join(FONTS_DIR, f)).size > 1000, f);
  }
  assert.match(fs.readFileSync(path.join(FONTS_DIR, 'LICENSE-source-sans-3.txt'), 'utf8'), /SIL OPEN FONT LICENSE/i);
  const css = fontFaceCss();
  assert.match(css, /font-family:"Source Sans 3"/);
  assert.match(css, /font-family:"Source Serif 4"/);
  assert.ok(tokens.fontFamily.body!.includes('"Source Sans 3"') && tokens.fontFamily.heading!.includes('"Source Serif 4"'));
  assert.match(fontFaceCss({ embed: false, baseUrl: 'fonts/' }), /url\(fonts\/source-sans-3-latin-wght-normal\.woff2\)/);
});

test('screens and assets reach for no network at all, so they render the same offline', () => {
  const screen = wrapScreen(tokens, 'x', '<div class="mo-container"><h1 class="mo-h4">Hi</h1></div>');
  assert.equal(/https?:\/\//.test(screen), false);
  const plan = { campaign: 'c', message: { headline: 'h', subline: 's', cta: 'go' }, variations: [], sizes: [] };
  const asset = composeAssetHtml(tokens, plan, { id: 'v1', name: 'n', theme: 't', concept: 'c', image_prompt: 'p', palette: [], panel: 'mo-grey-1', text: 'mo-black', cta_variant: 'primary' }, SIZE_BY_ID.get('ig-square')!, { mime: 'image/png', data: Buffer.from('x') });
  assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(asset), false);
});

test('with the network switched off, the real brand fonts still load and are used', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fonts-test-'));
  const file = path.join(dir, 'a.html');
  fs.writeFileSync(file, wrapScreen(tokens, 'x', '<div class="mo-container"><h1 class="mo-h4">Heading</h1><p class="mo-body">Body text</p></div>'));
  const browser = await launch(cfg.chromePath);
  try {
    const page = await browser.newPage();
    await page.setOfflineMode(true);
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready');
    const loaded = (await page.evaluate(`[...document.fonts].filter(f => f.status === 'loaded').map(f => f.family)`)) as string[];
    assert.ok(loaded.some((f) => /Source Serif 4/.test(f)), `loaded: ${loaded}`);
    assert.ok(loaded.some((f) => /Source Sans 3/.test(f)), `loaded: ${loaded}`);
    assert.equal(await page.evaluate(`document.fonts.check('700 36px "Source Serif 4"') && document.fonts.check('400 16px "Source Sans 3"')`), true);
  } finally {
    await browser.close();
  }
  const r = await reviewScreen({ htmlFile: file, tokens, chromePath: cfg.chromePath, shotsDir: path.join(dir, 's') });
  assert.equal(r.fontsLoaded, true);
});
