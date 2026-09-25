/**
 * SRIFT AgentNet — the agent node.
 *
 * One AgentNode = one identity connected (outbound only) to one or more relays.
 *   recv=true     → ONLINE: registers its live card (+ beacon if discoverable),
 *                   receives, verifies, stores locally, acks, fires wake-up
 *                   hooks, answers knocks, receives files, keeps group state,
 *                   flushes its local outbox, auto-answers contact calls.
 *   sidecar=true  → a helper connection for one-shot CLI/MCP processes while
 *                   another node owns the identity: it only consumes control
 *                   replies addressed to it (file_accept / file_ack /
 *                   knock_answer) and leaves everything else to the main node.
 *   neither       → send-only; never counted as online.
 *
 * Everything a relay sees is ciphertext; relays store nothing and route only
 * to online recipients. Groups and files are end-to-end encrypted per member.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as C from '../../lib/agentnet/crypto.mjs';
import { buildCard, signBeacon, signCard, verifyCard } from '../../lib/agentnet/card.mjs';
import { createGroup, isMember, updateGroup, verifyGroupState } from '../../lib/agentnet/group.mjs';
import { autoDescribe } from './describe.ts';
import { FILE_WINDOW, FileReceiver, makeOffer, readChunk, type FileOffer, type ReceivedFile } from './files.ts';
import { fireHooks, runDecideHook } from './hooks.ts';
import {
  anDir, appendInbox, appendSent, clearInviteToken, inHome, getContact, getGroup, getSentKnock, identityOrNull, loadConfig, outboxAdd, outboxList, outboxRemove,
  loadGroups, outboxUpdate, prune, readInbox, recordKnock, redeemInvite, relayAcl, rememberPeer, saveGroup, saveProfile, upsertContact,
  type Config, type GroupRecord, type Identity, type InboxRecord, type OutboxItem, type Profile,
} from './local.ts';
import { RelayClient, type LiveResult, type SendResult } from './relay-client.ts';
import { keysFor, liveSearch, type Resolved } from './resolve.ts';
import { safeRelays } from './netpolicy.ts';

export type MessageType =
  | 'msg' | 'call' | 'call_answer' | 'receipt' | 'contact_card' | 'typing' | 'knock' | 'knock_answer'
  | 'file_offer' | 'file_accept' | 'file_chunk' | 'file_ack'
  | 'group_update' | 'group_msg' | 'group_leave';
export type SessionBackend = {
  ensure: () => Promise<unknown>;
  call: (endpoint: string, method: 'GET' | 'POST', body?: any) => Promise<any>;
};
export type NodeOpts = { recv: boolean; sidecar?: boolean; forcePoll?: boolean; sessions?: SessionBackend; log?: (m: string) => void; hooks?: boolean };
export type SendOutcome = { id: string; result: SendResult['result'] | 'queued' | 'no_keys'; relay?: string; error?: string };
export type KnockOutcome = { knockId: string; to: string; delivery: SendOutcome['result']; accepted?: boolean; note?: string; timedOut?: boolean };
export type ConnectOutcome = {
  need: string;
  connected: (Resolved & { note?: string }) | null;
  firstMessage?: SendOutcome;
  tried: Array<{ address: string; tag?: string; oneLine?: string; result: 'rejected' | 'no_answer' | 'unreachable'; note?: string }>;
  candidates: number;
};
export type FileOutcome = {
  to: string; fileId: string; name: string; size: number; sha256: string;
  result: 'delivered' | 'rejected' | 'offline' | 'failed' | 'no_answer'; reason?: string; ms?: number; verified?: boolean;
};
export type Keys = { xPub: string; relays?: string[] };

const RESULT_RANK: Record<string, number> = { delivered: 5, unconfirmed: 4, offline: 3, rate_limited: 2, invalid: 1, error: 0 };
const MAX_CLOCK_SKEW_SEC = 7 * 24 * 3600;
const CALL_TTL_SEC = 300;
/** Protocol messages that never go to the inbox. */
const CONTROL = new Set(['file_offer', 'file_accept', 'file_chunk', 'file_ack', 'group_leave', 'typing']);
/** What a sidecar consumes (replies to requests it made). */
const SIDECAR_TYPES = new Set(['file_accept', 'file_ack', 'knock_answer']);
/** Types recorded in the local sent log (conversation history). */
const LOGGED = new Set(['msg', 'group_msg', 'knock']);

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

export class AgentNode extends EventEmitter {
  identity: Identity;
  cfg: Config;
  clients: RelayClient[] = [];
  private extra = new Map<string, RelayClient>();
  private opts: NodeOpts;
  private timers: NodeJS.Timeout[] = [];
  private seen = new Set<string>();
  private flushing = new Set<string>();
  private aclSig = '';
  private profileSig = '';
  private stopped = false;
  private discovered = new Set<string>();
  private files = new FileReceiver();
  /** The AgentNet home this node belongs to (bound for all of its work). */
  readonly home: string;

  constructor(identity: Identity, opts: NodeOpts) {
    super();
    this.identity = identity;
    this.opts = opts;
    this.home = anDir();
    this.cfg = loadConfig();
    this.setMaxListeners(100);
    // Run every public entry point inside this node's home (AsyncLocalStorage survives awaits),
    // so several agents can share one process without touching each other's files.
    const bound = ['start', 'stop', 'send', 'presence', 'watch', 'waitOnline', 'search', 'seek', 'knock', 'answerKnock', 'connect',
      'sendFile', 'groupCreate', 'groupAdd', 'groupRemove', 'groupPromote', 'groupRename', 'groupJoin', 'groupLeave', 'groupSend',
      'groupSendFile', 'groupCall', 'flushOutbox', 'flushOutboxFor', 'handleEnvelope', 'announce', 'call', 'acceptCall', 'rejectCall',
      'sendReadReceipts', 'findKnock', 'findCall'] as const;
    for (const m of bound) {
      const f = (this as any)[m].bind(this);
      (this as any)[m] = (...a: unknown[]) => inHome(this.home, () => f(...a));
    }
  }
  /** Run arbitrary work (e.g. CLI/MCP reads of this node's inbox) bound to this node's home. */
  within<T>(fn: () => T): T {
    return inHome(this.home, fn);
  }

  private log(m: string): void {
    this.opts.log?.(m);
  }
  private get receiving(): boolean {
    return this.opts.recv || !!this.opts.sidecar;
  }

  // ─── self-presentation ─────────────────────────────────────────
  card(): any {
    return signCard(buildCard(this.identity, { ...this.identity.profile, relays: this.cfg.relays }), this.identity.edPriv);
  }
  beacon(): any {
    const p = this.identity.profile;
    if (!p.discoverable) return null;
    return signBeacon(this.identity, { oneLine: p.oneLine || autoDescribe(p), status: p.status || 'available', discoverable: true });
  }
  /** Member entry used in group state (address + verified keys + where I can be reached). */
  memberEntry(): any {
    return { address: this.identity.address, edPub: this.identity.edPub, xPub: this.identity.xPub, name: this.identity.profile.name || this.identity.profile.handle, relays: this.cfg.relays };
  }
  private sigOfProfile(): string {
    return JSON.stringify([this.identity.profile, this.cfg.relays]);
  }
  async announce(patch: Partial<Profile>): Promise<{ searchable: boolean; oneLine: string | null }> {
    this.identity.profile = { ...this.identity.profile, ...patch };
    saveProfile(this.identity.address, this.identity.profile);
    return this.pushAnnouncement();
  }
  private async pushAnnouncement(): Promise<{ searchable: boolean; oneLine: string | null }> {
    this.profileSig = this.sigOfProfile();
    const card = this.card();
    const beacon = this.beacon();
    let searchable = false;
    if (this.opts.recv) {
      const rs = await Promise.all(this.clients.map((c) => c.announce(card, beacon).catch(() => ({ searchable: false }))));
      searchable = rs.some((r) => r.searchable);
    }
    return { searchable, oneLine: beacon?.oneLine ?? null };
  }

  // ─── lifecycle ────────────────────────────────────────────────
  async start(): Promise<void> {
    const full = this.opts.recv;
    const acl = full ? relayAcl(this.cfg) : undefined;
    this.aclSig = JSON.stringify(acl || {});
    this.profileSig = this.sigOfProfile();
    const card = full ? this.card() : undefined;
    const beacon = full ? this.beacon() : undefined;
    this.clients = this.cfg.relays.map((base) => this.wire(new RelayClient(base, this.identity, { recv: this.opts.recv, listen: !!this.opts.sidecar && !this.opts.recv, acl, forcePoll: this.opts.forcePoll, card, beacon })));
    const results = await Promise.allSettled(this.clients.map((c) => c.connect()));
    if (!results.some((r) => r.status === 'fulfilled')) {
      const err = (results[0] as PromiseRejectedResult).reason;
      throw new Error(`Could not reach any AgentNet relay (${this.cfg.relays.join(', ')}): ${err?.message || err}`);
    }
    if (full) {
      try { prune(this.cfg); } catch (e: any) { this.log(`prune failed: ${e?.message}`); }
      await this.watchOutboxTargets();
      this.timers.push(setInterval(() => { try { prune(loadConfig()); } catch { /* next time */ } }, 6 * 3600_000));
      this.timers.push(setInterval(() => { void this.maintenance(); }, 5_000));
      this.timers.push(setInterval(() => { void this.flushOutbox(); }, 60_000));
      for (const t of this.timers) t.unref?.();
    }
  }

  private wire(c: RelayClient): RelayClient {
    c.on('deliver', (env) => { void this.handleEnvelope(env, c); });
    c.on('presence', (ev) => { this.emit('presence', ev); if (ev.state === 'online' && this.opts.recv) void this.flushOutboxFor(ev.address); });
    c.on('connected', (i) => { this.emit('connected', { relay: c.base, ...i }); if (this.opts.recv) void this.flushOutbox(); });
    c.on('disconnected', () => this.emit('disconnected', { relay: c.base }));
    c.on('discovery', (ev: { seekId: string; result: LiveResult; relay?: string }) => {
      const key = `${ev.seekId}|${ev.result.address}`;
      if (this.discovered.has(key) || ev.result.address === this.identity.address) return;
      const card = ev.result.card;
      if (!card || !verifyCard(card).ok || card.address !== ev.result.address) return;
      this.discovered.add(key);
      this.emit('discovery', { seekId: ev.seekId, ...ev.result, relay: ev.relay || ev.result.relay });
    });
    return c;
  }
  private clientFor(base: string): RelayClient {
    const b = base.replace(/\/$/, '');
    const mine = this.clients.find((c) => c.base === b);
    if (mine) return mine;
    let c = this.extra.get(b);
    if (c) { this.extra.delete(b); this.extra.set(b, c); return c; } // LRU touch
    c = this.wire(new RelayClient(b, this.identity, { recv: false, connectTimeoutMs: 5000 }));
    this.extra.set(b, c);
    while (this.extra.size > 8) {
      const [oldest, oc] = this.extra.entries().next().value!;
      this.extra.delete(oldest);
      void oc.close().catch(() => {});
    }
    return c;
  }
  /** Relays to try for a recipient: mine first, then at most 2 SAFE learned relays (no SSRF). */
  private async routeFor(learned: string[]): Promise<RelayClient[]> {
    const mine = new Set(this.clients.map((c) => c.base));
    const extra = await safeRelays(learned.filter((r) => typeof r === 'string' && !mine.has(r.replace(/\/$/, ''))), 2);
    return [...this.clients, ...extra.map((r) => this.clientFor(r))].filter((c, i, arr) => arr.indexOf(c) === i);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.files.close();
    await Promise.all([...this.clients, ...this.extra.values()].map((c) => c.close()));
  }

  // ─── sending ───────────────────────────────────────────────────
  private buildEnvelope(to: string, recipientXPub: string, type: MessageType, body: any, id = C.newId()): any {
    const inner = C.signInner(
      {
        type, id, to,
        from: this.identity.address,
        fromEdPub: this.identity.edPub,
        fromXPub: this.identity.xPub,
        fromName: this.identity.profile?.name || this.identity.profile?.handle,
        fromRelays: this.cfg.relays,
        body,
        ts: C.nowSec(),
      },
      this.identity.edPriv,
    );
    // Chunks of an accepted transfer and typing indicators skip proof-of-work (the receiver authorizes them by fileId).
    const pow = type === 'typing' || type === 'file_chunk' ? 0 : this.cfg.powBits;
    return C.sealEnvelope({ to, recipientXPub, inner, id, powBits: pow });
  }

  /** Send to an ONLINE recipient. Offline → `offline` (or `queued` in THIS machine's outbox with opts.queue). */
  async send(toRaw: string, type: MessageType, body: any, opts: { queue?: boolean; id?: string; keys?: Keys; groupId?: string } = {}): Promise<SendOutcome> {
    const to = C.normalizeAddress(toRaw);
    if (!to) throw new Error(`Invalid address: ${toRaw}`);
    const id = opts.id || C.newId();
    const log = (r: SendOutcome) => {
      if (LOGGED.has(type)) appendSent({ id, to, groupId: opts.groupId, type, body: type === 'knock' ? { note: body?.note } : body, ts: C.nowSec(), result: r.result });
      return r;
    };
    const keys: { xPub: string; relays: string[] } | null = opts.keys
      ? { xPub: opts.keys.xPub, relays: opts.keys.relays || [] }
      : await keysFor(to).then((k) => (k ? { xPub: k.xPub, relays: k.relays } : null));
    const queueIt = (relay?: string): SendOutcome => {
      outboxAdd({ id, to, type, body, createdAt: C.nowSec(), attempts: 1, lastAttempt: C.nowSec() });
      if (this.opts.recv) void this.watch([to]).catch(() => {});
      return { id, result: 'queued', relay };
    };
    if (!keys) {
      if (opts.queue && type !== 'typing') return log(queueIt());
      return log({ id, result: 'offline', error: 'Not online (no live card found on any reachable relay).' });
    }
    const contact = getContact(to);
    const presentToken = contact?.inviteToken && (type === 'msg' || type === 'call' || type === 'knock') ? contact.inviteToken : undefined;
    if (presentToken) body = { ...body, invite: presentToken };
    const env = this.buildEnvelope(to, keys.xPub, type, body, id);
    const route = await this.routeFor(keys.relays);
    let best: SendOutcome = { id, result: 'error', error: 'no relay reachable' };
    for (const c of route) {
      let r: SendResult;
      try { r = await c.send(env); } catch (e: any) { r = { id, result: 'error', error: e?.message, relay: c.base }; }
      if ((RESULT_RANK[r.result] ?? -1) > (RESULT_RANK[best.result] ?? -1)) best = { id, result: r.result, relay: r.relay, error: r.error };
      if (r.result === 'delivered') break;
    }
    if (presentToken && (best.result === 'delivered' || best.result === 'unconfirmed')) clearInviteToken(to);
    if (best.result === 'offline' && opts.queue && type !== 'typing' && type !== 'file_chunk') return log(queueIt(best.relay));
    return log(best);
  }

  private async relaysOf(address: string): Promise<RelayClient[]> {
    const k = await keysFor(address).catch(() => null);
    return this.routeFor(k?.relays || []);
  }
  async presence(addressRaw: string): Promise<string> {
    const a = C.normalizeAddress(addressRaw);
    if (!a) throw new Error(`Invalid address: ${addressRaw}`);
    const clients = await this.relaysOf(a);
    const states = await Promise.all(clients.map((c) => c.presence(a).catch(() => 'error')));
    if (states.includes('online')) return 'online';
    if (states.includes('offline')) return 'offline';
    if (states.includes('hidden')) return 'hidden';
    return 'error';
  }
  async watch(addresses: string[]): Promise<Record<string, string>> {
    const merged: Record<string, string> = {};
    await Promise.all(this.clients.map(async (c) => {
      const s = await c.watch(addresses).catch(() => ({} as Record<string, string>));
      for (const [k, v] of Object.entries(s)) if (merged[k] !== 'online') merged[k] = v;
    }));
    return merged;
  }
  async waitOnline(address: string, timeoutMs: number): Promise<boolean> {
    const a = C.normalizeAddress(address)!;
    const states = await this.watch([a]);
    if (states[a] === 'online') return true;
    if (states[a] === 'hidden') return false;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.off('presence', on); resolve(false); }, timeoutMs);
      const on = (ev: any) => { if (ev.address === a && ev.state === 'online') { clearTimeout(t); this.off('presence', on); resolve(true); } };
      this.on('presence', on);
    });
  }

  /** Resolve with the first control/inbox record matching `pred` (via events, plus the inbox file for knock answers). */
  private waitFor(pred: (r: { type: string; from: string; body: any }) => boolean, timeoutMs: number, alsoInbox = false): { promise: Promise<any | null>; cancel: () => void } {
    let done = false;
    let cancel = () => {};
    const promise = new Promise<any | null>((resolve) => {
      const finish = (v: any) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        clearInterval(poll);
        this.off('control', on);
        this.off('message', on);
        resolve(v);
      };
      const on = (r: any) => { if (pred(r)) finish(r); };
      this.on('control', on);
      this.on('message', on);
      const poll = setInterval(() => {
        if (!alsoInbox) return;
        const r = readInbox().reverse().find((x) => pred(x));
        if (r) finish(r);
      }, 750);
      const t = setTimeout(() => finish(null), timeoutMs);
      cancel = () => finish(null);
    });
    return { promise, cancel: () => cancel() };
  }

  // ─── live discovery ───────────────────────────────────────────
  async search(q: string, limit = 20): Promise<Resolved[]> {
    return liveSearch({ q, limit });
  }
  async seek(q: string): Promise<{ results: Resolved[]; seekIds: string[] }> {
    const rs = await Promise.all(this.clients.map((c) => c.seek(q, true).catch(() => ({ seekId: null, results: [] as LiveResult[] }))));
    const best = new Map<string, Resolved>();
    for (const r of rs.flatMap((x) => x.results)) {
      if (!r?.card || !verifyCard(r.card).ok || r.address === this.identity.address) continue;
      const prev = best.get(r.address);
      if (!prev || (r.score || 0) > (prev.score || 0)) {
        best.set(r.address, { address: r.address, card: r.card, source: 'live', online: true, oneLine: r.beacon?.oneLine || r.oneLine, status: r.status, since: r.since, tag: r.tag, relay: r.relay, score: r.score });
      }
    }
    return { results: [...best.values()].sort((a, b) => (b.score || 0) - (a.score || 0)), seekIds: rs.map((x) => x.seekId).filter(Boolean) as string[] };
  }

  // ─── knock / connect ──────────────────────────────────────────
  async knock(to: string, note: string, opts: { intent?: string; waitMs?: number } = {}): Promise<KnockOutcome> {
    const addr = C.normalizeAddress(to);
    if (!addr) throw new Error(`Invalid address: ${to}`);
    const knockId = C.newId();
    recordKnock({ knockId, to: addr, ts: C.nowSec(), note });
    const answer = this.waitFor((r) => r.type === 'knock_answer' && r.from === addr && r.body?.knockId === knockId, opts.waitMs ?? 60_000, true);
    const r = await this.send(addr, 'knock', {
      knockId, note: String(note || '').slice(0, 500), intent: opts.intent ? String(opts.intent).slice(0, 200) : undefined,
      card: this.card(), oneLine: this.identity.profile.oneLine || autoDescribe(this.identity.profile),
    }, { id: knockId });
    if (r.result !== 'delivered' && r.result !== 'unconfirmed') { answer.cancel(); return { knockId, to: addr, delivery: r.result }; }
    const a = await answer.promise;
    if (!a) return { knockId, to: addr, delivery: r.result, timedOut: true };
    if (a.body?.accepted && !getContact(addr)) upsertContact(addr, { name: a.fromName, policy: 'auto' });
    return { knockId, to: addr, delivery: r.result, accepted: !!a.body?.accepted, note: a.body?.note };
  }
  findKnock(idOrKnockId: string): InboxRecord | null {
    return readInbox().reverse().find((r) => r.type === 'knock' && (r.id === idOrKnockId || r.body?.knockId === idOrKnockId)) || null;
  }
  async answerKnock(idOrKnockId: string, accept: boolean, note?: string): Promise<SendOutcome & { knockId: string }> {
    const rec = this.findKnock(idOrKnockId);
    if (!rec) throw new Error(`No knock ${idOrKnockId} in inbox`);
    if (accept) {
      const card = rec.body?.card && verifyCard(rec.body.card).ok && rec.body.card.address === rec.from ? rec.body.card : undefined;
      upsertContact(rec.from, { name: rec.fromName, card, policy: 'auto', presence: 'allow' });
    }
    const r = await this.send(rec.from, 'knock_answer', { knockId: rec.body?.knockId, accepted: accept, note: note ? String(note).slice(0, 280) : undefined });
    return { ...r, knockId: rec.body?.knockId };
  }
  /**
   * search → knock the best candidates one by one → first accept wins → the
   * conversation starts: the need is sent as the first message (or opts.message).
   */
  async connect(need: string, opts: { max?: number; waitMs?: number; note?: string; message?: string | false } = {}): Promise<ConnectOutcome> {
    const candidates = (await this.search(need, Math.max(1, opts.max ?? 5) * 2)).filter((c) => c.status !== 'away').slice(0, opts.max ?? 5);
    const tried: ConnectOutcome['tried'] = [];
    for (const c of candidates) {
      this.emit('connect_try', c);
      const k = await this.knock(c.address, opts.note || `Hi, it's ${this.identity.profile.name || 'an agent'} (${this.identity.address}). I'm looking for: ${need}`, {
        intent: need, waitMs: opts.waitMs ?? 30_000,
      }).catch(() => null);
      if (!k || (k.delivery !== 'delivered' && k.delivery !== 'unconfirmed')) { tried.push({ address: c.address, tag: c.tag, oneLine: c.oneLine, result: 'unreachable' }); continue; }
      if (k.timedOut) { tried.push({ address: c.address, tag: c.tag, oneLine: c.oneLine, result: 'no_answer' }); continue; }
      if (k.accepted) {
        const firstMessage = opts.message === false ? undefined : await this.send(c.address, 'msg', { text: opts.message || need }).catch(() => undefined);
        return { need, connected: { ...c, note: k.note }, firstMessage, tried, candidates: candidates.length };
      }
      tried.push({ address: c.address, tag: c.tag, oneLine: c.oneLine, result: 'rejected', note: k.note });
      this.emit('connect_rejected', { ...c, note: k.note });
    }
    return { need, connected: null, tried, candidates: candidates.length };
  }

  // ─── native file transfer ─────────────────────────────────────
  /** Send a file E2EE over AgentNet (recipient must be online and accept). */
  async sendFile(toRaw: string, filePath: string, opts: { groupId?: string; keys?: Keys; offer?: FileOffer; onProgress?: (p: number) => void } = {}): Promise<FileOutcome> {
    const to = C.normalizeAddress(toRaw);
    if (!to) throw new Error(`Invalid address: ${toRaw}`);
    const offer = opts.offer ? { ...opts.offer, fileId: C.newId() } : makeOffer(filePath, opts.groupId);
    const base = { to, fileId: offer.fileId, name: offer.name, size: offer.size, sha256: offer.sha256 };
    const t0 = Date.now();
    const keys = opts.keys || (await keysFor(to).then((k) => (k ? { xPub: k.xPub, relays: k.relays } : undefined)));
    if (!keys) return { ...base, result: 'offline', reason: 'recipient not online' };
    const accept = this.waitFor((r) => r.type === 'file_accept' && r.from === to && r.body?.fileId === offer.fileId, 30_000);
    const o = await this.send(to, 'file_offer', offer, { keys });
    if (o.result !== 'delivered' && o.result !== 'unconfirmed') { accept.cancel(); return { ...base, result: o.result === 'offline' ? 'offline' : 'failed', reason: o.error }; }
    const a = await accept.promise;
    if (!a) return { ...base, result: 'no_answer', reason: 'recipient did not answer the offer (is its node running?)' };
    if (!a.body?.accepted) return { ...base, result: 'rejected', reason: a.body?.reason };
    const ack = this.waitFor((r) => r.type === 'file_ack' && r.from === to && r.body?.fileId === offer.fileId, 120_000);
    const fd = fs.openSync(filePath, 'r');
    let failed: string | null = null;
    let sent = 0;
    try {
      const indexes = Array.from({ length: offer.chunks }, (_, i) => i);
      await pool(indexes, FILE_WINDOW, async (i) => {
        if (failed) return;
        for (let attempt = 0; attempt < 3; attempt++) {
          const r = await this.send(to, 'file_chunk', { fileId: offer.fileId, index: i, data: readChunk(fd, offer, i) }, { keys });
          if (r.result === 'delivered' || r.result === 'unconfirmed') { sent++; opts.onProgress?.(sent / offer.chunks); return; }
          if (r.result === 'offline' && attempt === 2) break;
          await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
        }
        failed = `chunk ${i} not delivered`;
      });
    } finally {
      fs.closeSync(fd);
    }
    if (failed) { ack.cancel(); return { ...base, result: 'failed', reason: failed, ms: Date.now() - t0 }; }
    const fin = await ack.promise;
    if (!fin) return { ...base, result: 'failed', reason: 'no final acknowledgement', ms: Date.now() - t0 };
    if (!fin.body?.ok) return { ...base, result: 'failed', reason: fin.body?.reason || 'receiver rejected the file', ms: Date.now() - t0 };
    appendSent({ id: offer.fileId, to, groupId: opts.groupId, type: 'file', body: { name: offer.name, size: offer.size, sha256: offer.sha256 }, ts: C.nowSec(), result: 'delivered' });
    return { ...base, result: 'delivered', verified: fin.body.sha256 === offer.sha256, ms: Date.now() - t0 };
  }

  // ─── groups ───────────────────────────────────────────────────
  private groupOrThrow(id: string): GroupRecord {
    const g = getGroup(id);
    if (!g) throw new Error(`Unknown group ${id}`);
    return g;
  }
  private async memberFor(address: string): Promise<any> {
    const a = C.normalizeAddress(address);
    if (!a) throw new Error(`Invalid address: ${address}`);
    const c = getContact(a);
    if (c?.card && verifyCard(c.card).ok) return { address: a, edPub: c.card.edPub, xPub: c.card.xPub, name: c.name || c.card.name, relays: c.card.relays };
    const k = await keysFor(a);
    if (!k) throw new Error(`No keys for ${a}: add them as a contact (invite/knock) or make sure they are online.`);
    return { address: a, edPub: k.edPub, xPub: k.xPub, name: c?.name || k.card?.name, relays: k.relays };
  }
  /** Send the signed state to members (+ extra recipients such as removed members). */
  private async broadcastState(state: any, extra: string[] = []): Promise<Record<string, string>> {
    const targets = [...state.members.map((m: any) => m.address), ...extra].filter((a: string, i: number, arr: string[]) => a !== this.identity.address && arr.indexOf(a) === i);
    const res: Record<string, string> = {};
    await pool(targets, 8, async (a: string) => {
      const m = state.members.find((x: any) => x.address === a);
      const r = await this.send(a, 'group_update', { state }, { keys: m ? { xPub: m.xPub, relays: m.relays } : undefined, queue: true }).catch((e) => ({ result: 'error', error: e?.message } as SendOutcome));
      res[a] = r.result;
    });
    return res;
  }
  async groupCreate(name: string, members: string[]): Promise<{ group: any; delivery: Record<string, string> }> {
    const entries = await Promise.all(members.map((m) => this.memberFor(m)));
    const state = createGroup({ ...this.memberEntry(), edPriv: this.identity.edPriv }, name, entries);
    saveGroup(state.id, { state, status: 'joined', updatedAt: C.nowSec() });
    return { group: state, delivery: await this.broadcastState(state) };
  }
  async groupAdd(id: string, members: string[]): Promise<{ group: any; delivery: Record<string, string> }> {
    const g = this.groupOrThrow(id);
    const entries = await Promise.all(members.map((m) => this.memberFor(m)));
    const state = updateGroup({ address: this.identity.address, edPriv: this.identity.edPriv }, g.state, (d: any) => { d.members.push(...entries); });
    saveGroup(id, { ...g, state });
    return { group: state, delivery: await this.broadcastState(state) };
  }
  async groupRemove(id: string, address: string): Promise<{ group: any; delivery: Record<string, string> }> {
    const g = this.groupOrThrow(id);
    const a = C.normalizeAddress(address)!;
    const state = updateGroup({ address: this.identity.address, edPriv: this.identity.edPriv }, g.state, (d: any) => {
      d.members = d.members.filter((m: any) => m.address !== a);
      d.admins = d.admins.filter((x: string) => x !== a);
    });
    saveGroup(id, { ...g, state, left: (g.left || []).filter((x) => x !== a) });
    return { group: state, delivery: await this.broadcastState(state, [a]) };
  }
  async groupPromote(id: string, address: string): Promise<{ group: any; delivery: Record<string, string> }> {
    const g = this.groupOrThrow(id);
    const a = C.normalizeAddress(address)!;
    if (!isMember(g.state, a)) throw new Error('Only members can become admins');
    const state = updateGroup({ address: this.identity.address, edPriv: this.identity.edPriv }, g.state, (d: any) => { d.admins.push(a); });
    saveGroup(id, { ...g, state });
    return { group: state, delivery: await this.broadcastState(state) };
  }
  async groupRename(id: string, name: string): Promise<{ group: any; delivery: Record<string, string> }> {
    const g = this.groupOrThrow(id);
    const state = updateGroup({ address: this.identity.address, edPriv: this.identity.edPriv }, g.state, (d: any) => { d.name = name; });
    saveGroup(id, { ...g, state });
    return { group: state, delivery: await this.broadcastState(state) };
  }
  groupJoin(id: string): GroupRecord {
    const g = this.groupOrThrow(id);
    if (g.status === 'removed') throw new Error('You were removed from this group');
    saveGroup(id, { ...g, status: 'joined' });
    return getGroup(id)!;
  }
  async groupLeave(id: string): Promise<{ left: boolean }> {
    const g = this.groupOrThrow(id);
    let state = g.state;
    const me = this.identity.address;
    // Last admin leaving hands admin to the next member first, so the group keeps working.
    if (state.admins.length === 1 && state.admins[0] === me && state.members.length > 1) {
      const next = state.members.find((m: any) => m.address !== me).address;
      state = updateGroup({ address: me, edPriv: this.identity.edPriv }, state, (d: any) => {
        d.admins = [next];
        d.members = d.members.filter((m: any) => m.address !== me);
      });
      await this.broadcastState(state);
    } else {
      await pool(state.members.filter((m: any) => m.address !== me), 8, (m: any) =>
        this.send(m.address, 'group_leave', { groupId: id }, { keys: { xPub: m.xPub, relays: m.relays } }).catch(() => null));
    }
    saveGroup(id, { ...g, state, status: 'left' });
    return { left: true };
  }
  private activeMembers(g: GroupRecord): any[] {
    const left = new Set(g.left || []);
    return g.state.members.filter((m: any) => m.address !== this.identity.address && !left.has(m.address));
  }
  /** Fan out an E2EE message to every member (pairwise encryption). */
  async groupSend(id: string, text: string, opts: { queue?: boolean; attachments?: any[] } = {}): Promise<{ groupId: string; results: Record<string, string>; delivered: number; total: number }> {
    const g = this.groupOrThrow(id);
    if (g.status !== 'joined') throw new Error(`You are not an active member of ${id} (status: ${g.status})`);
    const msgId = C.newId();
    const members = this.activeMembers(g);
    const results: Record<string, string> = {};
    await pool(members, 8, async (m: any) => {
      const r = await this.send(m.address, 'group_msg', { groupId: id, msgId, text: String(text).slice(0, 16_000), attachments: opts.attachments }, { keys: { xPub: m.xPub, relays: m.relays }, queue: opts.queue, groupId: id }).catch((e) => ({ result: 'error', error: e?.message } as SendOutcome));
      results[m.address] = r.result;
    });
    return { groupId: id, results, delivered: Object.values(results).filter((r) => r === 'delivered' || r === 'unconfirmed').length, total: members.length };
  }
  async groupSendFile(id: string, filePath: string): Promise<{ groupId: string; results: FileOutcome[] }> {
    const g = this.groupOrThrow(id);
    if (g.status !== 'joined') throw new Error(`You are not an active member of ${id}`);
    const offer = makeOffer(filePath, id);
    const results = await pool(this.activeMembers(g), 3, (m: any) =>
      this.sendFile(m.address, filePath, { groupId: id, keys: { xPub: m.xPub, relays: m.relays }, offer }).catch((e) => ({ to: m.address, fileId: '', name: offer.name, size: offer.size, sha256: offer.sha256, result: 'failed', reason: e?.message } as FileOutcome)));
    return { groupId: id, results };
  }
  /** Group call: one E2EE session, a sealed invite per member, auto-approve only those members' secret usernames. */
  async groupCall(id: string, purpose?: string): Promise<{ sessionId: string; invited: Record<string, string>; approved: Promise<number> }> {
    const s = this.sessions();
    const g = this.groupOrThrow(id);
    await s.ensure();
    const roomSecret = C.randomToken(18);
    const started = await s.call('/session/start', 'POST', { sessionName: `agentnet-group-${g.state.name}`.slice(0, 60), roomSecret });
    const sessionId = started?.sessionId;
    if (!sessionId) throw new Error('Could not start a session');
    const usernames = new Set<string>();
    const invited: Record<string, string> = {};
    await pool(this.activeMembers(g), 8, async (m: any) => {
      const username = `an-${C.randomToken(9)}`;
      const callId = C.newId();
      const r = await this.send(m.address, 'call', { callId, sessionId, roomSecret, username, groupId: id, purpose: purpose?.slice(0, 500), expiresAt: C.nowSec() + CALL_TTL_SEC }, { keys: { xPub: m.xPub, relays: m.relays }, id: callId });
      invited[m.address] = r.result;
      if (r.result === 'delivered' || r.result === 'unconfirmed') usernames.add(username);
    });
    const approved = (async () => {
      let n = 0;
      const deadline = Date.now() + CALL_TTL_SEC * 1000;
      while (usernames.size && Date.now() < deadline && !this.stopped) {
        const st = await s.call('/status', 'GET').catch(() => null);
        for (const j of st?.pendingJoins || []) {
          if (usernames.has(j.username)) { await s.call('/session/approve', 'POST', { tempUserId: j.tempUserId }).catch(() => {}); usernames.delete(j.username); n++; }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return n;
    })();
    return { sessionId, invited, approved };
  }

  // ─── outbox (local only) ──────────────────────────────────────
  private watchedTargets = new Set<string>();
  private async watchOutboxTargets(): Promise<void> {
    const targets = [...new Set(outboxList().map((i) => i.to))].filter((t) => !this.watchedTargets.has(t));
    if (!targets.length) return;
    for (const t of targets) this.watchedTargets.add(t);
    const states = await this.watch(targets).catch(() => { for (const t of targets) this.watchedTargets.delete(t); return {} as Record<string, string>; });
    // Presence events only fire on a change: a target that is ALREADY online when
    // we start watching it (queued by another CLI process just before it came up)
    // would otherwise wait for the 60 s sweep.
    for (const [addr, st] of Object.entries(states)) if (st === 'online' && this.opts.recv) void this.flushOutboxFor(addr);
  }
  private expired(i: OutboxItem): boolean {
    return C.nowSec() - i.createdAt > this.cfg.outboxMaxAgeDays * 86400;
  }
  async flushOutboxFor(address: string): Promise<void> {
    for (const item of outboxList().filter((i) => i.to === address)) await this.flushItem(item);
  }
  async flushOutbox(): Promise<void> {
    for (const item of outboxList()) await this.flushItem(item);
  }
  private async flushItem(item: OutboxItem): Promise<void> {
    if (this.flushing.has(item.id) || this.stopped) return;
    if (this.expired(item)) { outboxRemove(item.id); this.emit('outbox_expired', item); return; }
    this.flushing.add(item.id);
    try {
      let keys: Keys | undefined;
      const gid = item.body?.groupId || item.body?.state?.id;
      if (gid) {
        const m = getGroup(gid)?.state?.members?.find((x: any) => x.address === item.to);
        if (m) keys = { xPub: m.xPub, relays: m.relays };
      }
      const r = await this.send(item.to, item.type as MessageType, item.body, { id: item.id, keys });
      if (r.result === 'delivered' || r.result === 'unconfirmed') {
        outboxRemove(item.id);
        this.emit('outbox_delivered', { ...item, result: r.result });
      } else {
        outboxUpdate({ ...item, attempts: item.attempts + 1, lastAttempt: C.nowSec() });
      }
    } finally {
      this.flushing.delete(item.id);
    }
  }
  private async maintenance(): Promise<void> {
    await this.watchOutboxTargets();
    this.cfg = loadConfig();
    const acl = relayAcl(this.cfg);
    const sig = JSON.stringify(acl);
    if (sig !== this.aclSig) {
      this.aclSig = sig;
      await Promise.all(this.clients.map((c) => c.setAcl(acl).catch(() => {})));
    }
    const disk = identityOrNull();
    if (disk && disk.address === this.identity.address) this.identity.profile = disk.profile;
    if (this.sigOfProfile() !== this.profileSig) await this.pushAnnouncement().catch(() => {});
  }

  // ─── receiving ─────────────────────────────────────────────────
  private bridgedRate = { start: 0, n: 0 };
  private knockRate = new Map<string, { start: number; n: number }>();
  private rateOk(map: Map<string, { start: number; n: number }>, key: string, limit: number): boolean {
    const now = Date.now();
    let r = map.get(key);
    if (!r || now - r.start > 60_000) { r = { start: now, n: 0 }; map.set(key, r); }
    if (map.size > 5000) map.clear();
    return ++r.n <= limit;
  }

  /** Never throws: nothing a peer sends may crash the node. */
  async handleEnvelope(env: any, via: RelayClient): Promise<InboxRecord | null> {
    try {
      return await this.processEnvelope(env, via);
    } catch (e: any) {
      this.log(`dropped a malformed message: ${e?.message}`);
      return null;
    }
  }

  private async processEnvelope(env: any, via: RelayClient): Promise<InboxRecord | null> {
    if (!env || env.to !== this.identity.address || typeof env.id !== 'string') return null;
    if (this.seen.has(env.id)) { if (!this.opts.sidecar) void via.ack([env.id]).catch(() => {}); return null; }
    // Cheap anti-spam first: a present-but-invalid proof-of-work is rejected before any crypto.
    if (env.pow !== undefined && this.cfg.powBits && !C.checkPow(env, this.cfg.powBits)) return null;
    let inner: any;
    try { inner = C.openEnvelope(env, this.identity.xPriv, this.identity.xPub); } catch { return null; }
    if (!inner || typeof inner !== 'object' || Array.isArray(inner) || C.tooDeep(inner)) return null;

    // A2A-bridge messages are relay-originated and UNAUTHENTICATED: plain text only, always a
    // message request, rate-limited, never able to knock, call, send files or touch groups.
    const bridged = inner.from === 'a2a-bridge' && inner.bridge && inner.to === env.to && inner.id === env.id;
    if (bridged) {
      if (inner.type !== 'msg' || typeof inner.body?.text !== 'string' || !Number.isFinite(inner.ts) || this.cfg.acceptBridged === false) return null;
      const now = Date.now();
      if (now - this.bridgedRate.start > 60_000) this.bridgedRate = { start: now, n: 0 };
      if (++this.bridgedRate.n > 30) return null;
    } else if (!C.verifyInner(inner, env).ok) return null;
    if (!Number.isFinite(Number(inner.ts)) || Math.abs(C.nowSec() - Number(inner.ts)) > MAX_CLOCK_SKEW_SEC) return null;
    const type = String(inner.type);

    // Helper connection: only replies to our own requests; the main node handles the rest.
    if (this.opts.sidecar) {
      if (!SIDECAR_TYPES.has(type) || bridged) return null;
      this.seen.add(env.id);
      await via.ack([env.id]).catch(() => {});
      this.emit('control', { id: env.id, type, from: inner.from, fromName: inner.fromName, body: inner.body ?? {}, ts: Number(inner.ts), receivedAt: C.nowSec(), request: false });
      return null;
    }

    // Chunks of an accepted transfer: authorized by fileId, never stored in the inbox.
    if (type === 'file_chunk') {
      const res = this.files.chunk(inner.from, inner.body);
      if (res.error === 'unknown transfer') return null;
      this.seen.add(env.id);
      await via.ack([env.id]).catch(() => {});
      if (res.complete) {
        // Ack first (above), then hash + move — a slow disk never makes the sender retry.
        const fin = this.files.finalize(String(inner.body?.fileId));
        if (fin.done) await this.onFileReceived(fin.done);
        else void this.send(inner.from, 'file_ack', { fileId: inner.body?.fileId, ok: false, reason: fin.error }).catch(() => {});
      } else if (res.error) {
        this.files.cancel(String(inner.body?.fileId));
        void this.send(inner.from, 'file_ack', { fileId: inner.body?.fileId, ok: false, reason: res.error }).catch(() => {});
      }
      return null;
    }

    let contact = bridged ? null : getContact(inner.from);
    if (contact?.policy === 'blocked') return null;
    const groupId = typeof inner.body?.groupId === 'string' ? inner.body.groupId : typeof inner.body?.state?.id === 'string' ? inner.body.state.id : null;
    const g = groupId ? getGroup(groupId) : null;
    // Membership only counts for groups I actually JOINED (a forged invite grants nothing).
    const groupMember = !!(g && g.status === 'joined' && isMember(g.state, inner.from) && !(g.left || []).includes(inner.from));
    if (!contact && !groupMember && !bridged && this.cfg.requirePowFromUnknown && type !== 'receipt' && !C.checkPow(env, this.cfg.powBits)) return null;
    if (!contact && !bridged && inner.body?.invite && redeemInvite(inner.body.invite)) {
      contact = upsertContact(inner.from, { name: typeof inner.fromName === 'string' ? inner.fromName.slice(0, 64) : undefined, policy: 'auto' });
      this.emit('invite_redeemed', { address: inner.from });
    }
    if (!bridged && type === 'knock_answer' && inner.body?.accepted === true) {
      const sent = getSentKnock(String(inner.body?.knockId || ''));
      if (sent && sent.to === inner.from && !contact) contact = upsertContact(inner.from, { name: typeof inner.fromName === 'string' ? inner.fromName.slice(0, 64) : undefined, policy: 'auto' });
    }
    if (type === 'knock' && !contact && !this.rateOk(this.knockRate, inner.from, 3)) return null; // knock flood from one sender
    const known = !!contact || groupMember; // after invite redemption / accepted knock

    this.seen.add(env.id);
    if (this.seen.size > 20_000) this.seen = new Set([...this.seen].slice(-10_000));
    if (!bridged) {
      const relays = Array.isArray(inner.fromRelays) ? inner.fromRelays.filter((r: unknown) => typeof r === 'string' && /^https?:\/\//.test(r) && r.length < 200).slice(0, 8) : [];
      rememberPeer({ address: inner.from, edPub: inner.fromEdPub, xPub: inner.fromXPub, relays, seenAt: C.nowSec() });
    }
    const fromName = bridged ? 'A2A caller (unverified)' : contact?.name || (typeof inner.fromName === 'string' ? inner.fromName.slice(0, 64) : undefined);
    const control = { id: env.id, type, from: inner.from, fromName, body: inner.body ?? {}, ts: Number(inner.ts), receivedAt: C.nowSec(), request: !known };

    if (CONTROL.has(type)) {
      await via.ack([env.id]).catch(() => {});
      this.emit('control', control);
      if (type === 'typing') this.emit('typing', control);
      if (type === 'file_offer') await this.onFileOffer(inner.from, fromName, inner.body, !!contact);
      if (type === 'group_leave') await this.onGroupLeave(inner.from, inner.body);
      return null;
    }

    if (type === 'group_update') {
      await via.ack([env.id]).catch(() => {});
      return this.onGroupUpdate(inner.from, fromName, inner.body?.state, !!contact, env.id, Number(inner.ts));
    }
    if (type === 'group_msg' && !groupMember) { await via.ack([env.id]).catch(() => {}); return null; }

    const rec: InboxRecord = {
      id: env.id,
      type,
      from: inner.from,
      fromName,
      body: (() => { const { invite: _i, ...b } = inner.body ?? {}; return b; })(),
      ts: Number(inner.ts),
      receivedAt: C.nowSec(),
      request: !known,
      bridge: bridged ? inner.bridge : undefined,
    };
    if (type === 'group_msg') (rec as any).group = { id: groupId, name: g?.state?.name };
    if (type === 'contact_card' && !verifyCard(rec.body?.card).ok) rec.body = { invalidCard: true };
    if (type === 'knock' && rec.body?.card && (!verifyCard(rec.body.card).ok || rec.body.card.address !== rec.from)) delete rec.body.card;

    // Already stored (restart, retry, second relay): ack again but never re-fire hooks/knocks/calls.
    if (!appendInbox(rec)) { await via.ack([env.id]).catch(() => {}); return null; }
    await via.ack([env.id]).catch(() => {});
    this.emit('message', rec);

    if (type === 'knock') { void this.onKnock(rec); return rec; }
    if (type !== 'receipt' && this.opts.hooks !== false) void fireHooks(this.cfg.hooks, rec, (m) => this.log(m));
    // Calls auto-join only from trusted contacts, or from members of a group I joined (group calls).
    const callFromGroup = !!(inner.body?.groupId && groupMember);
    if (type === 'call' && (contact?.policy === 'auto' || callFromGroup) && this.cfg.autoAcceptCallsFromContacts && this.opts.sessions) {
      this.acceptCall(rec.id).then((r) => this.emit('call_accepted', r), (e) => this.log(`auto-accept failed: ${e?.message}`));
    }
    return rec;
  }

  private async onFileOffer(from: string, fromName: string | undefined, offer: any, isContact: boolean): Promise<void> {
    const g = offer?.groupId !== undefined ? getGroup(String(offer.groupId)) : null;
    const groupOk = !!(g && g.status === 'joined' && isMember(g.state, from));
    const policy = this.cfg.acceptFilesFrom;
    let reason: string | null = null;
    if (offer?.groupId !== undefined && !groupOk) reason = 'not a member of that group';
    else if (!groupOk && (policy === 'nobody' || (policy === 'contacts' && !isContact))) reason = 'files are accepted from contacts only — knock first';
    if (!reason) reason = this.files.check(offer, this.cfg.maxFileMB * 1024 * 1024, from);
    if (reason) { await this.send(from, 'file_accept', { fileId: offer?.fileId, accepted: false, reason }).catch(() => {}); return; }
    this.files.begin(offer, from, fromName);
    this.emit('file_incoming', { from, fromName, ...offer });
    await this.send(from, 'file_accept', { fileId: offer.fileId, accepted: true }).catch(() => {});
  }

  private async onFileReceived(f: ReceivedFile): Promise<void> {
    const g = f.groupId ? getGroup(f.groupId) : null;
    const rec: InboxRecord = {
      id: f.fileId, type: 'file', from: f.from, fromName: f.fromName,
      body: { name: f.name, size: f.size, sha256: f.sha256, path: f.path, groupId: f.groupId },
      ts: C.nowSec(), receivedAt: C.nowSec(), request: false,
    };
    if (g) (rec as any).group = { id: f.groupId, name: g.state?.name };
    appendInbox(rec);
    this.emit('message', rec);
    this.emit('file', f);
    if (this.opts.hooks !== false) void fireHooks(this.cfg.hooks, rec, (m) => this.log(m));
    await this.send(f.from, 'file_ack', { fileId: f.fileId, ok: true, sha256: f.sha256 }).catch(() => {});
  }

  private onGroupUpdate(from: string, fromName: string | undefined, state: any, isContact: boolean, envId: string, ts: number): InboxRecord | null {
    if (!state?.id) return null;
    const cur = getGroup(state.id);
    const v = verifyGroupState(state, cur?.state || null);
    if (!v.ok) { this.log(`ignored group update ${state.id}: ${v.error}`); return null; }
    const me = this.identity.address;
    const stillMember = isMember(state, me);
    let status: GroupRecord['status'];
    if (!stillMember) status = cur ? 'removed' : 'removed';
    else if (cur && (cur.status === 'joined' || cur.status === 'invited')) status = cur.status;
    else if (cur?.status === 'left') status = 'left';
    else status = isContact && this.cfg.autoJoinGroupsFromContacts ? 'joined' : 'invited';
    if (!cur && !stillMember) return null;
    if (!cur && status === 'invited') {
      // Invites from non-contacts are capped (oldest pending invites are dropped).
      const pendingInvites = Object.values(loadGroups()).filter((x) => x.status === 'invited').sort((x, y) => x.updatedAt - y.updatedAt);
      if (pendingInvites.length >= 20) return null;
    }
    const left = (cur?.left || []).filter((a) => isMember(state, a));
    saveGroup(state.id, { state, status, invitedBy: cur?.invitedBy || from, left, updatedAt: C.nowSec() });
    const rec: InboxRecord = {
      id: envId, type: 'group_update', from, fromName,
      body: { groupId: state.id, name: state.name, version: state.version, members: state.members.length, status, youAreAdmin: state.admins.includes(me) },
      ts, receivedAt: C.nowSec(), request: status === 'invited',
    };
    (rec as any).group = { id: state.id, name: state.name };
    appendInbox(rec);
    this.emit('message', rec);
    this.emit('group', { id: state.id, status, state });
    if (this.opts.hooks !== false && (!cur || status === 'removed')) void fireHooks(this.cfg.hooks, { ...rec, request: status === 'invited' && !isContact }, (m) => this.log(m));
    return rec;
  }

  private async onGroupLeave(from: string, body: any): Promise<void> {
    const id = String(body?.groupId || '');
    const g = getGroup(id);
    if (!g || !isMember(g.state, from)) return;
    if (g.state.admins.includes(this.identity.address)) {
      // Admin: publish the new membership so everyone converges.
      await this.groupRemove(id, from).catch((e) => this.log(`group leave update failed: ${e?.message}`));
    } else {
      saveGroup(id, { ...g, left: [...new Set([...(g.left || []), from])] });
    }
    this.emit('group', { id, left: from });
  }

  /** Knock policy: accept | reject | decide (hook) | ask (the agent/LLM answers; hooks wake it). */
  private async onKnock(rec: InboxRecord): Promise<void> {
    this.emit('knock', rec);
    const policy = this.cfg.knockPolicy;
    let decision: { accept: boolean; note?: string } | null = null;
    if (policy === 'accept') decision = { accept: true, note: 'Hi! Connected.' };
    else if (policy === 'reject') decision = { accept: false, note: 'Not taking new connections right now.' };
    else if (policy === 'decide' && this.cfg.hooks.decide) decision = await runDecideHook(this.cfg.hooks.decide, rec);
    if (decision) {
      await this.answerKnock(rec.id, decision.accept, decision.note).catch((e) => this.log(`knock answer failed: ${e?.message}`));
      this.emit('knock_answered', { ...rec, accepted: decision.accept, note: decision.note });
      return;
    }
    if (this.opts.hooks !== false) void fireHooks({ ...this.cfg.hooks, allowUnknown: true }, rec, (m) => this.log(m));
  }

  // ─── calls (reuse the EXISTING SRIFT session stack) ───────────
  private sessions(): SessionBackend {
    if (!this.opts.sessions) throw new Error('Calls need the SRIFT daemon (session backend not available in this context).');
    return this.opts.sessions;
  }
  async call(to: string, purpose?: string, opts: { approveTimeoutMs?: number } = {}): Promise<{
    callId: string; sessionId?: string; result: string; approved?: Promise<boolean>; error?: string;
  }> {
    const s = this.sessions();
    const toN = C.normalizeAddress(to);
    if (!toN) throw new Error(`Invalid address: ${to}`);
    const state = await this.presence(toN);
    if (state === 'offline') return { callId: '', result: 'offline' };
    await s.ensure();
    const roomSecret = C.randomToken(18);
    const username = `an-${C.randomToken(9)}`;
    const started = await s.call('/session/start', 'POST', { sessionName: 'agentnet-call', roomSecret });
    const sessionId = started?.sessionId;
    if (!sessionId) throw new Error('Could not start a session');
    const callId = C.newId();
    const r = await this.send(toN, 'call', {
      callId, sessionId, roomSecret, username, purpose: purpose ? String(purpose).slice(0, 500) : undefined, expiresAt: C.nowSec() + CALL_TTL_SEC,
    }, { id: callId });
    if (r.result !== 'delivered' && r.result !== 'unconfirmed') {
      await s.call('/session/close', 'POST', {}).catch(() => {});
      return { callId, sessionId, result: r.result, error: r.error };
    }
    return { callId, sessionId, result: r.result, approved: this.autoApprove(username, opts.approveTimeoutMs ?? CALL_TTL_SEC * 1000) };
  }
  private async autoApprove(username: string, timeoutMs: number): Promise<boolean> {
    const s = this.sessions();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.stopped) {
      const st = await s.call('/status', 'GET').catch(() => null);
      const pending = (st?.pendingJoins || []).find((j: any) => j.username === username);
      if (pending) { await s.call('/session/approve', 'POST', { tempUserId: pending.tempUserId }); return true; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }
  findCall(callId: string): InboxRecord | null {
    return readInbox().reverse().find((r) => r.type === 'call' && (r.id === callId || r.body?.callId === callId)) || null;
  }
  async acceptCall(callId: string): Promise<{ callId: string; sessionId: string; joined: boolean }> {
    const rec = this.findCall(callId);
    if (!rec) throw new Error(`No call ${callId} in inbox`);
    const b = rec.body || {};
    if (Number(b.expiresAt) < C.nowSec()) throw new Error('Call invite expired');
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(String(b.sessionId)) || !/^an-[A-Za-z0-9_-]{6,32}$/.test(String(b.username))) throw new Error('Malformed call invite');
    const s = this.sessions();
    await s.ensure();
    await s.call('/session/join', 'POST', { sessionId: b.sessionId, username: b.username, roomSecret: b.roomSecret });
    await this.send(rec.from, 'call_answer', { callId: b.callId, accepted: true }).catch(() => {});
    return { callId: b.callId, sessionId: b.sessionId, joined: true };
  }
  async rejectCall(callId: string, reason?: string): Promise<void> {
    const rec = this.findCall(callId);
    if (!rec) throw new Error(`No call ${callId} in inbox`);
    await this.send(rec.from, 'call_answer', { callId: rec.body?.callId, accepted: false, reason: reason?.slice(0, 200) });
  }
  async sendReadReceipts(records: InboxRecord[]): Promise<void> {
    const byFrom = new Map<string, string[]>();
    for (const r of records) {
      if (r.type !== 'msg' || r.bridge || r.request) continue;
      byFrom.set(r.from, [...(byFrom.get(r.from) || []), r.id]);
    }
    await Promise.all([...byFrom].map(([from, ids]) => this.send(from, 'receipt', { ids: ids.slice(0, 200), state: 'read' }).catch(() => null)));
  }
}
