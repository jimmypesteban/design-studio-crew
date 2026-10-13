import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from 'puppeteer-core';
import type { MoonTokens } from '../moon/tokens.ts';
import { clean } from '../plain.ts';
import type { RawMeasure } from '../reviewer/checks.ts';
import { analyzerSource, baseParams, launch, SWEEP_WIDTHS } from '../reviewer/index.ts';
import type { Finding, PageExtras } from './findings.ts';
import { hostBlocked, type Resolver } from './target.ts';

export interface PageAuditOptions {
  /** http(s) address, or a file path for a local page. */
  url: string;
  isFile: boolean;
  tokens: MoonTokens;
  chromePath: string;
  shotsDir: string;
  allowLoopback: boolean;
  /** Local files a page may load. Anything else on file: is refused. */
  allowFile: (file: string) => boolean;
  resolve?: Resolver;
  widths?: number[];
  /** Called once every width is measured. Returns the findings to draw on the screenshots. */
  judge: (measures: RawMeasure[], extras: PageExtras) => Finding[];
  navTimeoutMs?: number;
}

export interface PageAuditResult {
  measures: RawMeasure[];
  extras: PageExtras;
  findings: Finding[];
  screenshots: { width: number; plain: string; annotated: string }[];
  finalUrl: string;
  loadNotes: string[];
  fontsLoaded: boolean;
}

const MAX_SHOT_HEIGHT = 8000;

/** Draw a numbered box around every finding that has a position at this width. */
function overlayScript(boxes: { n: number; r: [number, number, number, number] }[]): string {
  return `(function(boxes){
    var root = document.createElement('div');
    root.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    boxes.forEach(function (b) {
      var box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:' + b.r[0] + 'px;top:' + b.r[1] + 'px;width:' + b.r[2] + 'px;height:' + b.r[3] + 'px;outline:3px solid #E5484D;outline-offset:1px;background:rgba(229,72,77,0.08)';
      var tag = document.createElement('div');
      tag.textContent = String(b.n);
      tag.style.cssText = 'position:absolute;left:-3px;top:-12px;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border-radius:10px;background:#E5484D;color:#fff;font:700 12px/20px sans-serif;text-align:center';
      box.appendChild(tag);
      root.appendChild(box);
    });
    document.body.appendChild(root);
  })(${JSON.stringify(boxes)})`;
}

async function settle(page: Page, notes: string[]): Promise<void> {
  // Scroll down in steps so lazy images load, then back to the top. No clicking, ever.
  await page
    .evaluate(
      `(async () => { const h = Math.min(document.documentElement.scrollHeight, ${MAX_SHOT_HEIGHT}); for (let y = 0; y < h; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 80)); } window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 1200)); })()`,
    )
    .catch(() => notes.push('The page could not be scrolled to load lazy content.'));
}

/**
 * Open a page read only at 375, 768 and 1024 px and measure it. The page is untrusted:
 * only http(s) and allowed local files load, private networks are refused (every
 * request, including redirects), downloads are denied, and nothing is clicked or typed.
 */
export async function auditPage(o: PageAuditOptions): Promise<PageAuditResult> {
  fs.mkdirSync(o.shotsDir, { recursive: true });
  const widths = o.widths ?? SWEEP_WIDTHS;
  const params = { ...baseParams(o.tokens), mode: 'audit', allowedClasses: null, collectRects: true, maxElements: 6000 };
  const extras: PageExtras = { consoleErrors: [], failedRequests: [] };
  const notes: string[] = [];
  const hostCache = new Map<string, string | null>();
  const refused = new Set<string>();
  const browser = await launch(o.chromePath);
  const pages: Page[] = [];
  const measures: RawMeasure[] = [];
  let finalUrl = o.url;
  let fontsLoaded = false;

  try {
    for (const width of widths) {
      const page = await browser.newPage();
      pages.push(page);
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      try {
        const cdp = await page.createCDPSession();
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      } catch {
        notes.push('Download blocking could not be confirmed.');
      }
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        void (async () => {
          try {
            const u = new URL(req.url());
            if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return void (await req.continue());
            if (u.protocol === 'file:') {
              if (o.isFile && o.allowFile(fileURLToPath(u))) return void (await req.continue());
              refused.add(req.url());
              return void (await req.abort('blockedbyclient'));
            }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
              refused.add(req.url());
              return void (await req.abort('blockedbyclient'));
            }
            if (!hostCache.has(u.hostname)) hostCache.set(u.hostname, await hostBlocked(u.hostname, o.allowLoopback, o.resolve));
            const why = hostCache.get(u.hostname);
            if (why) {
              refused.add(`${u.host}: ${why}`);
              return void (await req.abort('blockedbyclient'));
            }
            await req.continue();
          } catch {
            await req.abort('failed').catch(() => undefined);
          }
        })();
      });
      if (width === widths[0]) {
        page.on('console', (m) => {
          if (m.type() === 'error' && extras.consoleErrors.length < 10) extras.consoleErrors.push(clean(m.text()).slice(0, 160));
        });
        page.on('requestfailed', (r) => {
          const why = r.failure()?.errorText ?? 'failed';
          if (why.includes('BLOCKED_BY_CLIENT') || why.includes('ERR_ABORTED')) return;
          if (extras.failedRequests.length < 20) extras.failedRequests.push({ url: r.url().replace(/[?#].*$/, ''), status: why.replace('net::', '') });
        });
        page.on('response', (r) => {
          if (r.status() >= 400 && extras.failedRequests.length < 20) extras.failedRequests.push({ url: r.url().replace(/[?#].*$/, ''), status: `HTTP ${r.status()}` });
        });
      }
      try {
        await page.goto(o.isFile ? pathToFileURL(o.url).href : o.url, { waitUntil: 'load', timeout: o.navTimeoutMs ?? 20000 });
      } catch (e) {
        const msg = (e as Error).message;
        if (/timeout/i.test(msg)) notes.push('The page took longer than 20 seconds to finish loading. It was measured as it stood.');
        else throw new Error(`The page could not be opened: ${clean(msg).slice(0, 160)}`);
      }
      if (width === widths[0]) finalUrl = page.url();
      await settle(page, notes);
      fontsLoaded = await page.evaluate(`document.fonts ? document.fonts.ready.then(() => true) : true`).then(Boolean).catch(() => false);
      measures.push((await page.evaluate(`(${analyzerSource})(${JSON.stringify(params)})`)) as RawMeasure);
    }
    if (refused.size) notes.push(`The studio refused ${refused.size} request${refused.size === 1 ? '' : 's'} to private or disallowed places while loading the page.`);

    const findings = o.judge(measures, extras);
    const screenshots: PageAuditResult['screenshots'] = [];
    for (const [i, width] of widths.entries()) {
      const page = pages[i]!;
      const m = measures[i]!;
      const height = Math.min(MAX_SHOT_HEIGHT, Math.max(900, await page.evaluate('document.documentElement.scrollHeight').then(Number)));
      const plain = path.join(o.shotsDir, `page-${width}.png`);
      const annotated = path.join(o.shotsDir, `annotated-${width}.png`);
      await page.screenshot({ path: plain, clip: { x: 0, y: 0, width, height }, captureBeyondViewport: true });
      const boxes = findings
        // Only what blocks people is boxed. Moon conformance and tidy-ups would cover the whole page.
        .filter((f) => f.widths.includes(width) && !f.waived && f.category !== 'moon' && f.priority <= 2)
        .flatMap((f) => f.sels.map((s) => ({ n: f.n, r: m.rects[s] })))
        .filter((b): b is { n: number; r: [number, number, number, number] } => !!b.r && b.r[1] < MAX_SHOT_HEIGHT)
        .slice(0, 80);
      await page.evaluate(overlayScript(boxes));
      await page.screenshot({ path: annotated, clip: { x: 0, y: 0, width, height }, captureBeyondViewport: true });
      screenshots.push({ width, plain, annotated });
    }
    return { measures, extras, findings, screenshots, finalUrl, loadNotes: notes, fontsLoaded };
  } finally {
    await browser.close();
  }
}
