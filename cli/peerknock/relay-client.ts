/**
 * SRIFT Peerknock — relay client.
 *
 * Outbound only. Tries WebSocket (wss://<relay>/an); if that is blocked or
 * fails, falls back to signed HTTPS long-polling (/api/pk/poll). Honors
 * HTTPS_PROXY / NO_PROXY through cli/net.ts. Receiving clients reconnect
 * automatically with backoff.
 *
 * Events:
 *   'deliver'   (env)                      — sealed envelope for us
 *   'presence'  ({address, state})         — watched address changed state
 *   'connected' ({transport})              — authenticated
 *   'disconnected' ()
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { agentFor, requestJson, USER_AGENT } from '../net.ts';
import * as C from '../../lib/peerknock/crypto.mjs';
import type { Identity } from './local.ts';
import { guardedLookup } from './netpolicy.ts';

export type SendResult = { id: string; result: 'delivered' | 'offline' | 'unconfirmed' | 'rate_limited' | 'invalid' | 'error'; error?: string; relay?: string };
export type Acl = { mode: string; allow: string[]; block: string[] };
export type RelayClientOpts = {
  recv: boolean; acl?: Acl; forcePoll?: boolean; connectTimeoutMs?: number;
  /** Helper connection: receives deliveries (replies to our requests) without making the agent "online". */
  listen?: boolean;
  /** Signed card + optional beacon registered while this receiving connection is up (RAM only at the relay). */
  card?: any; beacon?: any;
};
/** Bare-handle state: one live holder per @name across the relay (the ~suffix tag is always yours). */
export type HandleStatus = { name: string; held: boolean; holder?: string };

export type LiveResult = {
  address: string; tag: string; online: true; since: number; status: string; oneLine: string;
  card: any; beacon: any; relay: string; score: number | null;
};

/** Client heartbeat; well under Cloudflare's ~100 s and nginx's 60 s idle timeouts. */
const PING_MS = 25_000;
/** A connection that stayed up this long was healthy: the reconnect backoff starts over. */
const STABLE_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
/** Long-poll fallback: retry the WebSocket after 5 min, backing off to 30 min while it stays blocked. */
const UPGRADE_MIN_MS = 5 * 60_000;
const UPGRADE_MAX_MS = 30 * 60_000;
/** A replaced socket closes once its own replies are in, at most this long (the relay waits 60 s). */
const RETIRE_MAX_MS = 25_000;
const MAX_SEEKS = 20;
/** 50–100 % of `ms`, so agents dropped together (relay restart) do not reconnect in lockstep. */
const jitter = (ms: number) => Math.round(ms * (0.5 + Math.random() * 0.5));

export class RelayClient extends EventEmitter {
  readonly base: string;
  private id: Identity | null;
  private opts: RelayClientOpts;
  private ws: WebSocket | null = null;
  transport: 'ws' | 'poll' | null = null;
  private rid = 0;
  private waiting = new Map<number, (m: any) => void>();
  private cid = C.randomToken(9);
  private closed = false;
  private pollAbort: AbortController | null = null;
  private watched = new Set<string>();
  private reconnectDelay = 1000;
  /** At most one pending reconnect: every failed attempt used to add one, so an outage doubled them each round. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedAt = 0;
  private refreshing = false;
  /** On the long-poll fallback: when to try the WebSocket again (one failed handshake must not pin us to polling). */
  private upgradeTimer: ReturnType<typeof setTimeout> | null = null;
  private upgradeDelay = UPGRADE_MIN_MS;
  /** Only the newest long-poll loop runs: two loops on one cid answer each other's polls in a tight loop. */
  private pollGen = 0;
  /** Requests awaiting a reply, per socket (a replaced socket stays open until its own replies arrive). */
  private inFlight = new WeakMap<WebSocket, Set<number>>();
  /** Standing seeks by the id first returned; relay seeks belong to one connection, so they are re-registered. */
  private seeks = new Map<string, { q: string; known: Set<string> }>();
  private seekAlias = new Map<string, string>();
  private connecting: Promise<void> | null = null;
  /** Relay host this client signs for (signatures are bound to it, so they cannot be replayed elsewhere). */
  readonly host: string;
  /** Seconds to add to the local clock, learned from the relay (fixes skewed machines). */
  private clockOffset = 0;

  constructor(base: string, identity: Identity | null, opts: RelayClientOpts) {
    super();
    this.base = base.replace(/\/$/, '');
    this.host = new URL(this.base).host.toLowerCase();
    this.id = identity;
    this.opts = opts;
    this.lookup = guardedLookup(this.base);
  }
  /** Connect-time address check for learned relays (DNS rebinding); undefined = unrestricted. */
  private lookup: ReturnType<typeof guardedLookup>;
  private get receives(): boolean {
    return this.opts.recv || !!this.opts.listen;
  }
  private learnTime(serverTs: unknown): void {
    const t = Number(serverTs);
    if (Number.isFinite(t) && t > 1_600_000_000) {
      const off = t - C.nowSec();
      this.clockOffset = Math.abs(off) > 5 ? off : 0;
    }
  }

  /** Identity required for authenticated operations (connect, send, announce …). */
  private me(): Identity {
    if (!this.id) throw new Error('No Peerknock identity on this machine yet: run `srift pk id` first.');
    return this.id;
  }

  get connected(): boolean {
    return this.transport === 'ws' ? this.ws?.readyState === WebSocket.OPEN : this.transport === 'poll';
  }

  connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    if (!this.opts.forcePoll && process.env.SRIFT_PK_TRANSPORT !== 'poll') {
      try {
        await this.connectWs();
        return;
      } catch (e: any) {
        if (process.env.SRIFT_PK_DEBUG) console.error(`[peerknock] WebSocket to ${this.base} failed (${e?.message}); using HTTPS long-poll.`);
      }
    }
    try {
      await this.connectPoll();
    } catch (e) {
      // A receiving client never gives up on a relay: keep retrying in the background.
      this.transport = null;
      this.scheduleReconnect();
      throw e;
    }
    this.connectedAt = Date.now();
  }

  // ─── WebSocket ─────────────────────────────────────────────────
  private connectWs(): Promise<void> {
    const url = this.base.replace(/^http/, 'ws') + '/pk';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { agent: agentFor(url), handshakeTimeout: this.opts.connectTimeoutMs ?? 10_000, headers: { 'User-Agent': USER_AGENT }, ...(this.lookup ? { lookup: this.lookup } : {}) });
      let authed = false;
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('auth timeout')); }, (this.opts.connectTimeoutMs ?? 10_000) + 2000);
      ws.on('message', (raw) => {
        let m: any;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === 'hello') {
          this.learnTime(m.time);
          const ts = C.nowSec() + this.clockOffset;
          const acl = this.opts.recv ? this.opts.acl : undefined;
          ws.send(JSON.stringify({
            type: 'auth',
            address: this.me().address,
            edPub: this.me().edPub,
            ts,
            host: this.host,
            sig: C.sign(this.me().edPriv, C.authPayload(m.nonce, this.me().address, ts, this.host, this.opts.recv, C.aclHash(acl))),
            recv: this.opts.recv,
            listen: this.opts.listen === true && !this.opts.recv ? true : undefined,
            acl,
            card: this.opts.recv ? this.opts.card : undefined,
            beacon: this.opts.recv ? this.opts.beacon : undefined,
          }));
          return;
        }
        if (m.type === 'auth_ok') {
          authed = true;
          clearTimeout(timer);
          // close() ran while this socket was authenticating (refresh / upgrade): never resurrect the client.
          if (this.closed) { try { ws.close(1000); } catch { /* gone */ } reject(new Error('client closed')); return; }
          // A new socket replaces the previous one (refresh): the old closes once its own replies are in.
          const prev = this.ws;
          if (prev && prev !== ws) this.retire(prev);
          this.ws = ws;
          this.transport = 'ws';
          this.pollGen++; // ends a long-poll loop (upgrade from the fallback)
          this.cancelReconnect();
          this.connectedAt = Date.now();
          this.keepAlive(ws);
          if (this.watched.size) this.wsRequest({ type: 'watch', addresses: [...this.watched] }).catch(() => {});
          this.resubscribeSeeks();
          this.emit('connected', { transport: 'ws' });
          if (m.handle) this.emit('handle', m.handle);
          resolve();
          return;
        }
        if (m.type === 'auth_error') { clearTimeout(timer); try { ws.terminate(); } catch { /* gone */ } reject(new Error(m.error || 'auth failed')); return; }
        if (m.type === 'reconnect') { if (this.ws === ws) void this.refresh(); return; }
        this.onFrame(m);
      });
      ws.on('error', (e) => { if (!authed) { clearTimeout(timer); reject(e); } });
      ws.on('unexpected-response', (req, res) => { clearTimeout(timer); res.resume(); try { req.destroy(); } catch { /* gone */ } reject(new Error(`HTTP ${res.statusCode}`)); });
      ws.on('close', () => {
        clearTimeout(timer);
        if (!authed) { reject(new Error('closed before auth')); return; }
        // Only the requests sent on THIS socket fail; a replaced socket closing never reconnects.
        this.failRequests(ws);
        if (this.ws !== ws) return;
        this.ws = null; this.transport = null;
        this.emit('disconnected');
        this.scheduleReconnect();
      });
    });
  }

  /**
   * Client heartbeat. Pings keep idle-timeout middleboxes from cutting the socket, and a socket that hears
   * nothing for three intervals (half-open: the relay instance vanished) is terminated so the normal
   * reconnect runs instead of waiting for TCP to notice.
   */
  private keepAlive(ws: WebSocket): void {
    let heard = Date.now();
    const alive = () => { heard = Date.now(); };
    ws.on('pong', alive);
    ws.on('ping', alive);
    ws.on('message', alive);
    const t = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) { clearInterval(t); return; }
      if (Date.now() - heard > PING_MS * 3) { ws.terminate(); return; }
      try { ws.ping(); } catch { /* closing */ }
    }, PING_MS);
    t.unref?.();
    ws.once('close', () => clearInterval(t));
  }

  /**
   * The relay asked us to move (it is shutting down, or this socket reached its maximum age): the new
   * connection is opened before the old one closes, so the agent never shows as offline in between.
   * If it fails, the old socket stays in use until the relay closes it and the normal reconnect runs.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing || this.closed || this.transport !== 'ws') return;
    this.refreshing = true;
    try { await this.connectWs(); } catch { /* keep the current socket */ } finally { this.refreshing = false; }
  }

  private ridsOf(ws: WebSocket): Set<number> {
    let s = this.inFlight.get(ws);
    if (!s) { s = new Set(); this.inFlight.set(ws, s); }
    return s;
  }
  private failRequests(ws: WebSocket): void {
    const own = this.ridsOf(ws);
    for (const rid of own) { const cb = this.waiting.get(rid); this.waiting.delete(rid); cb?.({ type: 'error', error: 'connection closed' }); }
    own.clear();
  }
  /** Close a replaced socket once the replies to requests sent on it have arrived (send results can take ~10 s). */
  private retire(ws: WebSocket): void {
    const own = this.ridsOf(ws);
    const since = Date.now();
    const t = setInterval(() => {
      if (own.size && Date.now() - since < RETIRE_MAX_MS && ws.readyState === WebSocket.OPEN) return;
      clearInterval(t);
      try { ws.close(1000, 'replaced'); } catch { /* gone */ }
    }, 250);
    t.unref?.();
  }

  /** Re-register standing seeks on a new connection; matches that came online meanwhile are reported once. */
  private resubscribeSeeks(): void {
    for (const [orig, s] of this.seeks) {
      const done = (m: any) => {
        if (!m?.seekId) return;
        for (const [alias, o] of this.seekAlias) if (o === orig) this.seekAlias.delete(alias);
        if (m.seekId !== orig) this.seekAlias.set(m.seekId, orig);
        for (const result of m.results || []) this.onEvent({ type: 'discovery', seekId: m.seekId, result });
      };
      if (this.transport === 'ws') this.wsRequest({ type: 'seek', q: s.q, watch: true, federated: false }, 20_000).then(done, () => {});
      else this.http('POST', '/api/pk/seek', { cid: this.cid, q: s.q, watch: true }).then((r) => done(r.data), () => {});
    }
  }

  private onFrame(m: any): void {
    if (m.rid !== undefined && this.waiting.has(m.rid)) {
      const cb = this.waiting.get(m.rid)!;
      this.waiting.delete(m.rid);
      cb(m);
      return;
    }
    this.onEvent(m);
  }

  private onEvent(m: any): void {
    if (m.type === 'deliver' && m.env) this.emit('deliver', m.env);
    else if (m.type === 'presence_event') this.emit('presence', { address: m.address, state: m.state });
    else if (m.type === 'discovery' && m.result) {
      const seekId = this.seekAlias.get(m.seekId) ?? m.seekId;
      const known = this.seeks.get(seekId)?.known;
      if (known && typeof m.result.address === 'string') {
        if (known.has(m.result.address)) return;
        known.add(m.result.address);
      }
      this.emit('discovery', { seekId, result: m.result, relay: this.base });
    }
    else if (m.type === 'handle_status' && m.handle) this.emit('handle', m.handle);
  }

  private wsRequest(frame: any, timeoutMs = 15_000): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const rid = ++this.rid;
    const own = this.ridsOf(ws);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(rid); own.delete(rid); reject(new Error('relay timeout')); }, timeoutMs);
      this.waiting.set(rid, (m) => { clearTimeout(t); own.delete(rid); resolve(m); });
      own.add(rid);
      ws.send(JSON.stringify({ ...frame, rid }));
    });
  }

  // ─── HTTP long-poll ─────────────────────────────────────────────
  private async http(method: string, pathQ: string, body?: any, timeoutMs = 20_000): Promise<{ status: number; data: any }> {
    // Anonymous lookups are allowed (public live search / live cards) when no identity exists yet.
    const headers = this.id ? (C.signHttp(this.id, method, pathQ, body, this.host, this.clockOffset) as Record<string, string>) : {};
    // Never follow redirects (a hostile relay could bounce signed POSTs to local services) and cap body size.
    const r = await requestJson(this.base + pathQ, { method, headers, json: body, timeoutMs, signal: this.pollAbort?.signal, maxRedirects: 0, maxBytes: 4 * 1024 * 1024, lookup: this.lookup });
    const date = Date.parse(String(r.headers?.date || ''));
    if (Number.isFinite(date) && r.status === 401) this.learnTime(Math.floor(date / 1000));
    return r;
  }
  private pollQuery(wait: number): string {
    return `/api/pk/poll?cid=${this.cid}&wait=${wait}${this.opts.listen && !this.opts.recv ? '&listen=1' : ''}`;
  }
  /** (Re)register everything the relay keeps for a receiving poll client. */
  private async syncPollState(): Promise<void> {
    if (this.opts.recv && this.opts.acl) await this.http('POST', '/api/pk/acl', { acl: this.opts.acl });
    if (this.opts.recv && this.opts.card) await this.http('POST', '/api/pk/announce', { cid: this.cid, card: this.opts.card, beacon: this.opts.beacon ?? null });
    if (this.watched.size) await this.http('POST', '/api/pk/watch', { cid: this.cid, addresses: [...this.watched] });
    this.resubscribeSeeks();
  }

  private async connectPoll(): Promise<void> {
    this.pollAbort?.abort(); // an older loop's held poll ends now
    this.pollAbort = new AbortController();
    const info = await this.http('GET', '/api/pk');
    if (info.status !== 200) throw new Error(`relay HTTP ${info.status}`);
    this.learnTime(info.data?.time);
    if (this.receives) {
      // First poll registers presence (or the helper listener) and proves reachability.
      const r = await this.http('GET', this.pollQuery(0));
      if (r.status !== 200) throw new Error(`poll HTTP ${r.status}: ${r.data?.error || ''}`);
      await this.syncPollState();
      for (const ev of r.data?.events || []) this.onEvent(ev);
      this.transport = 'poll';
      this.cancelReconnect();
      this.emit('connected', { transport: 'poll' });
      void this.pollLoop(++this.pollGen);
      this.scheduleUpgrade();
    } else {
      this.transport = 'poll';
      this.emit('connected', { transport: 'poll' });
    }
  }

  private async pollLoop(gen: number): Promise<void> {
    let backoff = 1000;
    const current = () => !this.closed && this.transport === 'poll' && gen === this.pollGen;
    while (current()) {
      try {
        const r = await this.http('GET', this.pollQuery(25), undefined, 40_000);
        if (r.status !== 200) throw new Error(`poll HTTP ${r.status}`);
        backoff = 1000;
        // The relay restarted or dropped us after a long gap: re-register card, beacon, ACL and watches.
        if (r.data?.reset && current()) { await this.syncPollState(); this.emit('connected', { transport: 'poll', resync: true }); }
        // Events already fetched are handled even by a superseded loop (deliveries wait for our ack).
        for (const ev of r.data?.events || []) this.onEvent(ev);
      } catch (e: any) {
        if (!current()) return;
        if (process.env.SRIFT_PK_DEBUG) console.error(`[peerknock] poll error: ${e?.message}`);
        await new Promise((r) => setTimeout(r, jitter(backoff)));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /**
   * Back from the long-poll fallback to the WebSocket once it works again. The socket authenticates first,
   * then the poll registration is dropped, so the agent stays online throughout; the poll loop then ends.
   */
  private scheduleUpgrade(): void {
    if (this.closed || !this.receives || this.upgradeTimer || this.opts.forcePoll || process.env.SRIFT_PK_TRANSPORT === 'poll') return;
    this.upgradeTimer = setTimeout(async () => {
      this.upgradeTimer = null;
      if (this.closed || this.transport !== 'poll') return;
      try {
        await this.connectWs();
      } catch {
        this.upgradeDelay = Math.min(this.upgradeDelay * 2, UPGRADE_MAX_MS);
        this.scheduleUpgrade();
        return;
      }
      this.upgradeDelay = UPGRADE_MIN_MS;
      await this.leavePoll();
    }, jitter(this.upgradeDelay));
    this.upgradeTimer.unref?.();
  }

  /** Drop this client's long-poll registration at the relay now (not after its grace period). */
  private leavePoll(): Promise<unknown> {
    return requestJson(this.base + '/api/pk/leave', {
      method: 'POST',
      headers: C.signHttp(this.me(), 'POST', '/api/pk/leave', { cid: this.cid }, this.host, this.clockOffset) as Record<string, string>,
      json: { cid: this.cid },
      timeoutMs: 5000,
      maxRedirects: 0,
      lookup: this.lookup,
    }).catch(() => {});
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.receives || this.reconnectTimer) return;
    // Start over only after a connection that proved healthy; a relay that accepts and then drops us
    // keeps the delay growing instead of being redialled every second.
    if (this.connectedAt && Date.now() - this.connectedAt >= STABLE_MS) this.reconnectDelay = 1000;
    this.connectedAt = 0;
    const d = jitter(this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Something else (send, watch, an upgrade) may have connected meanwhile: a second connect would
      // start a second poll loop or socket.
      if (this.closed || this.connected) return;
      this.connect().catch(() => this.scheduleReconnect());
    }, d);
    this.reconnectTimer.unref?.();
  }
  private cancelReconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  // ─── API ────────────────────────────────────────────────────────
  async send(env: any): Promise<SendResult> {
    if (!this.connected) await this.connect();
    if (this.transport === 'ws') {
      const m = await this.wsRequest({ type: 'send', env }, 20_000);
      if (m.type === 'error') return { id: env.id, result: 'error', error: m.error, relay: this.base };
      return { id: env.id, result: m.result, error: m.error, relay: this.base };
    }
    const r = await this.http('POST', '/api/pk/send', { env }, 25_000);
    return { id: env.id, result: r.data?.result || 'error', error: r.data?.error, relay: this.base };
  }

  async ack(ids: string[]): Promise<void> {
    if (this.transport === 'ws' && this.ws) {
      this.ws.send(JSON.stringify({ type: 'ack', ids }));
      return;
    }
    await this.http('POST', '/api/pk/ack', { ids });
  }

  async presence(address: string): Promise<string> {
    if (!this.connected) await this.connect();
    if (this.transport === 'ws') return (await this.wsRequest({ type: 'presence_query', address })).state;
    const r = await this.http('GET', `/api/pk/presence?addr=${encodeURIComponent(address)}`);
    return r.data?.state || 'error';
  }

  async watch(addresses: string[]): Promise<Record<string, string>> {
    for (const a of addresses) this.watched.add(a);
    if (!this.connected) await this.connect();
    if (this.transport === 'ws') return (await this.wsRequest({ type: 'watch', addresses })).states || {};
    const r = await this.http('POST', '/api/pk/watch', { cid: this.cid, addresses });
    return r.data?.states || {};
  }

  async unwatch(addresses: string[]): Promise<void> {
    for (const a of addresses) this.watched.delete(a);
    if (this.transport === 'ws') await this.wsRequest({ type: 'unwatch', addresses }).catch(() => {});
    else if (this.transport === 'poll') await this.http('POST', '/api/pk/watch', { cid: this.cid, unwatch: addresses }).catch(() => {});
  }

  async setAcl(acl: Acl): Promise<void> {
    this.opts.acl = acl;
    if (this.transport === 'ws') await this.wsRequest({ type: 'presence_acl', acl });
    else if (this.transport === 'poll') await this.http('POST', '/api/pk/acl', { acl });
  }

  /** Update the live card/beacon (RAM at the relay; gone when this connection closes). */
  async announce(card: any, beacon: any): Promise<{ searchable: boolean; handle?: HandleStatus }> {
    this.opts.card = card;
    this.opts.beacon = beacon;
    if (!this.connected) await this.connect();
    if (this.transport === 'ws') {
      const m = await this.wsRequest({ type: 'announce', card, beacon: beacon ?? null });
      if (m.type === 'error') throw new Error(m.error);
      return { searchable: !!m.searchable, handle: m.handle };
    }
    const r = await this.http('POST', '/api/pk/announce', { cid: this.cid, card, beacon: beacon ?? null });
    if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
    return { searchable: !!r.data?.searchable, handle: r.data?.handle };
  }

  /** Live search + optional standing watch ("tell me when a match comes online"). */
  async seek(q: string, watchIt = true): Promise<{ seekId: string | null; results: LiveResult[] }> {
    if (!this.connected) await this.connect();
    if (this.transport === 'ws') {
      const m = await this.wsRequest({ type: 'seek', q, watch: watchIt }, 20_000);
      if (m.type === 'error') throw new Error(m.error);
      this.rememberSeek(m.seekId, q, m.results || []);
      return { seekId: m.seekId, results: m.results || [] };
    }
    const r = await this.http('POST', '/api/pk/seek', { cid: this.cid, q, watch: watchIt }, 20_000);
    if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
    this.rememberSeek(r.data.seekId, q, r.data.results || []);
    return { seekId: r.data.seekId, results: r.data.results || [] };
  }
  private rememberSeek(seekId: string | null, q: string, results: LiveResult[]): void {
    if (!seekId) return;
    if (this.seeks.size >= MAX_SEEKS) this.seeks.delete(this.seeks.keys().next().value!);
    this.seeks.set(seekId, { q, known: new Set(results.map((r) => r.address)) });
  }

  /** Card of an ONLINE agent (this relay or its peers). null if offline/hidden. */
  async liveCard(address: string): Promise<{ card: any; beacon?: any; relay?: string } | null> {
    if (this.transport === 'ws') {
      const m = await this.wsRequest({ type: 'live_card', address }).catch(() => null);
      return m?.card ? { card: m.card, beacon: m.beacon, relay: m.relay } : null;
    }
    const pathQ = `/api/pk/live/card/${encodeURIComponent(address)}?hops=1`;
    const r = await this.http('GET', pathQ).catch(() => null);
    return r?.status === 200 && r.data?.card ? r.data : null;
  }

  /** Live search over HTTP (signed so the relay can apply presence ACLs). */
  async liveSearch(params: { q?: string; handle?: string; owner?: string; limit?: number; hops?: number }): Promise<LiveResult[]> {
    const qs = new URLSearchParams();
    for (const k of ['q', 'handle', 'owner'] as const) if (params[k]) qs.set(k, params[k]!);
    qs.set('limit', String(params.limit ?? 20));
    qs.set('hops', String(params.hops ?? 1));
    const r = await this.http('GET', `/api/pk/live/search?${qs}`, undefined, 15_000);
    if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
    return r.data?.results || [];
  }

  /** Signed relay API call. */
  async api(method: string, pathQ: string, body?: any): Promise<{ status: number; data: any }> {
    const headers = C.signHttp(this.me(), method, pathQ, body, this.host, this.clockOffset) as Record<string, string>;
    return requestJson(this.base + pathQ, { method, headers, json: body, timeoutMs: 20_000, maxRedirects: 0, maxBytes: 4 * 1024 * 1024, lookup: this.lookup });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelReconnect();
    if (this.upgradeTimer) { clearTimeout(this.upgradeTimer); this.upgradeTimer = null; }
    this.pollGen++;
    const wasPoll = this.transport === 'poll' && this.receives;
    this.pollAbort?.abort();
    this.pollAbort = null;
    if (this.ws) { try { this.ws.close(); } catch { /* gone */ } this.ws = null; }
    this.transport = null;
    if (wasPoll) await this.leavePoll();
  }
}

/** Unsigned public directory GET. */
export async function publicGet(base: string, pathQ: string): Promise<{ status: number; data: any }> {
  return requestJson(base.replace(/\/$/, '') + pathQ, { timeoutMs: 15_000, maxRedirects: 0, maxBytes: 4 * 1024 * 1024, lookup: guardedLookup(base) });
}
