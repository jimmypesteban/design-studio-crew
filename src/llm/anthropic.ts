import Anthropic from '@anthropic-ai/sdk';
import { CostCapError, type AgentRequest, type LLM, type LLMResult, type ToolRunner } from '../agents/types.ts';

/** US dollars per million tokens, first-party API rates. */
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export function priceFor(model: string) {
  // An unknown model is billed at the highest known rate so the cap errs on the safe side.
  return PRICES[model] ?? { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 };
}

export function usageUsd(
  model: string,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null },
): number {
  const p = priceFor(model);
  return (
    (u.input_tokens * p.in +
      u.output_tokens * p.out +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}

const MAX_TURNS = 6;

export class AnthropicLLM implements LLM {
  mode = 'live' as const;
  private client: Anthropic;

  constructor(
    private model: string,
    client?: Anthropic,
  ) {
    // The SDK reads ANTHROPIC_API_KEY from the environment. The key is never passed around or logged here.
    this.client = client ?? new Anthropic();
  }

  async run(req: AgentRequest, tools: ToolRunner, budgetUsd: number): Promise<LLMResult> {
    const defs = tools.definitions(req.toolNames);
    const content: Anthropic.ContentBlockParam[] = [
      ...(req.images ?? []).map((i): Anthropic.ImageBlockParam => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
      { type: 'text', text: req.user },
    ];
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.images?.length ? content : req.user }];
    let usd = 0;
    let inTok = 0;
    let outTok = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (usd >= budgetUsd) throw new CostCapError(usd, budgetUsd);
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: req.system,
        messages,
        output_config: { effort: 'medium' },
        ...(defs.length ? { tools: defs as Anthropic.Tool[] } : {}),
      });
      usd += usageUsd(this.model, res.usage);
      inTok += res.usage.input_tokens;
      outTok += res.usage.output_tokens;

      if (res.stop_reason === 'refusal') {
        throw new Error(`The model declined this request (${res.stop_details?.category ?? 'no category'}).`);
      }
      if (res.stop_reason === 'max_tokens') throw new Error('The model ran out of output space before it finished.');

      if (res.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: res.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of res.content) {
          if (block.type === 'tool_use') {
            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: tools.run(block.name, (block.input ?? {}) as Record<string, unknown>),
            });
          }
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { text, usd, inputTokens: inTok, outputTokens: outTok };
    }
    throw new Error('The agent kept calling tools and never finished.');
  }
}
