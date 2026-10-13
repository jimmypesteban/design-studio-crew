import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function expand(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export const ROOT = path.resolve(here, '..');

/** Secret names whose values must never reach a log, a note or a message. */
export const SECRET_ENV = ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY'] as const;

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return SECRET_ENV.map((k) => env[k]).filter((v): v is string => !!v && v.length > 6);
}

export interface Config {
  root: string;
  outDir: string;
  dbPath: string;
  agentsDir: string;
  moonPath: string;
  chromePath: string;
  llmMode: 'mock' | 'live';
  model: string;
  maxUsd: number;
  hasAnthropicKey: boolean;
  /** mock draws placeholder art, live calls Gemini. Opt in separately from the agents. */
  imageMode: 'mock' | 'live';
  hasGeminiKey: boolean;
  geminiModel: string;
  /** Estimated cost of one generated image. Check it against your own Gemini pricing. */
  geminiCostUsd: number;
  /** Most images one job may generate. */
  maxImages: number;
  /** Let audits open pages on this machine (localhost). Off by default. */
  auditAllowLocal: boolean;
  /** Extra folders audits may read local files from, besides out/ and samples/. */
  auditFileRoots: string[];
  telegramOwnerId: number | null;
}

function positive(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const maxUsd = Number(env.STUDIO_MAX_USD ?? '1');
  const owner = env.TELEGRAM_OWNER_ID ? Number(env.TELEGRAM_OWNER_ID) : null;
  return {
    root: ROOT,
    outDir: path.join(ROOT, 'out'),
    dbPath: env.STUDIO_DB ? expand(env.STUDIO_DB) : path.join(ROOT, 'data', 'studio.db'),
    agentsDir: path.join(ROOT, 'agents'),
    moonPath: expand(env.MOON_PATH ?? '~/2026/moon-design-system'),
    chromePath: expand(env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    llmMode: env.STUDIO_LLM === 'live' ? 'live' : 'mock',
    model: env.STUDIO_MODEL ?? 'claude-sonnet-5-5',
    maxUsd: Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : 1,
    hasAnthropicKey: !!env.ANTHROPIC_API_KEY,
    imageMode: env.STUDIO_IMAGES === 'live' ? 'live' : 'mock',
    hasGeminiKey: !!env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
    geminiCostUsd: positive(env.GEMINI_COST_PER_IMAGE_USD, 0.05),
    maxImages: Math.floor(positive(env.BRAND_MAX_IMAGES, 12)),
    auditAllowLocal: env.AUDIT_ALLOW_LOCALHOST === '1',
    auditFileRoots: (env.AUDIT_FILE_ROOTS ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(expand),
    telegramOwnerId: owner && Number.isFinite(owner) ? owner : null,
  };
}
