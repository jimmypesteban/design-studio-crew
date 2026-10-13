import crypto from 'node:crypto';
import type { MoonTokens } from '../moon/tokens.ts';
import { CTA_VARIANTS, HEADLINE_CLASSES, SIZE_BY_ID, type AspectRatio } from './sizes.ts';
import { MAX_PROMPT_LENGTH } from './gemini.ts';

export interface Variation {
  id: string;
  name: string;
  theme: string;
  concept: string;
  /** What the image model is asked to draw. No text, the studio sets all type itself. */
  image_prompt: string;
  /** Moon colour tokens for the artwork mood. */
  palette: string[];
  /** Moon colour tokens for the text panel and the text on it. */
  panel: string;
  text: string;
  cta_variant: string;
}

export interface BrandPlan {
  campaign: string;
  message: { headline: string; subline: string; cta: string };
  variations: Variation[];
  sizes: string[];
  /** Optional headline class per size, from mo-h2 to mo-h7. */
  type_overrides?: Record<string, string>;
  notes?: string;
}

export const LIMITS = { headline: 40, subline: 90, cta: 20, maxVariations: 6 };

function fence(text: string): string | null {
  const m = /```json\s*\n([\s\S]*?)```/i.exec(text);
  return m ? m[1]!.trim() : null;
}

export function parsePlan(text: string): { plan: BrandPlan; note: string } {
  const raw = fence(text) ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let obj: Partial<BrandPlan>;
  try {
    obj = JSON.parse(raw) as Partial<BrandPlan>;
  } catch {
    throw new Error('The Brand agent did not return a readable plan (JSON).');
  }
  const m = obj.message ?? { headline: '', subline: '', cta: '' };
  const plan: BrandPlan = {
    campaign: String(obj.campaign ?? 'Campaign').slice(0, 80),
    message: { headline: String(m.headline ?? ''), subline: String(m.subline ?? ''), cta: String(m.cta ?? '') },
    variations: (obj.variations ?? []).map((v, i) => ({
      id: String(v.id ?? `v${i + 1}`),
      name: String(v.name ?? `Variation ${i + 1}`),
      theme: String(v.theme ?? 'default'),
      concept: String(v.concept ?? ''),
      image_prompt: String(v.image_prompt ?? ''),
      palette: (v.palette ?? []).map(String),
      panel: String(v.panel ?? 'mo-grey-1'),
      text: String(v.text ?? 'mo-black'),
      cta_variant: String(v.cta_variant ?? 'primary'),
    })),
    sizes: (obj.sizes ?? []).map(String),
    type_overrides: obj.type_overrides,
    notes: obj.notes ? String(obj.notes) : undefined,
  };
  return { plan, note: text.replace(/```json[\s\S]*?```/i, '').trim() };
}

/** Structural checks only. Whether the design is good is the Reviewer's job. */
export function validatePlan(plan: BrandPlan, tokens: MoonTokens, maxImages: number): string[] {
  const errors: string[] = [];
  const { headline, subline, cta } = plan.message;
  if (!headline) errors.push('The headline is empty.');
  if (headline.length > LIMITS.headline) errors.push(`The headline is ${headline.length} characters. Keep it to ${LIMITS.headline} so it fits the small sizes.`);
  if (subline.length > LIMITS.subline) errors.push(`The subline is ${subline.length} characters. Keep it to ${LIMITS.subline}.`);
  if (!cta || cta.length > LIMITS.cta) errors.push(`The button text must be 1 to ${LIMITS.cta} characters.`);
  if (!plan.variations.length) errors.push('There are no variations.');
  if (plan.variations.length > LIMITS.maxVariations) errors.push(`Too many variations. The most is ${LIMITS.maxVariations}.`);
  const ids = new Set<string>();
  for (const v of plan.variations) {
    if (!/^[a-z0-9-]+$/.test(v.id)) errors.push(`Variation id "${v.id}" must be lowercase letters, numbers and hyphens.`);
    if (ids.has(v.id)) errors.push(`Variation id "${v.id}" is used twice.`);
    ids.add(v.id);
    if (!v.image_prompt.trim()) errors.push(`${v.id} has no image prompt.`);
    if (v.image_prompt.length > MAX_PROMPT_LENGTH - 200) errors.push(`${v.id} image prompt is too long. Keep it under ${MAX_PROMPT_LENGTH - 200} characters.`);
    for (const t of [v.panel, v.text, ...v.palette]) if (!tokens.colors[t]) errors.push(`${v.id} uses "${t}", which is not a Moon colour token.`);
    if (!CTA_VARIANTS.includes(v.cta_variant)) errors.push(`${v.id} button style "${v.cta_variant}" must be one of ${CTA_VARIANTS.join(', ')}.`);
  }
  if (!plan.sizes.length) errors.push('There are no sizes.');
  for (const s of plan.sizes) if (!SIZE_BY_ID.has(s)) errors.push(`Unknown size "${s}". Known sizes: ${[...SIZE_BY_ID.keys()].join(', ')}.`);
  for (const [s, c] of Object.entries(plan.type_overrides ?? {})) {
    if (!SIZE_BY_ID.has(s)) errors.push(`Type override for unknown size "${s}".`);
    if (!HEADLINE_CLASSES.includes(c)) errors.push(`Type override "${c}" must be one of ${HEADLINE_CLASSES.join(', ')}.`);
  }
  const n = imageNeeds(plan).length;
  if (n > maxImages) errors.push(`This plan needs ${n} images and the most one job may generate is ${maxImages}. Cut variations or sizes.`);
  return errors;
}

export interface ImageNeed {
  key: string;
  variationId: string;
  ratio: AspectRatio;
  prompt: string;
  theme: string;
}

const SUFFIX = 'Do not draw any text, letters, numbers, logos or watermarks. Keep the composition calm and uncluttered, with plenty of open space.';

export function finalPrompt(v: Variation, tokens: MoonTokens): string {
  const hexes = v.palette.map((n) => tokens.colors[n]).filter(Boolean);
  const palette = hexes.length ? ` Colour palette: ${hexes.join(', ')}.` : '';
  return `${v.image_prompt.trim()}${palette} ${SUFFIX}`.slice(0, MAX_PROMPT_LENGTH);
}

/** One image per variation per aspect ratio. Sizes that share a ratio share the image. */
export function imageNeeds(plan: BrandPlan, tokens?: MoonTokens): ImageNeed[] {
  const ratios = [...new Set(plan.sizes.map((s) => SIZE_BY_ID.get(s)?.genRatio).filter((r): r is AspectRatio => !!r))];
  const out: ImageNeed[] = [];
  for (const v of plan.variations) {
    for (const ratio of ratios) {
      const prompt = tokens ? finalPrompt(v, tokens) : v.image_prompt;
      const hash = crypto.createHash('sha1').update(`${v.id}|${ratio}|${prompt}`).digest('hex').slice(0, 8);
      out.push({ key: `${v.id}-${ratio.replace(':', 'x')}-${hash}`, variationId: v.id, ratio, prompt, theme: v.theme });
    }
  }
  return out;
}

export function planSummary(plan: BrandPlan, needs: ImageNeed[], cached: number, estUsd: number, provider: string): string {
  const lines = [
    `Campaign: ${plan.campaign}`,
    `Words on every asset: "${plan.message.headline}" / "${plan.message.subline}" / button "${plan.message.cta}"`,
    '',
    `${plan.variations.length} variations:`,
    ...plan.variations.map((v) => `- ${v.id} ${v.name}: ${v.concept} (panel ${v.panel}, text ${v.text})`),
    '',
    `Sizes (${plan.sizes.length}): ${plan.sizes.map((s) => { const z = SIZE_BY_ID.get(s); return z ? `${s} ${z.width}x${z.height}` : s; }).join(', ')}`,
    `Finished assets: ${plan.variations.length * plan.sizes.length}`,
    '',
    `Images to generate: ${needs.length - cached} new${cached ? `, ${cached} already made` : ''}. Source: ${provider}.`,
    `Estimated cost: $${estUsd.toFixed(2)}.`,
    'Nothing is generated until you approve.',
  ];
  return lines.join('\n');
}
