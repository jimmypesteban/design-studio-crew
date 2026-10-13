import { assetCss } from '../moon/assetcss.ts';
import { fontFaceCss } from '../moon/fonts.ts';
import { studioCss } from '../moon/recipes.ts';
import type { MoonTokens } from '../moon/tokens.ts';
import type { BrandPlan, Variation } from './plan.ts';
import { HEADLINE_CLASSES, type SizeSpec } from './sizes.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function headlineClass(plan: BrandPlan, size: SizeSpec): string {
  const o = plan.type_overrides?.[size.id];
  return o && HEADLINE_CLASSES.includes(o) ? o : size.headline;
}

/** One finished asset as a fixed-size page. Chrome renders it to the PNG that ships. */
export function composeAssetHtml(
  tokens: MoonTokens,
  plan: BrandPlan,
  v: Variation,
  size: SizeSpec,
  image: { mime: string; data: Buffer },
): string {
  const src = `data:${image.mime};base64,${image.data.toString('base64')}`;
  const { headline, subline, cta } = plan.message;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(plan.campaign)} ${esc(v.name)} ${size.width}x${size.height}</title>
<style>
${fontFaceCss()}
${studioCss(tokens)}${assetCss(tokens)}</style>
</head>
<body>
<div class="mo-asset mo-asset--${size.id}">
  <img class="mo-asset__img" src="${src}" alt="">
  <div class="mo-asset__panel mo-bg-${v.panel} mo-fg-${v.text}">
    <h1 class="${headlineClass(plan, size)}">${esc(headline)}</h1>
    <p class="${size.sub}">${esc(subline)}</p>
    <span class="mo-btn mo-btn--${v.cta_variant} mo-btn--${size.cta} mo-asset__cta">${esc(cta)}</span>
  </div>
</div>
</body>
</html>
`;
}

/** A sheet of every finished asset, for Telegram and the job folder. */
export function contactSheetHtml(title: string, items: { label: string; file: string }[]): string {
  const cells = items
    .map((i) => `<figure style="margin:0"><img src="${i.file}" alt="${esc(i.label)}" style="max-width:100%;height:auto;display:block"><figcaption style="font:12px sans-serif;padding-top:4px">${esc(i.label)}</figcaption></figure>`)
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="margin:0;padding:16px;background:#F5F4F0"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;align-items:start">${cells}</div></body></html>`;
}
