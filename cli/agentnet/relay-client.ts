/**
 * SRIFT AgentNet — relay client.
 *
 * Outbound only. Tries WebSocket (wss://<relay>/an); if that is blocked or
 * fails, falls back to signed HTTPS long-polling (/api/an/poll). Honors
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
import { agentFor, requestJson } from '../net.ts';
import * as C from '../../lib/agentnet/crypto.mjs';
import type { Identity } from './local.ts';

export type SendResult = { id: string; result: 'delivered' | 'offline' | 'unconfirmed' | 'rate_limited' | 'invalid' | 'error'; error?: string; relay?: string };
export type Acl = { mode: string; allow: string[]; block: string[] };
export type RelayClientOpts = {
  recv: boolean; acl?: Acl; forcePoll?: boolean; connectTimeoutMs?: number;
  /** Helper connection: receives deliveries (replies to our requests) without making the agent "online". */
  listen?: boolean;
  /** Signed card + optional beacon registered while this receiving connection is up (RAM only at the relay). */
  card?: any; beacon?: any;
};
export type LiveResult = {
  address: string; tag: string; online: true; since: number; status: string; oneLine: string;
  card: any; beacon: any; relay: string; score: number | null;
};

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
  }
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
    if (!this.id) throw new Error('No AgentNet identity on this machine yet: run `srift an id` first.');
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
    if (!this.opts.forcePoll && process.env.SRIFT_AN_TRANSPORT !== 'poll') {
      try {
        await this.connectWs();
        this.reconnectDelay = 1000;
        return;
      } catch (e: any) {
        if (process.env.SRIFT_AN_DEBUG) console.error(`[agentnet] WebSocket to ${this.base} failed (${e?.message}); using HTTPS long-poll.`);
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
    this.reconnectDelay = 1000;
  }

  // ─── WebSocket ─────────────────────────────────────────────────
  private connectWs(): Promise<void> {
    const url = this.base.replace(/^http/, 'ws') + '/an';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { agent: agentFor(url), handshakeTimeout: this.opts.connectTimeoutMs ?? 10_000 });
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
          this.ws = ws;
          this.transport = 'ws';
          if (this.watched.size) this.wsRequest({ type: 'watch', addresses: [...this.watched] }).catch(() => {});
          this.emit('connected', { transport: 'ws' });
          resolve();
          return;
        }
        if (m.type === 'auth_error') { clearTimeout(timer); reject(new Error(m.error || 'auth failed')); return; }
        this.onFrame(m);
      });
      ws.on('error', (e) => { if (!authed) { clearTimeout(timer); reject(e); } });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); reject(new Error(`HTTP ${res.statusCode}`)); });
      ws.on('close', () => {
        clearTimeout(timer);
        if (!authed) { reject(new Error('closed before auth')); return; }
        // A replaced socket closing must not fail the current one's requests or reconnect.
        if (this.ws !== ws) return;
        this.ws = null; this.transport = null;
        for (const [, cb] of this.waiting) cb({ type: 'error', error: 'connection closed' });
        this.waiting.clear();
        this.emit('disconnected');
        this.scheduleReconnect();
      });
    });
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
    else if (m.type === 'discovery' && m.result) this.emit('discovery', { seekId: m.seekId, result: m.result, relay: this.base });
  }

  private wsRequest(frame: any, timeoutMs = 15_000): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(rid); reject(new Error('relay timeout')); }, timeoutMs);
      this.waiting.set(rid, (m) => { clearTimeout(t); resolve(m); });
      ws.send(JSON.stringify({ ...frame, rid }));
    });
  }

  // ─── HTTP long-poll ─────────────────────────────────────────────
  private async http(method: string, pathQ: string, body?: any, timeoutMs = 20_000): Promise<{ status: number; data: any }> {
    // Anonymous lookups are allowed (public live search / live cards) when no identity exists yet.
    const headers = this.id ? (C.signHttp(this.id, method, pathQ, body, this.host, this.clockOffset) as Record<string, string>) : {};
    // Never follow redirects (a hostile relay could bounce signed POSTs to local services) and cap body size.
    const r = await requestJson(this.base + pathQ, { method, headers, json: body, timeoutMs, signal: this.pollAbort?.signal, maxRedirects: 0, maxBytes: 4 * 1024 * 1024 });
    const date = Date.parse(String(r.headers?.date || ''));
    if (Number.isFinite(date) && r.status === 401) this.learnTime(Math.floor(date / 1000));
    return r;
  }
  private pollQuery(wait: number): string {
    return `/api/an/poll?cid=${this.cid}&wait=${wait}${this.opts.listen && !this.opts.recv ? '&listen=1' : ''}`;
  }
  /** (Re)register everything the relay keeps for a receiving poll client. */
  private async syncPollState(): Promise<void> {
    if (this.opts.recv && this.opts.acl) await this.http('POST', '/api/an/acl', { acl: this.opts.acl });
    if (this.opts.recv && this.opts.card) await this.http('POST', '/api/an/announce', { cid: this.cid, card: this.opts.card, beacon: this.opts.beacon ?? null });
    if (this.watched.size) await this.http('POST', '/api/an/watch', { cid: this.cid, addresses: [...this.watched] });
  }

  private async connectPoll(): Promise<void> {
    this.pollAbort = new AbortController();
    const info = await this.http('GET', '/api/an');
    if (info.status !== 200) throw new Error(`relay HTTP ${info.status}`);
    this.learnTime(info.data?.time);
    if (this.receives) {
      // First poll registers presence (or the helper listener) and proves reachability.
      const r = await this.http('GET', this.pollQuery(0));
      if (r.status !== 200) throw new Error(`poll HTTP ${r.status}: ${r.data?.error || ''}`);
      await this.syncPollState();
      for (const ev of r.data?.events || []) this.onEvent(ev);
      this.transport = 'poll';
      this.emit('connected', { transport: 'poll' });
      void this.pollLoop();
    } else {
      this.transport = 'poll';
      this.emit('connected', { transport: 'poll' });
    }
  }

  private async pollLoop(): Promise<void> {
    let backoff = 1000;
    while (!this.closed && this.transport === 'poll') {
      try {
        const r = await this.http('GET', this.pollQuery(25), undefined, 40_000);
        if (r.status !== 200) throw new Error(`poll HTTP ${r.status}`);
        backoff = 1000;
        // The relay restarted or dropped us after a long gap: re-register card, beacon, ACL and watches.
        if (r.data?.reset) { await this.syncPollState(); this.emit('connected', { transport: 'poll', resync: true }); }
        for (const ev of r.data?.events || []) this.onEvent(ev);
      } catch (e: any) {
        if (this.closed) return;
        if (process.env.SRIFT_AN_DEBUG) console.error(`[agentnet] poll error: ${e?.message}`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.receives) return;
    const d = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    setTimeout(() => { if (!this.closed) this.connect().catch(() => this.scheduleReconnect()); }, d).unref?.();
  }

  // ─── API ────────────────────────────────────────────────────────
  async send(env: any): Promise<SendResult> {
    if (!this.connected) await this.connect();
    if (this.transport === 'ws') {
      const m = await this.wsRequest({ type: 'send', env }, 20_000);
      if (m.type === 'error') return { id: env.id, result: 'error', error: m.error, relay: this.base };
      return { id: env.id, result: m.result, error: m.error, relay: this.base };
    }
    const r = await this.http('POST', '/api/an/send', { env }, 25_000);
    return { id: env.id, result: r.data?.result || 'error', error: r.data?.error, relay: this.base };
  }

  async ack(ids: string[]): Promise<void> {
    if (this.transport === 'ws' && this.ws) {
      this.ws.send(JSON.stringify({ type: 'ack', ids }));
      return;
    }
    await this.http('POST', '/api/an/ack', { ids });
  }

  async presence(address: string): Promise<string> {
    if (!this.connected) await this.connect();
    if (this.transport === 'ws') return (await this.wsRequest({ type: 'presence_query', address })).state;
    const r = await this.http('GET', `/api/an/presence?addr=${encodeURIComponent(address)}`);
    return r.data?.state || 'error';
  }

  async watch(addresses: string[]): Promise<Record<string, string>> {
    for (const a of addresses) this.watched.add(a);
    if (!this.connected) await this.connect();
    if (this.transport === 'ws') return (await this.wsRequest({ type: 'watch', addresses })).states || {};
    const r = await this.http('POST', '/api/an/watch', { cid: this.cid, addresses });
    return r.data?.states || {};
  }

  async unwatch(addresses: string[]): Promise<void> {
    for (const a of addresses) this.watched.delete(a);
    if (this.transport === 'ws') await this.wsRequest({ type: 'unwatch', addresses }).catch(() => {});
    else if (this.transport === 'poll') await this.http('POST', '/api/an/watch', { cid: this.cid, unwatch: addresses }).catch(() => {});
  }

  async setAcl(acl: Acl): Promise<void> {
    this.opts.acl = acl;
    if (this.transport === 'ws') await this.wsRequest({ type: 'presence_acl', acl });
    else if (this.transport === 'poll') await this.http('POST', '/api/an/acl', { acl });
  }

  /** Update the live card/beacon (RAM at the relay; gone when this connection closes). */
  async announce(card: any, beacon: any): Promise<{ searchable: boolean }> {
    this.opts.card = card;
    this.opts.beacon = beacon;
    if (!this.connected) await this.connect();
    if (this.transport === 'ws') {
      const m = await this.wsRequest({ type: 'announce', card, beacon: beacon ?? null });
      if (m.type === 'error') throw new Error(m.error);
      return { searchable: !!m.searchable };
    }
    const r = await this.http('POST', '/api/an/announce', { cid: this.cid, card, beacon: beacon ?? null });
    if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
    return { searchable: !!r.data?.searchable };
  }

  /** Live search + optional standing watch ("tell me when a match comes online"). */
  async seek(q: string, watchIt = true): Promise<{ seekId: string | null; results: LiveResult[] }> {
    if (!this.connected) await this.connect();
    if (this.transport === 'ws') {
      const m = await this.wsRequest({ type: 'seek', q, watch: watchIt }, 20_000);
      if (m.type === 'error') throw new Error(m.error);
      return { seekId: m.seekId, results: m.results || [] };
    }
    const r = await this.http('POST', '/api/an/seek', { cid: this.cid, q, watch: watchIt }, 20_000);
    if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
    return { seekId: r.data.seekId, results: r.data.results || [] };
  }

  /** Card of an ONLINE agent (this relay or its peers). null if offline/hidden. */
  async liveCard(address: string): Promise<{ card: any; beacon?: any; relay?: string } | null> {
    if (this.transport === 'ws') {
      const m = await this.wsRequest({ type: 'live_card', address }).catch(() => null);
      return m?.card ? { card: m.card, beacon: m.beacon, relay: m.relay } : null;
    }
    const pathQ = `/api/an/live/card/${encodeURIComponent(address)}?hops=1`;
    const r = await this.http('GET', pathQ).catch(() => null);
    return r?.status === 200 && r.data?.card ? r.data : null;
  }

  /** Live search over HTTP (signed so the relay can apply presence ACLs). */
  async liveSearch(params: { q?: string; handle?: string; owner?: string; limit?: number; hops?: number }): Promise<LiveResult[]> {
    const qs = new URLSearchParams();
    for (const k of ['q', 'handle', 'owner'] as const) if (params[k]) qs.set(k, params[k]!);
    qs.set('limit', String(params.limit ?? 20));
    qs.set('hops', String(params.hops ?? 1));
    const r = await this.http('GET', `/api/an/live/search?${qs}`, undefined, 15_000);
    if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
    return r.data?.results || [];
  }

  /** Signed relay API call. */
  async api(method: string, pathQ: string, body?: any): Promise<{ status: number; data: any }> {
    const headers = C.signHttp(this.me(), method, pathQ, body, this.host, this.clockOffset) as Record<string, string>;
    return requestJson(this.base + pathQ, { method, headers, json: body, timeoutMs: 20_000, maxRedirects: 0, maxBytes: 4 * 1024 * 1024 });
  }

  async close(): Promise<void> {
    this.closed = true;
    const wasPoll = this.transport === 'poll' && this.receives;
    this.pollAbort?.abort();
    this.pollAbort = null;
    if (this.ws) { try { this.ws.close(); } catch { /* gone */ } this.ws = null; }
    this.transport = null;
    if (wasPoll) {
      await requestJson(this.base + '/api/an/leave', {
        method: 'POST',
        headers: C.signHttp(this.me(), 'POST', '/api/an/leave', { cid: this.cid }, this.host, this.clockOffset) as Record<string, string>,
        json: { cid: this.cid },
        timeoutMs: 5000,
        maxRedirects: 0,
      }).catch(() => {});
    }
  }
}

/** Unsigned public directory GET. */
export async function publicGet(base: string, pathQ: string): Promise<{ status: number; data: any }> {
  return requestJson(base.replace(/\/$/, '') + pathQ, { timeoutMs: 15_000, maxRedirects: 0, maxBytes: 4 * 1024 * 1024 });
}
