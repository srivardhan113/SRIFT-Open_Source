/**
 * SRIFT doctor — one diagnostic engine for every surface:
 *   `srift doctor` / `npx srift-transfer doctor` / the PyPI & binary wrappers,
 *   the MCP tool `srift_net_diagnose`, the daemon's GET /v1/diag and its
 *   startup network check.
 *
 * It answers three questions, with a reason and an exact fix for anything wrong:
 *   1. Can links be served from here?          (HTTPS, WebSocket relay, DNS, TLS, proxy)
 *   2. How will SRIFT run here?                (background daemon vs embedded, sandbox,
 *                                               CI/ephemeral, container, network namespace)
 *   3. What should the agent/user do?          (a concrete plan: flags, commands, caveats)
 *
 * All checks run concurrently with bounded timeouts (≈8 s worst case, usually
 * 1–3 s). Results are cached 10 min in ~/.srift/probe.json (--fresh bypasses).
 * `deep` adds a real end-to-end self-test: an encrypted link is created and
 * downloaded back through the relay, byte-compared, and throughput measured.
 */
import { spawn, spawnSync } from 'child_process';
import dgram from 'dgram';
import dns from 'dns';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { WebSocket } from 'ws';
import { agentFor, describeProxy, explainNetError, getProxyForUrl, requestJson } from './net.ts';

export type RungStatus = 'WORKS' | 'WARN' | 'BLOCKED' | 'SKIPPED';
export type RungGroup = 'connectivity' | 'runtime' | 'environment';
export type Rung = { id: string; name: string; status: RungStatus; detail: string; fix?: string; ms?: number; group?: RungGroup };
export type SelfTestResult = { ok: boolean; ms: number; bytes: number; mbps?: number; via?: string; error?: string };
export type DiagReport = {
  ok: boolean;
  verdict: 'ok' | 'degraded' | 'blocked';
  recommendedMode: 'relay' | 'none';
  summary: string;
  rungs: Rung[];
  /** How SRIFT will run here and what to do — ready to follow. */
  plan: {
    serveFrom: 'background-daemon' | 'embedded' | 'unavailable';
    transport: string;
    shareCommand: string;
    downloadCommand: string;
    advice: string[];
  };
  context: {
    runtime: string;
    cliVersion: string | null;
    serverVersion: string | null;
    daemonVersion: string | null;
  };
  selfTest?: SelfTestResult;
  env: {
    platform: string;
    node: string;
    proxy: string;
    noProxy: string | null;
    extraCaCerts: string | null;
    sandbox: { detected: boolean; ephemeral: boolean; hints: string[] };
  };
  base: string;
  checkedAt: string;
  cached?: boolean;
};

const CACHE_FILE = path.join(os.homedir(), '.srift', 'probe.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_SCHEMA = 2;

export function apiBase(): string {
  // Same server the CLI/daemon talk to (NEXT_PUBLIC_API_URL), so doctor tests the real path.
  return (process.env.SRIFT_API_BASE || process.env.SRIFT_PUBLIC_BASE || process.env.NEXT_PUBLIC_API_URL || 'https://srift.app').replace(/\/+$/, '');
}

// ─── environment detection ──────────────────────────────────────────────

/** Environment hints. `ephemeral` = the process (and any daemon) is likely to vanish soon. */
export function detectSandbox(): { detected: boolean; ephemeral: boolean; hints: string[] } {
  const e = process.env;
  const hints: string[] = [];
  let ephemeral = false;
  const flag = (cond: unknown, hint: string, eph = false) => {
    if (cond) { hints.push(hint); if (eph) ephemeral = true; }
  };
  flag(e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT, 'Claude Code');
  flag(e.CLAUDE_CODE_REMOTE, 'Claude Code (remote)', true);
  flag(e.CODEX_SANDBOX || e.CODEX_SANDBOX_NETWORK_DISABLED, 'Codex sandbox', true);
  flag(e.CURSOR_TRACE_ID || e.CURSOR_AGENT, 'Cursor');
  flag(e.E2B_SANDBOX || e.E2B_SANDBOX_ID, 'E2B sandbox', true);
  flag(Object.keys(e).some((k) => k.startsWith('DAYTONA_')), 'Daytona', true);
  flag(e.CODESPACES, 'GitHub Codespaces');
  flag(e.GITPOD_WORKSPACE_ID, 'Gitpod');
  flag(e.REPL_ID, 'Replit', true);
  flag(Object.keys(e).some((k) => k.startsWith('MODAL_')), 'Modal', true);
  flag(e.VERCEL_SANDBOX || e.VERCEL_SANDBOX_ID, 'Vercel Sandbox', true);
  flag(e.GITHUB_ACTIONS === 'true', 'GitHub Actions', true);
  flag(e.GITLAB_CI, 'GitLab CI', true);
  flag(e.BUILDKITE, 'Buildkite', true);
  flag(e.CIRCLECI, 'CircleCI', true);
  flag(e.JENKINS_URL, 'Jenkins', true);
  flag(e.CI === 'true' || e.CI === '1', 'CI', true);
  flag(e.K_SERVICE, 'Cloud Run', true);
  flag(e.AWS_LAMBDA_FUNCTION_NAME, 'AWS Lambda', true);
  flag(e.KUBERNETES_SERVICE_HOST, 'Kubernetes');
  try { flag(fs.existsSync('/.dockerenv'), 'container (/.dockerenv)'); } catch { /* ignore */ }
  try { flag(fs.existsSync('/run/.containerenv'), 'container (podman)'); } catch { /* ignore */ }
  if (process.platform === 'linux') {
    try {
      const cg = fs.readFileSync('/proc/1/cgroup', 'utf8');
      flag(/bwrap|bubblewrap/i.test(cg), 'bubblewrap');
      flag(/docker|containerd|kubepods/i.test(cg), 'container (cgroup)');
    } catch { /* ignore */ }
    try { flag(/microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')), 'WSL'); } catch { /* ignore */ }
    // Network namespace without a default route = proxy-only egress (typical agent sandbox).
    try {
      const routes = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).filter(Boolean);
      const hasDefault = routes.some((l) => l.split(/\s+/)[1] === '00000000');
      flag(!hasDefault, 'no default network route (sandboxed network namespace)');
    } catch { /* ignore */ }
  }
  return { detected: hints.length > 0, ephemeral, hints: [...new Set(hints)] };
}

/** How this process was launched: mcp / npx / binary / pypi / daemon / cli. */
export function detectRuntime(): string {
  const e = process.env;
  const argv = process.argv.join(' ');
  const bun = !!(process.versions as any).bun || /(^|[\\/])srift(\.exe)?$/i.test(process.execPath);
  const launcher = e.SRIFT_RUNTIME
    || (bun ? 'standalone binary' : null)
    || (/[\\/]_npx[\\/]/.test(argv) || e.npm_command === 'exec' ? 'npx' : null)
    || (/site-packages|srift_cli/i.test(argv) ? 'pypi' : null);
  if (process.argv.includes('mcp')) return launcher ? `mcp via ${launcher}` : 'mcp';
  if (/daemon\.(js|ts)/.test(argv)) return launcher ? `daemon via ${launcher}` : 'daemon';
  return launcher || 'cli';
}

// ─── helpers ────────────────────────────────────────────────────────────

function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: any; ms: number }> {
  const t0 = Date.now();
  return fn().then((value) => ({ value, ms: Date.now() - t0 }), (error) => ({ error, ms: Date.now() - t0 }));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms} ms`), { code: 'ETIMEDOUT' })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// ─── individual checks ──────────────────────────────────────────────────

async function checkLoopback(): Promise<string> {
  // Bind AND connect: some sandboxes allow one but not the other.
  return withTimeout(new Promise<string>((resolve, reject) => {
    const srv = net.createServer((s) => s.end());
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      const c = net.connect(port, '127.0.0.1');
      c.once('connect', () => { c.destroy(); srv.close(() => resolve('can bind and connect on 127.0.0.1')); });
      c.once('error', (e: any) => { srv.close(); reject(Object.assign(e, { loopbackConnect: true })); });
    });
  }), 3000, 'loopback');
}

async function checkSpawn(): Promise<string> {
  // The background daemon is a detached child process; some sandboxes forbid that.
  return withTimeout(new Promise<string>((resolve, reject) => {
    let c;
    try { c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true, detached: true }); } catch (e) { reject(e); return; }
    c.once('error', reject);
    c.once('exit', (code) => (code === 0 ? resolve('can start background processes') : reject(new Error(`child exited ${code}`))));
  }), 5000, 'process spawn');
}

async function checkDaemon(port: number): Promise<any> {
  return withTimeout(new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('something else answers on the daemon port')); } });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('something on the daemon port accepts connections but does not answer'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  }), 2000, 'daemon health');
}

async function checkDns(host: string): Promise<string> {
  if (net.isIP(host) || host === 'localhost') return 'no lookup needed (IP address)';
  const addrs = await withTimeout(dns.promises.lookup(host, { all: true }), 4000, 'DNS lookup');
  return addrs.map((a) => a.address).slice(0, 2).join(', ');
}

type HttpsInfo = { summary: string; serverVersion: string | null; clockSkewMs: number | null };
async function checkHttps(base: string): Promise<HttpsInfo> {
  const r: any = await requestJson(`${base}/compat.json`, { timeoutMs: 6000, headers: { 'User-Agent': 'srift-doctor' } });
  if (r.status !== 200) throw Object.assign(new Error(`HTTP ${r.status}`), { code: 'EHTTPSTATUS', status: r.status });
  if (!r.data || typeof r.data !== 'object' || r.data.raw !== undefined) {
    throw Object.assign(new Error('Got HTTP 200 but not SRIFT\'s JSON — a captive portal or filtering proxy is answering instead'), { code: 'EPORTAL' });
  }
  const dateHdr = r.headers?.date ? Date.parse(String(r.headers.date)) : NaN;
  return {
    summary: 'HTTP 200 with a valid body',
    serverVersion: typeof r.data.daemon === 'string' ? r.data.daemon : null,
    clockSkewMs: Number.isFinite(dateHdr) ? Date.now() - dateHdr : null,
  };
}

function checkWs(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { agent: agentFor(url), handshakeTimeout: timeoutMs });
    } catch (e) { reject(e); return; }
    const t = setTimeout(() => { try { ws.terminate(); } catch {} reject(Object.assign(new Error(`no upgrade within ${timeoutMs} ms`), { code: 'ETIMEDOUT' })); }, timeoutMs + 200);
    ws.once('open', () => { clearTimeout(t); try { ws.close(); } catch {} resolve(`upgrade OK in ${Date.now() - t0} ms`); });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(t);
      try { ws.terminate(); } catch {}
      reject(Object.assign(new Error(`upgrade refused (HTTP ${res.statusCode}) — a proxy may be stripping WebSocket upgrades`), { code: 'EWSUPGRADE' }));
    });
    ws.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function checkUdp(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let sock: dgram.Socket;
    try { sock = dgram.createSocket('udp4'); } catch (e) { reject(e); return; }
    const txid = crypto.randomBytes(12);
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(0x0001, 0); // Binding Request
    msg.writeUInt16BE(0, 2);
    msg.writeUInt32BE(0x2112a442, 4);
    txid.copy(msg, 8);
    const done = (err?: any, v?: string) => {
      clearTimeout(t);
      try { sock.close(); } catch {}
      err ? reject(err) : resolve(v!);
    };
    const t = setTimeout(() => done(Object.assign(new Error(`no STUN response within ${timeoutMs} ms`), { code: 'ETIMEDOUT' })), timeoutMs);
    sock.on('message', (m) => {
      if (m.length >= 20 && m.readUInt16BE(0) === 0x0101 && m.subarray(8, 20).equals(txid)) done(undefined, 'STUN binding response received');
    });
    sock.on('error', (e) => done(e));
    dns.lookup('stun.cloudflare.com', { family: 4 }, (err, addr) => {
      if (err) return done(err);
      sock.send(msg, 3478, addr, (e) => { if (e) done(e); });
    });
  });
}

async function checkProxy(proxyUrl: URL | string): Promise<string> {
  const u = typeof proxyUrl === "string" ? new URL(proxyUrl) : proxyUrl;
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : u.protocol.startsWith('socks') ? 1080 : 80);
  await withTimeout(new Promise<void>((resolve, reject) => {
    const s = net.connect(port, u.hostname);
    s.once('connect', () => { s.destroy(); resolve(); });
    s.once('error', reject);
  }), 3000, 'proxy connect');
  return `reachable at ${u.hostname}:${port}`;
}

async function checkStorage(): Promise<string> {
  const home = path.join(os.homedir(), '.srift');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const probe = path.join(home, `.doctor-${process.pid}`);
  fs.writeFileSync(probe, 'ok'); fs.rmSync(probe, { force: true });
  let free = '';
  try {
    const st: any = (fs as any).statfsSync?.(os.tmpdir());
    if (st) {
      const bytes = Number(st.bavail) * Number(st.bsize);
      free = `, ${(bytes / 1024 ** 3).toFixed(1)} GB free in temp`;
      if (bytes < 512 * 1024 * 1024) throw Object.assign(new Error(`only ${(bytes / 1024 ** 2).toFixed(0)} MB free in ${os.tmpdir()}`), { code: 'ELOWDISK' });
    }
  } catch (e: any) { if (e?.code === 'ELOWDISK') throw e; }
  return `~/.srift writable${free}`;
}

/** Does the system curl work? (Recipients are often told to use it.) */
function checkCurl(base: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const r = spawnSync('curl', ['-sS', '-o', os.devNull, '-w', '%{http_code}', '--max-time', '5', `${base}/compat.json`], { encoding: 'utf8', timeout: 7000, windowsHide: true });
      if (r.error && (r.error as any).code === 'ENOENT') { reject(Object.assign(new Error('curl is not installed'), { code: 'ENOCURL' })); return; }
      if (r.status === 0 && /^2\d\d$/.test(r.stdout.trim())) resolve(`works (HTTP ${r.stdout.trim()})`);
      else reject(Object.assign(new Error(`curl failed (exit ${r.status}${r.stderr ? `: ${r.stderr.trim().split('\n').pop()}` : ''})`), { code: 'ECURL' }));
    } catch (e) { reject(e); }
  });
}

// ─── orchestration ──────────────────────────────────────────────────────

function rungFrom(id: string, name: string, group: RungGroup, r: { value?: string; error?: any; ms: number }, url?: string): Rung {
  if (!r.error) return { id, name, group, status: 'WORKS', detail: r.value || 'OK', ms: r.ms };
  const d = explainNetError(r.error, url);
  let detail = d.message;
  let fix = d.fix;
  if (r.error?.code === 'EPORTAL') { detail = r.error.message; fix = 'Sign in to the network\'s captive portal, or check the proxy configuration.'; }
  if (r.error?.code === 'EWSUPGRADE') { detail = r.error.message; fix = 'Allow WebSocket upgrades to the SRIFT server on port 443 (proxy/firewall setting); relay links need them.'; }
  return { id, name, group, status: 'BLOCKED', detail, fix, ms: r.ms };
}

export type DiagOptions = {
  fresh?: boolean;
  base?: string;
  daemonPort?: number;
  /** Version of the calling CLI/daemon, for compatibility checks. */
  clientVersion?: string;
  /** Real end-to-end relay test (create a link, download it back). Never cached. */
  selfTest?: () => Promise<SelfTestResult>;
};

export async function runDiagnostics(opts: DiagOptions = {}): Promise<DiagReport> {
  const base = (opts.base || apiBase()).replace(/\/+$/, '');
  if (!opts.fresh && !opts.selfTest) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as DiagReport & { schema?: number };
      if (c.schema === CACHE_SCHEMA && c.base === base && Date.now() - Date.parse(c.checkedAt) < CACHE_TTL_MS) return { ...c, cached: true };
    } catch { /* no cache */ }
  }

  const port = opts.daemonPort || parseInt(process.env.SRIFT_DAEMON_PORT || '3822', 10);
  const wsBase = base.replace(/^http/, 'ws');
  const proxy = getProxyForUrl(base);
  const sandbox = detectSandbox();
  const runtime = detectRuntime();
  const host = (() => { try { return new URL(base).hostname; } catch { return base; } })();
  const hostPort = (() => { try { return new URL(base).host; } catch { return base; } })();

  const [dnsR, httpsR, ws, udp, peers, loop, spawnR, daemon, proxyR, storage, curl] = await Promise.all([
    timed(() => checkDns(host)),
    timed(() => checkHttps(base)),
    // 8 s: a slow (not blocked) handshake — via a proxy or a cold server — must
    // not be reported as BLOCKED. Probes run in parallel, so doctor stays fast.
    timed(() => checkWs(`${wsBase}/ws`, 8000)),
    timed(() => checkUdp(1500)),
    timed(() => checkWs(`${wsBase}/v1/peers`, 6000).catch(() => checkWs(`${wsBase}/announce`, 4000))),
    timed(() => checkLoopback()),
    timed(() => checkSpawn()),
    timed(() => checkDaemon(port)),
    proxy ? timed(() => checkProxy(proxy)) : Promise.resolve(null),
    timed(() => checkStorage()),
    timed(() => checkCurl(base)),
  ]);

  const rungs: Rung[] = [];

  // ── connectivity ──
  const dnsRung = rungFrom('dns', `DNS for ${host}`, 'connectivity', dnsR);
  if (dnsRung.status === 'BLOCKED' && proxy) {
    dnsRung.status = 'WARN';
    dnsRung.detail += ' — fine: the proxy resolves names for us';
    delete dnsRung.fix;
  }
  rungs.push(dnsRung);
  if (proxyR) {
    const pr = rungFrom('proxy', `Proxy ${describeProxy(proxy)}`, 'connectivity', proxyR);
    if (pr.status === 'BLOCKED') pr.fix = 'Check HTTPS_PROXY / HTTP_PROXY: nothing is listening at that address. Unset it if you are not behind a proxy.';
    rungs.push(pr);
  }
  const httpsRung = rungFrom('https', `HTTPS to ${hostPort}`, 'connectivity', { ...httpsR, value: httpsR.value?.summary });
  if (httpsRung.status === 'BLOCKED' && /certificate|self[- ]signed|issuer/i.test(`${httpsR.error?.code} ${httpsR.error?.message}`)) {
    httpsRung.fix = 'A TLS-inspecting proxy is re-signing traffic. Point NODE_EXTRA_CA_CERTS at its root CA (PEM). Never disable TLS verification.';
  }
  rungs.push(httpsRung);
  const skew = httpsR.value?.clockSkewMs ?? null;
  if (skew !== null && Math.abs(skew) > 5 * 60 * 1000) {
    rungs.push({ id: 'clock', name: 'System clock', group: 'connectivity', status: 'WARN',
      detail: `off by ${Math.round(skew / 60000)} min versus the server`, fix: 'Sync the system clock (NTP). Large skew breaks TLS and makes --ttl links expire early/late.' });
  }
  const wsRung = rungFrom('websocket', `WebSocket relay to ${hostPort}`, 'connectivity', ws, `${wsBase}/ws`);
  if (wsRung.status === 'WORKS' && ws.ms > 3000) {
    wsRung.status = 'WARN';
    wsRung.detail += ' — slow handshake (proxy or cold server); links still work';
  }
  rungs.push(wsRung);
  const udpRung = rungFrom('udp', 'UDP (direct P2P / STUN)', 'connectivity', udp);
  if (udpRung.status === 'BLOCKED') { udpRung.status = 'WARN'; udpRung.fix = 'Not required: links and relays work over HTTPS/WebSocket on port 443 (large files are just slower).'; }
  rungs.push(udpRung);
  const peersRung = rungFrom('peers', 'Peer discovery (swarm bonus)', 'connectivity', peers, `${wsBase}/v1/peers`);
  if (peersRung.status === 'BLOCKED') { peersRung.status = 'WARN'; peersRung.fix = 'Not required: SRIFT falls back to the WebSocket relay automatically.'; }
  rungs.push(peersRung);

  // ── local runtime ──
  const loopRung = rungFrom('loopback', 'Local daemon port (loopback)', 'runtime', { ...loop, value: loop.value });
  if (loopRung.status === 'BLOCKED') {
    loopRung.status = 'WARN';
    loopRung.detail = loop.error?.loopbackConnect
      ? `Loopback connections are blocked (${loop.error?.code || loop.error?.message}).`
      : `Cannot listen on 127.0.0.1 (${loop.error?.code || loop.error?.message}) — local servers are forbidden here.`;
    loopRung.fix = 'Handled automatically: quick-share and mcp serve from their own process (embedded daemon, no port).';
  }
  rungs.push(loopRung);
  const spawnRung = rungFrom('spawn', 'Background processes', 'runtime', spawnR);
  if (spawnRung.status === 'BLOCKED') {
    spawnRung.status = 'WARN';
    spawnRung.fix = 'Handled automatically: the daemon runs inside the quick-share / mcp process instead.';
  }
  rungs.push(spawnRung);
  const daemonVersion: string | null = daemon.value?.version || null;
  if (daemon.error) {
    const other = /something/.test(String(daemon.error?.message));
    rungs.push({ id: 'daemon', name: 'Daemon', group: 'runtime', status: other ? 'WARN' : 'SKIPPED',
      detail: other ? `port ${port}: ${daemon.error.message}` : 'not running (starts automatically when needed)',
      ...(other ? { fix: `Another program holds port ${port}. SRIFT falls back to embedded mode; to use a background daemon set SRIFT_DAEMON_PORT to a free port.` } : {}),
      ms: daemon.ms });
  } else {
    const stale = opts.clientVersion && daemonVersion && cmpVersion(daemonVersion, opts.clientVersion) !== 0;
    rungs.push({ id: 'daemon', name: 'Daemon', group: 'runtime', status: stale ? 'WARN' : 'WORKS',
      detail: `v${daemonVersion || '?'} on port ${port}${stale ? ` — differs from this CLI (v${opts.clientVersion})` : ''}`,
      ...(stale ? { fix: 'Restart it to load the installed version: srift daemon restart' } : {}), ms: daemon.ms });
  }
  const storageRung = rungFrom('storage', 'Local storage', 'runtime', storage);
  if (storageRung.status === 'BLOCKED' && storage.error?.code === 'ELOWDISK') {
    storageRung.status = 'WARN';
    storageRung.fix = 'Free disk space: encrypted links and folder bundles are staged in the temp directory.';
  } else if (storageRung.status === 'BLOCKED') {
    storageRung.fix = 'Make ~/.srift writable (or set HOME to a writable directory).';
  }
  rungs.push(storageRung);
  const serverVersion = httpsR.value?.serverVersion ?? null;
  if (opts.clientVersion && serverVersion && cmpVersion(serverVersion, opts.clientVersion) > 0) {
    rungs.push({ id: 'version', name: 'CLI version', group: 'runtime', status: 'WARN',
      detail: `v${opts.clientVersion}; the server's current release is v${serverVersion}`, fix: 'Update: srift self-update (or npx -y srift-transfer@latest …)' });
  } else if (opts.clientVersion) {
    rungs.push({ id: 'version', name: 'CLI version', group: 'runtime', status: 'WORKS', detail: `v${opts.clientVersion}${serverVersion ? ` (server v${serverVersion})` : ''}` });
  }

  // ── environment ──
  const curlRung = rungFrom('curl', 'curl (for recipients)', 'environment', curl);
  if (curlRung.status === 'BLOCKED') {
    curlRung.status = curl.error?.code === 'ENOCURL' ? 'SKIPPED' : 'WARN';
    curlRung.detail = curl.error?.message || curlRung.detail;
    curlRung.fix = 'Not required: tell recipients to use `srift get <url>` or `npx -y srift-transfer get <url>` (proxy-aware, resumable, decrypts).';
  }
  rungs.push(curlRung);
  rungs.push({ id: 'context', name: 'Running as', group: 'environment', status: 'WORKS',
    detail: `${runtime}${sandbox.detected ? ` · ${sandbox.hints.join(', ')}` : ''}` });

  // ── verdict + plan ──
  const httpsOk = !httpsR.error;
  const relayOk = httpsOk && !ws.error;
  const localDaemonOk = !loop.error && !spawnR.error && !(daemon.error && /something/.test(String(daemon.error?.message)));
  const p2pOk = !udp.error || !peers.error;
  const verdict: DiagReport['verdict'] = !relayOk ? 'blocked'
    : rungs.some((r) => r.status === 'WARN' && !['udp', 'peers', 'curl', 'dns'].includes(r.id)) || !p2pOk || !localDaemonOk ? 'degraded' : 'ok';
  const serveFrom: DiagReport['plan']['serveFrom'] = !relayOk ? 'unavailable' : localDaemonOk ? 'background-daemon' : 'embedded';

  const advice: string[] = [];
  if (!relayOk) advice.push('Links cannot be served until HTTPS and the WebSocket relay work — fix the first BLOCKED line.');
  if (serveFrom === 'embedded') {
    advice.push(runtime === 'mcp'
      ? 'MCP serves links from its own process: they stay live while this MCP session runs.'
      : 'quick-share serves from its own process here: run it in the background (or with --wait) — it exits after the download.');
  }
  if (serveFrom === 'background-daemon') advice.push('Links are served by the background daemon, which keeps running after quick-share returns.');
  if (sandbox.ephemeral && relayOk) advice.push('Ephemeral environment: use `--wait` so the job stays up until the recipient has downloaded.');
  if (proxy) advice.push(`All traffic goes through the proxy (${describeProxy(proxy)}); WebSocket relay uses HTTP CONNECT.`);
  if (!p2pOk && relayOk) advice.push('Direct P2P is unavailable: transfers use the relay on 443 (works; large files are slower).');
  if (curl.error && curl.error.code !== 'ENOCURL') advice.push('curl is broken here: recipients should use `srift get <url>` instead.');
  advice.push('Use --encrypt for anything sensitive (the key stays in the #k= part of the link).');

  const transport = !relayOk ? 'none' : p2pOk ? 'relay (443) + direct P2P when both sides allow' : 'relay over HTTPS/WSS 443';
  const shareCommand = serveFrom === 'unavailable' ? '(fix connectivity first)'
    : `srift quick-share <file> --encrypt${serveFrom === 'embedded' || sandbox.ephemeral ? ' --wait' : ''}`;
  const summary = verdict === 'blocked'
    ? 'SRIFT links cannot be served from here. Fix the first BLOCKED line below.'
    : serveFrom === 'embedded'
      ? 'Links work. No background daemon here, so quick-share and mcp serve from their own process (no port).'
      : verdict === 'ok'
        ? 'Everything works.'
        : 'Links work, with caveats listed below.';

  let selfTest: SelfTestResult | undefined;
  if (opts.selfTest) {
    if (!relayOk) selfTest = { ok: false, ms: 0, bytes: 0, error: 'skipped: relay unreachable' };
    else {
      const t0 = Date.now();
      try { selfTest = await opts.selfTest(); } catch (e: any) { selfTest = { ok: false, ms: Date.now() - t0, bytes: 0, error: e?.message || String(e) }; }
    }
    rungs.push(selfTest.ok
      ? { id: 'selftest', name: 'End-to-end self-test', group: 'connectivity', status: 'WORKS',
        detail: `encrypted link created + downloaded back, ${(selfTest.bytes / 1024 / 1024).toFixed(1)} MB in ${selfTest.ms} ms${selfTest.mbps ? ` (${selfTest.mbps.toFixed(1)} MB/s)` : ''}${selfTest.via ? ` via ${selfTest.via}` : ''}`, ms: selfTest.ms }
      : { id: 'selftest', name: 'End-to-end self-test', group: 'connectivity', status: 'BLOCKED', detail: selfTest.error || 'failed', fix: 'Run `srift doctor --deep --json` and share the output; check `srift logs`.' });
  }

  const report: DiagReport = {
    ok: verdict !== 'blocked' && (!selfTest || selfTest.ok),
    verdict: selfTest && !selfTest.ok && verdict === 'ok' ? 'degraded' : verdict,
    recommendedMode: relayOk ? 'relay' : 'none',
    summary,
    rungs,
    plan: { serveFrom, transport, shareCommand, downloadCommand: 'srift get <url>   (or: npx -y srift-transfer get <url>)', advice },
    context: { runtime, cliVersion: opts.clientVersion || null, serverVersion, daemonVersion },
    ...(selfTest ? { selfTest } : {}),
    env: {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      proxy: describeProxy(proxy),
      noProxy: process.env.NO_PROXY || process.env.no_proxy || null,
      extraCaCerts: process.env.NODE_EXTRA_CA_CERTS || null,
      sandbox,
    },
    base,
    checkedAt: new Date().toISOString(),
  };
  if (!opts.selfTest) {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...report, schema: CACHE_SCHEMA }), { mode: 0o600 });
    } catch { /* read-only home: fine */ }
  }
  return report;
}

/** Exit code for `srift doctor`: 0 all good, 1 degraded but usable, 2 nothing works. */
export function diagExitCode(r: DiagReport): number {
  return r.verdict === 'ok' ? 0 : r.verdict === 'degraded' ? 1 : 2;
}

export function formatDiagnostics(r: DiagReport): string {
  const icon = (s: RungStatus) => (s === 'WORKS' ? '✓' : s === 'BLOCKED' ? '✗' : s === 'WARN' ? '!' : '–');
  const lines: string[] = [];
  lines.push('');
  lines.push(`srift doctor — ${r.verdict.toUpperCase()}${r.cached ? ' (cached; --fresh to re-run)' : ''}`);
  lines.push(`  ${r.summary}`);
  const titles: Record<RungGroup, string> = { connectivity: 'Connectivity', runtime: 'This machine', environment: 'Environment' };
  for (const g of ['connectivity', 'runtime', 'environment'] as RungGroup[]) {
    const rs = r.rungs.filter((x) => (x.group || 'connectivity') === g);
    if (!rs.length) continue;
    lines.push('');
    lines.push(`  ${titles[g]}`);
    for (const x of rs) {
      lines.push(`  ${icon(x.status)} ${x.status.padEnd(7)} ${x.name.padEnd(32)} ${x.detail}${x.ms !== undefined && x.id !== 'selftest' ? `  (${x.ms} ms)` : ''}`);
      if (x.fix && (x.status === 'BLOCKED' || x.status === 'WARN')) lines.push(`  ${' '.repeat(10)}Fix: ${x.fix}`);
    }
  }
  if (r.plan) {
    lines.push('');
    lines.push('  What to do here');
    lines.push(`    Links served by: ${r.plan.serveFrom}    transport: ${r.plan.transport}`);
    lines.push(`    Share:    ${r.plan.shareCommand}`);
    lines.push(`    Download: ${r.plan.downloadCommand}`);
    for (const a of r.plan.advice) lines.push(`    • ${a}`);
  }
  lines.push('');
  lines.push(`  Proxy: ${r.env.proxy}${r.env.noProxy ? `  NO_PROXY=${r.env.noProxy}` : ''}${r.env.extraCaCerts ? `  NODE_EXTRA_CA_CERTS=${r.env.extraCaCerts}` : ''}`);
  lines.push(`  Node ${r.env.node} on ${r.env.platform}; server ${r.base}${r.selfTest ? '' : '    (add --deep for an end-to-end self-test)'}`);
  lines.push('');
  return lines.join('\n');
}
