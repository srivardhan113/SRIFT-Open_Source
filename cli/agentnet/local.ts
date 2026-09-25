/**
 * SRIFT AgentNet — local state under ~/.srift/agentnet (mode 0600).
 *
 *   identity.json   keys (+ optional passphrase protection via SRIFT_AN_PASSPHRASE)
 *   config.json     relays, presence mode, hooks, PoW settings
 *   contacts.json   address book + per-contact policy
 *   peers.json      reply-to cache of keys learned from verified messages
 *   inbox.jsonl     received messages (this machine only)
 *   inbox-read.json read markers
 *   outbox/<id>.json sender-side queue for offline recipients (this machine only)
 *   node.lock       pid of the running receiver node
 *
 * Override the directory with SRIFT_AN_HOME (used by tests / multi-agent hosts).
 *
 * EPHEMERAL MODE (SRIFT_AN_EPHEMERAL=1, or `--ephemeral`): conversation data —
 * inbox, sent log, peer cache, knocks, read markers, invites, outbox — lives
 * in this process's RAM only and is gone when it exits; received files go to a
 * private temp folder that is deleted on exit. Identity, contacts, groups and
 * config (settings) stay on disk.
 *
 * RETENTION: prune() drops inbox/sent records older than `retentionDays`
 * (default 30; 0 = keep forever), stale peers/knocks/invites/partial
 * downloads, rotates node.log, and optionally expires received files.
 *
 * CONCURRENCY: read-modify-write stores are guarded by a cross-process lock
 * file, so several CLI/MCP/node processes never lose each other's updates.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../../lib/agentnet/crypto.mjs';

export type Keys = { edPub: string; edPriv: string; xPub: string; xPriv: string };
export type OwnerProof = { address: string; edPub: string; agent: string; ts: number; sig: string };
export type Profile = {
  name?: string; description?: string; skills: string[]; handle?: string; domain?: string;
  /** Self-written one-line description advertised in the live beacon ("what I am / what I do"). */
  oneLine?: string;
  /** Advertise a live beacon so others can find this agent by search while it is online. */
  discoverable: boolean;
  status?: 'available' | 'busy' | 'away';
  /** 'owner' = a human/org identity that owns agents; default 'agent'. */
  kind?: 'agent' | 'owner';
  /** Signed by the owner; proves (with this identity's own card signature) who owns this agent. */
  owner?: OwnerProof;
};
export type Identity = Keys & {
  v: 1;
  address: string;
  createdAt: number;
  profile: Profile;
  rotations?: Array<{ from: string; fromEdPub: string; to: string; ts: number; sig: string }>;
};
export type PresenceMode = 'everyone' | 'contacts' | 'nobody';
export type HookConfig = {
  url?: string; secret?: string; exec?: string; allowUnknown?: boolean; timeoutSec?: number;
  /** Decision hook for knocks: gets the knock JSON on stdin, prints {"accept":bool,"note":"…"}. */
  decide?: string;
};
/** How to answer "hey, it's me" knocks from agents that are not contacts yet. */
export type KnockPolicy = 'ask' | 'accept' | 'reject' | 'decide';
export type Config = {
  relays: string[];
  presenceMode: PresenceMode;
  hooks: HookConfig;
  powBits: number;
  requirePowFromUnknown: boolean;
  autoAcceptCallsFromContacts: boolean;
  knockPolicy: KnockPolicy;
  /** Who may send me files over AgentNet: contacts (default), anyone, nobody. Group members always may, in their group. */
  acceptFilesFrom: 'contacts' | 'anyone' | 'nobody';
  maxFileMB: number;
  /** Auto-join groups when a contact adds me (otherwise the invite waits for `srift an group join`). */
  autoJoinGroupsFromContacts: boolean;
  /** Accept unauthenticated messages arriving through the relay's A2A bridge (as message requests). */
  acceptBridged: boolean;
  /** Days to keep inbox + sent history on disk (0 = forever). */
  retentionDays: number;
  /** Days to keep received files (0 = forever). */
  fileRetentionDays: number;
  outboxMaxAgeDays: number;
};
export type Policy = 'auto' | 'ask' | 'blocked';
export type Contact = {
  address: string; name?: string; card?: any; policy: Policy; presence: 'allow' | 'deny'; addedAt: number;
  /** One-time invite token to present on first contact (from their invite link). */
  inviteToken?: string;
};
export type Invite = { token: string; createdAt: number; exp?: number; once: boolean; uses: number; label?: string };
export type Peer = { address: string; edPub: string; xPub: string; seenAt: number; relays?: string[] };
export type InboxRecord = {
  id: string;
  type: string;
  from: string;
  fromName?: string;
  body: any;
  ts: number;
  receivedAt: number;
  request: boolean;
  bridge?: any;
};
export type OutboxItem = { id: string; to: string; type: string; body: any; createdAt: number; attempts: number; lastAttempt?: number };

export const DEFAULT_RELAY = 'https://srift.app';

/**
 * Home binding: every AgentNode runs its work inside inHome(itsHome, ...), so
 * several agents can live in ONE process (multi-agent hosts, tests) without
 * reading or writing each other's state; the binding survives every await.
 */
const homeCtx = new AsyncLocalStorage<string>();
export function inHome<T>(home: string, fn: () => T): T {
  return homeCtx.run(home, fn);
}
export function anDir(): string {
  return homeCtx.getStore() || process.env.SRIFT_AN_HOME || path.join(os.homedir(), '.srift', 'agentnet');
}
function file(name: string): string {
  return path.join(anDir(), name);
}
function ensureDir(dir = anDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
/** RAM-only stores used in ephemeral mode. */
const RAM_JSON = new Set(['peers.json', 'knocks.json', 'inbox-read.json', 'invites.json']);
type Ram = { json: Map<string, string>; inbox: any[]; sent: any[]; outbox: Map<string, string> };
const rams = new Map<string, Ram>();
function ramFor(): Ram {
  const k = anDir();
  let r = rams.get(k);
  if (!r) { r = { json: new Map(), inbox: [], sent: [], outbox: new Map() }; rams.set(k, r); }
  return r;
}
export function isEphemeral(): boolean {
  return process.env.SRIFT_AN_EPHEMERAL === '1';
}
export function readJson<T>(name: string, fallback: T): T {
  try {
    if (isEphemeral() && RAM_JSON.has(name)) {
      const v = ramFor().json.get(name);
      return v === undefined ? fallback : (JSON.parse(v) as T);
    }
    return JSON.parse(fs.readFileSync(file(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}
export function writeJson(name: string, data: unknown): void {
  if (isEphemeral() && RAM_JSON.has(name)) { ramFor().json.set(name, JSON.stringify(data)); return; }
  ensureDir();
  const target = file(name);
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch (e: any) {
    // Windows: rename over a file another process has open can fail transiently (EPERM/EBUSY) — retry briefly.
    for (let i = 0; i < 20; i++) {
      sleepSync(25);
      try { fs.renameSync(tmp, target); return; } catch { /* retry */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Cross-process mutual exclusion for read-modify-write of a store.
 * Lock = exclusive-create of `<name>.lock`; stale locks (>10 s) are broken.
 */
export function withLock<T>(name: string, fn: () => T): T {
  if (isEphemeral() && RAM_JSON.has(name)) return fn();
  ensureDir();
  const lock = file(`${name}.lock`);
  const deadline = Date.now() + 15_000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
    } catch (e: any) {
      if (e?.code !== 'EEXIST' && e?.code !== 'EPERM' && e?.code !== 'EACCES' && e?.code !== 'EBUSY') throw e;
      // Break a lock only when its holder is provably gone (dead pid) or it is ancient.
      try {
        const holder = Number(fs.readFileSync(lock, 'utf8'));
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if ((holder && holder !== process.pid && !pidAlive(holder) && age > 200) || age > 60_000) { fs.unlinkSync(lock); continue; }
      } catch { /* vanished or unreadable: retry */ }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock} (another SRIFT process is busy). Try again.`);
      sleepSync(5 + Math.floor(Math.random() * 15));
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}
/** Locked read-modify-write of a JSON store. */
export function mutateJson<T>(name: string, fallback: T, fn: (cur: T) => T): T {
  return withLock(name, () => {
    const next = fn(readJson<T>(name, fallback));
    writeJson(name, next);
    return next;
  });
}

// ─── identity ────────────────────────────────────────────────────
type StoredIdentity = Omit<Identity, 'edPriv' | 'xPriv'> & { edPriv?: string; xPriv?: string; protected?: any };

export function hasIdentity(): boolean {
  return fs.existsSync(file('identity.json'));
}

export function loadIdentity(): Identity | null {
  const p = file('identity.json');
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${p} (${e?.code || e?.message}). Refusing to continue so your address is never replaced.`);
  }
  let raw: StoredIdentity;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${p} is corrupt. Restore it from a backup (srift an id import <file>); AgentNet will not overwrite it with a new identity.`);
  }
  if (!raw || typeof raw.address !== 'string' || typeof raw.edPub !== 'string' || C.addressFromEdPub(raw.edPub) !== raw.address) {
    throw new Error(`${p} is not a valid AgentNet identity. Restore it from a backup; it will not be overwritten.`);
  }
  if (raw.protected) {
    const pass = process.env.SRIFT_AN_PASSPHRASE;
    if (!pass) throw new Error('Identity is passphrase-protected: set SRIFT_AN_PASSPHRASE.');
    const priv = JSON.parse(C.decryptWithPassphrase(raw.protected, pass));
    const { protected: _p, ...rest } = raw;
    return { ...(rest as any), edPriv: priv.edPriv, xPriv: priv.xPriv };
  }
  return raw as Identity;
}

/** Identity if one exists (never creates one). */
export function identityOrNull(): Identity | null {
  try { return loadIdentity(); } catch { return null; }
}

export function saveIdentity(id: Identity): void {
  const pass = process.env.SRIFT_AN_PASSPHRASE;
  if (pass) {
    const { edPriv, xPriv, ...rest } = id;
    writeJson('identity.json', { ...rest, protected: C.encryptWithPassphrase(JSON.stringify({ edPriv, xPriv }), pass) });
  } else {
    writeJson('identity.json', id);
  }
}

export function createIdentity(profile: Partial<Profile> = {}): Identity {
  const keys = C.generateKeys() as Keys;
  return {
    v: 1,
    address: C.addressFromEdPub(keys.edPub),
    ...keys,
    createdAt: C.nowSec(),
    profile: { skills: [], discoverable: false, ...profile },
  };
}

export function ensureIdentity(): { identity: Identity; created: boolean } {
  const existing = loadIdentity();
  if (existing) return { identity: existing, created: false };
  // Exclusive creation: two processes starting at once must not create two different identities.
  ensureDir();
  let fd: number;
  try {
    fd = fs.openSync(file('identity.json.creating'), 'wx');
  } catch {
    for (let i = 0; i < 100; i++) { sleepSync(20); const again = loadIdentity(); if (again) return { identity: again, created: false }; }
    try { fs.unlinkSync(file('identity.json.creating')); } catch { /* ignore */ }
    return ensureIdentity();
  }
  try {
    const again = loadIdentity();
    if (again) return { identity: again, created: false };
    const identity = createIdentity();
    saveIdentity(identity);
    return { identity, created: true };
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(file('identity.json.creating')); } catch { /* ignore */ }
  }
}

/** Update only the public profile on disk (never the keys): safe while another process rotates/imports. */
export function saveProfile(address: string, profile: Profile): boolean {
  let ok = false;
  withLock('identity.json', () => {
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(file('identity.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return; }
    if (raw?.address !== address) return;
    raw.profile = profile;
    writeJson('identity.json', raw);
    ok = true;
  });
  return ok;
}

/** New keys; the rotation record is signed by the OLD key so contacts can verify continuity. */
export function rotateIdentity(old: Identity): Identity {
  const next = createIdentity(old.profile);
  const ts = C.nowSec();
  const payload = `srift-an-rotate|${old.address}|${next.address}|${ts}`;
  next.rotations = [...(old.rotations || []), { from: old.address, fromEdPub: old.edPub, to: next.address, ts, sig: C.sign(old.edPriv, payload) }];
  return next;
}

// ─── config ──────────────────────────────────────────────────────
export function loadConfig(): Config {
  const c = readJson<Partial<Config>>('config.json', {});
  const envRelay = process.env.SRIFT_AN_RELAY;
  return {
    relays: envRelay ? envRelay.split(',').map((s) => s.trim()).filter(Boolean) : c.relays?.length ? c.relays : [DEFAULT_RELAY],
    presenceMode: c.presenceMode || 'everyone',
    hooks: c.hooks || {},
    powBits: c.powBits ?? 12,
    requirePowFromUnknown: c.requirePowFromUnknown ?? true,
    autoAcceptCallsFromContacts: c.autoAcceptCallsFromContacts ?? true,
    acceptFilesFrom: (['contacts', 'anyone', 'nobody'] as const).includes(c.acceptFilesFrom as any) ? c.acceptFilesFrom! : 'contacts',
    maxFileMB: c.maxFileMB ?? 200,
    autoJoinGroupsFromContacts: c.autoJoinGroupsFromContacts ?? true,
    knockPolicy: (['ask', 'accept', 'reject', 'decide'] as const).includes(c.knockPolicy as KnockPolicy) ? (c.knockPolicy as KnockPolicy) : 'ask',
    outboxMaxAgeDays: c.outboxMaxAgeDays ?? 7,
    acceptBridged: c.acceptBridged ?? true,
    retentionDays: c.retentionDays ?? 30,
    fileRetentionDays: c.fileRetentionDays ?? 0,
  };
}
export function saveConfig(patch: Partial<Config>): Config {
  mutateJson<Partial<Config>>('config.json', {}, (cur) => ({ ...cur, ...patch }));
  return loadConfig();
}

// ─── contacts / peers ───────────────────────────────────────────
type ContactsFile = { contacts: Record<string, Contact> };
export function loadContacts(): Record<string, Contact> {
  return readJson<ContactsFile>('contacts.json', { contacts: {} }).contacts || {};
}
export function saveContacts(contacts: Record<string, Contact>): void {
  writeJson('contacts.json', { contacts });
}
export function getContact(address: string): Contact | null {
  return loadContacts()[address] || null;
}
export function upsertContact(address: string, patch: Partial<Contact>): Contact {
  let next!: Contact;
  mutateJson<ContactsFile>('contacts.json', { contacts: {} }, (f) => {
    const all = f.contacts || {};
    const defaults: Contact = { address, policy: 'auto', presence: 'allow', addedAt: C.nowSec() };
    next = {
      ...defaults,
      ...(all[address] || {}),
      ...(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Contact>),
      address,
    };
    all[address] = next;
    return { contacts: all };
  });
  return next;
}
export function clearInviteToken(address: string): void {
  mutateJson<ContactsFile>('contacts.json', { contacts: {} }, (f) => {
    if (f.contacts?.[address]) delete f.contacts[address].inviteToken;
    return f;
  });
}
export function removeContact(address: string): boolean {
  let removed = false;
  mutateJson<ContactsFile>('contacts.json', { contacts: {} }, (f) => {
    removed = !!f.contacts?.[address];
    if (removed) delete f.contacts[address];
    return f;
  });
  return removed;
}
export function findContactByName(name: string): Contact | null {
  const n = name.trim().toLowerCase().replace(/^@/, '');
  const hits = Object.values(loadContacts()).filter((c) => c.name?.toLowerCase() === n && c.policy !== 'blocked');
  return hits.length === 1 ? hits[0] : null; // ambiguous names never guess
}

export function loadPeers(): Record<string, Peer> {
  return readJson<Record<string, Peer>>('peers.json', {});
}
export function rememberPeer(p: Peer): void {
  const prev = loadPeers()[p.address];
  if (prev && prev.edPub === p.edPub && prev.xPub === p.xPub && JSON.stringify(prev.relays || []) === JSON.stringify(p.relays || []) && p.seenAt - prev.seenAt < 3600) return;
  mutateJson<Record<string, Peer>>('peers.json', {}, (all) => {
    all[p.address] = p;
    const entries = Object.values(all).sort((a, b) => b.seenAt - a.seenAt).slice(0, 5000);
    return Object.fromEntries(entries.map((e) => [e.address, e]));
  });
}

/** ACL pushed to the relay (RAM only there). */
export function relayAcl(cfg: Config = loadConfig()): { mode: PresenceMode; allow: string[]; block: string[] } {
  const contacts = Object.values(loadContacts());
  return {
    mode: cfg.presenceMode,
    allow: contacts.filter((c) => c.policy !== 'blocked' && c.presence !== 'deny').map((c) => c.address),
    block: contacts.filter((c) => c.policy === 'blocked').map((c) => c.address),
  };
}

// ─── invites I issued (tokens that let strangers become contacts) ─
export function loadInvites(): Record<string, Invite> {
  return readJson<Record<string, Invite>>('invites.json', {});
}
export function addInvite(inv: Invite): void {
  mutateJson<Record<string, Invite>>('invites.json', {}, (all) => ({ ...all, [inv.token]: inv }));
}
/** Validate + consume a presented token atomically (a one-time token can never be redeemed twice). */
export function redeemInvite(token: unknown): boolean {
  if (typeof token !== 'string' || token.length < 16 || token.length > 64 || !/^[A-Za-z0-9_-]+$/.test(token)) return false;
  let ok = false;
  mutateJson<Record<string, Invite>>('invites.json', {}, (all) => {
    const inv = Object.prototype.hasOwnProperty.call(all, token) ? all[token] : undefined;
    if (!inv) return all;
    if (inv.exp && inv.exp < C.nowSec()) { delete all[token]; return all; }
    inv.uses++;
    if (inv.once) delete all[token];
    ok = true;
    return all;
  });
  return ok;
}
export function revokeInvites(): number {
  let n = 0;
  mutateJson<Record<string, Invite>>('invites.json', {}, (all) => { n = Object.keys(all).length; return {}; });
  return n;
}

// ─── inbox ───────────────────────────────────────────────────────
export function inboxPath(): string {
  return file('inbox.jsonl');
}
export function readInbox(): InboxRecord[] {
  if (isEphemeral()) return ramFor().inbox.slice();
  try {
    return fs
      .readFileSync(inboxPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean) as InboxRecord[];
  } catch {
    return [];
  }
}
const recentIds = new Map<string, Set<string>>();
export function appendInbox(rec: InboxRecord): boolean {
  const key = (isEphemeral() ? 'ram:' : 'disk:') + anDir();
  let ids = recentIds.get(key);
  if (!ids) {
    ids = new Set(readInbox().slice(-5000).map((r) => r.id));
    recentIds.set(key, ids);
  }
  if (ids.has(rec.id)) return false;
  if (isEphemeral()) {
    const r = ramFor();
    r.inbox.push(rec);
    if (r.inbox.length > 20_000) r.inbox.splice(0, r.inbox.length - 20_000);
  } else {
    ensureDir();
    withLock('inbox.jsonl', () => fs.appendFileSync(inboxPath(), JSON.stringify(rec) + '\n', { mode: 0o600 }));
  }
  ids.add(rec.id);
  if (ids.size > 20_000) recentIds.set(key, new Set([...ids].slice(-10_000)));
  return true;
}
export function readMarkers(): Set<string> {
  return new Set(readJson<string[]>('inbox-read.json', []));
}
export function markRead(ids: string[]): void {
  if (!ids.length) return;
  mutateJson<string[]>('inbox-read.json', [], (cur) => [...new Set([...cur, ...ids])].slice(-20000));
}

// ─── outbox (sender-side queue; never on a server) ──────────────
function outboxDir(): string {
  return file('outbox');
}
const OUTBOX_ID = /^[A-Za-z0-9_-]{1,80}$/;
export function outboxAdd(item: OutboxItem): void {
  if (!OUTBOX_ID.test(item.id)) throw new Error('invalid outbox id');
  if (isEphemeral()) { ramFor().outbox.set(item.id, JSON.stringify(item)); return; }
  ensureDir(outboxDir());
  fs.writeFileSync(path.join(outboxDir(), `${item.id}.json`), JSON.stringify(item), { mode: 0o600 });
}
export function outboxList(): OutboxItem[] {
  if (isEphemeral()) return [...ramFor().outbox.values()].map((v) => JSON.parse(v));
  try {
    return fs
      .readdirSync(outboxDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(outboxDir(), f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean) as OutboxItem[];
  } catch {
    return [];
  }
}
export function outboxUpdate(item: OutboxItem): void {
  if (isEphemeral()) { if (ramFor().outbox.has(item.id)) ramFor().outbox.set(item.id, JSON.stringify(item)); return; }
  if (OUTBOX_ID.test(item.id) && fs.existsSync(path.join(outboxDir(), `${item.id}.json`))) outboxAdd(item);
}
export function outboxRemove(id: string): void {
  if (isEphemeral()) { ramFor().outbox.delete(id); return; }
  if (!OUTBOX_ID.test(id)) return;
  try { fs.unlinkSync(path.join(outboxDir(), `${id}.json`)); } catch { /* already gone */ }
}
export function outboxClear(): number {
  const items = outboxList();
  for (const i of items) outboxRemove(i.id);
  return items.length;
}

// ─── node lock ───────────────────────────────────────────────────
/**
 * The running node holds node.lock (exclusive create) and refreshes its mtime every few
 * seconds. A lock is live only if its pid exists AND its heartbeat is fresh — so a
 * reused pid after a crash is never mistaken for a running node.
 */
const LOCK_STALE_MS = 30_000;
let myLockNonce: string | null = null;
export function readLock(): { pid: number; startedAt: number; nonce?: string } | null {
  const p = file('node.lock');
  let l: { pid: number; startedAt: number; nonce?: string } | null = null;
  try { l = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  if (!l || !Number.isInteger(l.pid)) return null;
  if (l.pid === process.pid && l.nonce && l.nonce === myLockNonce) return l;
  try { if (Date.now() - fs.statSync(p).mtimeMs > LOCK_STALE_MS) return null; } catch { return null; }
  return pidAlive(l.pid) ? l : null;
}
/** Take the node lock. Returns false if another live node holds it. */
export function acquireLock(): boolean {
  ensureDir();
  const p = file('node.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p, 'wx', 0o600);
      myLockNonce = C.randomToken(12);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: C.nowSec(), nonce: myLockNonce }));
      fs.closeSync(fd);
      return true;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      if (readLock()) return false;
      try { fs.unlinkSync(p); } catch { /* raced */ }
    }
  }
  return false;
}
/** Keep the lock fresh (call every few seconds while the node runs). */
export function heartbeatLock(): void {
  if (!myLockNonce) return;
  const now = new Date();
  try { fs.utimesSync(file('node.lock'), now, now); } catch { /* removed */ }
}
/** @deprecated kept for callers that only need to mark ownership; prefer acquireLock(). */
export function writeLock(): void {
  if (!acquireLock()) throw new Error('Another AgentNet node is already running for this identity.');
}
/** Ask the running node to stop gracefully (works on Windows, where kill() is a hard kill). */
export function requestStop(): void {
  ensureDir();
  fs.writeFileSync(file('node.stop'), String(Date.now()), { mode: 0o600 });
}
export function stopRequested(): boolean {
  return fs.existsSync(file('node.stop'));
}
export function clearStopRequest(): void {
  try { fs.unlinkSync(file('node.stop')); } catch { /* none */ }
}
export function clearLock(): void {
  const l = readJson<{ pid: number; nonce?: string } | null>('node.lock', null);
  if (l && l.pid === process.pid && (!l.nonce || l.nonce === myLockNonce)) {
    myLockNonce = null;
    try { fs.unlinkSync(file('node.lock')); } catch { /* gone */ }
  }
}

// ─── knocks I sent (so an accept can be matched to my request) ───
export type SentKnock = { knockId: string; to: string; ts: number; note?: string };
export function recordKnock(k: SentKnock): void {
  mutateJson<Record<string, SentKnock>>('knocks.json', {}, (all) => {
    all[k.knockId] = k;
    const recent = Object.values(all).sort((a, b) => b.ts - a.ts).slice(0, 500);
    return Object.fromEntries(recent.map((x) => [x.knockId, x]));
  });
}
export function getSentKnock(knockId: string): SentKnock | null {
  return readJson<Record<string, SentKnock>>('knocks.json', {})[knockId] || null;
}

// ─── groups (signed state held by every member; no server) ───────
export type GroupRecord = {
  state: any;
  status: 'joined' | 'invited' | 'left' | 'removed';
  invitedBy?: string;
  /** Members that announced they left (until an admin publishes a new version). */
  left?: string[];
  updatedAt: number;
};
export function loadGroups(): Record<string, GroupRecord> {
  return readJson<Record<string, GroupRecord>>('groups.json', {});
}
export function getGroup(id: string): GroupRecord | null {
  return loadGroups()[id] || null;
}
export function saveGroup(id: string, rec: GroupRecord): void {
  mutateJson<Record<string, GroupRecord>>('groups.json', {}, (all) => {
    // Never let a slower process overwrite a newer group version with an older one.
    const cur = all[id];
    if (cur && cur.state?.version > rec.state?.version) return all;
    all[id] = { ...rec, updatedAt: C.nowSec() };
    return all;
  });
}
export function findGroup(q: string): GroupRecord | null {
  const all = loadGroups();
  if (all[q]) return all[q];
  const n = q.trim().toLowerCase().replace(/^#/, '');
  const byName = Object.values(all).filter((g) => g.status !== 'left' && String(g.state?.name || '').toLowerCase() === n);
  if (byName.length === 1) return byName[0];
  const byPrefix = Object.values(all).filter((g) => g.state?.id?.startsWith(q));
  return byPrefix.length === 1 ? byPrefix[0] : null;
}

// ─── sent log (for conversation history; this machine only) ──────
export type SentRecord = { id: string; to: string; groupId?: string; type: string; body: any; ts: number; result: string };
export function appendSent(rec: SentRecord): void {
  if (isEphemeral()) {
    const r = ramFor();
    r.sent.push(rec);
    if (r.sent.length > 20_000) r.sent.splice(0, r.sent.length - 20_000);
    return;
  }
  ensureDir();
  withLock('sent.jsonl', () => fs.appendFileSync(file('sent.jsonl'), JSON.stringify(rec) + '\n', { mode: 0o600 }));
}
export function readSent(): SentRecord[] {
  if (isEphemeral()) return ramFor().sent.slice();
  try {
    return fs.readFileSync(file('sent.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as SentRecord[];
  } catch {
    return [];
  }
}

// ─── received files ───────────────────────────────────────────────
const ephemeralRoots = new Map<string, string>();
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}
/** Remove temp folders left behind by ephemeral processes that were hard-killed or crashed. */
export function cleanStaleEphemeral(): number {
  let n = 0;
  try {
    for (const d of fs.readdirSync(os.tmpdir())) {
      const m = d.match(/^srift-an-(\d+)-/);
      if (m && Number(m[1]) !== process.pid && !pidAlive(Number(m[1]))) {
        try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); n++; } catch { /* in use */ }
      }
    }
  } catch { /* no tmp */ }
  return n;
}
export function filesRoot(): string {
  if (isEphemeral()) {
    const key = anDir();
    let root = ephemeralRoots.get(key);
    if (!root) {
      cleanStaleEphemeral();
      root = fs.mkdtempSync(path.join(os.tmpdir(), `srift-an-${process.pid}-`));
      ephemeralRoots.set(key, root);
      const r = root;
      process.once('exit', () => { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } });
    }
    return root;
  }
  return path.join(anDir(), 'files');
}
export function filesDir(...parts: string[]): string {
  const d = path.join(filesRoot(), ...parts);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

// ─── hygiene: retention, rotation, wipe ─────────────────────────
export type PruneReport = { inbox: number; sent: number; peers: number; knocks: number; invites: number; markers: number; partials: number; files: number; logRotated: boolean };

function rewriteJsonl(name: string, keep: (r: any) => boolean): number {
  const p = file(name);
  let removed = 0;
  withLock(name, () => {
    let lines: string[];
    try { lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return; }
    const kept = lines.filter((l) => {
      try { if (keep(JSON.parse(l))) return true; } catch { /* corrupt line: drop */ }
      removed++;
      return false;
    });
    if (!removed) return;
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.map((l) => l + '\n').join(''), { mode: 0o600 });
    fs.renameSync(tmp, p);
  });
  if (removed) recentIds.delete('disk:' + anDir());
  return removed;
}

/** Apply retention policies. Safe to call any time (the node calls it at start and every 6 h). */
export function prune(cfg: Config = loadConfig(), now = C.nowSec()): PruneReport {
  const r: PruneReport = { inbox: 0, sent: 0, peers: 0, knocks: 0, invites: 0, markers: 0, partials: 0, files: 0, logRotated: false };
  const cutoff = cfg.retentionDays > 0 ? now - cfg.retentionDays * 86400 : 0;
  if (isEphemeral()) {
    if (cutoff) {
      const m = ramFor();
      const bi = m.inbox.length; m.inbox = m.inbox.filter((x) => (x.receivedAt || x.ts) >= cutoff); r.inbox = bi - m.inbox.length;
      const bs = m.sent.length; m.sent = m.sent.filter((x) => x.ts >= cutoff); r.sent = bs - m.sent.length;
    }
  } else if (cutoff) {
    r.inbox = rewriteJsonl('inbox.jsonl', (x) => (x.receivedAt || x.ts) >= cutoff);
    r.sent = rewriteJsonl('sent.jsonl', (x) => x.ts >= cutoff);
  }
  const inboxIds = new Set(readInbox().map((x) => x.id));
  mutateJson<string[]>('inbox-read.json', [], (cur) => { const k = cur.filter((id) => inboxIds.has(id)); r.markers = cur.length - k.length; return k; });
  mutateJson<Record<string, Peer>>('peers.json', {}, (all) => {
    const k = Object.fromEntries(Object.entries(all).filter(([, p]) => now - p.seenAt < 90 * 86400));
    r.peers = Object.keys(all).length - Object.keys(k).length;
    return k;
  });
  mutateJson<Record<string, SentKnock>>('knocks.json', {}, (all) => {
    const k = Object.fromEntries(Object.entries(all).filter(([, x]) => now - x.ts < 30 * 86400));
    r.knocks = Object.keys(all).length - Object.keys(k).length;
    return k;
  });
  mutateJson<Record<string, Invite>>('invites.json', {}, (all) => {
    const k = Object.fromEntries(Object.entries(all).filter(([, x]) => !x.exp || x.exp >= now));
    r.invites = Object.keys(all).length - Object.keys(k).length;
    return k;
  });
  // Partial downloads nobody is writing any more (> 1 h old).
  try {
    const inc = path.join(filesRoot(), '.incoming');
    for (const f of fs.readdirSync(inc)) {
      const fp = path.join(inc, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > 3600_000) { fs.rmSync(fp, { force: true }); r.partials++; }
    }
  } catch { /* none */ }
  // Received files past their retention.
  if (cfg.fileRetentionDays > 0) {
    const limit = Date.now() - cfg.fileRetentionDays * 86400_000;
    const walk = (d: string) => {
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== '.incoming') walk(fp); continue; }
        try { if (fs.statSync(fp).mtimeMs < limit) { fs.rmSync(fp, { force: true }); r.files++; } } catch { /* gone */ }
      }
    };
    walk(filesRoot());
  }
  r.logRotated = rotateLog();
  return r;
}

/** Keep node.log under 5 MB (one previous generation kept as node.log.1). */
export function rotateLog(maxBytes = 5 * 1024 * 1024): boolean {
  const p = file('node.log');
  try {
    if (fs.statSync(p).size <= maxBytes) return false;
    try { fs.rmSync(p + '.1', { force: true }); } catch { /* none */ }
    fs.renameSync(p, p + '.1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete local AgentNet data. Default: conversation data only (inbox, sent log,
 * peers, knocks, read markers, invites, outbox, received files, partial
 * downloads, logs). all=true also deletes identity, contacts, groups and config.
 */
export function wipe(all = false): string[] {
  const removed: string[] = [];
  rams.delete(anDir()); recentIds.clear();
  const names = ['inbox.jsonl', 'sent.jsonl', 'peers.json', 'knocks.json', 'inbox-read.json', 'invites.json', 'node.log', 'node.log.1', 'outbox', 'files'];
  if (all) names.push('identity.json', 'contacts.json', 'groups.json', 'config.json', 'node.lock');
  for (const n of names) {
    const p = file(n);
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed.push(n); }
  }
  if (all) {
    try { for (const f of fs.readdirSync(anDir())) if (f.endsWith('.lock') || f.endsWith('.tmp')) fs.rmSync(path.join(anDir(), f), { force: true }); } catch { /* none */ }
  }
  return removed;
}
