import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.ts';

export interface Attachment {
  kind: 'image' | 'html';
  path: string;
  name?: string;
}

export type AuditTarget =
  | { type: 'url'; url: string; key: string }
  | { type: 'file'; path: string; key: string }
  | { type: 'image'; path: string; key: string };

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export const describeTarget = (t: AuditTarget) => (t.type === 'url' ? t.url : path.basename(t.path));

function expand(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Folders an audit may read local files from. */
export function allowedRoots(cfg: Pick<Config, 'outDir' | 'root' | 'auditFileRoots'>): string[] {
  return [cfg.outDir, path.join(cfg.root, 'samples'), ...cfg.auditFileRoots]
    .map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return r;
      }
    });
}

function inside(file: string, roots: string[]): boolean {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return false;
  }
  return roots.some((r) => real === r || real.startsWith(r + path.sep));
}

export function urlKey(u: URL): string {
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '') || '/'}`;
}

/**
 * Work out what to audit. Done in code, not by a model, because the target decides
 * what the browser touches. Order: an attachment, then a web address, then a job
 * id, then a local file in an allowed folder.
 */
export function findTarget(brief: string, attachments: Attachment[], cfg: Pick<Config, 'outDir' | 'root' | 'auditFileRoots'>): AuditTarget | null {
  const roots = allowedRoots(cfg);
  for (const a of attachments) {
    if (!inside(a.path, [...roots, path.join(cfg.outDir, 'inbox')].map((r) => { try { return fs.realpathSync(r); } catch { return r; } }))) continue;
    if (a.kind === 'image') return { type: 'image', path: a.path, key: `image:${sha(a.path)}` };
    if (a.kind === 'html') return { type: 'file', path: a.path, key: `file:${fs.realpathSync(a.path)}` };
  }
  const url = /https?:\/\/[^\s<>"'`]+/i.exec(brief)?.[0]?.replace(/[.,;:!?)\]]+$/, '');
  if (url) {
    try {
      return { type: 'url', url: new URL(url).href, key: urlKey(new URL(url)) };
    } catch {
      return null;
    }
  }
  const job = /\bjob-\d{8}-\d{6}-[a-z0-9-]+/i.exec(brief)?.[0];
  if (job) {
    const f = path.join(cfg.outDir, job, 'final', 'screen.html');
    if (fs.existsSync(f)) return { type: 'file', path: f, key: `file:${fs.realpathSync(f)}` };
  }
  const local = /(?:~|\.{0,2}\/)?[\w@%+=:,./~-]+\.(?:html?|png|jpe?g|webp)\b/gi;
  for (const m of brief.matchAll(local)) {
    const candidate = path.resolve(m[0].startsWith('~') ? expand(m[0]) : path.isAbsolute(m[0]) ? m[0] : path.join(cfg.root, m[0]));
    if (fs.existsSync(candidate) && inside(candidate, roots)) {
      const real = fs.realpathSync(candidate);
      return /\.html?$/i.test(real) ? { type: 'file', path: real, key: `file:${real}` } : { type: 'image', path: real, key: `image:${sha(real)}` };
    }
  }
  return null;
}

function sha(file: string): string {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);
  }
}

// ---------- safety ----------

function v4(ip: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
}

/** Private, link-local, metadata, carrier and reserved addresses are never audited. Loopback only if allowed. */
export function isBlockedIp(ip: string, allowLoopback: boolean): boolean {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return isBlockedIp(mapped, allowLoopback);
  const a = v4(lower);
  if (a) {
    const [o1, o2] = a as [number, number];
    if (o1 === 127) return !allowLoopback;
    return o1 === 0 || o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254) || (o1 === 100 && o2 >= 64 && o2 <= 127) || o1 >= 224;
  }
  if (net.isIPv6(lower)) {
    if (lower === '::1') return !allowLoopback;
    if (lower === '::') return true;
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
  }
  return true;
}

export interface Resolver {
  (host: string): Promise<string[]>;
}
export const systemResolver: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((r) => r.address);

export async function hostBlocked(host: string, allowLoopback: boolean, resolve: Resolver = systemResolver): Promise<string | null> {
  const h = host.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return isBlockedIp(h, allowLoopback) ? `${h} is a private or reserved address` : null;
  if (/^localhost$/i.test(h) || /\.localhost$/i.test(h)) return allowLoopback ? null : 'localhost audits are switched off (set AUDIT_ALLOW_LOCALHOST=1)';
  let ips: string[];
  try {
    ips = await resolve(h);
  } catch {
    return `${h} could not be found`;
  }
  const bad = ips.find((ip) => isBlockedIp(ip, allowLoopback));
  return bad ? `${h} points to a private or reserved address (${bad})` : null;
}

export async function checkTarget(t: AuditTarget, opts: { allowLoopback: boolean; resolve?: Resolver; cfg: Pick<Config, 'outDir' | 'root' | 'auditFileRoots'> }): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  if (t.type === 'url') {
    let u: URL;
    try {
      u = new URL(t.url);
    } catch {
      return { ok: false, reason: 'That is not a valid web address.' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'Only http and https addresses can be audited.' };
    if (u.username || u.password) return { ok: false, reason: 'The address contains a username or password. Remove it. Audits never sign in.' };
    const blocked = await hostBlocked(u.hostname, opts.allowLoopback, opts.resolve);
    if (blocked) return { ok: false, reason: `That address is not allowed: ${blocked}.` };
    return { ok: true, note: `${u.protocol}//${u.host} (public address)` };
  }
  const roots = allowedRoots(opts.cfg);
  if (!inside(t.path, [...roots, path.join(opts.cfg.outDir, 'inbox')].map((r) => { try { return fs.realpathSync(r); } catch { return r; } }))) return { ok: false, reason: 'That file is outside the folders audits may read. Put it in samples/ or add its folder to AUDIT_FILE_ROOTS.' };
  const st = fs.statSync(t.path);
  if (t.type === 'image') {
    if (st.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'That image is over 10 MB.' };
    const head = fs.readFileSync(t.path).subarray(0, 12);
    const isPng = head.subarray(1, 4).toString('ascii') === 'PNG';
    const isJpg = head[0] === 0xff && head[1] === 0xd8;
    const isWebp = head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!isPng && !isJpg && !isWebp) return { ok: false, reason: 'That file is not a PNG, JPEG or WebP image.' };
    return { ok: true, note: `${(st.size / 1024).toFixed(0)} KB image` };
  }
  if (st.size > MAX_HTML_BYTES) return { ok: false, reason: 'That HTML file is over 5 MB.' };
  return { ok: true, note: `${(st.size / 1024).toFixed(0)} KB local file` };
}
