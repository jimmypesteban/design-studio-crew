import fs from 'node:fs';
import path from 'node:path';
import { clean } from './plain.ts';

// node:sqlite is still flagged experimental in Node 24. It works and needs no
// native build, so we use it and silence only that one warning.
const realEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/i.test(text)) return;
  return (realEmit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = realEmit;

export type EventType =
  | 'job_created'
  | 'route'
  | 'agent_note'
  | 'proposal'
  | 'approval'
  | 'rejection'
  | 'fix'
  | 'review_pass'
  | 'review_reject'
  | 'override'
  | 'cost'
  | 'cost_cap'
  | 'job_done'
  | 'job_stopped'
  | 'info';

export interface JobRow {
  id: string;
  created_at: string;
  brief: string;
  kind: string | null;
  status: string;
  cost_usd: number;
  llm_mode: string;
}

export interface EventRow {
  id: number;
  job_id: string;
  ts: string;
  type: EventType;
  role: string | null;
  message: string;
  data: string | null;
}

export interface StepRow {
  id: number;
  job_id: string;
  seq: number;
  role: string;
  attempt: number;
  status: string;
  note_path: string | null;
  created_at: string;
  decided_at: string | null;
  reason: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  brief TEXT NOT NULL,
  kind TEXT,
  status TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  llm_mode TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  note_path TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  role TEXT,
  message TEXT NOT NULL,
  data TEXT
);
CREATE TABLE IF NOT EXISTS memory (
  role TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (role, key)
);
CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  target_key TEXT NOT NULL,
  target TEXT NOT NULL,
  profile TEXT NOT NULL,
  ts TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS waivers (
  target_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rule TEXT NOT NULL,
  reason TEXT NOT NULL,
  job_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  PRIMARY KEY (target_key, fingerprint)
);
CREATE INDEX IF NOT EXISTS audits_target ON audits(target_key, id);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id, id);
`;

const now = () => new Date().toISOString();

export class Store {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createJob(id: string, brief: string, llmMode: string): void {
    this.db
      .prepare('INSERT INTO jobs (id, created_at, brief, status, llm_mode) VALUES (?, ?, ?, ?, ?)')
      .run(id, now(), clean(brief), 'running', llmMode);
    this.log(id, 'job_created', null, 'Job created from a brief.');
  }

  getJob(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
  }

  listJobs(limit = 20): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as JobRow[];
  }

  setJob(id: string, patch: { kind?: string; status?: string }): void {
    if (patch.kind !== undefined) this.db.prepare('UPDATE jobs SET kind = ? WHERE id = ?').run(patch.kind, id);
    if (patch.status !== undefined) this.db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(patch.status, id);
  }

  addCost(id: string, usd: number): number {
    this.db.prepare('UPDATE jobs SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, id);
    return this.getJob(id)?.cost_usd ?? 0;
  }

  addStep(jobId: string, seq: number, role: string, attempt: number, notePath: string | null): number {
    const r = this.db
      .prepare(
        'INSERT INTO steps (job_id, seq, role, attempt, status, note_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(jobId, seq, role, attempt, 'proposed', notePath, now());
    return Number(r.lastInsertRowid);
  }

  decideStep(stepId: number, status: 'approved' | 'rejected' | 'overridden', reason?: string): void {
    this.db
      .prepare('UPDATE steps SET status = ?, decided_at = ?, reason = ? WHERE id = ?')
      .run(status, now(), reason ? clean(reason) : null, stepId);
  }

  listSteps(jobId: string): StepRow[] {
    return this.db.prepare('SELECT * FROM steps WHERE job_id = ? ORDER BY id').all(jobId) as unknown as StepRow[];
  }

  log(jobId: string, type: EventType, role: string | null, message: string, data?: unknown): void {
    this.db
      .prepare('INSERT INTO events (job_id, ts, type, role, message, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, now(), type, role, clean(message), data === undefined ? null : clean(JSON.stringify(data)));
  }

  events(jobId: string): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id').all(jobId) as unknown as EventRow[];
  }

  saveAudit(jobId: string, targetKey: string, target: string, profile: string, summary: unknown): void {
    this.db
      .prepare('INSERT INTO audits (job_id, target_key, target, profile, ts, summary) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, targetKey, clean(target), profile, now(), JSON.stringify(summary));
  }

  /** The most recent audit of this target, not counting the current job. */
  lastAudit(targetKey: string, exceptJobId?: string): { job_id: string; ts: string; summary: unknown } | undefined {
    const row = this.db
      .prepare('SELECT job_id, ts, summary FROM audits WHERE target_key = ? AND job_id != ? ORDER BY id DESC LIMIT 1')
      .get(targetKey, exceptJobId ?? '') as unknown as { job_id: string; ts: string; summary: string } | undefined;
    return row ? { job_id: row.job_id, ts: row.ts, summary: JSON.parse(row.summary) as unknown } : undefined;
  }

  addWaiver(targetKey: string, fingerprint: string, rule: string, reason: string, jobId: string): void {
    this.db
      .prepare(
        `INSERT INTO waivers (target_key, fingerprint, rule, reason, job_id, ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_key, fingerprint) DO UPDATE SET reason = excluded.reason, job_id = excluded.job_id, ts = excluded.ts`,
      )
      .run(targetKey, fingerprint, rule, clean(reason), jobId, now());
  }

  waivers(targetKey: string): Map<string, string> {
    const rows = this.db.prepare('SELECT fingerprint, reason FROM waivers WHERE target_key = ?').all(targetKey) as unknown as { fingerprint: string; reason: string }[];
    return new Map(rows.map((r) => [r.fingerprint, r.reason]));
  }

  /** Remember a lesson for a role. Repeats raise the count instead of duplicating. */
  remember(role: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO memory (role, key, value, count, updated_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(role, key) DO UPDATE SET count = count + 1, value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(role, key, clean(value), now());
  }

  recall(role: string, limit = 8): { key: string; value: string; count: number }[] {
    return this.db
      .prepare('SELECT key, value, count FROM memory WHERE role = ? ORDER BY count DESC, updated_at DESC LIMIT ?')
      .all(role, limit) as unknown as { key: string; value: string; count: number }[];
  }
}
