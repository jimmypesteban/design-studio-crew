import { SIZES } from '../brand/sizes.ts';
import type { MoonTokens } from './tokens.ts';

/**
 * Extra recipes for fixed-size brand assets. Layout values are on the 4px grid and
 * every colour is a Moon token, exposed as a class so the Reviewer can hold assets
 * to the same palette rule as screens.
 */
export function assetCss(t: MoonTokens): string {
  const colourClasses = Object.keys(t.colors)
    .map((n) => `.mo-bg-${n}{background:var(--${n})}.mo-fg-${n}{color:var(--${n})}`)
    .join('\n');
  const sizeClasses = SIZES.map((s) => `.mo-asset--${s.id}{width:${s.width}px;height:${s.height}px}`).join('\n');
  return `
html,body{margin:0}
.mo-asset{position:relative;overflow:hidden;background:var(--mo-grey-2)}
.mo-asset__img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.mo-asset__panel{position:absolute;display:flex;flex-direction:column;border-radius:var(--radius-mo-md);box-shadow:var(--shadow-mo-xl)}
.mo-asset__cta{align-self:flex-start}
.mo-asset--ig-square .mo-asset__cta,.mo-asset--ig-story .mo-asset__cta{padding:16px 32px;min-height:64px;font-size:var(--mo-h6-size);line-height:var(--mo-h6-lh)}
${sizeClasses}
.mo-asset--ig-square .mo-asset__panel{left:64px;bottom:64px;width:700px;padding:48px;gap:24px}
.mo-asset--ig-story .mo-asset__panel{left:64px;right:64px;bottom:288px;padding:64px;gap:32px}
.mo-asset--link-landscape .mo-asset__panel{left:48px;top:48px;bottom:48px;width:520px;padding:40px;gap:16px;justify-content:center}
.mo-asset--banner-wide .mo-asset__panel{left:48px;top:48px;bottom:48px;width:680px;padding:32px;gap:12px;justify-content:center}
.mo-asset--display-medium .mo-asset__panel{left:16px;right:16px;bottom:16px;padding:16px;gap:8px}
${colourClasses}
`;
}
