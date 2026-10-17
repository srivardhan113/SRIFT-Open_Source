/**
 * SRIFT Peerknock — which relay URLs may this node contact?
 *
 * Relays in the user's own config are always allowed. Relay URLs LEARNED from
 * other agents (cards, message headers, group state) are attacker-controlled,
 * so they must be https, must not point at loopback / private / link-local
 * addresses (checked on the literal AND after DNS resolution), and are capped.
 * This prevents a stranger from steering the node into local services (SSRF),
 * e.g. the zero-auth SRIFT daemon on 127.0.0.1.
 *
 * SRIFT_PK_ALLOW_PRIVATE_RELAYS=1 relaxes this for LAN / self-hosted test setups.
 */
import dns from 'node:dns';
import net from 'node:net';
import { loadConfig } from './local.ts';

const cache = new Map<string, { ok: boolean; at: number }>();
const TTL_MS = 10 * 60_000;

export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(v)) {
    // Work on the 8 expanded hextets: URL parsing rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1, so
    // string prefixes are not enough, and several forms embed an IPv4 address that must be checked.
    const h = expandIPv6(v.replace(/%.*$/, ''));
    if (!h) return true;
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
    if (zero(0, 8) || (zero(0, 7) && h[7] === 1)) return true; // :: and ::1
    if (zero(0, 5) && h[5] === 0xffff) return isPrivateIp(v4(h[6], h[7])); // IPv4-mapped
    if (zero(0, 6)) return isPrivateIp(v4(h[6], h[7])); // IPv4-compatible (deprecated)
    if (h[0] === 0x64 && h[1] === 0xff9b) return zero(2, 6) ? isPrivateIp(v4(h[6], h[7])) : true; // NAT64 (well-known / local-use)
    if (h[0] === 0x2002) return isPrivateIp(v4(h[1], h[2])); // 6to4
    if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) return true; // Teredo, documentation
    if ((h[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
    if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
    if ((h[0] & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true;
}

function expandIPv6(v: string): number[] | null {
  let s = v;
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = s.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const part = (x: string | undefined) => (x ? x.split(':').map((g) => parseInt(g, 16)) : []);
  const hi = part(head);
  const lo = part(tail);
  const fill = s.includes('::') ? 8 - hi.length - lo.length : 0;
  const out = [...hi, ...Array(Math.max(fill, 0)).fill(0), ...lo];
  return out.length === 8 && out.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? out : null;
}

function normalize(u: string): string | null {
  try {
    const url = new URL(u);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Is this relay URL safe to contact? Own-config relays: always. Learned relays: https + public addresses only. */
export async function relayAllowed(u: string): Promise<boolean> {
  const n = normalize(u);
  if (!n) return false;
  const own = loadConfig().relays.map((r) => normalize(r)).filter(Boolean);
  if (own.includes(n)) return true;
  if (process.env.SRIFT_PK_ALLOW_PRIVATE_RELAYS === '1') return /^https?:\/\//.test(n);
  const hit = cache.get(n);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  let ok = false;
  try {
    const url = new URL(n);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol === 'https:' && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local')) {
      if (net.isIP(host)) ok = !isPrivateIp(host);
      else {
        const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
        ok = addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
      }
    }
  } catch {
    ok = false;
  }
  cache.set(n, { ok, at: Date.now() });
  return ok;
}

/** Filter learned relay URLs down to safe ones (max `limit`). */
export async function safeRelays(urls: string[], limit = 2): Promise<string[]> {
  const out: string[] = [];
  for (const u of [...new Set(urls)].slice(0, 8)) {
    if (out.length >= limit) break;
    if (await relayAllowed(u)) out.push(normalize(u)!);
  }
  return out;
}

/**
 * `lookup` for a relay connection. relayAllowed() vets a learned relay's addresses once (and caches the
 * answer); the connection resolves again, so a rebinding DNS name could swap in 127.0.0.1 in between.
 * This re-checks every address at connect time. Own-config relays and SRIFT_PK_ALLOW_PRIVATE_RELAYS=1
 * are not restricted (LAN / self-hosted setups). IP literals never reach a lookup: relayAllowed checks them.
 */
export function guardedLookup(base: string): net.LookupFunction | undefined {
  const n = normalize(base);
  if (!n || process.env.SRIFT_PK_ALLOW_PRIVATE_RELAYS === '1') return undefined;
  try {
    if (loadConfig().relays.map((r) => normalize(r)).includes(n)) return undefined;
  } catch { /* no config yet: treat as learned */ }
  return ((hostname: string, options: any, cb: any) => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err: any, addrs: dns.LookupAddress[]) => {
      if (err) return cb(err);
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
        return cb(Object.assign(new Error(`Refusing relay ${hostname}: it resolves to a private address`), { code: 'EAI_PRIVATE' }));
      }
      if (options?.all) cb(null, addrs);
      else cb(null, addrs[0].address, addrs[0].family);
    });
  }) as net.LookupFunction;
}
