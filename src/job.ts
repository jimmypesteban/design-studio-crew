import fs from 'node:fs';
import path from 'node:path';
import { buildRequest } from './agents/registry.ts';
import { makeTools } from './agents/tools.ts';
import { CostCapError, ROLE_TITLES, type AgentContext, type LLM, type Role } from './agents/types.ts';
import type { Attachment } from './audit/target.ts';
import type { ImageProvider } from './brand/images.ts';
import { APPROVE, REJECT, STOP, type Button, type Channel } from './channel/types.ts';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import type { MoonTokens } from './moon/tokens.ts';
import { plain } from './plain.ts';

export interface Deps {
  cfg: Config;
  store: Store;
  llm: LLM;
  channel: Channel;
  tokens: MoonTokens;
  images: ImageProvider;
}

export interface JobOptions {
  /** Mock mode only: agents start with known flaws so the review loop is visible. */
  seedFlaw: boolean;
  /** How many times the Reviewer may send work back before Jimmy sees it. */
  maxAutoFixes: number;
  /** Most times Jimmy can send one step back. */
  maxHumanRounds: number;
  /** After the main work is approved, offer the Handoff pack. */
  offerHandoff: boolean;
  /** Files that came with the brief, such as a screenshot sent in Telegram. */
  attachments: Attachment[];
}

export const DEFAULT_OPTIONS: JobOptions = { seedFlaw: true, maxAutoFixes: 3, maxHumanRounds: 3, offerHandoff: true, attachments: [] };

export class StopJob extends Error {
  constructor(public why: string) {
    super(why);
  }
}

export const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3).trimEnd() + '...' : s);

/** `other` is any button besides Approve, Send back, Stop and Approve anyway. It carries the button id. */
export type GateDecision = { decision: 'approve' | 'reject' | 'override' | 'other'; reason?: string; id?: string };

/**
 * Everything one job shares: the output folder, the notes approved so far, the
 * cost cap, the agent call wrapper and the approval gate. The route steps
 * (UI, Brand, Handoff) are written against this.
 */
export interface JobKit {
  deps: Deps;
  opts: JobOptions;
  jobId: string;
  dir: string;
  notes: Partial<Record<Role, string>>;
  flagged: Set<string>;
  /** Write a file inside the job folder. Returns its absolute path. */
  w(rel: string, data: string | Buffer): string;
  nextSeq(): number;
  currentSeq(): number;
  baseCtx(): AgentContext;
  callAgent(role: Role, ctx: AgentContext): Promise<string>;
  /** Count money spent outside agent calls, such as images. */
  charge(usd: number, role: Role, message: string, data?: unknown): void;
  /** Make sure `extraUsd` fits under the cap. Asks Jimmy to raise it or stop. */
  ensureBudget(extraUsd: number, role: Role): Promise<void>;
  gate(
    role: Role,
    stepId: number,
    body: string,
    opt?: { file?: string; caption?: string; buttons?: Button[] },
  ): Promise<GateDecision>;
  textStep(role: Role, label: string, show: (text: string) => string): Promise<string>;
}

export function createKit(deps: Deps, jobId: string, dir: string, opts: JobOptions): JobKit {
  const { cfg, store, llm, channel, tokens } = deps;
  const tools = makeTools(tokens);
  let cap = cfg.maxUsd;
  let seq = 0;
  const notes: Partial<Record<Role, string>> = {};
  const flagged = new Set<string>();

  const kit: JobKit = {
    deps,
    opts,
    jobId,
    dir,
    notes,
    flagged,
    w(rel, data) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      return file;
    },
    nextSeq: () => ++seq,
    currentSeq: () => seq,
    baseCtx: () => ({
      jobId,
      brief: store.getJob(jobId)?.brief ?? '',
      attempt: 1,
      notes: { ...notes },
      flaggedRules: [...flagged],
      seedFlaw: opts.seedFlaw && llm.mode === 'mock',
      tokens,
      memory: [],
      attachments: opts.attachments.map((a) => ({ kind: a.kind, name: path.basename(a.path) })),
    }),

    charge(usd, role, message, data) {
      if (usd <= 0) return;
      const total = store.addCost(jobId, usd);
      store.log(jobId, 'cost', role, `${message} Job total $${total.toFixed(4)}.`, data);
    },

    async ensureBudget(extraUsd, role) {
      for (;;) {
        const spent = store.getJob(jobId)?.cost_usd ?? 0;
        if (spent + extraUsd <= cap) return;
        store.log(jobId, 'cost_cap', role, `Next step costs about $${extraUsd.toFixed(2)}. Spent $${spent.toFixed(2)} against a cap of $${cap.toFixed(2)}.`);
        const a = await channel.ask(
          `The next step is estimated at $${extraUsd.toFixed(2)}. This job has spent $${spent.toFixed(2)} and the cap is $${cap.toFixed(2)}. Add another $1 to the cap and carry on, or stop here?`,
          [{ id: 'raise', label: 'Add $1 and continue' }, STOP],
        );
        if (a !== 'raise') throw new StopJob('Stopped at the cost cap.');
        cap += 1;
      }
    },

    async callAgent(role, ctx) {
      const withMemory = { ...ctx, memory: role === 'ui' || role === 'brand' || role === 'handoff' ? store.recall(role) : [] };
      for (;;) {
        try {
          const spent = store.getJob(jobId)?.cost_usd ?? 0;
          const budget = cap - spent;
          if (budget <= 0) throw new CostCapError(0, cap);
          const res = await llm.run(buildRequest(cfg.agentsDir, role, withMemory), tools, budget);
          if (res.usd > 0) {
            kit.charge(res.usd, role, `${ROLE_TITLES[role]} call cost $${res.usd.toFixed(4)}.`, {
              input: res.inputTokens,
              output: res.outputTokens,
            });
          }
          return plain(res.text);
        } catch (e) {
          if (!(e instanceof CostCapError)) throw e;
          const total = store.addCost(jobId, e.spent);
          store.log(jobId, 'cost_cap', role, `Job reached $${total.toFixed(2)} against a cap of $${cap.toFixed(2)}.`);
          const a = await channel.ask(
            `This job has spent $${total.toFixed(2)} and the cap is $${cap.toFixed(2)}. Add another $1 and carry on, or stop here?`,
            [{ id: 'raise', label: 'Add $1 and continue' }, STOP],
          );
          if (a !== 'raise') throw new StopJob('Stopped at the cost cap.');
          cap += 1;
        }
      }
    },

    /** Show a proposal and wait for Jimmy. Every decision is logged. */
    async gate(role, stepId, body, opt = {}) {
      store.log(jobId, 'proposal', role, `${ROLE_TITLES[role]} proposed step ${seq}.`);
      if (opt.file) await channel.sendFile(opt.file, opt.caption);
      const id = await channel.ask(`${ROLE_TITLES[role]} proposes:\n\n${trim(body, 3000)}`, opt.buttons ?? [APPROVE, REJECT, STOP]);
      if (id === 'approve') {
        store.decideStep(stepId, 'approved');
        store.log(jobId, 'approval', role, `Jimmy approved the ${ROLE_TITLES[role]} step.`);
        return { decision: 'approve' };
      }
      if (id === 'stop') {
        store.decideStep(stepId, 'rejected', 'Stopped by Jimmy');
        throw new StopJob('Stopped by Jimmy.');
      }
      if (id === 'override') {
        const why = await channel.askText('Approving work the Reviewer rejected is logged as an override. Why is it fine to ship?');
        store.decideStep(stepId, 'overridden', why);
        store.log(jobId, 'override', role, `Jimmy approved despite Reviewer rejection: ${why}`, { reason: why });
        return { decision: 'override', reason: why };
      }
      if (id !== 'reject') return { decision: 'other', id };
      const reason = await channel.askText('What should change? One or two plain sentences is enough.');
      store.decideStep(stepId, 'rejected', reason);
      store.log(jobId, 'rejection', role, `Jimmy sent the ${ROLE_TITLES[role]} step back: ${reason}`, { reason });
      return { decision: 'reject', reason };
    },

    /** A text-only role: propose, wait, revise until approved. */
    async textStep(role, label, show) {
      const seqNo = kit.nextSeq();
      const n = String(seqNo).padStart(2, '0');
      let feedback: string | undefined;
      for (let attempt = 1; attempt <= opts.maxHumanRounds + 1; attempt++) {
        const text = await kit.callAgent(role, { ...kit.baseCtx(), attempt, feedback });
        if (attempt > 1) {
          store.log(jobId, 'fix', role, `${ROLE_TITLES[role]} revised the note after Jimmy's feedback.`, { attempt, feedback });
        }
        const rel = `notes/${n}-${role}${attempt > 1 ? `.v${attempt}` : ''}.md`;
        const file = kit.w(rel, `# ${label}\n\n${text}\n`);
        store.log(jobId, 'agent_note', role, `${ROLE_TITLES[role]} wrote ${rel}.`);
        const stepId = store.addStep(jobId, seqNo, role, attempt, file);
        const g = await kit.gate(role, stepId, show(text));
        if (g.decision === 'approve') {
          kit.w(`notes/${n}-${role}.md`, `# ${label}\n\n${text}\n`);
          return text;
        }
        feedback = g.reason;
      }
      throw new StopJob(`${ROLE_TITLES[role]} was sent back too many times.`);
    },
  };
  return kit;
}
