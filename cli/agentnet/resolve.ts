/**
 * SRIFT AgentNet — discovery. LIVE ONLY: no directory, no database.
 *
 * How agent A finds agent B the first time (like phone numbers + Instagram
 * search, but decentralized):
 *   1. Invite link          https://srift.app/c#…        signed card inside the link (works offline)
 *   2. Address              srift:7K2F-9QXM-…           shared like a phone number / reply-to
 *   3. Contacts             "ravi"                        local address book
 *   4. Handle tag           @ravi~dxobfa  or  @ravi       live: agents online now whose signed card
 *                                                          has that handle (~suffix = key-derived, unique)
 *   5. Owner namespace      @ravi/support, owner:@ravi    live: agents carrying an owner-signed proof
 *   6. Domain               support@acme.com, acme.com    https://acme.com/.well-known/srift (DNS)
 *   7. Live search          "book a flight"               ranked one-line descriptions of agents
 *                                                          ONLINE right now, across peered relays
 *
 * Every card/beacon is verified locally (address = hash(key), self-signatures,
 * owner proofs), so a relay or peer cannot substitute keys or fake ownership.
 */
import { requestJson } from '../net.ts';
import * as C from '../../lib/agentnet/crypto.mjs';
import { cardMatchesTag, decodeInvite, isInvite, parseHandleTag, verifyBeacon, verifyCard } from '../../lib/agentnet/card.mjs';
import { findContactByName, getContact, identityOrNull, loadConfig, loadContacts, loadPeers, rememberPeer } from './local.ts';
import { RelayClient, type LiveResult } from './relay-client.ts';

export type Card = {
  v: 1; address: string; edPub: string; xPub: string; name?: string; description?: string;
  skills?: string[]; handle?: string; domain?: string; relays?: string[]; updatedAt?: number; sig: string;
  kind?: 'agent' | 'owner'; owner?: { address: string; edPub: string; agent: string; ts: number; name?: string; sig: string };
};
export type Resolved = {
  address: string; card: Card | null; source: string;
  online?: boolean; oneLine?: string; status?: string; since?: number; tag?: string; relay?: string; score?: number | null;
  attest?: { domain?: string };
  inviteToken?: string;
};

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function checked(card: any, expectAddress?: string): Card | null {
  if (!card || !verifyCard(card).ok) return null;
  if (expectAddress && card.address !== expectAddress) return null;
  return card as Card;
}

/** A throwaway signer for lookups when this machine has no identity yet. */
function lookupClients(extraRelays: string[] = []): RelayClient[] {
  const me = identityOrNull();
  const relays = [...new Set([...loadConfig().relays, ...extraRelays])];
  return relays.map((r) => new RelayClient(r, me, { recv: false }));
}

function fromLive(r: LiveResult, source = 'live'): Resolved | null {
  const card = checked(r.card, r.address);
  if (!card) return null;
  if (r.beacon && !verifyBeacon(r.beacon, card).ok) return null;
  return {
    address: card.address, card, source, online: true, oneLine: r.beacon?.oneLine || r.oneLine, status: r.beacon?.status || r.status,
    since: r.since, tag: r.tag, relay: r.relay, score: r.score,
  };
}

/** Query all configured relays (they fan out to their peers) and merge by address. */
export async function liveSearch(params: { q?: string; handle?: string; owner?: string; limit?: number }): Promise<Resolved[]> {
  const clients = lookupClients();
  const lists = await Promise.all(clients.map((c) => c.liveSearch({ ...params, hops: 1 }).catch(() => [] as LiveResult[])));
  const best = new Map<string, Resolved>();
  for (const r of lists.flat()) {
    const v = fromLive(r);
    if (!v) continue;
    const prev = best.get(v.address);
    if (!prev || (v.score || 0) > (prev.score || 0)) best.set(v.address, v);
  }
  const me = identityOrNull()?.address;
  return [...best.values()].filter((r) => r.address !== me).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, params.limit ?? 20);
}

/** Live card of an ONLINE agent, from any configured relay (+ peers) or the given relays. */
export async function liveCard(address: string, relays: string[] = []): Promise<{ card: Card; relay?: string; beacon?: any } | null> {
  const clients = lookupClients(relays);
  for (const c of clients) {
    const r = await c.liveCard(address).catch(() => null);
    const card = checked(r?.card, address);
    if (card) return { card, relay: r!.relay, beacon: r!.beacon };
  }
  return null;
}

/** Back-compat name used by CLI/MCP. */
export async function fetchCard(address: string): Promise<{ card: Card } | null> {
  const l = await liveCard(address);
  return l ? { card: l.card } : null;
}

/** Keys needed to encrypt to `address`: contact card → peer cache → live card. */
export async function keysFor(address: string): Promise<{ xPub: string; edPub: string; card: Card | null; relays: string[] } | null> {
  const contact = getContact(address);
  const cc = checked(contact?.card, address);
  if (cc) return { xPub: cc.xPub, edPub: cc.edPub, card: cc, relays: cc.relays || [] };
  const peer = loadPeers()[address];
  if (peer && C.addressFromEdPub(peer.edPub) === address) return { xPub: peer.xPub, edPub: peer.edPub, card: null, relays: peer.relays || [] };
  const l = await liveCard(address);
  if (!l) return null;
  // Route only via relays the agent itself signed into its card (a relay's word is never trusted for routing).
  rememberPeer({ address, edPub: l.card.edPub, xPub: l.card.xPub, relays: l.card.relays || [], seenAt: C.nowSec() });
  return { xPub: l.card.xPub, edPub: l.card.edPub, card: l.card, relays: l.card.relays || [] };
}

async function wellKnown(domain: string): Promise<Array<{ name?: string; address: string; card?: any }>> {
  const r = await requestJson(`https://${domain}/.well-known/srift`, { timeoutMs: 10_000, maxRedirects: 2 }).catch(() => null);
  if (!r || r.status !== 200 || !Array.isArray(r.data?.agents)) return [];
  return r.data.agents.slice(0, 100);
}
async function fromWellKnown(domain: string, name?: string): Promise<Resolved | null> {
  const agents = await wellKnown(domain);
  const pick = name ? agents.find((a) => String(a.name || '').toLowerCase() === name.toLowerCase()) : agents[0];
  if (!pick) return null;
  const address = C.normalizeAddress(pick.address);
  if (!address) return null;
  const card = checked(pick.card, address) || (await liveCard(address))?.card || null;
  return { address, card, source: `domain:${domain}`, attest: { domain } };
}

/** Agents (online now) that carry a valid owner proof from `owner` (address, @handle or @handle~suffix). */
export async function agentsOf(owner: string): Promise<Resolved[]> {
  const o = owner.trim();
  const direct = C.normalizeAddress(o);
  const tag = direct ? null : parseHandleTag(o);
  if (!direct && !tag) return [];
  const res = await liveSearch({ owner: direct || o.replace(/^@/, ''), limit: 50 });
  return res
    .filter((r) => {
      const p = r.card?.owner;
      if (!p) return false;
      if (direct) return p.address === direct;
      return p.name === tag!.handle && (!tag!.suffix || C.compactAddress(p.address).startsWith(tag!.suffix));
    })
    .map((r) => ({ ...r, source: 'owner' }));
}

function isBareAddress(q: string): string | null {
  const direct = C.normalizeAddress(q);
  return direct && q.replace(/^srift:/i, '').replace(/-/g, '').trim().length === 20 ? direct : null;
}

/** Resolve a single target. Returns null if nothing matched (or it is ambiguous — see resolveAll). */
export async function resolveOne(query: string): Promise<Resolved | null> {
  const all = await resolveAll(query);
  return all.length === 1 ? all[0] : all.length > 1 && all[0].source !== 'handle' && all[0].source !== 'owner' ? all[0] : null;
}

/**
 * Resolve to candidates. Unique forms (invite, address, contact, ~suffix, domain)
 * return one; bare @handle / @owner/agent may return several (names are not unique —
 * the ~suffix disambiguates).
 */
export async function resolveAll(query: string): Promise<Resolved[]> {
  const q = query.trim();
  if (isInvite(q)) {
    const inv = decodeInvite(q);
    return [{ address: inv.card.address, card: inv.card, source: 'invite', inviteToken: inv.token }];
  }
  const direct = isBareAddress(q);
  if (direct) {
    const k = await keysFor(direct);
    return [{ address: direct, card: k?.card || null, source: 'address' }];
  }
  const contact = findContactByName(q);
  if (contact) return [{ address: contact.address, card: checked(contact.card, contact.address), source: 'contacts' }];

  const ns = q.match(/^@?([a-z0-9][a-z0-9-]{1,30}[a-z0-9](?:~[a-z2-7]{4,20})?)\/([^/\s]+)$/i);
  if (ns && ns[2] !== '*') {
    const want = ns[2].toLowerCase().replace(/^@/, '');
    return (await agentsOf(ns[1])).filter((a) => a.card && cardMatchesTag(a.card, want));
  }

  const tag = q.startsWith('@') || /~[a-z2-7]{4,20}$/i.test(q) ? parseHandleTag(q) : null;
  if (tag) {
    // Contacts first: someone you already know stays reachable by @handle even
    // when they are not publicly discoverable. The ~suffix is checked against the
    // contact's (key-derived) address, so a stored handle cannot be spoofed.
    const known = Object.values(loadContacts()).filter((c) => c.policy !== 'blocked' && cardMatchesTag({ ...(c.card || {}), name: c.card?.name || c.name, address: c.address }, tag));
    if (known.length === 1) return [{ address: known[0].address, card: checked(known[0].card, known[0].address), source: 'contacts' }];
    const res = await liveSearch({ handle: tag.suffix ? `${tag.handle}~${tag.suffix}` : tag.handle, limit: 20 });
    return res.filter((r) => r.card && cardMatchesTag(r.card, tag)).map((r) => ({ ...r, source: 'handle' }));
  }

  const at = q.lastIndexOf('@');
  if (at > 0 && DOMAIN_RE.test(q.slice(at + 1))) {
    const r = await fromWellKnown(q.slice(at + 1).toLowerCase(), q.slice(0, at));
    return r ? [r] : [];
  }
  if (DOMAIN_RE.test(q)) {
    const r = await fromWellKnown(q.toLowerCase());
    if (r) return [r];
  }
  return [];
}

/** find = exact resolution first; otherwise a live search of online agents. */
export async function find(query: string, limit = 10): Promise<Resolved[]> {
  const q = query.trim();
  const all = q.match(/^(?:owner:\s*(.+)|@?([a-z0-9][a-z0-9-]{1,30}[a-z0-9](?:~[a-z2-7]{4,20})?)\/\*?)$/i);
  if (all) return (await agentsOf((all[1] || all[2]).trim())).slice(0, limit);
  const exact = await resolveAll(q);
  if (exact.length) return exact.slice(0, limit);
  if (q.startsWith('@')) return [];
  return liveSearch({ q, limit });
}
