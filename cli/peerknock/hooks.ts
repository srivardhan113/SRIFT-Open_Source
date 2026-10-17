/**
 * SRIFT Peerknock — wake-up hooks (how a sleeping AI "picks up").
 *
 *   webhook: POST JSON to a URL, signed with HMAC-SHA256 (X-Srift-Signature).
 *   exec:    run a command. Message data is passed ONLY via environment
 *            variables and stdin — never interpolated into the command line.
 *            Only {{from}}, {{id}}, {{type}} placeholders are substituted, and
 *            those are validated to a strict safe charset first.
 *
 * Env vars for exec: SRIFT_PK_ID, SRIFT_PK_TYPE, SRIFT_PK_FROM, SRIFT_PK_FROM_NAME,
 *                    SRIFT_PK_TEXT, SRIFT_PK_REQUEST ("1" for unknown senders),
 *                    SRIFT_PK_JSON (full record). stdin also receives the JSON.
 */
import { spawn } from 'node:child_process';
import { request } from '../net.ts';
import * as C from '../../lib/peerknock/crypto.mjs';
import type { HookConfig, InboxRecord } from './local.ts';

// No leading '-': a sender-chosen id like `--config` must not become a flag of the hook command.
const SAFE = /^[A-Za-z0-9:_][A-Za-z0-9:_-]{0,79}$/;

export function renderExecCommand(template: string, rec: InboxRecord): string {
  return template.replace(/\{\{(from|id|type)\}\}/g, (_m, k: 'from' | 'id' | 'type') => {
    const v = String(rec[k] ?? '');
    return SAFE.test(v) ? v : 'invalid';
  });
}

export function hookEnv(rec: InboxRecord): Record<string, string> {
  const text = typeof rec.body?.text === 'string' ? rec.body.text : typeof rec.body?.note === 'string' ? rec.body.note : rec.body?.purpose ? String(rec.body.purpose) : '';
  return {
    SRIFT_PK_ID: rec.id,
    SRIFT_PK_TYPE: rec.type,
    SRIFT_PK_FROM: rec.from,
    SRIFT_PK_FROM_NAME: rec.fromName || '',
    SRIFT_PK_TEXT: text.replace(/\0/g, ''),
    SRIFT_PK_REQUEST: rec.request ? '1' : '0',
    // Windows limits a single environment value to 32767 chars; the full record is always on stdin.
    SRIFT_PK_JSON: JSON.stringify(rec).replace(/\0/g, '').slice(0, 30_000),
  };
}

export function signWebhook(secret: string, ts: number, body: string): string {
  return 'sha256=' + C.hmacHex(secret, `${ts}.${body}`);
}

async function fireWebhook(cfg: HookConfig, rec: InboxRecord): Promise<void> {
  const body = JSON.stringify({ event: 'peerknock.message', message: rec });
  const ts = C.nowSec();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Srift-Timestamp': String(ts), 'User-Agent': 'srift-peerknock' };
  if (cfg.secret) headers['X-Srift-Signature'] = signWebhook(cfg.secret, ts, body);
  const r = await request(cfg.url!, { method: 'POST', headers, body, timeoutMs: 10_000, maxRedirects: 0 });
  if (r.status >= 400) throw new Error(`webhook HTTP ${r.status}`);
}

let execChain: Promise<void> = Promise.resolve();
let execQueued = 0;

/** On Windows cmd.exe expands %VAR% BEFORE parsing & | >, so %SRIFT_PK_*% would let a message inject commands. */
export function unsafeOnWindows(cmd: string): boolean {
  return process.platform === 'win32' && /%SRIFT_PK_[A-Z_]+%/i.test(cmd);
}
function fireExec(cfg: HookConfig, rec: InboxRecord): Promise<void> {
  if (unsafeOnWindows(cfg.exec!)) return Promise.reject(new Error('refusing exec hook: %SRIFT_PK_…% is unsafe on Windows — read the JSON from stdin instead'));
  if (execQueued >= 100) return Promise.reject(new Error('exec hook queue full'));
  execQueued++;
  const run = () =>
    new Promise<void>((resolve) => {
      const cmd = renderExecCommand(cfg.exec!, rec);
      const child = spawn(cmd, { shell: true, env: { ...process.env, ...hookEnv(rec) }, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
      const timer = setTimeout(() => child.kill(), (cfg.timeoutSec ?? 600) * 1000);
      child.on('error', () => { clearTimeout(timer); resolve(); });
      child.on('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify(rec));
    });
  execChain = execChain.then(run).finally(() => { execQueued--; });
  return execChain;
}

/** Fire configured hooks for a received record. Never throws. */
export async function fireHooks(cfg: HookConfig, rec: InboxRecord, log: (m: string) => void = () => {}): Promise<void> {
  if (rec.request && !cfg.allowUnknown) return;
  const jobs: Promise<void>[] = [];
  if (cfg.url) jobs.push(fireWebhook(cfg, rec).catch((e) => log(`webhook failed: ${e?.message}`)));
  if (cfg.exec) jobs.push(fireExec(cfg, rec).catch((e) => log(`exec hook failed: ${e?.message}`)));
  await Promise.all(jobs);
}

/**
 * Decision hook for knocks (who is knocking + what they need + a note).
 * The command gets the knock record as JSON on stdin (and the usual env vars)
 * and must print {"accept": true|false, "note": "..."} on stdout.
 * Any failure/timeout → null (caller falls back to leaving the knock pending).
 */
let decideChain: Promise<unknown> = Promise.resolve();
let decideQueued = 0;
/** Decision hooks run one at a time (max 20 waiting): a knock flood cannot fork-bomb the machine. */
/**
 * The agent's own answer to a knock. The decide hook prints one JSON line:
 *   {"accept": true|false, "reason": "…", "busy": true, "retryAfterSec": 600}
 * ("note" is accepted as an alias of "reason").
 */
export type KnockDecision = { accept: boolean; reason?: string; busy?: boolean; retryAfterSec?: number };
export function runDecideHook(cmd: string, rec: InboxRecord, timeoutMs = 30_000): Promise<KnockDecision | null> {
  if (unsafeOnWindows(cmd) || decideQueued >= 20) return Promise.resolve(null);
  decideQueued++;
  const job = decideChain.then(() => runDecideNow(cmd, rec, timeoutMs)).finally(() => { decideQueued--; });
  decideChain = job.catch(() => null);
  return job;
}
function runDecideNow(cmd: string, rec: InboxRecord, timeoutMs: number): Promise<KnockDecision | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(renderExecCommand(cmd, rec), { shell: true, env: { ...process.env, ...hookEnv(rec) }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout!.on('data', (d) => { out += d; if (out.length > 64_000) child.kill(); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const line = out.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop() || '';
        const j = JSON.parse(line);
        if (typeof j.accept !== 'boolean') return resolve(null);
        const reason = typeof j.reason === 'string' ? j.reason : typeof j.note === 'string' ? j.note : undefined;
        const retry = Number(j.retryAfterSec);
        resolve({ accept: j.accept, reason: reason?.slice(0, 500), busy: !j.accept && j.busy === true, retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : undefined });
      } catch {
        resolve(null);
      }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(rec));
  });
}
