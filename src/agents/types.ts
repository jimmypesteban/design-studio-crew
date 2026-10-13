import type { MoonTokens } from '../moon/tokens.ts';

export type Role = 'lead' | 'strategist' | 'ux' | 'ui' | 'brand' | 'reviewer' | 'handoff';

export const ROLE_TITLES: Record<Role, string> = {
  lead: 'Studio Lead',
  strategist: 'Strategist',
  ux: 'UX',
  ui: 'UI',
  brand: 'Brand',
  reviewer: 'Reviewer',
  handoff: 'Handoff',
};

/** Roles wired into the pipeline in milestone 1. */
export const BUILT_ROLES: Role[] = ['lead', 'strategist', 'ux', 'ui', 'brand', 'reviewer', 'handoff'];

export interface IssueLite {
  rule: string;
  where: string;
  detail: string;
  fix: string;
}

/** Everything an agent may need. Live agents get it as text, the mock reads it directly. */
export interface AgentContext {
  jobId: string;
  brief: string;
  attempt: number;
  /** Approved notes from earlier agents, by role. */
  notes: Partial<Record<Role, string>>;
  /** A rejection reason from Jimmy, if this is a revision. */
  feedback?: string;
  /** Reviewer issues to fix, if this is a revision. */
  issues?: IssueLite[];
  /** Every Reviewer rule flagged so far on this job. */
  flaggedRules: string[];
  /** Mock only: start the UI agent with known flaws so the review loop is visible. */
  seedFlaw: boolean;
  tokens: MoonTokens;
  /** Lessons remembered from earlier jobs. */
  memory: { key: string; value: string; count: number }[];
  /** Brand: the plan being revised, as JSON text. */
  previousPlan?: string;
  /** Handoff: which kind of work is being handed off. */
  handoffKind?: 'ui' | 'brand' | 'audit';
  /** Files that came with the brief, by kind. The Lead uses this to route. */
  attachments?: { kind: 'image' | 'html'; name: string }[];
  /** Images for a visual review. Never logged. */
  images?: { mime: 'image/jpeg' | 'image/png'; data: string }[];
  /** Reviewer: do a visual review of the attached screenshot. */
  visualReview?: boolean;
  /** Handoff: facts measured from the approved work, as text. The agent must not contradict them. */
  facts?: string;
  /** Handoff: the React draft the converter wrote. */
  draftCode?: string;
  /** Handoff: the React code that failed verification. */
  previousCode?: string;
  /** Mock only: what the facts say, so the mock can write the spec without a model. */
  factsData?: unknown;
}

export interface AgentRequest {
  role: Role;
  system: string;
  user: string;
  toolNames: string[];
  ctx: AgentContext;
  images?: { mime: 'image/jpeg' | 'image/png'; data: string }[];
}

export interface LLMResult {
  text: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ToolRunner {
  definitions(names: string[]): { name: string; description: string; input_schema: Record<string, unknown> }[];
  run(name: string, input: Record<string, unknown>): string;
}

export interface LLM {
  mode: 'mock' | 'live';
  /** budgetUsd is what the job may still spend. Live calls stop when it runs out. */
  run(req: AgentRequest, tools: ToolRunner, budgetUsd: number): Promise<LLMResult>;
}

export class CostCapError extends Error {
  constructor(
    public spent: number,
    public cap: number,
  ) {
    super(`Job cost $${spent.toFixed(2)} reached the cap of $${cap.toFixed(2)}.`);
  }
}
