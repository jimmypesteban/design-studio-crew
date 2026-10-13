import { AnthropicLLM } from './llm/anthropic.ts';
import { MockLLM } from './llm/mock.ts';
import { GeminiImages, MockImages, type ImageProvider } from './brand/images.ts';
import type { Config } from './config.ts';
import type { LLM } from './agents/types.ts';
import type { MoonTokens } from './moon/tokens.ts';

/** Live agents are opt in. A key on its own never starts spending. */
export function makeLlm(cfg: Config, say: (s: string) => void = console.log): LLM {
  if (cfg.llmMode === 'live') {
    if (!cfg.hasAnthropicKey) throw new Error('STUDIO_LLM=live needs ANTHROPIC_API_KEY set in your environment or .env. It is not set.');
    return new AnthropicLLM(cfg.model);
  }
  if (cfg.hasAnthropicKey) say('Note: an Anthropic key is set, but STUDIO_LLM is not "live", so this run uses the free mock agents.');
  return new MockLLM();
}

/** Real images are opt in too, and separately from the agents. */
export function makeImages(cfg: Config, tokens: MoonTokens, say: (s: string) => void = console.log): ImageProvider {
  if (cfg.imageMode === 'live') {
    if (!cfg.hasGeminiKey) throw new Error('STUDIO_IMAGES=live needs GEMINI_API_KEY set in your environment or .env. It is not set.');
    return new GeminiImages(cfg.geminiModel, cfg.geminiCostUsd);
  }
  if (cfg.hasGeminiKey) say('Note: a Gemini key is set, but STUDIO_IMAGES is not "live", so this run uses free placeholder art.');
  return new MockImages(tokens);
}
