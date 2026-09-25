/**
 * SRIFT CLI network layer — zero dependencies.
 *
 * Every outbound request the CLI and daemon make goes through here so that
 * proxy support, custom-CA hints and error messages are consistent:
 *
 *   • HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (+ lower-case) and NO_PROXY.
 *   • http:// and https:// proxies via CONNECT tunnelling, socks5:// and
 *     socks5h:// proxies via a minimal SOCKS5 client (no-auth + user/pass).
 *   • Loopback (127.0.0.1, ::1, localhost) is NEVER proxied — the local
 *     daemon must stay reachable when a proxy is configured.
 *   • The `ws` package ignores proxy env vars; `agentFor()` returns an agent
 *     that it accepts via `new WebSocket(url, { agent })`.
 *   • TLS verification is never disabled. On a certificate error we explain
 *     NODE_EXTRA_CA_CERTS instead.
 */
import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { URL } from 'url';
import type { Duplex } from 'stream';

type ConnCb = (err: Error | null, stream: Duplex) => void;

// ─────────────────────────────────────────────────────────────────
// Proxy resolution
// ─────────────────────────────────────────────────────────────────

function envFirst(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h) || h === '0.0.0.0';
}

/** NO_PROXY semantics shared by curl/wget/Go: comma or space separated,
 *  `*` matches everything, `.example.com` and `example.com` both match the
 *  domain and its subdomains, an optional `:port` restricts the match. */
export function matchesNoProxy(hostname: string, port: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  for (const raw of noProxy.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryPort = '';
    const m = /^(.*?)(?::(\d+))?$/.exec(entry);
    if (m && m[2] && !entry.includes('::')) { entry = m[1]; entryPort = m[2]; }
    if (entryPort && entryPort !== port) continue;
    entry = entry.replace(/^\*?\./, '');
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** Returns the proxy URL to use for `target`, or null for a direct connection. */
export function getProxyForUrl(target: string | URL): URL | null {
  let u: URL;
  try { u = typeof target === 'string' ? new URL(target) : target; } catch { return null; }
  if (isLoopbackHost(u.hostname)) return null;
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  const port = u.port || (secure ? '443' : '80');
  if (matchesNoProxy(u.hostname, port, envFirst('NO_PROXY', 'no_proxy'))) return null;
  const raw = secure
    ? envFirst('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy')
    : envFirst('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
  if (!raw) return null;
  try {
    // Bare "host:port" is common in the wild; treat it as http://
    const p = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks:'].includes(p.protocol)) return null;
    return p;
  } catch {
    return null;
  }
}

/** Human-safe proxy description (credentials stripped). */
export function describeProxy(p: URL | null): string {
  if (!p) return 'none';
  return `${p.protocol}//${p.hostname}${p.port ? `:${p.port}` : ''}${p.username ? ' (with credentials)' : ''}`;
}

export function proxyEnvPresent(): boolean {
  return !!envFirst('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
}

// ─────────────────────────────────────────────────────────────────
// Tunnels
// ─────────────────────────────────────────────────────────────────

function proxyDefaultPort(p: URL): number {
  if (p.port) return parseInt(p.port, 10);
  if (p.protocol === 'https:') return 443;
  if (p.protocol.startsWith('socks')) return 1080;
  return 80;
}

function connectViaHttpProxy(proxy: URL, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `${host}:${port}` };
    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
    }
    const mod = proxy.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: proxy.hostname,
      port: proxyDefaultPort(proxy),
      method: 'CONNECT',
      path: `${host.includes(':') ? `[${host}]` : host}:${port}`,
      headers,
      agent: false,
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const err: any = new Error(`Proxy CONNECT to ${host}:${port} failed: HTTP ${res.statusCode}`);
        err.code = res.statusCode === 407 ? 'EPROXYAUTH' : 'EPROXYCONNECT';
        err.proxyStatus = res.statusCode;
        reject(err);
        return;
      }
      if (head && head.length) socket.unshift(head);
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error(`Proxy CONNECT timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
    req.once('error', reject);
    req.end();
  });
}

function connectViaSocks5(proxy: URL, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyDefaultPort(proxy), proxy.hostname);
    let buf = Buffer.alloc(0);
    let stage: 'greet' | 'auth' | 'connect' = 'greet';
    const user = proxy.username ? decodeURIComponent(proxy.username) : '';
    const pass = proxy.password ? decodeURIComponent(proxy.password) : '';
    const fail = (msg: string, code = 'ESOCKS') => {
      sock.destroy();
      reject(Object.assign(new Error(`SOCKS5 proxy: ${msg}`), { code }));
    };
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs} ms`, 'ETIMEDOUT'), timeoutMs);
    const sendConnect = () => {
      stage = 'connect';
      const hostBuf = Buffer.from(host, 'utf8');
      if (hostBuf.length > 255) return fail('hostname too long');
      const req = Buffer.alloc(7 + hostBuf.length);
      req[0] = 5; req[1] = 1; req[2] = 0; req[3] = 3; req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(port, 5 + hostBuf.length);
      sock.write(req);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        const method = buf[1];
        buf = buf.subarray(2);
        if (method === 0x00) return sendConnect();
        if (method === 0x02 && user) {
          stage = 'auth';
          const u = Buffer.from(user), p = Buffer.from(pass);
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          return;
        }
        return fail(method === 0xff ? 'no acceptable authentication method' : `unsupported auth method ${method}`);
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail('authentication rejected', 'EPROXYAUTH');
        buf = buf.subarray(2);
        return sendConnect();
      }
      // connect reply: VER REP RSV ATYP BND.ADDR BND.PORT
      if (buf.length < 5) return;
      if (buf[1] !== 0) return fail(`CONNECT to ${host}:${port} rejected (code ${buf[1]})`, 'EPROXYCONNECT');
      const atyp = buf[3];
      const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + buf[4] : -1;
      if (addrLen < 0) return fail('malformed reply');
      const total = 4 + addrLen + 2;
      if (buf.length < total) return;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      const rest = buf.subarray(total);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    const onErr = (e: Error) => { clearTimeout(timer); reject(e); };
    sock.on('data', onData);
    sock.once('error', onErr);
    sock.once('connect', () => {
      sock.write(user ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
    });
  });
}

export function openTunnel(proxy: URL, host: string, port: number, timeoutMs = 15_000): Promise<net.Socket> {
  return proxy.protocol.startsWith('socks')
    ? connectViaSocks5(proxy, host, port, timeoutMs)
    : connectViaHttpProxy(proxy, host, port, timeoutMs);
}

class TunnelHttpsAgent extends https.Agent {
  private proxy: URL;
  constructor(proxy: URL) { super({ keepAlive: true, maxSockets: 16 }); this.proxy = proxy; }
  // Node calls createConnection(options, cb); returning undefined and invoking
  // cb asynchronously is the documented extension point used by agent-base.
  createConnection(options: any, cb?: ConnCb): any {
    const host = options.host || options.hostname;
    const port = Number(options.port) || 443;
    openTunnel(this.proxy, host, port).then((raw) => {
      const secure = tls.connect({ ...options, socket: raw, servername: options.servername || (net.isIP(host) ? undefined : host) });
      cb?.(null, secure);
    }, (err) => cb?.(err, undefined as unknown as Duplex));
    return undefined;
  }
}

class TunnelHttpAgent extends http.Agent {
  private proxy: URL;
  constructor(proxy: URL) { super({ keepAlive: true, maxSockets: 16 }); this.proxy = proxy; }
  createConnection(options: any, cb?: ConnCb): any {
    openTunnel(this.proxy, options.host || options.hostname, Number(options.port) || 80)
      .then((s) => cb?.(null, s), (err) => cb?.(err, undefined as unknown as Duplex));
    return undefined;
  }
}

const agentCache = new Map<string, http.Agent>();

/** Agent to pass to http(s).request / `ws` for `target`; undefined = direct. */
export function agentFor(target: string | URL): http.Agent | undefined {
  const u = typeof target === 'string' ? new URL(target) : target;
  const proxy = getProxyForUrl(u);
  if (!proxy) return undefined;
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  const key = `${secure ? 's' : 'p'}|${proxy.href}`;
  let a = agentCache.get(key);
  if (!a) {
    a = secure ? new TunnelHttpsAgent(proxy) : new TunnelHttpAgent(proxy);
    agentCache.set(key, a);
  }
  return a;
}

// ─────────────────────────────────────────────────────────────────
// Request helpers
// ─────────────────────────────────────────────────────────────────

export type RequestOpts = {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Abort if the response body exceeds this many bytes (default: unlimited). */
  maxBytes?: number;
};

export type SimpleResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; url: string };

/** Open a request and resolve with the (unconsumed) response stream. Follows redirects. */
export function openRequest(url: string, opts: RequestOpts = {}): Promise<{ res: http.IncomingMessage; url: string }> {
  const maxRedirects = opts.maxRedirects ?? 5;
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(new Error(`Invalid URL: ${url}`)); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const body = typeof opts.body === 'string' ? Buffer.from(opts.body) : opts.body;
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(body.length);
    }
    const req = mod.request(u, { method: opts.method || 'GET', headers, agent: agentFor(u), signal: opts.signal }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        // Never downgrade https → http on redirect.
        if (u.protocol === 'https:' && next.startsWith('http:')) {
          reject(new Error(`Refusing insecure redirect to ${next}`));
          return;
        }
        const method = status === 303 ? 'GET' : opts.method;
        // Never forward credentials to a different origin.
        let headers = opts.headers;
        if (new URL(next).origin !== u.origin && headers) {
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|x-srift-resume)$/i.test(k)));
        }
        openRequest(next, { ...opts, headers, method, body: status === 303 ? undefined : opts.body, maxRedirects: maxRedirects - 1 })
          .then(resolve, reject);
        return;
      }
      resolve({ res, url: u.toString() });
    });
    const t = opts.timeoutMs ?? 15_000;
    if (t > 0) {
      req.setTimeout(t, () => req.destroy(Object.assign(new Error(`Request timed out after ${Math.round(t / 1000)}s`), { code: 'ETIMEDOUT' })));
    }
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function request(url: string, opts: RequestOpts = {}): Promise<SimpleResponse> {
  const { res, url: finalUrl } = await openRequest(url, opts);
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    res.on('data', (c: Buffer) => {
      total += c.length;
      if (opts.maxBytes && total > opts.maxBytes) {
        res.destroy();
        reject(Object.assign(new Error(`Response larger than ${opts.maxBytes} bytes`), { code: 'EMSGSIZE' }));
        return;
      }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return { status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), url: finalUrl };
}

export async function requestJson(url: string, opts: RequestOpts & { json?: unknown } = {}): Promise<{ status: number; data: any; headers: http.IncomingHttpHeaders }> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers || {}) };
  let body = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json';
  }
  const r = await request(url, { ...opts, headers, body });
  let data: any = null;
  const text = r.body.toString('utf8');
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  return { status: r.status, data, headers: r.headers };
}

// ─────────────────────────────────────────────────────────────────
// Error explanations
// ─────────────────────────────────────────────────────────────────

const TLS_TRUST_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
]);

export type NetDiagnosis = { kind: string; message: string; fix?: string };

/** Turn a low-level network error into a one-line reason plus the exact fix. */
export function explainNetError(err: any, url?: string): NetDiagnosis {
  const code: string = err?.code || '';
  const msg: string = err?.message || String(err);
  const target = url ? ` (${url})` : '';
  if (TLS_TRUST_CODES.has(code) || /self[- ]signed|unable to (get|verify)/i.test(msg)) {
    return process.env.NODE_EXTRA_CA_CERTS
      ? { kind: 'tls-untrusted', message: `TLS certificate not trusted${target} even with NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}.`, fix: 'Check that file contains the proxy\'s root CA in PEM format.' }
      : {
          kind: 'tls-untrusted',
          message: `TLS certificate not trusted${target} — a TLS-inspecting proxy is likely re-signing traffic.`,
          fix: process.platform === 'win32'
            ? 'Export the proxy root CA as PEM, then: setx NODE_EXTRA_CA_CERTS "C:\\path\\to\\proxy-ca.pem" (and open a new terminal). Never set NODE_TLS_REJECT_UNAUTHORIZED=0.'
            : 'Export the proxy root CA as PEM, then: export NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem. Never set NODE_TLS_REJECT_UNAUTHORIZED=0.',
        };
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return { kind: 'tls-invalid', message: `TLS certificate invalid${target}: ${code}.`, fix: 'Check the system clock, and whether a captive portal or proxy is intercepting HTTPS.' };
  }
  if (code === 'EPROXYAUTH') {
    return { kind: 'proxy-auth', message: `Proxy requires authentication${target}.`, fix: 'Put credentials in the proxy URL: HTTPS_PROXY=http://user:pass@proxy:port' };
  }
  if (code === 'EPROXYCONNECT') {
    return { kind: 'proxy-denied', message: `Proxy refused the connection${target}: ${msg}`, fix: 'Ask for srift.app:443 to be allow-listed on the proxy, or set NO_PROXY if it should be reached directly.' };
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return { kind: 'sandbox', message: `The OS denied the network operation${target} (${code}) — this looks like a sandbox.`, fix: proxyEnvPresent() ? 'SRIFT will use the configured proxy; allow srift.app in the sandbox network policy.' : 'Allow network access for this tool, or allow-list srift.app:443 in the sandbox settings.' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { kind: 'dns', message: `DNS lookup failed${target} (${code}).`, fix: proxyEnvPresent() ? 'Check the proxy URL host.' : 'Check network connectivity; if you are behind a proxy set HTTPS_PROXY.' };
  }
  if (code === 'ECONNREFUSED') {
    return { kind: 'refused', message: `Connection refused${target}.`, fix: proxyEnvPresent() ? 'Check that the proxy in HTTPS_PROXY is running.' : 'A firewall may be rejecting the connection; try setting HTTPS_PROXY.' };
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || /timed out/i.test(msg)) {
    return { kind: 'timeout', message: `Network timed out${target}.`, fix: 'Outbound traffic may be filtered. If you are behind a proxy set HTTPS_PROXY; run `srift doctor` for a full check.' };
  }
  return { kind: 'unknown', message: `${msg}${target}` };
}

export function formatNetError(err: any, url?: string): string {
  const d = explainNetError(err, url);
  return d.fix ? `${d.message}\n  Fix: ${d.fix}` : d.message;
}
