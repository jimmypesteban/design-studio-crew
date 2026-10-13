import { fontFaceCss } from './fonts.ts';
import { tokensCss, type MoonTokens } from './tokens.ts';

/**
 * Component recipes for static screens. Class names and variant maps follow the
 * Moon React components (Button, Input, Card, Badge, Alert). Every value is a
 * var(--...) from tokens.mjs or a step on the 4px grid, so the Reviewer can
 * hold a screen to the same system. No raw colours appear in this file.
 */
export function recipesCss(t: MoonTokens): string {
  const m = t.container.margin;
  const max = t.container.maxWidth;
  const bp = t.breakpoints;
  const grid = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16];
  const gaps = grid.map((n) => `.mo-gap-${n}{gap:${n * 4}px}`).join('\n');
  const pads = grid.map((n) => `.mo-pad-${n}{padding:${n * 4}px}`).join('\n');
  const mts = grid.map((n) => `.mo-mt-${n}{margin-top:${n * 4}px}`).join('\n');

  return `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--mo-grey-2);color:var(--mo-black);font-family:var(--font-body);font-size:var(--mo-body-size);line-height:var(--mo-body-lh);overflow-wrap:break-word}
img,svg,video{max-width:100%;height:auto}
h1,h2,h3,h4,h5,h6,p{margin:0}

.mo-container{width:100%;margin-inline:auto;padding-inline:${m.DEFAULT}}
@media (min-width:${bp.sm}){.mo-container{padding-inline:${m.sm}}}
@media (min-width:${bp.md}){.mo-container{padding-inline:${m.md}}}
@media (min-width:${bp.lg}){.mo-container{padding-inline:${m.lg}}}
@media (min-width:${bp.xl}){.mo-container{padding-inline:${m.xl};max-width:${max.xl}}}
@media (min-width:${bp['2xl']}){.mo-container{max-width:${max['2xl']}}}

.mo-section{padding-block:48px}
.mo-narrow{width:100%;max-width:480px;margin-inline:auto}
.mo-stack{display:flex;flex-direction:column}
.mo-row{display:flex;flex-wrap:wrap;align-items:center}
.mo-between{justify-content:space-between}
.mo-center{text-align:center;align-items:center}
.mo-grow{flex:1 1 0;min-width:0}
.mo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))}
.mo-grid--2{grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr))}
${gaps}
${pads}
${mts}

.mo-h1{font-family:var(--font-heading);font-size:var(--mo-h1-size);line-height:var(--mo-h1-lh);font-weight:700}
.mo-h2{font-family:var(--font-heading);font-size:var(--mo-h2-size);line-height:var(--mo-h2-lh);font-weight:700}
.mo-h3{font-family:var(--font-heading);font-size:var(--mo-h3-size);line-height:var(--mo-h3-lh);font-weight:700}
.mo-h4{font-family:var(--font-heading);font-size:var(--mo-h4-size);line-height:var(--mo-h4-lh);font-weight:700}
.mo-h5{font-family:var(--font-heading);font-size:var(--mo-h5-size);line-height:var(--mo-h5-lh);font-weight:700}
.mo-h6{font-family:var(--font-heading);font-size:var(--mo-h6-size);line-height:var(--mo-h6-lh);font-weight:700}
.mo-h7{font-family:var(--font-heading);font-size:var(--mo-h7-size);line-height:var(--mo-h7-lh);font-weight:700}
.mo-body-lg{font-size:var(--mo-body-lg-size);line-height:var(--mo-body-lg-lh)}
.mo-body{font-size:var(--mo-body-size);line-height:var(--mo-body-lh)}
.mo-body-sm{font-size:var(--mo-body-sm-size);line-height:var(--mo-body-sm-lh)}
.mo-subhead{font-size:var(--mo-subhead-size);line-height:var(--mo-subhead-lh);font-weight:600}
.mo-annotation{font-size:var(--mo-annotation-size);line-height:var(--mo-annotation-lh)}
.mo-muted{color:var(--mo-grey-8)}
.mo-on-dark{color:var(--mo-white)}
.mo-text-error{color:var(--mo-red-8)}
.mo-bold{font-weight:700}
.mo-surface-dark{background:var(--mo-ocean);color:var(--mo-white)}
.mo-surface-brand{background:var(--mo-forest);color:var(--mo-white)}
.mo-surface-white{background:var(--mo-grey-1);color:var(--mo-black)}

/* Button: variants follow Moon's state pattern (default step 6, hover 5, active 7). */
.mo-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:8px 16px;min-height:40px;border:1px solid transparent;border-radius:var(--radius-mo-sm);font-family:var(--font-body);font-size:var(--mo-cta-size);line-height:var(--mo-cta-lh);font-weight:500;text-decoration:none;cursor:pointer;transition:background-color .15s,box-shadow .15s}
.mo-btn:focus-visible,.mo-input:focus-visible,.mo-link:focus-visible{outline:2px solid var(--mo-blue-8);outline-offset:2px}
.mo-btn[disabled]{opacity:.5;cursor:not-allowed}
.mo-btn--xs{padding:4px 10px;min-height:28px;font-size:var(--mo-annotation-size);line-height:var(--mo-annotation-lh)}
.mo-btn--sm{padding:6px 12px;min-height:32px}
.mo-btn--lg{padding:10px 20px;min-height:44px;font-size:var(--mo-body-size);line-height:var(--mo-body-lh)}
.mo-btn--xl{padding:12px 24px;min-height:48px;font-size:var(--mo-body-lg-size);line-height:var(--mo-body-lg-lh)}
.mo-btn--pill{border-radius:var(--radius-mo-full)}
.mo-btn--block{display:flex;width:100%}
.mo-btn--primary,.mo-btn--danger{background:var(--mo-red-6);color:var(--mo-white)}
.mo-btn--primary:hover,.mo-btn--danger:hover{background:var(--mo-red-7)}
.mo-btn--highlight{background:var(--mo-yellow-6);color:var(--mo-black)}
.mo-btn--highlight:hover{background:var(--mo-yellow-5)}
.mo-btn--secondary{background:var(--mo-blue-6);color:var(--mo-white)}
.mo-btn--tertiary{background:var(--mo-grey-7);color:var(--mo-white)}
.mo-btn--accent{background:var(--mo-purple-6);color:var(--mo-white)}
.mo-btn--accent:hover{background:var(--mo-purple-5)}
.mo-btn--ghost{background:transparent;border-color:var(--mo-red-6);color:var(--mo-red-6)}
.mo-btn--outline{background:transparent;border-color:var(--mo-grey-3);color:var(--mo-black)}
.mo-btn--soft{background:var(--mo-red-1);border-color:var(--mo-red-2);color:var(--mo-red-7)}
.mo-btn--info{background:var(--mo-purple-1);color:var(--mo-purple-7)}
.mo-link{color:var(--mo-red-7);text-decoration:underline;font-weight:500}

/* Form */
.mo-field{display:flex;flex-direction:column;gap:6px}
.mo-label{font-size:var(--mo-body-sm-size);line-height:var(--mo-body-sm-lh);font-weight:500;color:var(--mo-black)}
.mo-input{width:100%;padding:10px 16px;border:1px solid var(--mo-grey-4);border-radius:var(--radius-mo-sm);background:var(--mo-grey-1);color:var(--mo-black);font-family:var(--font-body);font-size:var(--mo-body-size);line-height:var(--mo-body-lh)}
.mo-input--error{border-color:var(--mo-red-7)}
.mo-help{font-size:var(--mo-body-sm-size);line-height:var(--mo-body-sm-lh);color:var(--mo-grey-8)}
.mo-error{font-size:var(--mo-body-sm-size);line-height:var(--mo-body-sm-lh);color:var(--mo-red-8)}
.mo-check{display:flex;align-items:center;gap:8px;min-height:24px}
.mo-check input{width:20px;height:20px;margin:0;accent-color:var(--mo-red-6)}

/* Card */
.mo-card{overflow:hidden;background:var(--mo-grey-1);border:1px solid var(--mo-grey-3);border-radius:var(--radius-mo-sm);box-shadow:var(--shadow-mo-xs)}
.mo-card--student{border-radius:var(--radius-mo-md)}
.mo-card__header{padding:16px 20px;border-bottom:1px solid var(--mo-grey-3)}
.mo-card__body{padding:16px 20px}
.mo-card__footer{padding:12px 20px;border-top:1px solid var(--mo-grey-3);background:var(--mo-grey-2)}

/* Badge and alert */
.mo-badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:var(--radius-mo-full);font-size:var(--mo-annotation-size);line-height:var(--mo-annotation-lh);font-weight:600}
.mo-badge--neutral{background:var(--mo-grey-3);color:var(--mo-black)}
.mo-badge--success{background:var(--mo-green-1);color:var(--mo-green-9)}
.mo-badge--warning{background:var(--mo-yellow-1);color:var(--mo-yellow-10)}
.mo-badge--danger{background:var(--mo-red-1);color:var(--mo-red-8)}
.mo-badge--info{background:var(--mo-purple-1);color:var(--mo-purple-7)}
.mo-alert{display:flex;gap:12px;padding:12px 16px;border:1px solid transparent;border-radius:var(--radius-mo-sm);font-size:var(--mo-body-sm-size);line-height:var(--mo-body-sm-lh)}
.mo-alert--success{background:var(--mo-green-1);border-color:var(--mo-green-3);color:var(--mo-green-10)}
.mo-alert--warning{background:var(--mo-yellow-1);border-color:var(--mo-yellow-3);color:var(--mo-yellow-10)}
.mo-alert--danger{background:var(--mo-red-1);border-color:var(--mo-red-2);color:var(--mo-red-9)}
.mo-alert--info{background:var(--mo-blue-1);border-color:var(--mo-blue-2);color:var(--mo-blue-10)}

/* Navigation, stats, progress, misc */
.mo-topbar{background:var(--mo-grey-1);border-bottom:1px solid var(--mo-grey-3)}
.mo-brand{font-family:var(--font-heading);font-size:var(--mo-h7-size);line-height:var(--mo-h7-lh);font-weight:700;color:var(--mo-black);text-decoration:none}
.mo-nav{display:flex;flex-wrap:wrap;gap:16px}
.mo-nav a{color:var(--mo-black);text-decoration:none;font-weight:500;padding:8px 0;display:inline-block}
.mo-stat{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.mo-stat__value{font-family:var(--font-heading);font-size:var(--mo-h5-size);line-height:var(--mo-h5-lh);font-weight:700}
.mo-progress{height:8px;background:var(--mo-grey-3);border-radius:var(--radius-mo-full);overflow:hidden}
.mo-progress__bar{height:100%;background:var(--mo-forest-6)}
.mo-avatar{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:var(--radius-mo-full);background:var(--mo-purple-1);color:var(--mo-purple-7);font-weight:600}
.mo-divider{height:1px;border:0;background:var(--mo-grey-3);margin:0}
.mo-empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:48px 24px;text-align:center;border:1px dashed var(--mo-grey-4);border-radius:var(--radius-mo-md);background:var(--mo-grey-1)}
.mo-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.mo-list__item{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--mo-grey-3)}
.mo-skip{position:absolute;left:-9999px;color:var(--mo-black)}
.mo-skip:focus{left:16px;top:16px;background:var(--mo-grey-1);padding:8px 12px;z-index:10}
`;
}

/** All class names a screen may use. Anything else is off-system. */
export function allowedClasses(css: string): string[] {
  const found = new Set<string>();
  for (const m of css.matchAll(/\.(mo-[a-z0-9_-]+)/g)) found.add(m[1]!);
  return [...found].sort();
}

/** The full stylesheet shipped with every screen: tokens first, then recipes. */
export function studioCss(t: MoonTokens): string {
  return `/* Generated from Moon tokens.mjs by design-studio-crew. Do not edit by hand. */\n${tokensCss(t)}${recipesCss(t)}`;
}

/** Wrap an HTML fragment (the inside of <main>) as a finished, self-contained page. */
export function wrapScreen(t: MoonTokens, title: string, mainHtml: string, headerHtml = ''): string {
  const safeTitle = title.replace(/[<>&]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
${fontFaceCss()}
${studioCss(t)}</style>
</head>
<body>
<a class="mo-skip" href="#main">Skip to content</a>
${headerHtml}
<main id="main">
${mainHtml}
</main>
</body>
</html>
`;
}
