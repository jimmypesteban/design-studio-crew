import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { reviewScreen, type ReviewReport } from '../reviewer/index.ts';
import type { Issue } from '../reviewer/checks.ts';
import { ROOT } from '../config.ts';
import { fontFaceCss } from '../moon/fonts.ts';
import type { MoonTokens } from '../moon/tokens.ts';

const run = promisify(execFile);

export interface Step {
  ok: boolean;
  detail: string;
  errors: string[];
}

export interface VerifyReport {
  typecheck: Step;
  render: Step;
  parity: Step & { missing: string[]; extra: string[] };
  /** Layout and structure problems at 375, 768 and 1024 that the conversion could cause. They block. */
  fidelityBlocking: Issue[];
  /** Colour, type and contrast findings. They come from Moon's own components, so they are reported, not blocking. */
  mooNotes: Issue[];
  fidelity: ReviewReport | null;
  renderHtmlFile: string | null;
  pass: boolean;
}

/** Rules a bad conversion could cause. Anything else measured on Moon's components is a note about Moon. */
export const BLOCKING_RULES = new Set([
  'horizontal-overflow', 'content-clipped', 'text-collision',
  'missing-alt', 'missing-label', 'empty-control', 'missing-lang',
]);

function moonBin(moonPath: string, rel: string): string {
  const p = path.join(moonPath, 'node_modules', rel);
  if (!fs.existsSync(p)) throw new Error(`Moon dependencies are not installed (${p} is missing). Run npm install inside the Moon folder.`);
  return p;
}

export function writeProject(dir: string, moonPath: string, tsx: string, componentName: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Screen.tsx'), tsx);
  fs.writeFileSync(path.join(dir, 'entry.tsx'), `import { renderToStaticMarkup } from 'react-dom/server';\nimport { ${componentName} } from './Screen';\nprocess.stdout.write(renderToStaticMarkup(<${componentName} />));\n`);
  const nm = path.join(moonPath, 'node_modules');
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          // Mirrors Moon's own tsconfig, plus Node types because a few Moon files read process.env.
          target: 'ES2022', lib: ['dom', 'dom.iterable', 'esnext'], module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, noEmit: true,
          skipLibCheck: true, allowJs: true, resolveJsonModule: true, esModuleInterop: true, isolatedModules: true,
          types: ['node'], typeRoots: [path.join(ROOT, 'node_modules/@types'), path.join(nm, '@types')],
          paths: {
            'moon-design-system': [path.join(moonPath, 'src/index.ts')],
            react: [path.join(nm, '@types/react')],
            'react/jsx-runtime': [path.join(nm, '@types/react/jsx-runtime')],
            'react-dom/server': [path.join(nm, '@types/react-dom/server')],
          },
        },
        include: ['Screen.tsx', 'entry.tsx', path.join(moonPath, 'src/vite-env.d.ts')],
      },
      null,
      2,
    ),
  );
}

export async function typecheck(dir: string, moonPath: string): Promise<Step> {
  const tsc = moonBin(moonPath, 'typescript/bin/tsc');
  try {
    await run(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: dir, maxBuffer: 10_000_000, timeout: 120_000 });
    return { ok: true, detail: 'Type checks against the real Moon components with no errors.', errors: [] };
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
    const errors = out.filter((l) => /error TS\d+/.test(l)).map((l) => l.replace(dir + path.sep, ''));
    return { ok: false, detail: `${errors.length || 'Some'} type errors.`, errors: errors.length ? errors.slice(0, 20) : [String((e as Error).message).slice(0, 400)] };
  }
}

/** Bundle with Moon's esbuild, run on the server, return the HTML React produced. */
export async function renderToHtml(dir: string, moonPath: string): Promise<{ step: Step; html: string }> {
  try {
    const esbuild = await import(pathToFileURL(moonBin(moonPath, 'esbuild/lib/main.js')).href);
    const outfile = path.join(dir, '.bundle.mjs');
    await esbuild.build({
      entryPoints: [path.join(dir, 'entry.tsx')],
      bundle: true, platform: 'node', format: 'esm', outfile,
      loader: { '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl' },
      nodePaths: [path.join(moonPath, 'node_modules')],
      alias: { 'moon-design-system': path.join(moonPath, 'src/index.ts') },
      jsx: 'automatic', logLevel: 'silent',
      banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    });
    const { stdout } = await run(process.execPath, [outfile], { maxBuffer: 20_000_000, timeout: 60_000 });
    return { step: { ok: true, detail: `Rendered ${stdout.length} characters of HTML on the server.`, errors: [] }, html: stdout };
  } catch (e) {
    const err = e as { message?: string; stderr?: string; errors?: { text: string }[] };
    const msgs = err.errors?.map((x) => x.text) ?? [String(err.stderr || err.message).split('\n').slice(0, 6).join(' ')];
    return { step: { ok: false, detail: 'The code did not bundle or render.', errors: msgs.slice(0, 8) }, html: '' };
  }
}

/** Compile Moon's own Tailwind setup for exactly the classes the rendered page uses. */
export async function tailwindCss(html: string, moonPath: string, tokens: MoonTokens): Promise<string> {
  const mod = await import(pathToFileURL(moonBin(moonPath, '@tailwindcss/node/dist/index.mjs')).href);
  const candidates = [...new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await mod.compile(`@import "tailwindcss";\n@config "${path.join(moonPath, 'tailwind.config.js')}";\n`, { base: moonPath, onDependency() {} });
  const css: string = compiler.build(candidates);
  // Moon's Storybook defines these by hand because Tailwind drops custom font keys, so we do the same from the tokens.
  const fonts = `.font-heading{font-family:${tokens.fontFamily.heading?.join(', ')}}\n.font-body{font-family:${tokens.fontFamily.body?.join(', ')}}\nbody{margin:0;background:${tokens.colors['mo-grey-2']};font-family:${tokens.fontFamily.body?.join(', ')}}\n`;
  return css + '\n' + fonts;
}

export function renderPage(html: string, css: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<>&]/g, '')}</title>
<style>
${fontFaceCss()}
${css}</style>
</head>
<body>
${html}
</body>
</html>
`;
}

type Node = DefaultTreeAdapterMap['node'];

function words(html: string, isDocument = false): string[] {
  const root = parseFragment(html);
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeName === '#text') out.push(...(n as DefaultTreeAdapterMap['textNode']).value.split(/\s+/).filter(Boolean));
    else if (n.nodeName === 'script' || n.nodeName === 'style') return;
    else if ('childNodes' in n) (n.childNodes as Node[]).forEach(walk);
  };
  walk(root);
  void isDocument;
  return out;
}

/** Every word the approved screen shows must still be there in the React output. */
export function textParity(expectedFragment: string, renderedHtml: string): Step & { missing: string[]; extra: string[] } {
  const want = [...words(expectedFragment), 'Skip', 'to', 'content'];
  const got = words(renderedHtml);
  const pool = new Map<string, number>();
  for (const w of got) pool.set(w, (pool.get(w) ?? 0) + 1);
  const missing: string[] = [];
  for (const w of want) {
    const c = pool.get(w) ?? 0;
    if (c > 0) pool.set(w, c - 1);
    else missing.push(w);
  }
  const extra = [...pool.entries()].flatMap(([w, c]) => Array<string>(c).fill(w));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `${missing.length} of ${want.length} words from the approved screen are missing.` : `All ${want.length} words from the approved screen are present.${extra.length ? ` ${extra.length} extra words come from Moon components, such as icons or percentages.` : ''}`,
    errors: missing.slice(0, 12).map((w) => `Missing: ${w}`),
    missing,
    extra,
  };
}

export interface VerifyOptions {
  dir: string;
  moonPath: string;
  chromePath: string;
  tokens: MoonTokens;
  tsx: string;
  componentName: string;
  expectedFragment: string;
  title: string;
}

/** Hold generated React to the same standard as everything else, using the real Moon components. */
export async function verifyReact(o: VerifyOptions): Promise<VerifyReport> {
  writeProject(o.dir, o.moonPath, o.tsx, o.componentName);
  const tc = await typecheck(o.dir, o.moonPath);
  const empty = { ok: false, detail: 'Skipped because an earlier step failed.', errors: [] as string[] };
  const rendered = tc.ok ? await renderToHtml(o.dir, o.moonPath) : { step: empty, html: '' };
  const parity = rendered.step.ok ? textParity(o.expectedFragment, rendered.html) : { ...empty, missing: [] as string[], extra: [] as string[] };

  let fidelity: ReviewReport | null = null;
  let renderHtmlFile: string | null = null;
  if (rendered.step.ok) {
    const css = await tailwindCss(rendered.html, o.moonPath, o.tokens);
    renderHtmlFile = path.join(o.dir, 'react-render.html');
    fs.writeFileSync(renderHtmlFile, renderPage(rendered.html, css, o.title));
    fidelity = await reviewScreen({ htmlFile: renderHtmlFile, tokens: o.tokens, chromePath: o.chromePath, shotsDir: path.join(o.dir, 'shots'), mode: 'react' });
  }
  const failing = fidelity?.issues.filter((i) => i.severity === 'fail') ?? [];
  const fidelityBlocking = failing.filter((i) => BLOCKING_RULES.has(i.rule));
  const mooNotes = failing.filter((i) => !BLOCKING_RULES.has(i.rule));
  return {
    typecheck: tc,
    render: rendered.step,
    parity,
    fidelityBlocking,
    mooNotes,
    fidelity,
    renderHtmlFile,
    pass: tc.ok && rendered.step.ok && parity.ok && fidelityBlocking.length === 0,
  };
}

export function verifyMarkdown(v: VerifyReport): string {
  const mark = (s: Step) => (s.ok ? 'PASS' : 'FAIL');
  const lines = [
    '# Handoff verification',
    '',
    `Result: ${v.pass ? 'PASS' : 'FAIL'}`,
    '',
    `- Type check against Moon: ${mark(v.typecheck)}. ${v.typecheck.detail}`,
    `- Server render: ${mark(v.render)}. ${v.render.detail}`,
    `- Text matches the approved screen: ${mark(v.parity)}. ${v.parity.detail}`,
    `- Layout and structure at 375, 768 and 1024 px: ${v.fidelity ? (v.fidelityBlocking.length ? 'FAIL' : 'PASS') : 'not run'}.`,
    '',
  ];
  const errs = [...v.typecheck.errors, ...v.render.errors, ...v.parity.errors];
  if (errs.length) lines.push('## Problems', ...errs.map((e) => `- ${e}`), '');
  if (v.fidelityBlocking.length) {
    lines.push('## Layout and structure problems (these block)');
    for (const i of v.fidelityBlocking) lines.push(`- ${i.rule}: ${i.detail} Where: ${i.where}. Fix: ${i.fix}`);
    lines.push('');
  }
  lines.push('## Findings in Moon\'s own components (reported, not blocking)');
  if (!v.mooNotes.length) lines.push('None.');
  for (const i of v.mooNotes) lines.push(`- ${i.rule}: ${i.detail} Where: ${i.where}.`);
  lines.push('', 'These come from the real Moon components, which this code is required to use. They are for the design system owner to decide on.');
  return lines.join('\n') + '\n';
}
