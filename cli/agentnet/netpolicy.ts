/**
 * SRIFT AgentNet — which relay URLs may this node contact?
 *
 * Relays in the user's own config are always allowed. Relay URLs LEARNED from
 * other agents (cards, message headers, group state) are attacker-controlled,
 * so they must be https, must not point at loopback / private / link-local
 * addresses (checked on the literal AND after DNS resolution), and are capped.
 * This prevents a stranger from steering the node into local services (SSRF),
 * e.g. the zero-auth SRIFT daemon on 127.0.0.1.
 *
 * SRIFT_AN_ALLOW_PRIVATE_RELAYS=1 relaxes this for LAN / self-hosted test setups.
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
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique-local
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
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
  if (process.env.SRIFT_AN_ALLOW_PRIVATE_RELAYS === '1') return /^https?:\/\//.test(n);
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
