import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockChannel } from '../src/channel/mock.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { MockLLM } from '../src/llm/mock.ts';
import { loadMoonTokens } from '../src/moon/tokens.ts';
import type { Deps } from '../src/pipeline.ts';
import { MockImages, type ImageProvider } from '../src/brand/images.ts';
import type { LLM } from '../src/agents/types.ts';

export async function makeDeps(opts: { script?: string[]; llm?: LLM; maxUsd?: number; images?: ImageProvider; maxImages?: number; cfg?: Partial<Config> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const base = loadConfig();
  const cfg: Config = { ...base, outDir: path.join(dir, 'out'), dbPath: ':memory:', maxUsd: opts.maxUsd ?? 1, maxImages: opts.maxImages ?? 12, auditFileRoots: [dir], ...opts.cfg };
  const store = new Store(':memory:');
  const channel = new MockChannel({ script: opts.script ?? [], print: false });
  const tokens = await loadMoonTokens(cfg.moonPath);
  const deps: Deps = { cfg, store, llm: opts.llm ?? new MockLLM(), channel, tokens, images: opts.images ?? new MockImages(tokens) };
  return { deps, channel, store, cfg, dir };
}
