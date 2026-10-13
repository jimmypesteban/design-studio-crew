import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { auditFindings, conformance } from '../src/audit/findings.ts';
import { auditPage } from '../src/audit/page.ts';
import { loadConfig, ROOT } from '../src/config.ts';
import { placePins, renderDocs, scrubPaths } from '../src/docs.ts';
import { FONTS_DIR } from '../src/moon/fonts.ts';
import { loadMoonTokens, type MoonTokens } from '../src/moon/tokens.ts';
import { pngSize } from '../src/reviewer/index.ts';

/** Width and height of a PNG or JPEG, read from the file itself. */
function imageSize(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  if (b.subarray(1, 4).toString('ascii') === 'PNG') return pngSize(file);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error(`${file} is not a readable JPEG`);
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error(`${file} has no size`);
}

const cfg = loadConfig();
const docs = path.join(ROOT, 'docs');
let tokens: MoonTokens;
before(async () => {
  tokens = await loadMoonTokens(cfg.moonPath);
});

test('docs/index.html is built from its source and the live Moon tokens (run npm run docs if this fails)', () => {
  assert.equal(fs.readFileSync(path.join(docs, 'index.html'), 'utf8'), renderDocs(tokens));
  // The fonts it serves are the bundled ones, byte for byte
  for (const f of fs.readdirSync(FONTS_DIR).filter((x) => x.endsWith('.woff2'))) {
    assert.ok(fs.readFileSync(path.join(docs, 'fonts', f)).equals(fs.readFileSync(path.join(FONTS_DIR, f))), f);
  }
});

test('nothing from the machine that built it reaches the page: no local paths, no file addresses', () => {
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
  assert.equal(/\/Users\/|\/home\/|file:\/\/|jpesteban/.test(html.replace(/by Jimmy Esteban|Jimmy Esteban/g, '')), false);
  assert.equal(scrubPaths('An image did not load (file:///Users/me/proj/samples/missing-banner.png).'), 'An image did not load (missing-banner.png).');
});

test('every pin has a finding, a box and a position that sits on the image', () => {
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
  const pins = (html.match(/class="pin"/g) ?? []).length;
  assert.ok(pins >= 4);
  assert.equal((html.match(/class="box"/g) ?? []).length, pins);
  assert.equal((html.match(/class="card find"/g) ?? []).length, pins);
  const hot = JSON.parse(fs.readFileSync(path.join(docs, 'src', 'hotspots.json'), 'utf8')) as { pins: { x: number; y: number; w: number; h: number }[] };
  for (const p of hot.pins) assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= 100.5 && p.y + p.h <= 100.5, JSON.stringify(p));
});

test('pins never overlap at the smallest screen, even for findings that sit close together', () => {
  const hot = JSON.parse(fs.readFileSync(path.join(docs, 'src', 'hotspots.json'), 'utf8')) as { pins: Parameters<typeof placePins>[0] };
  for (const set of [hot.pins, hot.pins.map((p, i) => ({ ...p, y: 20 + i }))]) {
    const placed = placePins(set);
    for (let a = 0; a < placed.length; a++) {
      for (let b = a + 1; b < placed.length; b++) {
        const d = Math.hypot(((placed[a]!.x - placed[b]!.x) / 100) * 320, ((placed[a]!.y - placed[b]!.y) / 100) * 281);
        assert.ok(d >= 28, `pins ${a + 1} and ${b + 1} are ${d.toFixed(1)}px apart`);
      }
    }
  }
});

test('the page loads nothing from the network: no external fonts, scripts or styles', () => {
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
  const urls = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(urls, []);
  assert.equal(/googleapis|gstatic/.test(html), false);
});

test('every image on the page exists, has alt text, and its width and height match the file', () => {
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
  const imgs = [...html.matchAll(/<img\s[^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.length >= 8);
  for (const tag of imgs) {
    const src = /src="([^"]+)"/.exec(tag)![1]!;
    assert.match(tag, /alt="[^"]{20,}"/, `${src} needs real alt text`);
    const file = path.join(docs, src);
    assert.ok(fs.existsSync(file), `${src} is missing`);
    const { width, height } = imageSize(file);
    assert.equal(Number(/width="(\d+)"/.exec(tag)![1]), width, `${src} width`);
    assert.equal(Number(/height="(\d+)"/.exec(tag)![1]), height, `${src} height`);
  }
});

test('the page passes the studio own audit under the strict Moon standard at 375, 768 and 1024 px, apart from a documented display tier', async () => {
  const r = await auditPage({
    url: path.join(docs, 'index.html'),
    isFile: true,
    tokens,
    chromePath: cfg.chromePath,
    shotsDir: path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'docs-audit-')), 'shots'),
    allowLoopback: false,
    allowFile: (f) => f.startsWith(fs.realpathSync(docs)),
    judge: (m, e) => auditFindings(m, tokens, 'moon', e),
  });
  // The one deliberate departure from Moon: giant display type (96px and up) for the poster hero, the footer and the big "Aa".
  // Everything else, including every other type size, must be on the Moon scale.
  const display = r.findings.filter((f) => f.rule === 'off-scale-type');
  for (const f of display) {
    const sizes = [...f.detail.matchAll(/Font size (\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length && sizes.every((px) => px >= 96), `only display sizes may be off scale: ${f.detail}`);
  }
  const rest = r.findings.filter((f) => f.severity === 'fail' && f.rule !== 'off-scale-type');
  assert.deepEqual(rest.map((f) => `${f.rule}: ${f.detail}`), []);
  assert.ok(conformance(r.measures[2]!, tokens).overall >= 95);
  assert.equal(r.extras.failedRequests.length, 0);
});
