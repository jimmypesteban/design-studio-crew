import { generateImage, TRANSIENT, type GeminiErrorKind, type RateGate } from './gemini.ts';
import type { AspectRatio } from './sizes.ts';
import type { MoonTokens } from '../moon/tokens.ts';

export interface ImageRequest {
  /** Stable id for the cache: variation plus ratio. */
  key: string;
  prompt: string;
  aspectRatio: AspectRatio;
  /** Which look this is, so the placeholder art can differ. */
  theme: string;
  index: number;
}

export type ImageResult =
  | { ok: true; mime: string; data: Buffer; model: string; note?: string }
  | { ok: false; kind: GeminiErrorKind; message: string; detail?: string };

export interface ImageProvider {
  name: 'mock' | 'gemini';
  model: string;
  /** What one image is expected to cost, in US dollars. */
  estUsd: number;
  generate(req: ImageRequest): Promise<ImageResult>;
}

const DIMS: Record<AspectRatio, [number, number]> = {
  '1:1': [1024, 1024],
  '4:3': [1024, 768],
  '3:4': [768, 1024],
  '16:9': [1280, 720],
  '9:16': [720, 1280],
};

/** Palettes for the placeholder art. Every colour is a Moon token. */
const THEMES: Record<string, [string, string, string, string]> = {
  sunrise: ['mo-yellow-2', 'mo-orange-4', 'mo-red-6', 'mo-pink-4'],
  forest: ['mo-green-2', 'mo-green-6', 'mo-forest-6', 'mo-blue-3'],
  night: ['mo-ocean-5', 'mo-purple-6', 'mo-blue-6', 'mo-pink-5'],
  default: ['mo-grey-3', 'mo-blue-3', 'mo-purple-4', 'mo-yellow-5'],
};

/**
 * Free, offline placeholder art drawn only in Moon colours. It stands in for the
 * image model so the whole brand pipeline, composer and Reviewer run for real
 * without spending anything. It is clearly not final artwork.
 */
export class MockImages implements ImageProvider {
  name = 'mock' as const;
  model = 'placeholder-art';
  estUsd = 0;
  constructor(private tokens: MoonTokens) {}

  async generate(req: ImageRequest): Promise<ImageResult> {
    const [w, h] = DIMS[req.aspectRatio];
    const names = THEMES[req.theme] ?? THEMES.default!;
    const c = names.map((n) => this.tokens.colors[n] ?? '#F5F4F0');
    const r = (i: number, span: number) => ((req.index * 37 + i * 53) % 100) / 100 * span;
    const big = Math.max(w, h);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<circle cx="${w * 0.72 + r(1, w * 0.1)}" cy="${h * 0.3 + r(2, h * 0.1)}" r="${big * 0.22}" fill="${c[2]}" opacity="0.9"/>
<circle cx="${w * 0.9}" cy="${h * 0.85}" r="${big * 0.3}" fill="${c[3]}" opacity="0.75"/>
<path d="M0 ${h * 0.82} C ${w * 0.25} ${h * 0.62}, ${w * 0.5} ${h * 1.02}, ${w} ${h * 0.74} L ${w} ${h} L 0 ${h} Z" fill="${c[2]}" opacity="0.55"/>
<path d="M0 ${h * 0.92} C ${w * 0.3} ${h * 0.78}, ${w * 0.6} ${h * 1.05}, ${w} ${h * 0.88} L ${w} ${h} L 0 ${h} Z" fill="${c[3]}" opacity="0.7"/>
</svg>`;
    return { ok: true, mime: 'image/svg+xml', data: Buffer.from(svg), model: this.model };
  }
}

export class GeminiImages implements ImageProvider {
  name = 'gemini' as const;
  constructor(
    public model: string,
    public estUsd: number,
    private opts: { fetch?: typeof fetch; apiKey?: string; gate?: RateGate; retryDelayMs?: number } = {},
  ) {}

  async generate(req: ImageRequest): Promise<ImageResult> {
    for (let attempt = 1; ; attempt++) {
      const res = await generateImage({ prompt: req.prompt, aspectRatio: req.aspectRatio }, { ...this.opts, model: this.model });
      if (res.ok) return { ok: true, mime: res.mime, data: res.data, model: res.model, note: res.note };
      if (attempt >= 2 || !TRANSIENT.includes(res.kind)) return res;
      await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 2000));
    }
  }
}

export function extFor(mime: string): string {
  if (mime.includes('svg')) return 'svg';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  return 'png';
}
