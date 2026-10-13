import { clean } from '../plain.ts';
import type { AspectRatio } from './sizes.ts';

/**
 * Gemini image client. Same safe pattern as the Darkroom project: it runs only on
 * the studio server, the key comes from GEMINI_API_KEY and travels in a header
 * (never in the URL), errors are sorted into plain kinds, and every call has a
 * timeout. The key is never logged or returned.
 */

export type GeminiErrorKind =
  | 'config'
  | 'rate_limited'
  | 'billing'
  | 'auth'
  | 'filtered'
  | 'timeout'
  | 'network'
  | 'upstream'
  | 'invalid_input';

export interface GeminiOk {
  ok: true;
  mime: string;
  data: Buffer;
  model: string;
  latencyMs: number;
  note?: string;
}
export interface GeminiFail {
  ok: false;
  kind: GeminiErrorKind;
  message: string;
  detail?: string;
}
export type GeminiResult = GeminiOk | GeminiFail;

/** Kinds worth one more try. Everything else needs a person or a different prompt. */
export const TRANSIENT: GeminiErrorKind[] = ['timeout', 'network', 'upstream', 'rate_limited'];

const FILTER_REASONS = new Set([
  'SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_RECITATION',
]);

interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  thought?: boolean;
}
interface Response {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string; finishMessage?: string }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

export const MAX_PROMPT_LENGTH = 800;

/** Waits instead of failing when too many calls land in one window. */
export class RateGate {
  private hits: number[] = [];
  constructor(
    private max = 8,
    private windowMs = 60_000,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  async wait(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.hits = this.hits.filter((h) => t - h < this.windowMs);
      if (this.hits.length < this.max) {
        this.hits.push(t);
        return;
      }
      await this.sleep(this.windowMs - (t - this.hits[0]!) + 5);
    }
  }
}

const defaultGate = new RateGate();

export interface GeminiOptions {
  fetch?: typeof fetch;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  gate?: RateGate;
}

function failWith(secret: string | undefined) {
  const redact = (s: string) => (secret && secret.length > 3 ? s.split(secret).join('[secret removed]') : s);
  return (kind: GeminiErrorKind, message: string, detail?: string): GeminiFail => ({
    ok: false,
    kind,
    message: redact(message),
    detail: detail ? redact(clean(detail)).slice(0, 400) : undefined,
  });
}

export async function generateImage(req: { prompt: string; aspectRatio: AspectRatio }, opts: GeminiOptions): Promise<GeminiResult> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  // Whatever the upstream says, the key we used is removed from it before it goes anywhere.
  const fail = failWith(apiKey);
  if (!apiKey) return fail('config', 'GEMINI_API_KEY is not set.', 'Put it in .env, see the README.');
  const prompt = req.prompt.trim();
  if (!prompt) return fail('invalid_input', 'The image prompt is empty.');
  if (prompt.length > MAX_PROMPT_LENGTH) return fail('invalid_input', `Keep each image prompt under ${MAX_PROMPT_LENGTH} characters.`);

  await (opts.gate ?? defaultGate).wait();
  const doFetch = opts.fetch ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;
  const started = Date.now();
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: req.aspectRatio } },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 55_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') return fail('timeout', 'The model took too long to respond.');
    return fail('network', 'Could not reach the Gemini API.', (err as Error).message);
  }
  const latencyMs = Date.now() - started;

  let data: Response;
  try {
    data = (await res.json()) as Response;
  } catch {
    return fail('upstream', 'The model returned an unreadable response.', `HTTP ${res.status}`);
  }

  if (!res.ok) {
    const detail = data.error?.message ?? `HTTP ${res.status}`;
    if (/credits are depleted|prepayment/i.test(detail)) return fail('billing', 'Out of prepaid Gemini credits. Top up in Google AI Studio.', detail);
    if (res.status === 429 && /free_tier\S*, limit: 0/.test(detail)) return fail('billing', 'This key has no quota for image models. Enable billing in Google AI Studio.', detail);
    if (res.status === 429) return fail('rate_limited', 'The API quota is used up for now.', detail);
    if (res.status === 401 || res.status === 403 || /api key not valid|API_KEY_INVALID/i.test(detail)) return fail('auth', 'The API key was rejected or lacks access to this model.', detail);
    if (res.status === 400 && /safety|blocked|policy/i.test(detail)) return fail('filtered', 'This prompt was blocked by the safety filters.', detail);
    if (res.status === 404) return fail('config', `Model "${opts.model}" is not available to this key.`, detail);
    return fail('upstream', 'The model call failed.', detail);
  }

  if (data.promptFeedback?.blockReason) {
    return fail('filtered', 'This prompt was blocked by the safety filters.', data.promptFeedback.blockReasonMessage ?? data.promptFeedback.blockReason);
  }
  const candidate = data.candidates?.[0];
  const parts = (candidate?.content?.parts ?? []).filter((p) => !p.thought);
  const image = parts.find((p) => p.inlineData?.data)?.inlineData;
  if (image) {
    return {
      ok: true,
      mime: image.mimeType || 'image/png',
      data: Buffer.from(image.data, 'base64'),
      model: data.modelVersion || opts.model,
      latencyMs,
      note: parts.map((p) => p.text).filter(Boolean).join(' ').trim() || undefined,
    };
  }
  const reason = candidate?.finishReason;
  if (reason && FILTER_REASONS.has(reason)) {
    return fail('filtered', 'The image was withheld by the safety filters.', candidate?.finishMessage ?? reason);
  }
  return fail('upstream', 'The model returned no image.', parts.map((p) => p.text).filter(Boolean).join(' ') || reason);
}
