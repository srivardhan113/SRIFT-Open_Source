/**
 * SRIFT Peerknock — the agent node.
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
import * as C from '../../lib/peerknock/crypto.mjs';
import { buildCard, handleTag, signBeacon, signCard, verifyCard } from '../../lib/peerknock/card.mjs';
import { createGroup, isMember, updateGroup, verifyGroupState } from '../../lib/peerknock/group.mjs';
import { autoDescribe } from './describe.ts';
import { FILE_WINDOW, FileReceiver, makeOffer, readChunk, type FileOffer, type ReceivedFile } from './files.ts';
import { fireHooks, runDecideHook, type KnockDecision } from './hooks.ts';
import {
  anDir, appendInbox, appendLog, appendSent, replaySeen, clearInviteToken, inHome, getContact, getGroup, getSentKnock, identityOrNull, loadConfig, outboxAdd, outboxList, outboxRemove,
  getCall, listCalls, loadCalls, updateCall, loadGroups, outboxUpdate, prune, readInbox, readSent, recordKnock, redeemInvite, relayAcl, rememberPeer, saveGroup, saveProfile, upsertContact,
  type CallMember, type CallRecord, type Config, type GroupRecord, type Identity, type InboxRecord, type OutboxItem, type Profile,
} from './local.ts';
import { RelayClient, type HandleStatus, type LiveResult, type SendResult } from './relay-client.ts';
import { keysFor, liveSearch, type Resolved } from './resolve.ts';
import { safeRelays } from './netpolicy.ts';

export type MessageType =
  | 'msg' | 'call' | 'call_answer' | 'receipt' | 'contact_card' | 'typing' | 'knock' | 'knock_answer'
  | 'file_offer' | 'file_accept' | 'file_chunk' | 'file_ack'
  | 'group_update' | 'group_msg' | 'group_leave'
  | 'call_event' | 'call_msg';
export type SessionBackend = {
  ensure: () => Promise<unknown>;
  call: (endpoint: string, method: 'GET' | 'POST', body?: any) => Promise<any>;
};
export type NodeOpts = { recv: boolean; sidecar?: boolean; forcePoll?: boolean; sessions?: SessionBackend; log?: (m: string) => void; hooks?: boolean };
export type SendOutcome = { id: string; result: SendResult['result'] | 'queued' | 'no_keys'; relay?: string; error?: string };
/** Who an agent says it is, sent with every knock and every answer (checked against its signed card). */
export type AgentIntro = { address: string; tag: string; name?: string; oneLine?: string; skills?: string[] };
/** How the other agent answered: accepted, rejected, or busy (try again later). */
export type KnockStatus = 'accepted' | 'rejected' | 'busy';
export type KnockOutcome = {
  knockId: string; to: string; delivery: SendOutcome['result'];
  /** accepted | rejected | busy (absent: no answer / not delivered). */
  status?: KnockStatus; accepted?: boolean;
  /** The other agent's own words: why it accepted, rejected or is busy. `note` is the same text (older clients). */
  reason?: string; note?: string;
  /** busy: when the other agent suggests trying again (its own estimate). */
  retryAfterSec?: number; retryAt?: number;
  /** Who answered (username, description), from its signed card. */
  from?: AgentIntro;
  timedOut?: boolean;
};
export type ConnectOutcome = {
  need: string;
  connected: (Resolved & { note?: string }) | null;
  firstMessage?: SendOutcome;
  tried: Array<{ address: string; tag?: string; oneLine?: string; result: 'rejected' | 'busy' | 'no_answer' | 'unreachable'; reason?: string; note?: string; retryAfterSec?: number }>;
  candidates: number;
};
export type FileOutcome = {
  to: string; fileId: string; name: string; size: number; sha256: string;
  result: 'delivered' | 'rejected' | 'offline' | 'failed' | 'no_answer'; reason?: string; ms?: number; verified?: boolean;
};
export type Keys = { xPub: string; relays?: string[] };

const RESULT_RANK: Record<string, number> = { delivered: 5, unconfirmed: 4, offline: 3, rate_limited: 2, invalid: 1, error: 0 };
const MAX_CLOCK_SKEW_SEC = 7 * 24 * 3600;
const NO_REPLAY_CACHE = new Set(['typing', 'receipt', 'file_chunk', 'file_accept', 'file_ack']);
const CALL_TTL_SEC = 300;
/** Protocol messages that never go to the inbox. */
const CONTROL = new Set(['file_offer', 'file_accept', 'file_chunk', 'file_ack', 'group_leave', 'typing']);
/** What a sidecar consumes (replies to requests it made). */
const SIDECAR_TYPES = new Set(['file_accept', 'file_ack', 'knock_answer']);
/** Types recorded in the local sent log (conversation history). */
const LOGGED = new Set(['msg', 'group_msg', 'knock', 'call_msg']);
/** Live-call ids (C.newId() shape). */
const CALL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

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
  /** The Peerknock home this node belongs to (bound for all of its work). */
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
      'sendReadReceipts', 'findKnock', 'findCall', 'calls', 'liveCall', 'groupLiveCall', 'answerLiveCall', 'callSend', 'callFile', 'hangup',
      'mergeCalls', 'callHistory'] as const;
    for (const m of bound) {
      const f = (this as any)[m].bind(this);
      (this as any)[m] = (...a: unknown[]) => inHome(this.home, () => f(...a));
    }
    // Activity log (node.log, readable with `srift pk logs` / MCP srift://peerknock/log): metadata only,
    // never message text or file contents; size-capped and pruned by logRetentionDays.
    const L = (event: string, details: string) => inHome(this.home, () => appendLog(event, details));
    this.on('connected', (e: any) => L('online', `relay=${e.relay} transport=${e.transport}`));
    this.on('disconnected', (e: any) => L('offline', `relay=${e.relay}`));
    this.on('handle', (h: any) => L('handle', `@${h.name} ${h.held ? 'held' : `taken by ${h.holder}`}`));
    this.on('message', (r: InboxRecord) => { if (r.type !== 'receipt' && r.type !== 'knock' && r.type !== 'knock_answer') L(`recv.${r.type}`, `from=${r.from} id=${r.id}${r.request ? ' request' : ''}`); });
    this.on('file', (x: any) => L('file.received', `from=${x.from} size=${x.size}`));
    this.on('call', (c: any) => L('call.ring', `id=${c.callId} from=${c.from}`));
    this.on('call_answer', (c: any) => L('call.answer', `id=${c.callId} from=${c.from} state=${c.state}`));
    this.on('call_event', (c: any) => L('call.event', `id=${c.callId} from=${c.from} kind=${c.kind}`));
    this.on('outbox_delivered', (i: any) => L('outbox.delivered', `to=${i.to} id=${i.id}`));
  }
  /** Run arbitrary work (e.g. CLI/MCP reads of this node's inbox) bound to this node's home. */
  within<T>(fn: () => T): T {
    return inHome(this.home, fn);
  }

  /** Bare-handle state last reported by a relay (one live holder per @name). */
  handleState: (HandleStatus & { relay: string }) | null = null;

  private log(m: string): void {
    this.opts.log?.(m);
    appendLog('note', m);
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
  async announce(patch: Partial<Profile>): Promise<{ searchable: boolean; oneLine: string | null; handle?: HandleStatus }> {
    this.identity.profile = { ...this.identity.profile, ...patch };
    saveProfile(this.identity.address, this.identity.profile);
    return this.pushAnnouncement();
  }
  private async pushAnnouncement(): Promise<{ searchable: boolean; oneLine: string | null; handle?: HandleStatus }> {
    this.profileSig = this.sigOfProfile();
    const card = this.card();
    const beacon = this.beacon();
    let searchable = false;
    let handle: HandleStatus | undefined;
    if (this.opts.recv) {
      const rs: { searchable: boolean; handle?: HandleStatus }[] = await Promise.all(this.clients.map((c) => c.announce(card, beacon).catch(() => ({ searchable: false }))));
      searchable = rs.some((r) => r.searchable);
      handle = rs.find((r) => r.handle)?.handle;
      if (handle) this.handleState = { relay: this.clients[rs.findIndex((r) => r.handle)].base, ...handle };
    }
    return { searchable, oneLine: beacon?.oneLine ?? null, handle };
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
      throw new Error(`Could not reach any Peerknock relay (${this.cfg.relays.join(', ')}): ${err?.message || err}`);
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
    c.on('handle', (h: HandleStatus) => { this.handleState = { relay: c.base, ...h }; this.emit('handle', this.handleState); });
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
  /** Who this agent is, as sent with knocks and answers (the signed card travels alongside). */
  intro(): AgentIntro {
    const p = this.identity.profile;
    return { address: this.identity.address, tag: handleTag(this.card()), name: p.name || undefined, oneLine: p.oneLine || autoDescribe(p), skills: p.skills?.length ? p.skills.slice(0, 16) : undefined };
  }
  /**
   * Ask another agent to connect: "I am <intro>, I need <need>, <note>". It answers accepted /
   * rejected / busy with its own reason (and, if busy, when to try again) — the caller decides what next.
   */
  async knock(to: string, note: string, opts: { need?: string; intent?: string; waitMs?: number } = {}): Promise<KnockOutcome> {
    const addr = C.normalizeAddress(to);
    if (!addr) throw new Error(`Invalid address: ${to}`);
    const knockId = C.newId();
    const need = String(opts.need ?? opts.intent ?? '').trim().slice(0, 500) || undefined;
    const text = String(note || '').trim().slice(0, 500) || undefined;
    recordKnock({ knockId, to: addr, ts: C.nowSec(), note: text, need });
    const answer = this.waitFor((r) => r.type === 'knock_answer' && r.from === addr && r.body?.knockId === knockId, opts.waitMs ?? 60_000, true);
    const me = this.intro();
    const r = await this.send(addr, 'knock', {
      knockId, from: me, need, note: text,
      // older clients read these
      intent: need?.slice(0, 200), card: this.card(), oneLine: me.oneLine,
    }, { id: knockId });
    appendLog('knock.sent', `to=${addr} delivery=${r.result}`);
    if (r.result !== 'delivered' && r.result !== 'unconfirmed') { answer.cancel(); return { knockId, to: addr, delivery: r.result }; }
    const a = await answer.promise;
    if (!a) { appendLog('knock.no_answer', `to=${addr}`); return { knockId, to: addr, delivery: r.result, timedOut: true }; }
    const out = { knockId, to: addr, delivery: r.result, ...readAnswer(a.body, addr) };
    if (out.status === 'accepted' && !getContact(addr)) upsertContact(addr, { name: out.from?.name || a.fromName, policy: 'auto' });
    appendLog('knock.answer', `from=${addr} status=${out.status}${out.retryAfterSec ? ` retryAfter=${out.retryAfterSec}s` : ''}`);
    return out;
  }
  findKnock(idOrKnockId: string): InboxRecord | null {
    return readInbox().reverse().find((r) => r.type === 'knock' && (r.id === idOrKnockId || r.body?.knockId === idOrKnockId)) || null;
  }
  /**
   * Answer a knock: accept, reject, or busy (with retryAfterSec). The reason is this agent's own
   * words; it travels back with this agent's username and description.
   */
  async answerKnock(idOrKnockId: string, accept: boolean, note?: string, opts: { busy?: boolean; retryAfterSec?: number } = {}): Promise<SendOutcome & { knockId: string; status: KnockStatus }> {
    const rec = this.findKnock(idOrKnockId);
    if (!rec) throw new Error(`No knock ${idOrKnockId} in inbox`);
    const status: KnockStatus = accept ? 'accepted' : opts.busy ? 'busy' : 'rejected';
    if (accept) {
      const card = rec.body?.card && verifyCard(rec.body.card).ok && rec.body.card.address === rec.from ? rec.body.card : undefined;
      upsertContact(rec.from, { name: rec.fromName, card, policy: 'auto', presence: 'allow' });
    }
    const reason = note ? String(note).trim().slice(0, 500) || undefined : undefined;
    const retry = status === 'busy' && Number.isFinite(Number(opts.retryAfterSec)) && Number(opts.retryAfterSec) > 0 ? Math.min(30 * 86400, Math.round(Number(opts.retryAfterSec))) : undefined;
    const r = await this.send(rec.from, 'knock_answer', {
      knockId: rec.body?.knockId, accepted: accept, status, reason, retryAfterSec: retry,
      from: this.intro(), card: this.card(),
      note: reason?.slice(0, 280), // older clients read note
    });
    appendLog('knock.answered', `to=${rec.from} status=${status}${retry ? ` retryAfter=${retry}s` : ''} delivery=${r.result}`);
    return { ...r, knockId: rec.body?.knockId, status };
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
      const k = await this.knock(c.address, opts.note || '', { need, waitMs: opts.waitMs ?? 30_000 }).catch(() => null);
      if (!k || (k.delivery !== 'delivered' && k.delivery !== 'unconfirmed')) { tried.push({ address: c.address, tag: c.tag, oneLine: c.oneLine, result: 'unreachable' }); continue; }
      if (k.timedOut) { tried.push({ address: c.address, tag: c.tag, oneLine: c.oneLine, result: 'no_answer' }); continue; }
      if (k.status === 'accepted') {
        const firstMessage = opts.message === false ? undefined : await this.send(c.address, 'msg', { text: opts.message || need }).catch(() => undefined);
        return { need, connected: { ...c, note: k.reason }, firstMessage, tried, candidates: candidates.length };
      }
      const result = k.status === 'busy' ? 'busy' : 'rejected';
      tried.push({ address: c.address, tag: c.tag, oneLine: c.oneLine, result, reason: k.reason, note: k.reason, retryAfterSec: k.retryAfterSec });
      this.emit('connect_rejected', { ...c, status: result, reason: k.reason, retryAfterSec: k.retryAfterSec });
    }
    return { need, connected: null, tried, candidates: candidates.length };
  }

  // ─── native file transfer ─────────────────────────────────────
  /** Send a file E2EE over Peerknock (recipient must be online and accept). */
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
    const started = await s.call('/session/start', 'POST', { sessionName: `peerknock-group-${g.state.name}`.slice(0, 60), roomSecret });
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
    } catch (e: any) {
      // Background flush (timer / presence / connect): a throw here would be an unhandled rejection and
      // take down the MCP server. Keep the item for the next attempt.
      this.log(`outbox flush of ${item.id} failed: ${e?.message || e}`);
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
    // Replays across restarts / prune (the relay sees every envelope and could resend one). Streaming
    // and ack-type traffic is idempotent or keyed by its transfer, so it skips the disk write.
    if (!NO_REPLAY_CACHE.has(type)) {
      let dup = false;
      try { dup = replaySeen(env.id, Number(inner.ts), MAX_CLOCK_SKEW_SEC); } catch { /* store unavailable: in-memory dedupe only */ }
      if (dup) { this.seen.add(env.id); void via.ack([env.id]).catch(() => {}); return null; }
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
    // Same for live calls: only a call this agent is in, and a member that is still in it.
    const callId = !bridged && typeof inner.body?.callId === 'string' && CALL_ID_RE.test(inner.body.callId) ? inner.body.callId : null;
    const cr = callId ? getCall(callId) : null;
    // A call vouches for its members only for call traffic (never plain msg / hooks), and only while it
    // rings or runs: a missed or declined ring grants nothing. Files in a call need it to be running.
    const callLive = !!cr && (cr.state === 'active' || cr.state === 'ringing');
    const callScoped = type === 'call' || type === 'call_answer' || type === 'call_event' || type === 'call_msg' || (type === 'file_offer' && cr?.state === 'active');
    const callMember = !!(cr && callLive && callScoped && (cr.members[inner.from]?.state === 'joined' || cr.members[inner.from]?.state === 'ringing'));
    if (!contact && !groupMember && !callMember && !bridged && this.cfg.requirePowFromUnknown && type !== 'receipt' && !C.checkPow(env, this.cfg.powBits)) return null;
    if (!contact && !bridged && inner.body?.invite && redeemInvite(inner.body.invite)) {
      contact = upsertContact(inner.from, { name: typeof inner.fromName === 'string' ? inner.fromName.slice(0, 64) : undefined, policy: 'auto' });
      this.emit('invite_redeemed', { address: inner.from });
    }
    if (!bridged && type === 'knock_answer' && inner.body?.accepted === true) {
      const sent = getSentKnock(String(inner.body?.knockId || ''));
      if (sent && sent.to === inner.from && !contact) contact = upsertContact(inner.from, { name: typeof inner.fromName === 'string' ? inner.fromName.slice(0, 64) : undefined, policy: 'auto' });
    }
    if (type === 'knock' && !contact && !this.rateOk(this.knockRate, inner.from, 3)) return null; // knock flood from one sender
    const known = !!contact || groupMember || callMember; // after invite redemption / accepted knock

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
    if (type === 'call_event') {
      await via.ack([env.id]).catch(() => {});
      if (callMember) this.onCallEvent(inner.from, inner.body);
      return null;
    }
    if (type === 'call_msg' && !(callMember && cr?.state === 'active')) { await via.ack([env.id]).catch(() => {}); return null; }

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
    if (type === 'call_msg') (rec as any).call = { id: callId };
    if (type === 'contact_card' && !verifyCard(rec.body?.card).ok) rec.body = { invalidCard: true };
    if (type === 'knock' && rec.body?.card && (!verifyCard(rec.body.card).ok || rec.body.card.address !== rec.from)) delete rec.body.card;
    if (type === 'knock') {
      // "Who I am" comes from the verified card; the one-liner and need are the knocker's own words (data, not instructions).
      const b = rec.body || {};
      const card = b.card;
      const f = b.from && typeof b.from === 'object' ? b.from : {};
      rec.body = {
        ...b,
        need: typeof b.need === 'string' ? b.need.slice(0, 500) : typeof b.intent === 'string' ? b.intent.slice(0, 500) : undefined,
        note: typeof b.note === 'string' ? b.note.slice(0, 500) : undefined,
        from: {
          address: rec.from,
          tag: card ? handleTag(card) : undefined,
          name: (card?.name || (typeof f.name === 'string' ? f.name : undefined))?.slice(0, 64),
          oneLine: (typeof f.oneLine === 'string' ? f.oneLine : typeof b.oneLine === 'string' ? b.oneLine : undefined)?.slice(0, 160),
          skills: card?.skills?.length ? card.skills.slice(0, 16) : undefined,
          verified: !!card,
        },
      };
    }
    if (type === 'knock_answer') rec.body = { ...rec.body, ...readAnswer(rec.body, rec.from) };

    // Already stored (restart, retry, second relay): ack again but never re-fire hooks/knocks/calls.
    if (!appendInbox(rec)) { await via.ack([env.id]).catch(() => {}); return null; }
    await via.ack([env.id]).catch(() => {});
    this.emit('message', rec);

    if (type === 'knock') { void this.onKnock(rec); return rec; }
    if (type !== 'receipt' && this.opts.hooks !== false) void fireHooks(this.cfg.hooks, rec, (m) => this.log(m));
    // Calls auto-join only from trusted contacts, or from members of a group I joined (group calls).
    const callFromGroup = !!(inner.body?.groupId && groupMember);
    if (type === 'call' && inner.body?.live === true) {
      await this.onLiveCall(rec, inner, contact?.policy === 'auto' || callFromGroup).catch((e) => this.log(`live call failed: ${e?.message}`));
      return rec;
    }
    if (type === 'call_answer' && inner.body?.live === true) { this.onLiveCallAnswer(inner.from, inner.body, inner); return rec; }
    if (type === 'call' && (contact?.policy === 'auto' || callFromGroup) && this.cfg.autoAcceptCallsFromContacts && this.opts.sessions) {
      this.acceptCall(rec.id).then((r) => this.emit('call_accepted', r), (e) => this.log(`auto-accept failed: ${e?.message}`));
    }
    return rec;
  }

  private async onFileOffer(from: string, fromName: string | undefined, offer: any, isContact: boolean): Promise<void> {
    const g = offer?.groupId !== undefined ? getGroup(String(offer.groupId)) : null;
    const call = typeof offer?.callId === 'string' ? getCall(offer.callId) : null;
    const groupOk = !!(g && g.status === 'joined' && isMember(g.state, from)) || !!(call && call.state === 'active' && call.members[from]?.state === 'joined');
    const policy = this.cfg.acceptFilesFrom;
    let reason: string | null = null;
    if (offer?.groupId !== undefined && !groupOk) reason = 'not a member of that group';
    else if (offer?.callId !== undefined && !groupOk) reason = 'not in that call';
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
      body: { name: f.name, size: f.size, sha256: f.sha256, path: f.path, groupId: f.groupId, callId: f.callId },
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
    let v = verifyGroupState(state, cur?.state || null);
    // A first-sight state (not yet joined) cannot prove its admin lineage, so a removed member could plant
    // a high-version fork. The creator's key is bound to the group id: while the group is only 'invited',
    // a valid creator-signed state replaces a pending one that someone else signed, whatever its version.
    if (!v.ok && cur?.status === 'invited' && state.by === state.createdBy && cur.state?.by !== cur.state?.createdBy) {
      const fresh = verifyGroupState(state, null);
      if (fresh.ok) { this.log(`group ${state.id}: creator-signed state replaces a pending invite state`); v = fresh; }
    }
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
    appendLog('knock.received', `from=${rec.from} policy=${this.cfg.knockPolicy}`);
    const decision = await this.autoDecision(rec);
    if (decision) {
      const status: KnockStatus = decision.accept ? 'accepted' : decision.busy ? 'busy' : 'rejected';
      await this.answerKnock(rec.id, decision.accept, decision.reason, { busy: decision.busy, retryAfterSec: decision.retryAfterSec }).catch((e) => this.log(`knock answer failed: ${e?.message}`));
      this.emit('knock_answered', { ...rec, accepted: decision.accept, status, reason: decision.reason, note: decision.reason, retryAfterSec: decision.retryAfterSec });
      return;
    }
    if (this.opts.hooks !== false) void fireHooks({ ...this.cfg.hooks, allowUnknown: true }, rec, (m) => this.log(m));
  }

  /**
   * An automatic answer, or null to leave the knock for the agent (inbox / MCP / hooks).
   * 'decide': the agent's own hook reads the knock (who, need, note) and writes the reason.
   * 'accept' / 'reject': the reason states this agent's actual situation (who it is, its
   * status, its policy) — nothing canned. A "busy" status makes an automatic accept a busy.
   */
  private async autoDecision(rec: InboxRecord): Promise<KnockDecision | null> {
    const policy = this.cfg.knockPolicy;
    if (policy === 'decide') return this.cfg.hooks.decide ? runDecideHook(this.cfg.hooks.decide, rec) : null;
    if (policy !== 'accept' && policy !== 'reject') return null;
    const me = this.intro();
    const who = `@${me.tag}${me.oneLine ? ` (${me.oneLine})` : ''}`;
    const need = typeof rec.body?.need === 'string' ? rec.body.need : typeof rec.body?.intent === 'string' ? rec.body.intent : '';
    const status = this.identity.profile.status || 'available';
    if (policy === 'reject') return { accept: false, reason: `${who} does not take new connections (policy: reject).` };
    if (status === 'busy' || status === 'away') return { accept: false, busy: true, reason: `${who} is ${status} right now${need ? `; your need: "${need.slice(0, 120)}"` : ''}.` };
    return { accept: true, reason: `${who} accepted${need ? ` your request: "${need.slice(0, 120)}"` : ''}.` };
  }

  // ─── live calls: many at once, each an E2EE channel between its members (no daemon, no server) ───
  // A call is ringing → active → ended. Any number run in parallel: the agent sets its own limit
  // (config maxCalls, none by default); beyond it callers get "busy". Whoever invites a member introduces them to everyone already in
  // the call, so conferences, "add someone" and merging calls all use the same two messages.
  private memberOf(e: any, state: CallMember['state'] = 'joined'): CallMember | null {
    const address = C.normalizeAddress(String(e?.address || ''));
    if (!address || address === this.identity.address) return null;
    return {
      address,
      xPub: typeof e.xPub === 'string' && e.xPub.length < 200 ? e.xPub : undefined,
      relays: Array.isArray(e.relays) ? e.relays.filter((r: unknown) => typeof r === 'string' && /^https?:\/\//.test(r) && r.length < 200).slice(0, 8) : undefined,
      name: typeof e.name === 'string' ? e.name.slice(0, 64) : undefined,
      state,
    };
  }
  private entryOf(m: CallMember): any {
    return { address: m.address, xPub: m.xPub, relays: m.relays, name: m.name };
  }
  private callKeys(m: CallMember | undefined): Keys | undefined {
    return m?.xPub ? { xPub: m.xPub, relays: m.relays } : undefined;
  }
  private joinedOf(c: CallRecord): CallMember[] {
    return Object.values(c.members).filter((m) => m.state === 'joined');
  }
  private liveCallOrThrow(id: string): CallRecord {
    const c = getCall(id);
    if (!c || c.state !== 'active') throw new Error(`Call ${id} is not active${c ? ` (${c.state})` : ''}.`);
    return c;
  }
  /** Calls ringing or in progress (all=true: also ended/declined/missed). Expired rings become "missed". */
  calls(all = false): CallRecord[] {
    return listCalls(all);
  }
  /** At this agent's own call limit (config maxCalls; none by default)? `except`: a call not to count. */
  private atCallLimit(except?: string): boolean {
    const max = this.cfg.maxCalls;
    return max != null && this.calls().filter((c) => c.id !== except).length >= max;
  }
  /** Outgoing call: active once anyone joins; declined/missed once nobody is left ringing. */
  private settleCall(id: string): void {
    updateCall(id, (c) => {
      if (!c || c.direction !== 'out' || c.state === 'ended') return c;
      const ms = Object.values(c.members);
      if (ms.some((m) => m.state === 'joined')) return c.state === 'active' ? c : { ...c, state: 'active' };
      if (ms.some((m) => m.state === 'ringing')) return c;
      if (c.state === 'active') return { ...c, state: 'ended', endedAt: C.nowSec() };
      return { ...c, state: ms.some((m) => m.state === 'declined' || m.state === 'busy') ? 'declined' : 'missed', endedAt: C.nowSec() };
    });
  }

  /**
   * Ring one or more agents (several = a conference). With opts.callId: invite more people into a live
   * call (anyone in it may). Returns at once; answers arrive as 'call_answer' events / in calls().
   */
  async liveCall(targets: string[], opts: { purpose?: string; groupId?: string; callId?: string; mergedFrom?: string; keys?: Record<string, Keys> } = {}): Promise<{ callId: string; invited: Record<string, string> }> {
    const tos = [...new Set(targets.map((t) => C.normalizeAddress(t)).filter((a): a is string => !!a && a !== this.identity.address))];
    if (!tos.length) throw new Error('No one to call.');
    const now = C.nowSec();
    let id = opts.callId;
    if (id) {
      const c = getCall(id);
      if (!c || (c.state !== 'active' && !(c.state === 'ringing' && c.direction === 'out'))) throw new Error(`Call ${id} is not live.`);
    } else {
      if (this.atCallLimit()) throw new Error(`Already in ${this.cfg.maxCalls} live calls (your limit: srift pk calls limit <n|off>). Hang one up first.`);
      const newId = C.newId();
      updateCall(newId, () => ({
        id: newId, host: this.identity.address, direction: 'out', state: 'ringing', members: {},
        purpose: opts.purpose ? String(opts.purpose).slice(0, 500) : undefined, groupId: opts.groupId, createdAt: now, updatedAt: now, expiresAt: now + CALL_TTL_SEC,
      }));
      id = newId;
    }
    const callId = id;
    const invited: Record<string, string> = {};
    await pool(tos, 8, async (to) => {
      const k = opts.keys?.[to] || (await keysFor(to).then((x) => (x ? { xPub: x.xPub, relays: x.relays } : undefined)));
      const cur = getCall(callId)!;
      if (cur.members[to]?.state === 'joined') { invited[to] = 'already in call'; return; }
      updateCall(callId, (c) => c && { ...c, members: { ...c.members, [to]: { address: to, xPub: k?.xPub, relays: k?.relays, state: 'ringing' } } });
      const members = this.joinedOf(cur).filter((m) => m.address !== to).map((m) => this.entryOf(m));
      const r = k
        ? await this.send(to, 'call', {
          callId, live: true, host: cur.host, purpose: cur.purpose, groupId: cur.groupId, mergedFrom: opts.mergedFrom, members, expiresAt: now + CALL_TTL_SEC,
        }, { keys: k })
        : { id: '', result: 'offline' as const };
      invited[to] = r.result;
      if (r.result !== 'delivered' && r.result !== 'unconfirmed') {
        updateCall(callId, (c) => c && { ...c, members: { ...c.members, [to]: { ...c.members[to], state: 'missed', reason: r.result } } });
      }
    });
    this.settleCall(callId);
    return { callId, invited };
  }
  /** Conference with every member of a group (members auto-join group calls). */
  async groupLiveCall(groupId: string, purpose?: string): Promise<{ callId: string; invited: Record<string, string> }> {
    const g = this.groupOrThrow(groupId);
    const ms = this.activeMembers(g);
    if (!ms.length) return { callId: '', invited: {} }; // nobody else in the group right now
    return this.liveCall(ms.map((m: any) => m.address), { purpose, groupId: g.state.id, keys: Object.fromEntries(ms.map((m: any) => [m.address, { xPub: m.xPub, relays: m.relays }])) });
  }

  private async onLiveCall(rec: InboxRecord, inner: any, trusted: boolean): Promise<void> {
    const b = rec.body || {};
    const id = String(b.callId || '');
    if (!CALL_ID_RE.test(id)) return;
    const from = rec.from;
    const now = C.nowSec();
    const inviter = this.memberOf({ address: from, xPub: inner.fromXPub, relays: inner.fromRelays, name: rec.fromName });
    if (!inviter) return;
    const listed = (Array.isArray(b.members) ? b.members.slice(0, 256) : []).map((e: any) => this.memberOf(e)).filter(Boolean) as CallMember[];
    const cur = getCall(id);
    if (cur?.state === 'ringing') return; // duplicate ring
    if (cur?.state === 'active') {
      // Invited again into a call I am in (someone merged or re-added me): just learn who is there.
      updateCall(id, (c) => c && { ...c, members: { ...c.members, ...Object.fromEntries([inviter, ...listed].filter((m) => c.members[m.address]?.state !== 'joined').map((m) => [m.address, m])) } });
      return;
    }
    const src = typeof b.mergedFrom === 'string' && CALL_ID_RE.test(b.mergedFrom) ? getCall(b.mergedFrom) : null;
    const merged = !!(src && src.state === 'active' && src.members[from]?.state === 'joined');
    const members: Record<string, CallMember> = {};
    for (const m of listed) members[m.address] = m;
    members[from] = inviter;
    const hostAddr = C.normalizeAddress(String(b.host || ''));
    const record: CallRecord = {
      id, host: hostAddr && members[hostAddr] ? hostAddr : from, invitedBy: from, direction: 'in', state: 'ringing', members,
      purpose: typeof b.purpose === 'string' ? b.purpose.slice(0, 500) : undefined,
      groupId: typeof b.groupId === 'string' ? b.groupId : undefined,
      mergedFrom: merged ? b.mergedFrom : undefined,
      createdAt: now, updatedAt: now, expiresAt: Math.min(Number(b.expiresAt) || now + CALL_TTL_SEC, now + CALL_TTL_SEC),
    };
    if (!merged && this.atCallLimit()) {
      updateCall(id, () => ({ ...record, state: 'missed', endedAt: now }));
      await this.send(from, 'call_answer', { callId: id, live: true, accepted: false, busy: true, reason: 'busy: in too many calls right now' }, { keys: this.callKeys(inviter) }).catch(() => {});
      this.emit('call_missed', { callId: id, from, reason: 'busy' });
      return;
    }
    updateCall(id, () => record);
    this.emit('call', { callId: id, from, fromName: rec.fromName, purpose: record.purpose, members: Object.keys(members), merged, groupId: record.groupId });
    if (merged || (trusted && this.cfg.autoAcceptCallsFromContacts)) {
      await this.answerLiveCall(id, true);
      if (merged) updateCall(src!.id, (c) => c && { ...c, state: 'ended', mergedInto: id, endedAt: C.nowSec() });
      this.emit('call_accepted', { callId: id, live: true, auto: true });
    }
  }

  /** Answer an incoming live call: accept, decline (with a reason) or say busy. */
  async answerLiveCall(id: string, accept: boolean, opts: { reason?: string; busy?: boolean } = {}): Promise<{ callId: string; state: string; members: string[] }> {
    const c = getCall(id);
    if (!c || c.direction !== 'in') throw new Error(`No incoming call ${id}.`);
    if (c.state !== 'ringing') throw new Error(`Call ${id} is ${c.state}.`);
    if (c.expiresAt && c.expiresAt < C.nowSec()) {
      updateCall(id, (x) => x && { ...x, state: 'missed', endedAt: C.nowSec() });
      throw new Error('Call invite expired.');
    }
    let busy = !!opts.busy;
    if (accept && this.atCallLimit(id)) { accept = false; busy = true; }
    const to = c.members[c.invitedBy || c.host];
    const r = await this.send(to.address, 'call_answer', {
      callId: id, live: true, accepted: accept, busy: busy || undefined,
      reason: opts.reason ? String(opts.reason).slice(0, 200) : busy ? 'busy' : undefined,
      member: { name: this.identity.profile.name || this.identity.profile.handle },
    }, { keys: this.callKeys(to) });
    if (accept && r.result !== 'delivered' && r.result !== 'unconfirmed') {
      updateCall(id, (x) => x && { ...x, state: 'missed', endedAt: C.nowSec() });
      throw new Error(`The caller is not reachable (${r.result}).`);
    }
    const next = updateCall(id, (x) => x && { ...x, state: accept ? 'active' : 'declined', endedAt: accept ? undefined : C.nowSec() })!;
    return { callId: id, state: next.state, members: this.joinedOf(next).map((m) => m.address) };
  }

  private onLiveCallAnswer(from: string, b: any, inner: any): void {
    const id = String(b?.callId || '');
    const c = CALL_ID_RE.test(id) ? getCall(id) : null;
    if (!c || c.members[from]?.state !== 'ringing') return;
    const accepted = b.accepted === true;
    const state: CallMember['state'] = accepted ? 'joined' : b.busy ? 'busy' : 'declined';
    const entry = this.memberOf({ address: from, xPub: inner.fromXPub, relays: inner.fromRelays, name: b.member?.name }, state)!;
    const others = this.joinedOf(c).filter((m) => m.address !== from);
    updateCall(id, (x) => x && { ...x, members: { ...x.members, [from]: { ...entry, reason: typeof b.reason === 'string' ? b.reason.slice(0, 200) : undefined } } });
    this.settleCall(id);
    this.emit('call_answer', { callId: id, from, state, reason: b.reason });
    if (!accepted) return;
    // I rang them: introduce them to everyone already in the call, and everyone to them.
    const newEntry = this.entryOf(entry);
    void pool(others, 8, (m) => this.send(m.address, 'call_event', { callId: id, kind: 'joined', member: newEntry }, { keys: this.callKeys(m) }).catch(() => null));
    if (others.length) void this.send(from, 'call_event', { callId: id, kind: 'members', members: others.map((m) => this.entryOf(m)) }, { keys: this.callKeys(entry) }).catch(() => null);
  }

  private onCallEvent(from: string, b: any): void {
    const id = String(b?.callId || '');
    const c = getCall(id);
    if (!c) return;
    const kind = String(b.kind || '');
    const now = C.nowSec();
    if (kind === 'joined' || kind === 'members') {
      const list = (kind === 'joined' ? [b.member] : Array.isArray(b.members) ? b.members.slice(0, 256) : []).map((e: any) => this.memberOf(e)).filter(Boolean) as CallMember[];
      updateCall(id, (x) => x && { ...x, members: { ...x.members, ...Object.fromEntries(list.filter((m) => x.members[m.address]?.state !== 'joined').map((m) => [m.address, m])) } });
    } else if (kind === 'left' || kind === 'merged') {
      updateCall(id, (x) => {
        if (!x) return x;
        const members = { ...x.members, [from]: { ...x.members[from], state: 'left' as const } };
        const nobody = !Object.values(members).some((m) => m.state === 'joined');
        const inviterGone = x.direction === 'in' && x.state === 'ringing' && from === (x.invitedBy || x.host);
        const state = inviterGone ? 'missed' : x.state === 'active' && nobody ? 'ended' : x.state;
        return { ...x, members, state, endedAt: state !== x.state ? now : x.endedAt, mergedInto: kind === 'merged' && typeof b.into === 'string' ? b.into : x.mergedInto };
      });
      this.settleCall(id);
    } else if (kind === 'ended' && from === c.host) {
      updateCall(id, (x) => x && { ...x, state: x.state === 'ringing' ? 'missed' : 'ended', endedAt: now });
    } else return;
    this.emit('call_event', { callId: id, from, kind });
  }

  /** Say something to everyone in a live call (E2EE per member, in parallel). */
  async callSend(id: string, text: string): Promise<{ callId: string; msgId: string; results: Record<string, string>; delivered: number; total: number }> {
    const c = this.liveCallOrThrow(id);
    const ms = this.joinedOf(c);
    if (!ms.length) throw new Error('No one else is in this call right now.');
    const msgId = C.newId();
    const results: Record<string, string> = {};
    await pool(ms, 8, async (m) => {
      const r = await this.send(m.address, 'call_msg', { callId: id, text: String(text).slice(0, 16_000), msgId }, { keys: this.callKeys(m) });
      results[m.address] = r.result;
    });
    return { callId: id, msgId, results, delivered: Object.values(results).filter((r) => r === 'delivered').length, total: ms.length };
  }
  /** Share a file with everyone in a live call (verified transfer per member). */
  async callFile(id: string, filePath: string): Promise<{ callId: string; results: FileOutcome[] }> {
    const c = this.liveCallOrThrow(id);
    const ms = this.joinedOf(c);
    if (!ms.length) throw new Error('No one else is in this call right now.');
    const offer = makeOffer(filePath, undefined, id);
    const results = await pool(ms, 3, (m) => this.sendFile(m.address, filePath, { keys: this.callKeys(m), offer })
      .catch((e) => ({ to: m.address, fileId: '', name: offer.name, size: offer.size, sha256: offer.sha256, result: 'failed', reason: e?.message } as FileOutcome)));
    return { callId: id, results };
  }
  /** Leave a call (end=true: the host ends it for everyone). Declines if it is still ringing here. */
  async hangup(id: string, opts: { end?: boolean } = {}): Promise<{ callId: string; state: string; told: number }> {
    const c = getCall(id);
    if (!c) throw new Error(`Unknown call ${id}.`);
    if (c.direction === 'in' && c.state === 'ringing') {
      const r = await this.answerLiveCall(id, false, { reason: 'declined' });
      return { callId: id, state: r.state, told: 1 };
    }
    if (c.state !== 'active' && c.state !== 'ringing') return { callId: id, state: c.state, told: 0 };
    const kind = opts.end && c.host === this.identity.address ? 'ended' : 'left';
    const ms = Object.values(c.members).filter((m) => m.state === 'joined' || m.state === 'ringing');
    await pool(ms, 8, (m) => this.send(m.address, 'call_event', { callId: id, kind }, { keys: this.callKeys(m) }).catch(() => null));
    updateCall(id, (x) => x && { ...x, state: 'ended', endedAt: C.nowSec() });
    return { callId: id, state: 'ended', told: ms.length };
  }
  /**
   * Merge live calls: everyone from the other calls is rung into the first one (they join
   * automatically) and the other calls end. With groupId/newGroup: add everyone to a group instead.
   */
  async mergeCalls(ids: string[], opts: { groupId?: string; newGroup?: string } = {}): Promise<any> {
    const calls = ids.map((id) => this.liveCallOrThrow(id));
    if (opts.groupId || opts.newGroup) {
      const addrs = [...new Set(calls.flatMap((c) => this.joinedOf(c).map((m) => m.address)))];
      if (!addrs.length) throw new Error('No one to add.');
      if (opts.groupId) {
        const g = this.groupOrThrow(opts.groupId);
        const fresh = addrs.filter((a) => !isMember(g.state, a));
        const r = fresh.length ? await this.groupAdd(g.state.id, fresh) : { delivery: {} };
        return { groupId: g.state.id, added: fresh, delivery: r.delivery };
      }
      const r = await this.groupCreate(String(opts.newGroup).slice(0, 64), addrs);
      return { groupId: r.group.id, added: addrs, delivery: r.delivery };
    }
    if (calls.length < 2) throw new Error('Give at least two live calls to merge.');
    const [target, ...rest] = calls;
    const invited: Record<string, string> = {};
    for (const src of rest) {
      const inTarget = getCall(target.id)!.members;
      const need = this.joinedOf(src).filter((m) => inTarget[m.address]?.state !== 'joined');
      if (need.length) {
        const r = await this.liveCall(need.map((m) => m.address), {
          callId: target.id, mergedFrom: src.id,
          keys: Object.fromEntries(need.filter((m) => m.xPub).map((m) => [m.address, this.callKeys(m)!])),
        });
        Object.assign(invited, r.invited);
      }
      await pool(this.joinedOf(src), 8, (m) => this.send(m.address, 'call_event', { callId: src.id, kind: 'merged', into: target.id }, { keys: this.callKeys(m) }).catch(() => null));
      updateCall(src.id, (x) => x && { ...x, state: 'ended', mergedInto: target.id, endedAt: C.nowSec() });
    }
    return { callId: target.id, merged: rest.map((c) => c.id), invited };
  }
  callHistory(id: string, limit = 50): ReturnType<typeof callHistory> {
    return callHistory(id, limit);
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
    const started = await s.call('/session/start', 'POST', { sessionName: 'peerknock-call', roomSecret });
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

/** Read a knock answer from any client version: status, the answer's own reason, retry hint, who answered. */
export function readAnswer(b: any, from: string): Omit<KnockOutcome, 'knockId' | 'to' | 'delivery'> {
  const accepted = b?.accepted === true || b?.status === 'accepted';
  const status: KnockStatus = accepted ? 'accepted' : b?.status === 'busy' ? 'busy' : 'rejected';
  const reason = typeof b?.reason === 'string' ? b.reason.slice(0, 500) : typeof b?.note === 'string' ? b.note.slice(0, 500) : undefined;
  const n = Number(b?.retryAfterSec);
  const retryAfterSec = status === 'busy' && Number.isFinite(n) && n > 0 ? Math.min(30 * 86400, Math.round(n)) : undefined;
  const card = b?.card && verifyCard(b.card).ok && b.card.address === from ? b.card : null;
  const f = b?.from && typeof b.from === 'object' ? b.from : {};
  const intro: AgentIntro | undefined = card || f.oneLine ? {
    address: from,
    tag: card ? handleTag(card) : typeof f.tag === 'string' ? f.tag.slice(0, 64) : from,
    name: (card?.name || (typeof f.name === 'string' ? f.name : undefined))?.slice(0, 64),
    oneLine: typeof f.oneLine === 'string' ? f.oneLine.slice(0, 160) : undefined,
    skills: card?.skills?.length ? card.skills.slice(0, 16) : undefined,
  } : undefined;
  return { status, accepted, reason, note: reason, retryAfterSec, retryAt: retryAfterSec ? C.nowSec() + retryAfterSec : undefined, from: intro };
}

/** Messages and files of one live call, oldest first (local history only). */
export function callHistory(id: string, limit = 50): Array<{ ts: number; from: string; mine: boolean; type: string; text: string; result?: string }> {
  const inbound = readInbox().filter((r) => (r.type === 'call_msg' && (r as any).call?.id === id) || (r.type === 'file' && r.body?.callId === id));
  const seen = new Set<string>();
  const outbound = readSent().filter((r) => r.type === 'call_msg' && r.body?.callId === id && !seen.has(r.body?.msgId) && seen.add(r.body?.msgId));
  return [
    ...inbound.map((r) => ({ ts: r.ts, from: r.fromName || r.from, mine: false, type: r.type, text: r.type === 'file' ? `📎 ${r.body?.name} (${r.body?.size} bytes) → ${r.body?.path}` : r.body?.text ?? '' })),
    ...outbound.map((r) => ({ ts: r.ts, from: 'me', mine: true, type: r.type, text: r.body?.text ?? '', result: r.result })),
  ].sort((a, b) => a.ts - b.ts).slice(-limit);
}
