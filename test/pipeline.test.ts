import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MockLLM } from '../src/llm/mock.ts';
import { AnthropicLLM, usageUsd } from '../src/llm/anthropic.ts';
import { runJob } from '../src/pipeline.ts';
import { makeTools } from '../src/agents/tools.ts';
import { CostCapError, type AgentRequest, type LLM, type LLMResult, type ToolRunner } from '../src/agents/types.ts';
import { makeDeps } from './helpers.ts';
import { buildRequest } from '../src/agents/registry.ts';
import { loadMoonTokens } from '../src/moon/tokens.ts';
import { loadConfig } from '../src/config.ts';

const BRIEF = 'A weekly progress screen for a student: streak, lessons done, next lesson, and a kind nudge.';
const types = (store: import('../src/db.ts').Store, id: string) => store.events(id).map((e) => e.type);

test('end to end: Reviewer rejects, UI fixes, Jimmy sends back once, then approves. Everything is logged and saved', async () => {
  const { deps, channel, store } = await makeDeps({
    script: ['approve', 'approve', 'approve', 'reject', 'Please make it simpler, with fewer sections.', 'approve'],
  });
  const res = await runJob(deps, BRIEF, { offerHandoff: false });
  assert.equal(res.status, 'done');
  assert.equal(res.reviewPassed, true);

  const ev = types(store, res.jobId);
  assert.equal(ev.filter((t) => t === 'review_reject').length, 1);
  assert.equal(ev.filter((t) => t === 'rejection').length, 1);
  assert.equal(ev.filter((t) => t === 'fix').length, 2); // one for the Reviewer, one for Jimmy
  assert.equal(ev.filter((t) => t === 'approval').length, 4);
  assert.equal(ev.at(-1), 'job_done');

  // Saved files
  for (const f of ['brief.md', 'notes/01-lead.md', 'notes/02-strategist.md', 'notes/03-ux.md', 'attempts/ui-1.html', 'attempts/review-1.md', 'attempts/ui-3.html', 'final/screen.html', 'final/moon.css', 'final/review.md', 'final/shots/width-375.png', 'log.md', 'job.json']) {
    assert.ok(fs.existsSync(path.join(res.dir, f)), `missing ${f}`);
  }
  // The rejection reasons are written down, with numbers and fixes
  const review1 = fs.readFileSync(path.join(res.dir, 'attempts/review-1.md'), 'utf8');
  assert.match(review1, /REJECTED/);
  assert.match(review1, /Fix:/);
  const log = fs.readFileSync(path.join(res.dir, 'log.md'), 'utf8');
  assert.match(log, /\[review_reject\]/);
  assert.match(log, /Please make it simpler/);

  // Final screen passes the same checks and has no off-system classes or raw hex
  const finalHtml = fs.readFileSync(path.join(res.dir, 'final/screen.html'), 'utf8');
  const body = finalHtml.slice(finalHtml.indexOf('<main'));
  assert.equal(/#[0-9a-fA-F]{6}\b/.test(body), false);

  // The Reviewer's lessons were remembered for next time
  assert.ok(store.recall('ui').some((m) => m.key === 'contrast'));

  // Plain language: no dashes in anything the studio wrote or said
  const all = [...channel.transcript, log, ...['notes/02-strategist.md', 'notes/03-ux.md', 'attempts/ui-2.md'].map((f) => fs.readFileSync(path.join(res.dir, f), 'utf8'))].join('\n');
  assert.equal(/[\u2014\u2013]/.test(all), false);
  // Every step waited for a decision
  assert.ok(channel.transcript.filter((l) => l.includes('Jimmy pressed')).length >= 5);
});

test('a clean build passes the Reviewer first time and needs no auto fixes', async () => {
  const { deps, store } = await makeDeps({ script: [] });
  const res = await runJob(deps, 'A sign up screen for students: name, email, password, terms and a clear button.', { seedFlaw: false, offerHandoff: false });
  assert.equal(res.status, 'done');
  const ev = types(store, res.jobId);
  assert.equal(ev.filter((t) => t === 'review_reject').length, 0);
  assert.equal(ev.filter((t) => t === 'review_pass').length, 1);
});

test('every screen archetype passes the Reviewer when built clean', async () => {
  for (const brief of ['A course catalog with search and level filters.', 'A welcome landing page for a learning app.', 'A log in screen for returning learners.']) {
    const { deps, store } = await makeDeps({ script: [] });
    const res = await runJob(deps, brief, { seedFlaw: false, offerHandoff: false });
    assert.equal(res.status, 'done', brief);
    assert.equal(types(store, res.jobId).filter((t) => t === 'review_reject').length, 0, brief);
  }
});

test('Stop at the first gate ends the job and logs why', async () => {
  const { deps, store } = await makeDeps({ script: ['stop'] });
  const res = await runJob(deps, BRIEF, { offerHandoff: false });
  assert.equal(res.status, 'stopped');
  assert.ok(types(store, res.jobId).includes('job_stopped'));
});

/** A UI agent that never fixes anything, to test the override path. */
class StubbornLLM implements LLM {
  mode = 'mock' as const;
  inner = new MockLLM();
  run(req: AgentRequest, tools: ToolRunner, budget: number) {
    if (req.role === 'ui') {
      return Promise.resolve<LLMResult>({
        text: '## What I built\nA page.\n\n```html\n<div class="mo-container mo-section"><h1 class="mo-h4">Hi</h1><p class="mo-body" style="color:var(--mo-grey-5)">Faint</p></div>\n```',
        usd: 0, inputTokens: 0, outputTokens: 0,
      });
    }
    return this.inner.run(req, tools, budget);
  }
}

test('if the UI agent cannot fix it, Jimmy sees the failing report and can override, which is logged', async () => {
  const { deps, store } = await makeDeps({
    llm: new StubbornLLM(),
    script: ['approve', 'approve', 'approve', 'override', 'This is a throwaway demo and the faint text is deliberate.'],
  });
  const res = await runJob(deps, BRIEF, { offerHandoff: false });
  assert.equal(res.status, 'done');
  assert.equal(res.overridden, true);
  assert.equal(res.reviewPassed, false);
  const ev = types(store, res.jobId);
  assert.equal(ev.filter((t) => t === 'review_reject').length, 4); // first try plus 3 auto fixes
  assert.equal(ev.filter((t) => t === 'override').length, 1);
  assert.match(fs.readFileSync(path.join(res.dir, 'log.md'), 'utf8'), /approved despite Reviewer rejection/);
});

/** Charges a fixed amount per call. */
class ExpensiveLLM implements LLM {
  mode = 'live' as const;
  inner = new MockLLM();
  constructor(private cost: number) {}
  async run(req: AgentRequest, tools: ToolRunner, budget: number): Promise<LLMResult> {
    if (budget <= 0) throw new CostCapError(0, 0);
    const r = await this.inner.run(req, tools, budget);
    return { ...r, usd: this.cost };
  }
}

test('the per-job cost cap stops the job and asks before spending more', async () => {
  const { deps, store } = await makeDeps({ llm: new ExpensiveLLM(0.6), maxUsd: 1, script: ['approve', 'approve', 'stop'] });
  const res = await runJob(deps, BRIEF, { offerHandoff: false });
  assert.equal(res.status, 'stopped');
  const ev = types(store, res.jobId);
  assert.ok(ev.includes('cost_cap'));
  assert.ok((store.getJob(res.jobId)?.cost_usd ?? 0) >= 1);
});

test('raising the cap lets the job continue', async () => {
  const { deps, store } = await makeDeps({ llm: new ExpensiveLLM(0.6), maxUsd: 1, script: ['approve', 'raise'] });
  const res = await runJob(deps, 'A welcome landing page for a learning app.', { seedFlaw: false, offerHandoff: false });
  assert.ok(types(store, res.jobId).includes('cost_cap'));
  assert.ok(['done', 'stopped'].includes(res.status));
  assert.ok(types(store, res.jobId).filter((t) => t === 'approval').length >= 2);
});

// ---------- live adapter, with a stubbed Anthropic client ----------

function stubClient(responses: unknown[]) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      messages: {
        create: async (params: unknown) => {
          calls.push(JSON.parse(JSON.stringify(params)));
          return responses.shift();
        },
      },
    },
  };
}

test('live adapter: tool loop, token costs and the model sent', async () => {
  const cfg = loadConfig();
  const tokens = await loadMoonTokens(cfg.moonPath);
  const { calls, client } = stubClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'check_contrast', input: { foreground: 'mo-white', background: 'mo-blue' } }], usage: { input_tokens: 1000, output_tokens: 100 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 500 } },
  ]);
  const llm = new AnthropicLLM('claude-sonnet-5-5', client as never);
  const ctx = { jobId: 'j', brief: 'b', attempt: 1, notes: {}, flaggedRules: [], seedFlaw: false, tokens, memory: [] };
  const req = buildRequest(cfg.agentsDir, 'ui', ctx);
  assert.deepEqual(req.toolNames, ['lookup_token', 'check_contrast', 'list_classes']);
  assert.match(req.system, /Allowed classes/);
  const out = await llm.run(req, makeTools(tokens), 1);
  assert.equal(out.text, 'Done.');
  // 3000 in at $2, 300 out at $10, 500 cache read at $0.20 per million
  assert.ok(Math.abs(out.usd - (3000 * 2 + 300 * 10 + 500 * 0.2) / 1e6) < 1e-9);
  assert.equal(calls.length, 2);
  const first = calls[0] as Record<string, unknown>;
  assert.equal(first.model, 'claude-sonnet-5-5');
  assert.equal('temperature' in first, false);
  assert.equal('thinking' in first, false);
  // The tool result went back to the model
  const second = calls[1] as { messages: { role: string; content: unknown }[] };
  assert.match(JSON.stringify(second.messages.at(-1)), /2\.91:1/);
});

test('live adapter: stops at the budget, and reports refusals plainly', async () => {
  const cfg = loadConfig();
  const tokens = await loadMoonTokens(cfg.moonPath);
  const ctx = { jobId: 'j', brief: 'b', attempt: 1, notes: {}, flaggedRules: [], seedFlaw: false, tokens, memory: [] };
  const req = buildRequest(cfg.agentsDir, 'ui', ctx);

  const loop = stubClient(
    Array.from({ length: 6 }, () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'list_classes', input: {} }], usage: { input_tokens: 400000, output_tokens: 1000 } })),
  );
  await assert.rejects(() => new AnthropicLLM('claude-sonnet-5-5', loop.client as never).run(req, makeTools(tokens), 0.5), CostCapError);

  const refuse = stubClient([{ stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [], usage: { input_tokens: 10, output_tokens: 0 } }]);
  await assert.rejects(() => new AnthropicLLM('claude-sonnet-5-5', refuse.client as never).run(req, makeTools(tokens), 1), /declined/);
  assert.ok(usageUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 0 }) === 2);
});
