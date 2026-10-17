import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import { WebSocket } from 'ws';
import { webcrypto } from 'crypto';
import fs from 'fs';
import http from 'http';
import { Duplex } from 'stream';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { handleMcpMessage, MCP_TOOLS, MCP_RESOURCES, MCP_PROMPTS } from './mcp.ts';
import { PROTOCOL_VERSION } from '../lib/mcp/core.mjs';
import { Keyring, isPk1, isPublicKey, relaySender, relayReceiver, RELAY_PK_SCHEME } from '../lib/e2e-keys.ts';
import { agentFor, requestJson, formatNetError } from './net.ts';
import { NodeHttpStreamSocket } from './http-stream.ts';
import { runDiagnostics, type DiagReport } from './probe.ts';
type ShareResult = {
  success: true;
  mode: 'relay';
  downloadUrl: string;
  token: string;
  fileName: string;
  fileSize: number;
  maxDownloads: number;
  expiresAt: number | null;
  encrypted: boolean;
  passwordProtected?: boolean;
  sessionId?: string | null;
  fileId?: string;
};
import { b64url, encryptFile, encryptedSize, newLinkKey } from './e2ee.ts';
import { packDirectory, packPaths, mapLimit, DEFAULT_EXCLUDES } from './pack.ts';

// ─── WebTorrent: lazy load so daemon still starts when native deps are missing ───
// `webtorrent` transitively pulls `utp-native` + `node-datachannel`. Those don't
// bundle into Bun's --compile single-file binary, so we load lazily on first
// torrent use. If they fail to load (e.g. compiled win-x64 binary), the daemon
// stays alive and falls back to WebSocket-chunked transfer only. WebTorrent
// large-file mode is then unavailable but every other surface (REST, MCP, chat,
// session, small/medium file transfer) keeps working.
let _WebTorrentCtor: any = null;
let _webTorrentLoadError: string | null = null;
async function loadWebTorrent(): Promise<any> {
  if (_WebTorrentCtor) return _WebTorrentCtor;
  if (_webTorrentLoadError) throw new Error(_webTorrentLoadError);
  try {
    const mod = await import('webtorrent');
    _WebTorrentCtor = (mod as any).default || mod;
    return _WebTorrentCtor;
  } catch (err: any) {
    _webTorrentLoadError = `WebTorrent unavailable (likely missing native module): ${err?.message || err}`;
    console.error('[DAEMON]', _webTorrentLoadError);
    throw new Error(_webTorrentLoadError);
  }
}

// ─── Fixed, per-user state home (was CWD-relative — persisted local file paths,
// session/user IDs, etc. to whatever directory the daemon happened to be
// launched from, with no single canonical location and no cleanup). All daemon
// disk artefacts now live under one place regardless of CWD.
const SRIFT_HOME = path.join(os.homedir(), '.srift');
try {
  fs.mkdirSync(SRIFT_HOME, { recursive: true, mode: 0o700 });
  // mkdirSync's `mode` only applies on creation; make sure it's locked down
  // even if the directory already existed from an older, laxer version.
  try { fs.chmodSync(SRIFT_HOME, 0o700); } catch {}
} catch (e: any) {
  // Fall back silently — worst case we inherit the platform default perms.
}
// Embedded mode: this module runs inside the CLI / MCP process instead of as
// a background daemon — no TCP port is opened (sandboxes that forbid local
// servers, blocked detached spawns, blocked loopback). Requests reach the
// Express app in-process via embeddedDispatch(); links stay live while the
// host process runs. Set by the importer before `import('./daemon.ts')`.
const EMBEDDED = process.env.SRIFT_DAEMON_EMBEDDED === '1';
const STATE_PATH = path.join(SRIFT_HOME, EMBEDDED ? 'state-embedded.json' : 'state.json');

// Redirect console logs to ~/.srift/daemon.log in the daemon itself to protect from parent process exit crashes
const logPath = path.join(SRIFT_HOME, 'daemon.log');
// Keep the log bounded while the daemon runs (daemon.log + one previous generation, each
// at most DAEMON_LOG_MAX bytes) and private to the user. Only the latest activity is kept.
const DAEMON_LOG_MAX = 1024 * 1024;
const openLog = () => fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
let logBytes = 0;
try { logBytes = fs.statSync(logPath).size; } catch { /* no log yet */ }
// Age limit on top of the size cap: a generation older than a week is dropped
// (checked at start and every 6 hours), matching Peerknock's log retention.
const DAEMON_LOG_MAX_AGE_MS = 7 * 24 * 3600_000;
const pruneOldLogs = (): void => {
  for (const f of [`${logPath}.1`, logPath]) {
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > DAEMON_LOG_MAX_AGE_MS) {
        if (f === logPath) { fs.truncateSync(f, 0); logBytes = 0; } else fs.rmSync(f, { force: true });
      }
    } catch { /* missing */ }
  }
};
pruneOldLogs();
setInterval(pruneOldLogs, 6 * 3600_000).unref();
let logStream = openLog();
try { fs.chmodSync(logPath, 0o600); } catch { /* not supported (Windows ACLs) */ }
let logRotating = false;
const logPending: string[] = [];
const writeLogLine = (line: string): void => {
  if (logRotating) { if (logPending.length < 1000) logPending.push(line); return; }
  if (logBytes + line.length > DAEMON_LOG_MAX) {
    logRotating = true;
    logPending.push(line);
    logStream.end(() => {
      try { fs.rmSync(`${logPath}.1`, { force: true }); fs.renameSync(logPath, `${logPath}.1`); } catch { /* keep appending */ }
      logStream = openLog();
      logBytes = 0;
      logRotating = false;
      for (const l of logPending.splice(0)) writeLogLine(l);
    });
    return;
  }
  logStream.write(line);
  logBytes += Buffer.byteLength(line);
};
const logMessage = (level: string, message: string) => {
  writeLogLine(`[${new Date().toISOString()}] [${level}] ${String(message).slice(0, 4000)}\n`);
};
// Errors serialize to {} with JSON.stringify; keep their message (and code).
const fmtLogArg = (arg: any): string => arg instanceof Error ? `${arg.name}: ${arg.message}${(arg as any).code ? ` [${(arg as any).code}]` : ''}` : typeof arg === 'object' ? (() => { try { return JSON.stringify(arg); } catch { return String(arg); } })() : String(arg);
(globalThis as any).__sriftConsole ||= { log: console.log, error: console.error, warn: console.warn };
console.log = (...args: any[]) => {
  logMessage('INFO', args.map(fmtLogArg).join(' '));
};
console.error = (...args: any[]) => {
  logMessage('ERROR', args.map(fmtLogArg).join(' '));
};
console.warn = (...args: any[]) => {
  logMessage('WARN', args.map(fmtLogArg).join(' '));
};

const crypto = (globalThis.crypto || webcrypto) as any;

// Load env variables
dotenv.config({ path: '.env.local' });
dotenv.config();

// Global Exception Handlers to prevent crashes from third-party WebRTC/P2P teardown
process.on('uncaughtException', (err) => {
  console.error('[DAEMON] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[DAEMON] Unhandled Rejection at:', promise, 'reason:', reason);
});

const PORT = parseInt(process.env.SRIFT_DAEMON_PORT || '3822', 10);
const DEFAULT_SIGNALER_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8080';

// Active Signaler URL that can dynamically fallback to production
let activeSignalerUrl = DEFAULT_SIGNALER_URL;

async function selectSignalerUrl(): Promise<void> {
  // If the configured signaler is local, ping it to check if it's running
  if (DEFAULT_SIGNALER_URL.includes('127.0.0.1') || DEFAULT_SIGNALER_URL.includes('localhost')) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3000);
      // Probe a static file, not '/': the home page is a full render that can
      // exceed the timeout under load and silently send us to production.
      const probe = await fetch(`${DEFAULT_SIGNALER_URL.replace(/\/+$/, '')}/compat.json`, { signal: controller.signal }); // loopback only: never proxied
      clearTimeout(id);
      // Port 8080 is a common port. Only a server that answers with SRIFT's own
      // compatibility document is a local signaler; anything else listening there is not.
      const compat: any = probe.ok ? await probe.json().catch(() => null) : null;
      if (!compat || typeof compat.wireVersion !== 'number' || typeof compat.daemon !== 'string') {
        throw new Error('not a SRIFT server');
      }
      console.log(`[DAEMON] Local signaler detected at ${DEFAULT_SIGNALER_URL}`);
    } catch (e) {
      console.log(`[DAEMON] Local signaler at ${DEFAULT_SIGNALER_URL} is unreachable. Falling back to production signaler: https://srift.app`);
      activeSignalerUrl = 'https://srift.app';
    }
  }
}

// POST JSON to the signaler through the proxy-aware HTTP layer (the global
// fetch() ignores HTTPS_PROXY). Throws Error with .status on HTTP errors.
async function signalerPost(pathname: string, body: unknown): Promise<any> {
  const url = `${activeSignalerUrl}${pathname}`;
  let r;
  try {
    r = await requestJson(url, { method: 'POST', json: body, timeoutMs: 20_000, headers: { 'User-Agent': `srift-daemon/${PACKAGE_VERSION}` } });
  } catch (e: any) {
    throw Object.assign(new Error(formatNetError(e, url)), { code: e?.code });
  }
  if (r.status < 200 || r.status >= 300) {
    throw Object.assign(new Error(r.data?.error || `Signaler returned status ${r.status}`), { status: r.status });
  }
  return r.data;
}

// ─── Capability probe (cached) ───
let lastDiag: DiagReport | null = null;
async function getDiag(fresh = false): Promise<DiagReport> {
  if (!fresh && lastDiag && Date.now() - Date.parse(lastDiag.checkedAt) < 10 * 60 * 1000) return lastDiag;
  lastDiag = await runDiagnostics({ fresh, base: publicApiBase(), daemonPort: PORT, clientVersion: PACKAGE_VERSION });
  return lastDiag;
}
function publicApiBase(): string {
  const local = activeSignalerUrl.includes('127.0.0.1') || activeSignalerUrl.includes('localhost');
  return (process.env.SRIFT_API_BASE || (local ? activeSignalerUrl : process.env.SRIFT_PUBLIC_BASE) || 'https://srift.app').replace(/\/+$/, '');
}
/** WebTorrent is a bonus path: only construct it when peer discovery was reachable. */
function webTorrentAllowed(): boolean {
  if (process.env.SRIFT_DISABLE_WEBTORRENT === '1') return false;
  const peers = lastDiag?.rungs.find((r) => r.id === 'peers');
  return !peers || peers.status === 'WORKS';
}

// Wait until the signaling socket is open and host auth completed (csrf token issued).
async function waitForHostAuth(timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (wsConn && wsConn.readyState === WebSocket.OPEN && csrfToken) return;
    if (sessionTerminated) throw new Error(terminationReason || 'Session terminated');
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out connecting to the SRIFT signaling server over WebSocket');
}

// In-memory daemon state
let session: {
  id: string | null;
  name: string | null;
  role: 'host' | 'guest' | null;
  isConnected: boolean;
  userId: string | null;
  tempUserId?: string | null;
  wsToken?: string | null;
  roomSecret?: string | null;
  /** The name this daemon joined with (sent again on every request_join). */
  username?: string | null;
} = {
  id: null,
  name: null,
  role: null,
  isConnected: false,
  userId: null,
};

let activeTransfers: Array<{
  fileId: string;
  name: string;
  size: number;
  progress: number; // percentage (0 - 100)
  speedKBps: number;
  etaSeconds: number;
  protocol: 'websocket' | 'webtorrent';
  status: 'pending' | 'uploading' | 'downloading' | 'completed' | 'cancelled' | 'error';
  direction: 'upload' | 'download';
  /** Upload to several people: the outcome per recipient. `status` is derived from these. */
  recipients?: Record<string, 'uploading' | 'completed' | 'cancelled' | 'error'>;
  filePath?: string;
  saveDir?: string;
  peerId?: string;
/** Download: 'plain' or the scheme ('sgcm1' / 'pgcm1') — a transfer never mixes them (downgrade guard). */
  relayMode?: string;
  bytesTransferred: number;
  chunksCount: number;
  /** Set once assembly starts (file_complete, or every chunk received and file_complete lost). */
  assembling?: boolean;
  totalChunks: number;
  startTime: number;
}> = [];

let chatHistory: Array<{
  messageId: string;
  sender: string;
  content: string;
  timestamp: string;
}> = [];

let pendingJoins: Array<{
  tempUserId: string;
  username: string;
}> = [];

/** Session members from the server's `user_list` (the host needs their ids to kick). */
let participants: Array<{ userId: string; username: string; isHost: boolean; online: boolean }> = [];

let sseClients: any[] = [];
let wsConn: WebSocket | NodeHttpStreamSocket | null = null;
// Signaling transport: WebSocket first. Two WebSocket attempts in a row that never open, or are cut
// before the session authenticates (proxies that strip Upgrade or kill upgraded connections), switch
// to the HTTPS session stream; a WebSocket is tried again every 10 minutes after that.
// SRIFT_SIGNALING=http forces the HTTPS stream.
let signalingMode: 'ws' | 'http' = process.env.SRIFT_SIGNALING === 'http' ? 'http' : 'ws';
let wsFailures = 0;
let httpModeSince = 0;
const WS_RETRY_AFTER_MS = 10 * 60_000;
let wsUrl: string | null = null;
let csrfToken: string | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let lastHeartbeatAckAt = 0;
let encryptionKey: any = null;
// Set when the server terminates this connection fatally (e.g. host rejected
// our join, or kicked us). Suppresses the auto-reconnect loop so a rejected
// peer doesn't keep re-appearing as "connected".
let sessionTerminated = false;
let terminationReason: string | null = null;

// Track active WebTorrent seed/download tasks so we can destroy/cancel them
const activeTorrents: Map<string, any> = new Map();
let wtClient: any = null;

// ─── Public-share state (direct HTTPS downloads via signaler tunnel) ───
// pubshares: fileId => { token?, filePath, filename, size, mime }
//   token is filled once the signaler ACKs the registration.
// activePulls: requestId => AbortController-ish flag for in-flight stream.
type PubshareEntry = {
  token: string | null;
  filePath: string;
  filename: string;
  size: number;
  mime: string;
  fileId: string;
  downloadUrl: string | null;
  maxDownloads: number;        // 0 = unlimited
  expiresAt: number | null;    // epoch ms, null = never
  downloadCount: number;
  completedDownloads?: number; // full downloads that finished streaming
  createdAt: number;
  encrypted?: boolean;         // served bytes are SRE1 ciphertext
  linkKey?: string;            // base64url fragment key (kept in memory only)
  tempFile?: string;           // pre-encrypted copy to delete on revoke/stop
  displayName?: string;        // recipient-visible name (encrypted links register a generic one)
  prefixLen?: number;          // SRE1 header + encrypted metadata length (for ?peek=1)
  claim?: string;              // server-issued secret: reclaims this token after a new session
};
const pubshares: Map<string, PubshareEntry> = new Map(); // by fileId
const pubsharesByToken: Map<string, PubshareEntry> = new Map();
const activePulls: Map<string, { cancelled: boolean; token?: string }> = new Map();
// Resolvers waiting for pubshare_register_ack, keyed by fileId
const pubshareRegResolvers: Map<string, (entry: PubshareEntry) => void> = new Map();

async function getWtClient() {
  if (!wtClient) {
    const WTCtor = await loadWebTorrent();
    // Peers come only from SRIFT's session-scoped tracker. The public BitTorrent DHT and local service
    // discovery would announce the transfer's infohash to anyone, and WebTorrent seeds the file bytes as
    // they are, so a stranger who saw the hash could download the file.
    wtClient = new WTCtor({ dht: false, lsd: false, utPex: false });
  }
  return wtClient;
}
function getWtClientOrNull() {
  // Synchronous accessor — returns existing instance, never creates.
  return wtClient;
}

// Temporary folder for chunks
const TEMP_DIR = path.join(SRIFT_HOME, 'tmp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 });
}
// Pre-encrypted relay copies (*.sre1) only live as long as this daemon's
// in-memory link table; anything left from a previous run is orphaned.
// Leftovers of a crashed or killed process are swept by age, so files a live
// process (e.g. an embedded `quick-share --keep-alive`) still serves are kept:
// transfer chunks after 24 h, packed archives and anything else after 7 days.
const TMP_CHUNK_MAX_AGE_MS = 24 * 3600_000;
const TMP_FILE_MAX_AGE_MS = 7 * 24 * 3600_000;
try {
  const now = Date.now();
  for (const f of fs.readdirSync(TEMP_DIR)) {
    const fp = path.join(TEMP_DIR, f);
    try {
      if (f.endsWith('.sre1')) { fs.unlinkSync(fp); continue; }
      const age = now - fs.statSync(fp).mtimeMs;
      if (age > (f.includes('_chunk_') ? TMP_CHUNK_MAX_AGE_MS : TMP_FILE_MAX_AGE_MS)) fs.rmSync(fp, { recursive: true, force: true });
    } catch { /* in use or already gone */ }
  }
} catch {}

// ─── Key Derivation and Encryption ───
const KDF_ITERATIONS = 100_000;
const IV_LEN = 12;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CH)) as unknown as number[]
    );
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(sessionId: string, roomSecret?: string): Promise<any> {
  const encoder = new TextEncoder();
  const salt = encoder.encode(
    'srift-salt-' + sessionId + (roomSecret ? '|rs|' + roomSecret : '')
  );
  const ikm = encoder.encode(sessionId + (roomSecret ? ('::' + roomSecret) : ''));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    ikm,
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encrypt(message: string): Promise<string> {
  if (!encryptionKey) throw new Error('Key not derived');
  const data = new TextEncoder().encode(message);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, data);
  const ct = new Uint8Array(encrypted);
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv);
  combined.set(ct, iv.length);
  return bytesToBase64(combined);
}

async function decrypt(encB64: string): Promise<string> {
  if (!encryptionKey) throw new Error('Key not derived');
  const combined = base64ToBytes(encB64);
  const iv = combined.slice(0, IV_LEN);
  const ciphertext = combined.slice(IV_LEN);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, encryptionKey, ciphertext);
  return new TextDecoder().decode(decrypted);
}

// ─── Session relay chunk sealing (wire-compatible with lib/relay-crypto.ts) ───
// File chunks relayed through the server are AES-256-GCM sealed when the
// receiver advertises `relayEnc: 'sgcm1'` in file_accept (browsers and this
// daemon do), so the relay only forwards ciphertext. Frame: chunk = number
// array of iv(12) || ciphertext || tag(16), AAD "sgcm1|<fileId>|<index>|<total>".
// Receivers that do not advertise it (older CLI daemons) get the legacy
// base64 plaintext frame. Like the browser, the relay key is derived from the
// session id alone.
const RELAY_ENC = 'sgcm1';
let relayKeyCache: { sessionId: string; key: Promise<any> } | null = null;
function relayKey(): Promise<any> {
  if (!session.id) return Promise.reject(new Error('No active session'));
  if (relayKeyCache?.sessionId !== session.id) relayKeyCache = { sessionId: session.id, key: deriveKey(session.id) };
  return relayKeyCache.key;
}
function relayAad(fileId: string, chunkIndex: number, totalChunks: number): Uint8Array {
  return new TextEncoder().encode(`${RELAY_ENC}|${fileId}|${chunkIndex}|${totalChunks}`);
}
async function sealRelayChunk(plain: Uint8Array, fileId: string, chunkIndex: number, totalChunks: number): Promise<number[]> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: relayAad(fileId, chunkIndex, totalChunks) }, await relayKey(), plain));
  const out = new Uint8Array(IV_LEN + ct.length);
  out.set(iv);
  out.set(ct, IV_LEN);
  return Array.from(out);
}
/** Plaintext bytes of a relay frame: sealed (sgcm1), browser plaintext (byte array) or legacy CLI (base64). */
async function openRelayChunk(p: { fileId: string; chunk: unknown; chunkIndex: number; totalChunks: number; enc?: unknown }): Promise<Buffer> {
  if (p.enc === undefined || p.enc === null) {
    if (typeof p.chunk === 'string') return Buffer.from(p.chunk, 'base64');
    if (Array.isArray(p.chunk)) return Buffer.from(p.chunk as number[]);
    throw new Error('relay chunk is neither base64 nor a byte array');
  }
  if (p.enc === RELAY_PK_SCHEME) {
    const rx = relayReceivers.get(p.fileId);
    const sealed = typeof p.chunk === 'string' ? new Uint8Array(Buffer.from(p.chunk, 'base64')) : Array.isArray(p.chunk) ? Uint8Array.from(p.chunk as number[]) : null;
    if (!rx || !sealed) throw new Error(`relay chunk ${p.chunkIndex} of ${p.fileId} is sealed for a key this daemon does not hold`);
    try {
      return Buffer.from(await (await rx).open(sealed, p.chunkIndex, p.totalChunks));
    } catch {
      throw new Error(`relay chunk ${p.chunkIndex} of ${p.fileId} failed authentication (tampered data or wrong key)`);
    }
  }
  if (p.enc !== RELAY_ENC) throw new Error(`unsupported relay encryption scheme: ${String(p.enc)}`);
  if (!Array.isArray(p.chunk) && typeof p.chunk !== 'string') throw new Error('sealed relay chunk is not a byte array');
  // A base64 string (fast relay format) or the legacy JSON number array.
  const data = typeof p.chunk === 'string' ? new Uint8Array(Buffer.from(p.chunk, 'base64')) : Uint8Array.from(p.chunk as number[]);
  if (data.length < IV_LEN + 16) throw new Error('sealed relay chunk too short');
  try {
    return Buffer.from(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: data.slice(0, IV_LEN), additionalData: relayAad(p.fileId, p.chunkIndex, p.totalChunks) },
      await relayKey(), data.slice(IV_LEN)));
  } catch {
    throw new Error(`relay chunk ${p.chunkIndex} of ${p.fileId} failed authentication (wrong session key or tampered data)`);
  }
}

// ─── Participant-only keys (lib/e2e-keys.ts) ───
// Chat copies and relayed chunks sealed with keys the server never sees. Used only with members
// that advertised support; everything else keeps the session-key path above.
let keyring: { sessionId: string; ring: Promise<Keyring> } | null = null;
function sessionKeyring(): Promise<Keyring> {
  if (!session.id) return Promise.reject(new Error('No active session'));
  if (keyring?.sessionId !== session.id) keyring = { sessionId: session.id, ring: Keyring.create(session.id, session.roomSecret) };
  return keyring.ring;
}
async function announceKey(to?: string) {
  try {
    const ring = await sessionKeyring();
    wsConn?.send(JSON.stringify({ type: 'e2e_key', payload: { pk: ring.publicKey, ...(to ? { to } : {}) } }));
  } catch (e: any) { console.warn(`[DAEMON] Could not announce the member key: ${e?.message || e}`); }
}
/** pk1 when every other online member advertised a key; the session-key format otherwise. */
async function sealChatContent(message: string): Promise<string> {
  try {
    const ring = await sessionKeyring();
    const to = participants.filter((p) => p.online && p.userId !== session.userId).map((p) => p.userId);
    if (to.length && ring.covers(to)) {
      const sealed = await ring.sealChat(message, to);
      if (sealed.length <= 200 * 1024) { console.log(`[DAEMON] Chat sealed pk1 for ${to.length} member(s)`); return sealed; }
    }
  } catch (e: any) { console.warn(`[DAEMON] pk1 sealing failed, using the session key: ${e?.message || e}`); }
  console.log(`[DAEMON] Chat sealed with the session key (members online: ${participants.filter((p) => p.online && p.userId !== session.userId).length}, keys known: ${keyring?.sessionId === session.id ? (await keyring.ring).peers.size : 0})`);
  return encrypt(message);
}
const relayReceivers = new Map<string, Promise<Awaited<ReturnType<typeof relayReceiver>>>>();
const relaySenders = new Map<string, Promise<Awaited<ReturnType<typeof relaySender>>>>();
/** Per-transfer keys live as long as recent transfers; the oldest go first. */
function remember<V>(m: Map<string, V>, k: string, v: V) {
  m.set(k, v);
  while (m.size > 256) m.delete(m.keys().next().value as string);
}

// ─── Tracker list for WebTorrent ───
const PUBLIC_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
];
function getTrackers(sessionId: string): string[] {
  const list: string[] = [];
  try {
    const signalerUrl = wsUrl || activeSignalerUrl;
    const trackerUrl = signalerUrl.replace(/^http/, 'ws').replace(/\/(ws|v1\/stream)$/, '/v1/peers');
    // ?s= lets a multi-instance server route every peer of this session to the section's home tracker.
    if (trackerUrl) list.push(/^[A-Z]{3}\d{4}$/.test(sessionId || '') ? `${trackerUrl}?s=${sessionId}` : trackerUrl);
  } catch {}
  // Extra trackers: SRIFT_EXTRA_TRACKERS=wss://a,wss://b
  for (const t of (process.env.SRIFT_EXTRA_TRACKERS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (/^wss?:\/\//.test(t) && !list.includes(t)) list.push(t);
  }
  // Public trackers only when opted in (SRIFT_PUBLIC_TRACKERS=1): the file is seeded as is, so a public tracker's
  // operator could join the swarm and fetch it. SRIFT's own tracker only serves the session's members.
  if (/^(1|true|on)$/i.test(process.env.SRIFT_PUBLIC_TRACKERS || '')) {
    for (const t of PUBLIC_TRACKERS) if (!list.includes(t)) list.push(t);
  }
  return list;
}

// ─── Workspace State File ───
// Persisted under a fixed per-user location (~/.srift/state.json) rather than
// CWD, so `srift daemon status`/other tooling always finds the same file
// regardless of where the daemon process happened to be launched from.
function writeStateFile() {
  const stateData = {
    session: {
      id: session.id,
      name: session.name,
      role: session.role,
      isConnected: session.isConnected,
      peerCount: session.role ? 1 : 0, // simplified peer calculation
    },
    activeTransfers: activeTransfers.map((t) => ({
      fileId: t.fileId,
      name: t.name,
      size: t.size,
      progress: parseFloat(t.progress.toFixed(2)),
      speedKBps: parseFloat(t.speedKBps.toFixed(2)),
      etaSeconds: Math.ceil(t.etaSeconds),
      protocol: t.protocol,
      status: t.status,
      // Timestamp used to detect/prune stale entries on the next daemon
      // startup (e.g. after an unclean shutdown / crash / SIGKILL).
      startedAt: new Date(t.startTime || Date.now()).toISOString(),
    })),
    lastUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(stateData, null, 2), 'utf-8');
}

// Entries older than this are considered stale leftovers from an unclean
// shutdown (crash, SIGKILL, laptop sleep, reboot) rather than live state, and
// are dropped instead of being served/loaded as current.
const STATE_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Prune stale persisted state on daemon startup ───
// The state file only ever reflects an in-process snapshot (there is no
// in-memory hydration from disk today), but a crashed/killed daemon can leave
// a stale file behind indefinitely — with no TTL — that still contains local
// file paths, session IDs and user IDs from a session that ended long ago.
// Sanitize the file on every startup so nothing older than the threshold is
// ever served as "current" via GET /state.
function pruneStaleStateOnStartup(): void {
  if (!fs.existsSync(STATE_PATH)) return;

  let prunedCount = 0;
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const now = Date.now();

    const lastUpdatedMs = parsed?.lastUpdated ? Date.parse(parsed.lastUpdated) : NaN;
    // No timestamp at all is treated as immediately stale/prunable.
    const sessionStale = !Number.isFinite(lastUpdatedMs) || (now - lastUpdatedMs) > STATE_STALE_MS;

    if (sessionStale && parsed?.session?.id) {
      prunedCount += 1;
      parsed.session = { id: null, name: null, role: null, isConnected: false, peerCount: 0 };
    }

    const transfers = Array.isArray(parsed?.activeTransfers) ? parsed.activeTransfers : [];
    const freshTransfers = transfers.filter((t: any) => {
      const ts = t?.startedAt ? Date.parse(t.startedAt) : NaN;
      const stale = !Number.isFinite(ts) || (now - ts) > STATE_STALE_MS;
      if (stale) prunedCount += 1;
      return !stale;
    });

    if (sessionStale || freshTransfers.length !== transfers.length) {
      parsed.activeTransfers = freshTransfers;
      parsed.lastUpdated = new Date().toISOString();
      fs.writeFileSync(STATE_PATH, JSON.stringify(parsed, null, 2), 'utf-8');
    }

    if (prunedCount > 0) {
      console.log(
        `[DAEMON] Pruned ${prunedCount} stale state entr${prunedCount === 1 ? 'y' : 'ies'} ` +
        `(older than ${STATE_STALE_MS / 3_600_000}h, or missing a timestamp) from ${STATE_PATH}`
      );
    }
  } catch (err: any) {
    // Corrupt/unreadable state file left over from a bad shutdown — safest to
    // remove it rather than risk serving/parsing garbage.
    console.warn('[DAEMON] Stale state file was unreadable, removing it:', err?.message || err);
    try { fs.unlinkSync(STATE_PATH); } catch {}
  }
}
pruneStaleStateOnStartup();

// ─── SSE Broadcaster ───
function broadcastSSE(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => res.write(payload));
}

// ─── WebSocket Signaling Client ───
function connectWebSocket(wsTargetUrl: string) {
  if (wsConn) {
    try { wsConn.close(); } catch {}
  }
  // A new socket is unauthenticated until init_host_ack arrives again.
  csrfToken = null;

  if (signalingMode === 'http' && process.env.SRIFT_SIGNALING !== 'http' && Date.now() - httpModeSince > WS_RETRY_AFTER_MS) {
    signalingMode = 'ws';
    wsFailures = 0;
  }
  const viaHttp = signalingMode === 'http';
  console.log(`[DAEMON] Connecting to Signaler ${viaHttp ? 'HTTPS stream' : 'WS'}: ${wsTargetUrl}`);
  // `ws` ignores HTTPS_PROXY; pass an explicit tunnelling agent when one applies.
  const sock = viaHttp
    ? new NodeHttpStreamSocket(wsTargetUrl, session.id || '')
    : new WebSocket(wsTargetUrl, { agent: agentFor(wsTargetUrl) });
  wsConn = sock;
  let opened = false;
  let openedAt = 0;
  // A WebSocket swallowed by a middlebox (no open, no error) counts as a failed attempt.
  const openTimer = viaHttp ? null : setTimeout(() => { if (!opened && wsConn === sock) { try { sock.terminate(); } catch {} } }, 10_000);
  // Events from a socket this function already replaced must be ignored: the
  // old socket's 'close' used to schedule another reconnect, which closed the
  // current socket, whose 'close' scheduled another… a reconnect every 3 s
  // that killed in-flight transfers.
  const current = () => wsConn === sock;

  sock.on('open', () => {
    if (!current()) return;
    opened = true;
    openedAt = Date.now();
    if (openTimer) clearTimeout(openTimer);
    console.log(`[DAEMON] ${viaHttp ? 'HTTPS stream' : 'WebSocket'} connection open`);
    session.isConnected = true;
    writeStateFile();
    broadcastSSE('connection_state', {
      sessionId: session.id,
      isConnected: true,
      signaling: 'connected',
    });

    // Authenticate
    setTimeout(() => {
      if (session.role === 'host') {
        wsConn?.send(JSON.stringify({
          type: 'init_host',
          payload: { userId: session.userId, sessionId: session.id, wsToken: session.wsToken }
        }));
      } else if (session.role === 'guest') {
        if (session.userId) {
          wsConn?.send(JSON.stringify({
            type: 'init_joiner',
            payload: { userId: session.userId, sessionId: session.id, wsToken: session.wsToken }
          }));
        } else {
          // The name given to `session join` (the join request over the socket must match it).
          const username = session.username || process.env.SRIFT_USERNAME || 'CLI-Agent';
          wsConn?.send(JSON.stringify({
            type: 'request_join',
            payload: { sessionId: session.id, tempUserId: session.tempUserId, username, wsToken: session.wsToken }
          }));
        }
      }
    }, 100);

    // Start Heartbeat
    lastHeartbeatAckAt = Date.now();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (wsConn?.readyState === WebSocket.OPEN) {
        // A half-open socket (NAT or proxy dropped it silently) never errors on its own: with no
        // heartbeat_ack for 75 s, drop it so the close handler reconnects and uploads resume.
        if (Date.now() - lastHeartbeatAckAt > 75_000) {
          console.warn('[DAEMON] No heartbeat ack for 75 s: reconnecting the signaling socket');
          try { wsConn.terminate(); } catch { /* already closing */ }
          return;
        }
        wsConn.send(JSON.stringify({ type: 'heartbeat', payload: { ts: Date.now() } }));
      }
    }, 30000);
  });

  sock.on('message', async (dataStr: string) => {
    if (!current()) return;
    try {
      const msg = JSON.parse(dataStr);
      const { type, payload } = msg;

      switch (type) {
        case 'init_host_ack':
          if (payload.status === 'ok') {
            csrfToken = payload.csrfToken;
            console.log('[DAEMON] Host authentication OK, CSRF Token obtained');
            announceKey();
            // After (re)auth, replay any public-share registrations so the
            // existing download URLs keep working across transient WS drops.
            reregisterPubsharesAfterReconnect().catch((e) =>
              console.warn('[DAEMON] pubshare replay failed:', e?.message));
            resumeRelayUploads();
          }
          break;

        case 'request_join_ack':
          console.log('[DAEMON] Join request received by server. Waiting for host approval...');
          break;

        case 'join_approved':
          console.log('[DAEMON] Host approved join request!');
          session.userId = payload.userId;
          // Re-auth as approved joiner
          wsConn?.send(JSON.stringify({
            type: 'init_joiner',
            payload: { userId: session.userId, sessionId: session.id, wsToken: session.wsToken }
          }));
          writeStateFile();
          break;

        case 'init_joiner_ack':
          if (payload.status === 'ok') {
            csrfToken = payload.csrfToken;
            console.log('[DAEMON] Approved joiner authentication OK');
            announceKey();
            resumeRelayUploads();
          }
          break;

        case 'heartbeat_ack':
          lastHeartbeatAckAt = Date.now();
          break;

        case 'user_list': {
          const users = Array.isArray(payload?.users) ? payload.users : [];
          participants = users.map((u: any) => ({ userId: String(u.id), username: String(u.username || ''), isHost: !!u.is_host, online: !!u.isOnline }));
          broadcastSSE('participants', { participants });
          if (payload?.messageId) {
            try { sock.send(JSON.stringify({ type: 'user_list_ack', payload: { messageId: payload.messageId } })); } catch {}
          }
          break;
        }

        case 'kicked_from_session':
          // The host removed us: never auto-reconnect into the session.
          console.log(`[DAEMON] Kicked from session: ${payload?.reason || ''}`);
          sessionTerminated = true;
          terminationReason = payload?.reason || 'You were removed from the session by the host';
          session.isConnected = false;
          session.userId = null;
          csrfToken = null;
          pendingJoins = [];
          participants = [];
          writeStateFile();
          broadcastSSE('session_terminated', { reason: terminationReason });
          break;

        case 'session_deleted':
          // Host tore down the room. Stop reconnecting and clear local state so
          // a guest doesn't loop trying to rejoin a session that no longer exists.
          console.log(`[DAEMON] Session deleted by host: ${payload.reason || ''}`);
          sessionTerminated = true;
          terminationReason = payload.message || 'Session was deleted by the host';
          session = { id: null, name: null, role: null, isConnected: false, userId: null } as any;
          activeTransfers = [];
          pendingJoins = [];
          participants = [];
          encryptionKey = null;
          writeStateFile();
          broadcastSSE('session_terminated', { reason: terminationReason });
          try { if (wsConn) wsConn.close(); } catch {}
          break;

        case 'error':
          // Server-side error. A "critical" severity means the connection was
          // terminated server-side (join rejected, kicked, session ended) and
          // the server is about to close our socket. Mark the session as
          // terminated so on('close') does NOT auto-reconnect us back in.
          console.error(`[DAEMON] Server error: ${payload.msg} (severity=${payload.severity || 'recoverable'})`);
          if (payload.severity === 'critical') {
            sessionTerminated = true;
            terminationReason = payload.msg || 'Connection terminated by host';
            session.isConnected = false;
            session.userId = null;
            pendingJoins = [];
            participants = [];
            writeStateFile();
            broadcastSSE('session_terminated', { reason: terminationReason });
          }
          break;

        case 'join_request':
          console.log(`[DAEMON] Peer join request: tempUserId=${payload.tempUserId}, username=${payload.username}`);
          // The server may repeat a request (host reconnected); keep one entry per tempUserId.
          if (!pendingJoins.some((p: any) => p.tempUserId === payload.tempUserId)) pendingJoins.push({ tempUserId: payload.tempUserId, username: payload.username });
          broadcastSSE('join_request', payload);
          break;

        case 'e2e_key':
          try {
            const ring = await sessionKeyring();
            // A new or changed key: answer with ours so both sides can seal for each other.
            const learned = ring.setPeer(String(payload?.from || ''), payload?.pk);
            if (learned) console.log(`[DAEMON] Member key received (${ring.peers.size} known)`);
            if (learned && !payload?.reply) announceKey(String(payload.from));
          } catch (e: any) { console.warn(`[DAEMON] Member key ignored: ${e?.message || e}`); }
          break;

        case 'chat':
          try {
            let decContent: string;
            if (isPk1(payload.content)) {
              const opened = await (await sessionKeyring()).openChat(payload.content, String(payload.senderId || ''));
              if (opened === null) { console.log('[DAEMON] Chat sealed before this device joined; skipped'); break; }
              decContent = opened;
            } else {
              decContent = await decrypt(payload.content);
            }
            const chatMsg = {
              messageId: payload.messageId || uuidv4(),
              sender: payload.username || 'Peer',
              content: decContent,
              timestamp: payload.timestamp || new Date().toISOString(),
            };
            chatHistory.push(chatMsg);
            broadcastSSE('chat_received', chatMsg);
            // Never log decrypted message text (it would defeat E2EE on disk): metadata only.
            console.log(`[DAEMON] Chat from ${chatMsg.sender} (${String(chatMsg.content ?? "").length} chars, ${isPk1(payload.content) ? 'pk1' : 'session key'})`);
          } catch (decErr) {
            console.error('[DAEMON] Decryption failed for chat message:', decErr);
          }
          break;

        case 'file_offer':
          console.log(`[DAEMON] File offer received: ${payload.filename} (${payload.size} bytes)`);
          // Record active transfer
          const newTx = {
            fileId: payload.fileId,
            name: payload.filename,
            size: payload.size,
            progress: 0,
            speedKBps: 0,
            etaSeconds: 0,
            protocol: (payload.transferType === 'webtorrent' ? 'webtorrent' : 'websocket') as 'websocket' | 'webtorrent',
            status: 'pending' as const,
            direction: 'download' as const,
            bytesTransferred: 0,
            chunksCount: 0,
            totalChunks: 0,
            startTime: Date.now(),
          };
          activeTransfers.push(newTx);
          writeStateFile();
          broadcastSSE('file_offer', {
            fileId: payload.fileId,
            filename: payload.filename,
            size: payload.size,
            from: payload.from,
            protocol: newTx.protocol,
          });
          break;

        case 'file_accept':
          console.log(`[DAEMON] File offer accepted by peer! ID: ${payload.fileId}`);
          {
            const acceptedTx = activeTransfers.find((t) => t.fileId === payload.fileId);
            if (acceptedTx && acceptedTx.protocol === 'webtorrent' && (acceptedTx.status === 'completed' || acceptedTx.status === 'uploading')) break;
          }
          // What this receiver can read: sealed chunks (sgcm1), its own per-transfer key (pgcm1), base64 frames.
          startUpload(payload.fileId, payload.userId, {
            relayEnc: payload.relayEnc === RELAY_ENC ? RELAY_ENC : undefined,
            relayPk: isPublicKey(payload.relayPk) ? payload.relayPk : undefined,
            fast: payload.relayFmt === RELAY_FORMAT,
          });
          break;

        case 'webtorrent_info_hash':
          handleWebTorrentInfoHash(payload);
          break;

        case 'file_chunk':
          handleIncomingChunk(payload).catch((e) => {
            console.error(`[DAEMON] Relay chunk rejected: ${e?.message || e}`);
            const bad = activeTransfers.find((t) => t.fileId === payload?.fileId);
            if (bad) { bad.status = 'error'; writeStateFile(); }
            // Tell the sender to stop instead of leaving it waiting for an ack forever.
            try { sock.send(JSON.stringify({ type: 'file_cancel_by_receiver', payload: { fileId: payload?.fileId } })); } catch {}
          });
          break;

        case 'file_cancelled_by_receiver':
        case 'file_cancelled_by_sender':
        case 'file_cancelled_all': {
          // The other side cancelled: stop sending / stop waiting for chunks.
          const gone = activeTransfers.find((t) => t.fileId === payload?.fileId);
          // A receiver that cancels stops its own stream only; the other recipients keep receiving.
          const stopped = type === 'file_cancelled_by_receiver' && payload?.receiverId
            ? [activeUploads.get(uploadKey(payload.fileId, payload.receiverId))].filter(Boolean) as RelayUpload[]
            : uploadsOf(payload?.fileId);
          for (const u of stopped) stopUpload(u);
          // One recipient stopping its own copy is that recipient's outcome, not the file's.
          const oneRecipient = !!gone && gone.direction === 'upload' && type === 'file_cancelled_by_receiver' && !!payload?.receiverId;
          if (gone && oneRecipient) { markRecipient(gone, payload.receiverId, 'cancelled'); writeStateFile(); }
          if (gone && gone.direction === 'upload' && uploadsOf(payload?.fileId).length > 0) break;
          if (gone && gone.direction === 'download') dropRelayDownload(gone.fileId, true);
          if (gone && (gone.status !== 'completed' || oneRecipient)) {
            if (oneRecipient) settleUploadStatus(gone);
            else gone.status = 'cancelled';
            writeStateFile();
            broadcastSSE('transfer_progress', { fileId: gone.fileId, fileName: gone.name, size: gone.size, bytesTransferred: gone.bytesTransferred, progress: gone.progress, status: gone.status });
          }
          break;
        }

        case 'file_chunk_ack':
          handleChunkAck(payload);
          break;

        case 'file_complete':
          handleFileComplete(payload);
          break;

        case 'pubshare_register_ack': {
          const entry = pubshares.get(payload.fileId);
          if (entry) {
            entry.token = payload.token;
            entry.downloadUrl = payload.downloadUrl;
            if (typeof payload.claim === 'string') entry.claim = payload.claim;
            pubsharesByToken.set(payload.token, entry);
            const resolver = pubshareRegResolvers.get(payload.fileId);
            if (resolver) {
              pubshareRegResolvers.delete(payload.fileId);
              resolver(entry);
            }
            console.log(`[DAEMON] pubshare registered: ${entry.filename} -> ${entry.downloadUrl}`);
          }
          break;
        }

        case 'pubshare_pull': {
          // Server is asking us to stream bytes [start..end] for an HTTP request.
          handlePubsharePull(payload).catch((err) => {
            console.error('[DAEMON] pubshare_pull failed:', err);
            try {
              wsConn?.send(JSON.stringify({
                type: 'pubshare_end',
                payload: { requestId: payload.requestId, ok: false, error: String(err?.message || err) },
              }));
            } catch {}
          });
          break;
        }

        case 'pubshare_cancel': {
          const a = activePulls.get(payload.requestId);
          if (a) a.cancelled = true;
          break;
        }
      }
    } catch (err) {
      console.error('[DAEMON] Error processing WS message:', err);
    }
  });

  sock.on('close', () => {
    if (openTimer) clearTimeout(openTimer);
    if (!current()) return;
    console.log('[DAEMON] WebSocket connection closed');
    const wasAuthed = !!csrfToken;
    if (!viaHttp) {
      if (wasAuthed) wsFailures = 0;
      else if ((!opened || Date.now() - openedAt < 10_000) && ++wsFailures >= 2) {
        signalingMode = 'http';
        httpModeSince = Date.now();
        console.log('[DAEMON] WebSocket does not hold on this network: switching signaling to the HTTPS stream');
      }
    }
    session.isConnected = false;
    csrfToken = null; // waitForHostAuth must wait for re-auth after a reconnect
    writeStateFile();
    broadcastSSE('connection_state', {
      sessionId: session.id,
      isConnected: false,
      signaling: 'disconnected',
    });

    // Auto-reconnect after 3s — but NOT if the server terminated us on purpose
    // (rejected/kicked/ended). Otherwise a rejected peer would loop straight
    // back in and keep showing as "connected".
    if (sessionTerminated) {
      console.log(`[DAEMON] Not reconnecting — session terminated: ${terminationReason}`);
      return;
    }
    setTimeout(() => {
      if (session.id && wsTargetUrl && !sessionTerminated) {
        connectWebSocket(wsTargetUrl);
      }
    }, 3000);
  });

  sock.on('error', (err) => {
    if (!current()) return;
    console.error('[DAEMON] WebSocket error:', err);
  });
}

// ─── File Upload Dispatcher ───
function startUpload(fileId: string, targetUserId: string, caps: { relayEnc?: 'sgcm1'; relayPk?: string; fast?: boolean } = {}) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;

  if (tx.protocol === 'webtorrent') {
    startWebTorrentUpload(fileId, targetUserId);
  } else {
    void startWebSocketUpload(fileId, targetUserId, caps);
  }
}

// ─── WebTorrent P2P Seeding / Upload Handler ───
async function startWebTorrentUpload(fileId: string, targetUserId: string) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx || !tx.filePath) return;

  console.log(`[DAEMON] Starting WebTorrent seeding for ${tx.name}...`);
  tx.status = 'uploading';
  tx.startTime = Date.now();
  writeStateFile();

  let client: any;
  try {
    client = await getWtClient();
  } catch (err: any) {
    console.error(`[DAEMON] WebTorrent unavailable, falling back to WebSocket for ${tx.name}: ${err?.message}`);
    tx.protocol = 'websocket';
    writeStateFile();
    // Fall back to WebSocket-chunked upload path
    return;
  }
  const trackers = getTrackers(session.id || '');

  // private (BEP 27): the torrent itself forbids DHT and peer exchange, for any client that joins it.
  client.seed(tx.filePath, { announce: trackers, private: true }, (torrent: any) => {
    console.log(`[DAEMON] WebTorrent seeding active. Info Hash: ${torrent.infoHash}`);
    activeTorrents.set(fileId, torrent);

    // Send the info hash to the peer so they can start downloading
    wsConn?.send(JSON.stringify({
      type: 'webtorrent_info_hash',
      payload: {
        fileId,
        infoHash: torrent.infoHash,
        fileName: tx.name,
        fileSize: tx.size,
        targetUserId,
      }
    }));

    torrent.on('upload', () => {
      tx.bytesTransferred = torrent.uploaded;
      tx.progress = Math.min(99.9, (torrent.uploaded / tx.size) * 100);
      tx.speedKBps = torrent.uploadSpeed / 1024;
      writeStateFile();
      broadcastSSE('transfer_progress', {
        fileId,
        fileName: tx.name,
        size: tx.size,
        bytesTransferred: torrent.uploaded,
        progress: tx.progress,
        speedBytesPerSecond: torrent.uploadSpeed,
        timeRemainingSeconds: -1,
        status: 'uploading',
      });
    });
  });
}

// ─── WebTorrent P2P Download Handler ───
async function handleWebTorrentInfoHash(payload: any) {
  const { fileId, infoHash, fileName, fileSize, senderId } = payload;
  console.log(`[DAEMON] Received WebTorrent info hash: ${infoHash} for file: ${fileName}`);

  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;

  tx.protocol = 'webtorrent';
  tx.status = 'downloading';
  tx.peerId = senderId;
  tx.startTime = Date.now();
  writeStateFile();

  let client: any;
  try {
    client = await getWtClient();
  } catch (err: any) {
    console.error(`[DAEMON] WebTorrent unavailable for download of ${fileName}: ${err?.message}. Ask the sender to retry with --protocol websocket.`);
    tx.status = 'error';
    writeStateFile();
    broadcastSSE('transfer_progress', {
      fileId,
      fileName: tx.name,
      size: tx.size,
      bytesTransferred: 0,
      progress: 0,
      speedBytesPerSecond: 0,
      timeRemainingSeconds: -1,
      status: 'error',
    });
    return;
  }
  const trackers = getTrackers(session.id || '');
  const downloadDir = tx.saveDir || process.cwd();

  client.add(infoHash, { announce: trackers, path: downloadDir }, (torrent: any) => {
    console.log(`[DAEMON] WebTorrent download started: ${torrent.name}`);
    activeTorrents.set(fileId, torrent);

    torrent.on('download', () => {
      tx.bytesTransferred = torrent.downloaded;
      tx.progress = torrent.progress * 100;
      tx.speedKBps = torrent.downloadSpeed / 1024;
      tx.etaSeconds = torrent.timeRemaining / 1000;
      writeStateFile();
      broadcastSSE('transfer_progress', {
        fileId,
        fileName: tx.name,
        size: tx.size,
        bytesTransferred: torrent.downloaded,
        progress: tx.progress,
        speedBytesPerSecond: torrent.downloadSpeed,
        timeRemainingSeconds: tx.etaSeconds,
        status: 'downloading',
      });
    });

    torrent.on('done', () => {
      console.log(`[DAEMON] WebTorrent download finished: ${tx.name}`);
      tx.status = 'completed';
      tx.progress = 100;
      tx.speedKBps = 0;
      tx.etaSeconds = 0;
      writeStateFile();
      broadcastSSE('transfer_progress', {
        fileId,
        fileName: tx.name,
        size: tx.size,
        bytesTransferred: tx.size,
        progress: 100,
        speedBytesPerSecond: 0,
        timeRemainingSeconds: 0,
        status: 'completed',
      });

      // Cleanup torrent and remove reference
      torrent.destroy();
      activeTorrents.delete(fileId);
    });
  });
}

// ─── WebSocket Fallback File Transfer Handlers ───
// One upload per (file, recipient): several members can accept the same offer and each gets its own
// windowed stream, sealed for its own key.
interface RelayUpload {
  fileId: string;
  targetUserId: string;
  filePath: string;
  size: number;
  fd: number;
  chunkSize: number;
  totalChunks: number;
  /** Fast frames: one base64 string per chunk (lib/relay-crypto.ts RELAY_FORMAT), else number arrays / legacy base64. */
  fast: boolean;
  relayEnc?: 'sgcm1';
  relayPk?: string;
  /** Next chunk index that was never sent. */
  next: number;
  acked: Set<number>;
  /** Sent and not yet acknowledged: index → time of the last send. */
  inFlight: Map<number, number>;
  lastAckAt: number;
  startTime: number;
  pumping: boolean;
  timer?: ReturnType<typeof setInterval>;
  lastStateAt: number;
}
const activeUploads: Map<string, RelayUpload> = new Map();
const uploadKey = (fileId: string, userId: string) => `${fileId}|${userId}`;
const uploadsOf = (fileId: string) => [...activeUploads.values()].filter((u) => u.fileId === fileId);

// One file can go to several recipients, and each ends on its own: delivered, cancelled by that
// recipient, or failed. The file's status says what happened overall: still uploading while anyone
// is being served; afterwards "completed" if at least one recipient has the whole file (the others
// are listed in `recipients`), otherwise "error" or "cancelled".
function markRecipient(tx: (typeof activeTransfers)[number], userId: string | undefined, outcome: 'uploading' | 'completed' | 'cancelled' | 'error'): void {
  if (!userId) return;
  if (!tx.recipients) tx.recipients = {};
  // A recipient that has the file keeps it, whatever arrives later.
  if (tx.recipients[userId] === 'completed' && outcome !== 'uploading') return;
  tx.recipients[userId] = outcome;
}

function settleUploadStatus(tx: (typeof activeTransfers)[number]): void {
  if (uploadsOf(tx.fileId).length > 0) { tx.status = 'uploading'; return; }
  const outcomes = Object.values(tx.recipients || {});
  tx.status = outcomes.includes('completed') ? 'completed' : outcomes.includes('error') ? 'error' : 'cancelled';
  tx.speedKBps = 0;
  tx.etaSeconds = 0;
  if (tx.status === 'completed') { tx.progress = 100; tx.bytesTransferred = tx.size; }
}

// Windowed relay: up to RELAY_WINDOW chunks in flight, the acknowledgments set the pace. A chunk not
// acknowledged within RELAY_ACK_TIMEOUT_MS is sent again (receivers de-duplicate and re-ack), across
// reconnects; with no acknowledgment at all for RELAY_STALL_MS the transfer is reported as failed
// instead of hanging.
const RELAY_ACK_TIMEOUT_MS = Number(process.env.SRIFT_RELAY_ACK_TIMEOUT_MS) || 15_000;
const RELAY_STALL_MS = RELAY_ACK_TIMEOUT_MS * 40;
const RELAY_WINDOW = 16;
const RELAY_LEGACY_CHUNK = 64 * 1024;   // number-array / base64 frames older receivers read (JSON stays under the 256 KB cap)
const RELAY_FAST_CHUNK = 256 * 1024;    // must equal RELAY_CHUNK_BYTES in lib/relay-crypto.ts
const RELAY_FORMAT = 'b64';
const RELAY_SOCKET_HIGH_BYTES = 8 * 1024 * 1024;

function stopUpload(u: RelayUpload): void {
  activeUploads.delete(uploadKey(u.fileId, u.targetUserId));
  if (u.timer) clearInterval(u.timer);
  try { fs.closeSync(u.fd); } catch { /* already closed */ }
}

function failUpload(u: RelayUpload, why: string): void {
  console.error(`[DAEMON] Relay upload ${u.fileId} to ${u.targetUserId} failed: ${why}`);
  stopUpload(u);
  const tx = activeTransfers.find((t) => t.fileId === u.fileId);
  if (tx) { markRecipient(tx, u.targetUserId, 'error'); settleUploadStatus(tx); writeStateFile(); }
}

/** After a reconnect, send every unacknowledged chunk again at once instead of waiting for the watchdog. */
function resumeRelayUploads(): void {
  if (!activeUploads.size) return;
  console.log(`[DAEMON] Reconnected: resuming ${activeUploads.size} relay upload(s) from their unacknowledged chunks`);
  for (const u of activeUploads.values()) {
    u.lastAckAt = Date.now();
    for (const index of u.inFlight.keys()) u.inFlight.set(index, 0);
    pumpUpload(u);
  }
}

async function startWebSocketUpload(fileId: string, targetUserId: string, caps: { relayEnc?: 'sgcm1'; relayPk?: string; fast?: boolean } = {}) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx || !tx.filePath) return;
  const key = uploadKey(fileId, targetUserId);
  const running = activeUploads.get(key);
  if (running) {
    // A repeated accept (the receiver reconnected or reloaded): keep what was acknowledged, adopt the
    // key it holds now and send the unacknowledged chunks again under it.
    if (caps.relayPk !== running.relayPk) relaySenders.delete(`${key}|${running.relayPk}`);
    running.relayEnc = caps.relayEnc;
    running.relayPk = caps.relayPk;
    console.log(`[DAEMON] Repeated accept for ${fileId} from ${targetUserId}: ${running.acked.size}/${running.totalChunks} chunks acknowledged, continuing`);
    for (const index of running.inFlight.keys()) running.inFlight.set(index, 0);
    running.lastAckAt = Date.now();
    pumpUpload(running);
    return;
  }

  let fd: number;
  let size: number;
  try {
    fd = fs.openSync(tx.filePath, 'r');
    size = fs.fstatSync(fd).size;
  } catch (e: any) {
    console.error(`[DAEMON] Cannot read ${tx.filePath}: ${e?.message || e}`);
    tx.status = 'error';
    writeStateFile();
    return;
  }
  const fast = !!caps.fast;
  const chunkSize = fast ? RELAY_FAST_CHUNK : RELAY_LEGACY_CHUNK;
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));

  tx.status = 'uploading';
  markRecipient(tx, targetUserId, 'uploading');
  tx.startTime = Date.now();
  tx.totalChunks = totalChunks;
  writeStateFile();

  const upload: RelayUpload = {
    fileId, targetUserId, filePath: tx.filePath, size, fd, chunkSize, totalChunks, fast,
    relayEnc: caps.relayEnc, relayPk: caps.relayPk,
    next: 0, acked: new Set(), inFlight: new Map(), lastAckAt: Date.now(), startTime: Date.now(),
    pumping: false, lastStateAt: 0,
  };
  activeUploads.set(key, upload);
  upload.timer = setInterval(() => pumpUpload(upload), Math.min(1000, Math.max(100, RELAY_ACK_TIMEOUT_MS / 4)));
  upload.timer.unref?.();
  pumpUpload(upload);
}

async function sendRelayChunk(u: RelayUpload, chunkIndex: number): Promise<void> {
  const start = chunkIndex * u.chunkSize;
  const end = Math.min(start + u.chunkSize, u.size);
  const buffer = Buffer.alloc(Math.max(0, end - start));
  let read = 0;
  while (read < buffer.length) {
    const n = fs.readSync(u.fd, buffer, read, buffer.length - read, start + read);
    if (n <= 0) throw new Error('file ended early (was it changed while sending?)');
    read += n;
  }

  // Sealed for the receiver's key when it advertised one, else for the session key, else plaintext
  // (receivers that advertise nothing). Fast frames carry the bytes as one base64 string.
  let frame: { chunk: number[] | string; enc?: string };
  if (u.relayPk && session.id) {
    const sk = `${uploadKey(u.fileId, u.targetUserId)}|${u.relayPk}`;
    let sender = relaySenders.get(sk);
    if (!sender) { sender = relaySender(session.id, u.fileId, u.relayPk, session.roomSecret); remember(relaySenders, sk, sender); }
    const s = await sender;
    frame = u.fast
      ? { chunk: Buffer.from(await s.sealBytes(buffer, chunkIndex, u.totalChunks)).toString('base64'), enc: RELAY_PK_SCHEME }
      : await s.seal(buffer, chunkIndex, u.totalChunks);
  } else if (u.relayEnc === RELAY_ENC) {
    const sealed = await sealRelayChunk(buffer, u.fileId, chunkIndex, u.totalChunks);
    frame = { chunk: u.fast ? Buffer.from(sealed).toString('base64') : sealed, enc: RELAY_ENC };
  } else {
    frame = { chunk: buffer.toString('base64') };
  }
  if (!activeUploads.has(uploadKey(u.fileId, u.targetUserId)) || u.acked.has(chunkIndex)) return;
  u.inFlight.set(chunkIndex, Date.now());
  if (!wsConn || wsConn.readyState !== WebSocket.OPEN) return; // goes out again after the reconnect
  wsConn.send(JSON.stringify({
    type: 'file_chunk',
    payload: {
      fileId: u.fileId,
      ...frame,
      chunkIndex,
      totalChunks: u.totalChunks,
      chunkSize: u.chunkSize,
      targetUserId: u.targetUserId,
    }
  }));
}

function reportUpload(u: RelayUpload, force = false): void {
  const tx = activeTransfers.find((t) => t.fileId === u.fileId);
  if (!tx) return;
  const now = Date.now();
  if (!force && now - u.lastStateAt < 250) return;
  u.lastStateAt = now;
  // With several recipients the transfer is as far as its slowest one.
  const all = uploadsOf(u.fileId);
  const slowest = all.reduce((m, x) => Math.min(m, x.acked.size >= x.totalChunks ? x.size : Math.min(x.size, x.acked.size * x.chunkSize)), u.size);
  tx.bytesTransferred = Math.max(tx.bytesTransferred || 0, slowest);
  tx.progress = u.size > 0 ? (tx.bytesTransferred / u.size) * 100 : 100;
  const elapsed = (now - u.startTime) / 1000;
  if (elapsed > 0) {
    tx.speedKBps = (tx.bytesTransferred / 1024) / elapsed;
    tx.etaSeconds = tx.speedKBps > 0 ? (u.size - tx.bytesTransferred) / (tx.speedKBps * 1024) : 0;
  }
  writeStateFile();
  broadcastSSE('transfer_progress', {
    fileId: u.fileId,
    fileName: tx.name,
    size: tx.size,
    bytesTransferred: tx.bytesTransferred,
    progress: tx.progress,
    speedBytesPerSecond: tx.speedKBps * 1024,
    timeRemainingSeconds: tx.etaSeconds,
    status: 'uploading',
  });
}

function pumpUpload(u: RelayUpload): void {
  if (u.pumping) return;
  u.pumping = true;
  pumpUploadAsync(u)
    .catch((e) => failUpload(u, e?.message || String(e)))
    .finally(() => { u.pumping = false; });
}

async function pumpUploadAsync(u: RelayUpload): Promise<void> {
  const key = uploadKey(u.fileId, u.targetUserId);
  while (activeUploads.get(key) === u) {
    if (u.acked.size >= u.totalChunks) {
      wsConn?.send(JSON.stringify({ type: 'file_complete', payload: { fileId: u.fileId, targetUserId: u.targetUserId } }));
      stopUpload(u);
      const tx = activeTransfers.find((t) => t.fileId === u.fileId);
      if (tx) {
        markRecipient(tx, u.targetUserId, 'completed');
        settleUploadStatus(tx);
        writeStateFile();
        if (uploadsOf(u.fileId).length === 0) console.log(`[DAEMON] File upload complete: ${tx.name}`);
      }
      return;
    }
    const now = Date.now();
    if (now - u.lastAckAt > RELAY_STALL_MS) throw new Error(`no acknowledgment for ${Math.round(RELAY_STALL_MS / 1000)}s (${u.acked.size}/${u.totalChunks} chunks delivered)`);
    const open = !!wsConn && wsConn.readyState === WebSocket.OPEN && wsConn.bufferedAmount < RELAY_SOCKET_HIGH_BYTES;
    if (!open) return; // the interval (or the reconnect) calls again

    // 1. a chunk whose acknowledgment is overdue
    let overdue = -1;
    for (const [index, sentAt] of u.inFlight) {
      if (now - sentAt > RELAY_ACK_TIMEOUT_MS) { overdue = index; break; }
    }
    if (overdue >= 0) {
      if (u.inFlight.get(overdue)) console.log(`[DAEMON] Relay upload ${u.fileId}: no ack for chunk ${overdue}, sending it again`);
      await sendRelayChunk(u, overdue);
      continue;
    }
    // 2. the next new chunk while the window has room
    while (u.next < u.totalChunks && u.acked.has(u.next)) u.next++;
    if (u.next < u.totalChunks && u.inFlight.size < RELAY_WINDOW) {
      const index = u.next++;
      u.inFlight.set(index, now);
      await sendRelayChunk(u, index);
      continue;
    }
    return; // window full: the next acknowledgment pumps again
  }
}

function handleChunkAck(payload: any) {
  const { fileId, chunkIndex, userId } = payload || {};
  if (!Number.isInteger(chunkIndex)) return;
  // The server names the acknowledging receiver; without it (older servers) there is one upload per file.
  const u = userId ? activeUploads.get(uploadKey(fileId, userId)) : uploadsOf(fileId)[0];
  if (!u || chunkIndex < 0 || chunkIndex >= u.totalChunks) return;
  u.inFlight.delete(chunkIndex);
  if (!u.acked.has(chunkIndex)) {
    u.acked.add(chunkIndex);
    u.lastAckAt = Date.now();
    reportUpload(u, u.acked.size >= u.totalChunks);
  }
  pumpUpload(u);
}

// ── receiving ──
// Chunks are written at their offset into one part file (no file per chunk, nothing to assemble).
const relayDownloads: Map<string, { fd: number; partPath: string; got: Set<number>; totalChunks: number; lastStateAt: number }> = new Map();
const partPathOf = (fileId: string) => path.join(TEMP_DIR, `${fileId.replace(/[^A-Za-z0-9_.-]/g, '_')}_chunk_part`);

function dropRelayDownload(fileId: string, removePart: boolean): void {
  const d = relayDownloads.get(fileId);
  relayDownloads.delete(fileId);
  if (d) { try { fs.closeSync(d.fd); } catch { /* closed */ } }
  if (removePart) { try { fs.rmSync(partPathOf(fileId), { force: true }); } catch { /* gone */ } }
}

async function handleIncomingChunk(payload: any) {
  const { fileId, chunkIndex, totalChunks, from } = payload;
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx || tx.direction !== 'download' || tx.status === 'cancelled') return;
  if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) || chunkIndex < 0 || chunkIndex >= totalChunks) return;
  const ack = () => wsConn?.send(JSON.stringify({ type: 'file_chunk_ack', payload: { fileId, chunkIndex, status: 'received' } }));
  // A chunk sent again after the file was already finished here: confirm it, nothing to write.
  if (tx.status === 'completed' || tx.assembling) { ack(); return; }

  // A transfer is sealed or plaintext end to end; switching mid-transfer is a downgrade.
  const mode = payload.enc === undefined || payload.enc === null ? 'plain' : String(payload.enc);
  if (tx.relayMode && tx.relayMode !== mode) throw new Error(`transfer ${fileId} mixed sealed and plaintext chunks`);
  if (!tx.relayMode) console.log(`[DAEMON] Relay transfer ${fileId}: ${mode}`);
  tx.relayMode = mode;
  const chunkBuffer = await openRelayChunk(payload);
  if ((tx.status as string) === 'completed' || tx.assembling || (tx.status as string) === 'cancelled') { ack(); return; }

  tx.status = 'downloading';
  tx.totalChunks = totalChunks;
  tx.peerId = from;

  let d = relayDownloads.get(fileId);
  if (!d) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const partPath = partPathOf(fileId);
    d = { fd: fs.openSync(partPath, 'w+'), partPath, got: new Set(), totalChunks, lastStateAt: 0 };
    relayDownloads.set(fileId, d);
  }
  // Every chunk but the last is a full chunk (its length is the chunk size); the last one ends the file.
  const isLast = chunkIndex === totalChunks - 1;
  const at = isLast && tx.size > 0 ? tx.size - chunkBuffer.length : chunkIndex * chunkBuffer.length;
  if (at < 0 || (tx.size > 0 && at + chunkBuffer.length > tx.size)) throw new Error(`relay chunk ${chunkIndex} of ${fileId} does not fit the file`);

  // A chunk sent again after a lost ack is written once and acknowledged again.
  if (!d.got.has(chunkIndex)) {
    let written = 0;
    while (written < chunkBuffer.length) written += fs.writeSync(d.fd, chunkBuffer, written, chunkBuffer.length - written, at + written);
    d.got.add(chunkIndex);
    tx.bytesTransferred += chunkBuffer.length;
    tx.chunksCount = d.got.size;
  }

  tx.progress = tx.size > 0 ? Math.min(100, (tx.bytesTransferred / tx.size) * 100) : 100;
  const elapsed = (Date.now() - tx.startTime) / 1000;
  if (elapsed > 0) {
    tx.speedKBps = (tx.bytesTransferred / 1024) / elapsed;
    tx.etaSeconds = tx.speedKBps > 0 ? (tx.size - tx.bytesTransferred) / (tx.speedKBps * 1024) : 0;
  }
  const done = d.got.size >= totalChunks;
  const now = Date.now();
  if (done || now - d.lastStateAt >= 250) {
    d.lastStateAt = now;
    writeStateFile();
    broadcastSSE('transfer_progress', {
      fileId,
      fileName: tx.name,
      size: tx.size,
      bytesTransferred: tx.bytesTransferred,
      progress: tx.progress,
      speedBytesPerSecond: tx.speedKBps * 1024,
      timeRemainingSeconds: tx.etaSeconds,
      status: 'downloading',
    });
  }

  // Acknowledged after the write: what the sender counts as delivered is on disk.
  ack();

  // Every chunk is here: the file is complete whether or not the sender's file_complete arrives.
  if (done) handleFileComplete({ fileId });
}

function handleFileComplete(payload: any) {
  const { fileId } = payload;
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx || tx.direction !== 'download' || tx.assembling || tx.status === 'completed') return;
  const d = relayDownloads.get(fileId);
  // file_complete follows the last acknowledgment, so every chunk is here. If not (a stray or
  // repeated signal), keep waiting for the chunks instead of saving a truncated file.
  if (tx.size > 0 && (!d || d.got.size < d.totalChunks)) return;
  tx.assembling = true;

  const fail = (err: any) => {
    console.error(`[DAEMON] Could not save ${tx.name}:`, err?.message || err);
    tx.status = 'error';
    writeStateFile();
    broadcastSSE('transfer_progress', {
      fileId,
      fileName: tx.name,
      size: tx.size,
      bytesTransferred: tx.bytesTransferred,
      progress: tx.progress,
      speedBytesPerSecond: 0,
      timeRemainingSeconds: 0,
      status: 'error',
    });
  };

  const destDir = tx.saveDir || process.cwd();
  const destPath = path.join(destDir, tx.name);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    if (d) {
      fs.fsyncSync(d.fd);
      dropRelayDownload(fileId, false);
      try {
        fs.renameSync(d.partPath, destPath);
      } catch {
        // Another volume: copy, then remove the part file.
        fs.copyFileSync(d.partPath, destPath);
        fs.rmSync(d.partPath, { force: true });
      }
    } else {
      fs.writeFileSync(destPath, Buffer.alloc(0)); // an empty file
    }
  } catch (err) {
    fail(err);
    return;
  }

  console.log(`[DAEMON] File successfully downloaded: ${destPath}`);
  tx.status = 'completed';
  tx.progress = 100;
  tx.bytesTransferred = tx.size;
  tx.speedKBps = 0;
  tx.etaSeconds = 0;
  writeStateFile();
  broadcastSSE('transfer_progress', {
    fileId,
    fileName: tx.name,
    size: tx.size,
    bytesTransferred: tx.size,
    progress: 100,
    speedBytesPerSecond: 0,
    timeRemainingSeconds: 0,
    status: 'completed',
  });
}

// ─── Express App Setup ───
const app = express();
// ─── Access policy ───
// Open CORS by design: any origin (srift.app, browser extensions, local tools,
// third-party web apps) may drive the daemon. The daemon is bound to loopback
// only, so it is reachable solely from programs/pages on this machine.
//   • Host must be a loopback name for our port (defeats DNS rebinding; this
//     does not restrict which origins may call us).
//   • Chrome Private Network Access preflights get
//     Access-Control-Allow-Private-Network: true so public https pages can reach
//     127.0.0.1.
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
app.use((req: Request, res: Response, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    return res.status(403).json({ success: false, error: 'Forbidden: the SRIFT daemon only accepts requests addressed to 127.0.0.1/localhost.' });
  }
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});
app.use(cors({ origin: '*', maxAge: 600 }));
app.use(express.json());

const DAEMON_START_TIME = Date.now();
const PACKAGE_VERSION = '4.4.1';

// ─── GET /health — liveness probe ───
app.get('/health', (req: Request, res: Response) => {
  res.json({
    ok: true,
    version: PACKAGE_VERSION,
    uptime_ms: Date.now() - DAEMON_START_TIME,
    mcp: true,
    webrtc: false,      // daemon uses WebSocket relay + WebTorrent, not raw WebRTC
    webtorrent: _webTorrentLoadError ? false : true,
    webtorrent_error: _webTorrentLoadError || undefined,
  });
});

app.get('/status', (req: Request, res: Response) => {
  res.json({
    session: {
      id: session.id,
      name: session.name,
      role: session.role,
      isConnected: session.isConnected,
      userId: session.userId,
    },
    activeTransfers: activeTransfers,
    pendingJoins: pendingJoins,
    participants,
    lastUpdated: new Date().toISOString(),
  });
});

app.post('/session/start', async (req: Request, res: Response) => {
  try {
    const { sessionName, username, roomSecret } = req.body;
    const sName = sessionName || 'cli-session';
    const uName = username || 'CLI-Host';
    // Fresh session — clear any prior fatal-termination state.
    sessionTerminated = false; terminationReason = null;

    console.log(`[DAEMON] Starting session: "${sName}" by "${uName}"`);

    // Call Signaler API (proxy-aware)
    const data = await signalerPost('/create-session', { username: uName, name: sName });
    console.log('[DAEMON] Session created successfully on server', data);

    session = {
      id: data.sessionId,
      name: data.name,
      role: 'host',
      isConnected: false,
      userId: data.userId,
      wsToken: data.wsToken,
      roomSecret: roomSecret || null,
    };

    // Derive Encryption Key
    encryptionKey = await deriveKey(data.sessionId, roomSecret);
    console.log('[DAEMON] E2EE Cryptographic key derived');

    // WS connection url
    wsUrl = data.wsUrl || `${activeSignalerUrl.replace(/^http/, 'ws')}/ws`;
    if (wsUrl) connectWebSocket(wsUrl);

    writeStateFile();
    // joinUrl: the web join page on the server this daemon actually uses (srift.app or a self-hosted one).
    res.json({ success: true, sessionId: data.sessionId, joinUrl: `${activeSignalerUrl.replace(/\/+$/, '')}/join-session?id=${data.sessionId}` });
  } catch (err: any) {
    console.error('[DAEMON] Failed to start session:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/session/join', async (req: Request, res: Response) => {
  try {
    const { sessionId, username, roomSecret } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    // Fresh join — clear any prior fatal-termination state.
    sessionTerminated = false; terminationReason = null;

    const uName = username || 'CLI-Guest';
    console.log(`[DAEMON] Joining session: "${sessionId}" as "${uName}"`);

    let data: any;
    try {
      data = await signalerPost('/join-session', { sessionId, username: uName });
    } catch (e: any) {
      // Map signaler HTTP status to sensible daemon status
      const statusCode = e?.status >= 400 && e?.status < 500 ? e.status : 502;
      return res.status(statusCode).json({ success: false, error: e?.message || String(e) });
    }
    console.log('[DAEMON] Join initialized on server', data);

    session = {
      id: data.sessionId,
      name: data.name,
      role: 'guest',
      isConnected: false,
      userId: null,
      tempUserId: data.tempUserId,
      wsToken: data.wsToken,
      roomSecret: roomSecret || null,
      username: uName,
    };

    encryptionKey = await deriveKey(data.sessionId, roomSecret);
    console.log('[DAEMON] E2EE Cryptographic key derived');

    wsUrl = data.wsUrl || `${activeSignalerUrl.replace(/^http/, 'ws')}/ws`;
    if (wsUrl) connectWebSocket(wsUrl);

    writeStateFile();
    res.json({ success: true, sessionId: data.sessionId });
  } catch (err: any) {
    console.error('[DAEMON] Failed to join session:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/session/approve', async (req: Request, res: Response) => {
  const { tempUserId } = req.body;
  if (!tempUserId) {
    return res.status(400).json({ success: false, error: 'tempUserId required' });
  }
  if (session.role !== 'host') {
    return res.status(403).json({ success: false, error: 'Only host can approve joins' });
  }
  const pending = pendingJoins.find((j) => j.tempUserId === tempUserId);
  if (!pending) {
    return res.status(404).json({ success: false, error: `No pending join request found for tempUserId: ${tempUserId}` });
  }

  console.log(`[DAEMON] Approving join request: ${tempUserId}`);
  wsConn?.send(JSON.stringify({
    type: 'approve_join',
    payload: { sessionId: session.id, tempUserId }
  }));

  pendingJoins = pendingJoins.filter((j) => j.tempUserId !== tempUserId);
  // Return once the guest is actually in the room (online in the member list),
  // so `approve` → `chat send` reaches them; the server keeps no chat history.
  const before = new Set(participants.filter((p) => p.online).map((p) => p.userId));
  const joined = () => participants.find((p) => p.online && !p.isHost && p.username === pending.username && !before.has(p.userId));
  for (let waited = 0; waited < 8000 && !joined() && session.id; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const member = joined();
  res.json({ success: true, joined: !!member, userId: member?.userId ?? null, username: pending.username });
});

app.post('/session/reject', (req: Request, res: Response) => {
  const { tempUserId, reason } = req.body;
  if (!tempUserId) {
    return res.status(400).json({ success: false, error: 'tempUserId required' });
  }
  if (session.role !== 'host') {
    return res.status(403).json({ success: false, error: 'Only host can reject joins' });
  }

  console.log(`[DAEMON] Rejecting join request: ${tempUserId}`);
  wsConn?.send(JSON.stringify({
    type: 'reject_join',
    payload: { tempUserId, reason: reason || 'Kicked by host CLI' }
  }));

  pendingJoins = pendingJoins.filter((j) => j.tempUserId !== tempUserId);
  res.json({ success: true });
});

app.post('/session/kick', (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId required' });
  }
  if (session.role !== 'host') {
    return res.status(403).json({ success: false, error: 'Only host can kick users' });
  }

  console.log(`[DAEMON] Kicking user: ${userId}`);
  wsConn?.send(JSON.stringify({
    type: 'kick',
    payload: { targetId: userId }
  }));
  res.json({ success: true });
});

app.post('/session/close', (req: Request, res: Response) => {
  console.log('[DAEMON] Closing active session — full teardown');
  // 0. Tell the SERVER to actually tear down the session, otherwise it lingers
  //    in the cloud DB as "active" forever (the old code only dropped the WS,
  //    so sessions leaked server-side). Host -> delete_session (kills the room
  //    for everyone + deletes the DB rows). Guest -> leave_session (removes just
  //    this user). Mark terminated so on('close') does NOT auto-reconnect.
  sessionTerminated = true;
  try {
    console.log(`[DAEMON] close: role=${session.role} id=${session.id} wsState=${wsConn ? wsConn.readyState : 'no-ws'}`);
    if (wsConn && wsConn.readyState === 1 /* OPEN */ && session.id) {
      if (session.role === 'host') {
        wsConn.send(JSON.stringify({ type: 'delete_session', payload: { sessionId: session.id } }));
        console.log('[DAEMON] close: sent delete_session');
      } else {
        wsConn.send(JSON.stringify({ type: 'leave_session', payload: { sessionId: session.id, userId: session.userId } }));
        console.log('[DAEMON] close: sent leave_session');
      }
    }
  } catch (e: any) { console.error('[DAEMON] close: send failed', e?.message); }
  // 1. WebSocket signaling — give the leave/delete frame ~300ms to flush before
  //    we tear the socket down, so the server actually receives it.
  if (wsConn) {
    const _ws = wsConn;
    setTimeout(() => { try { _ws.close(); } catch {} }, 700);
    wsConn = null;
  }
  wsUrl = null;
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  // 2. WebTorrent client + any in-flight torrents (previously leaked)
  if (wtClient) {
    try { wtClient.destroy(); } catch {}
    wtClient = null;
  }
  activeTorrents.clear();
  // 3. Session + in-memory crypto state (was leaking the AES key)
  session = { id: null, name: null, role: null, isConnected: false, userId: null };
  activeTransfers = [];
  chatHistory = [];
  pendingJoins = [];
  participants = [];
  csrfToken = null;
  encryptionKey = null;
  // 4. Clean .srift-temp/ chunk files from this session
  try {
    if (fs.existsSync(TEMP_DIR)) {
      for (const f of fs.readdirSync(TEMP_DIR)) {
        try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
      }
    }
  } catch {}

  writeStateFile();
  res.json({ success: true });
});

/**
 * Session-signaling readiness for chat and file offers. Right after join/approve
 * the socket is still (re)connecting or not yet authenticated (csrfToken arrives
 * with init_*_ack), and the server drops messages from unauthenticated sockets.
 * Waits briefly; returns an HTTP error to send, or null when ready.
 */
async function waitSignalReady(maxMs = 8000): Promise<{ status: number; body: any } | null> {
  if (!session.id) return { status: 409, body: { success: false, error: 'No active session. Call /session/start first.' } };
  if (sessionTerminated) return { status: 410, body: { success: false, error: terminationReason || 'The session ended.' } };
  if (session.role === 'guest' && !session.userId) {
    return { status: 409, body: { success: false, error: 'Waiting for the host to approve your join request.', retryAfterMs: 2000 } };
  }
  const ready = () => !!encryptionKey && !!csrfToken && wsConn?.readyState === WebSocket.OPEN;
  for (let waited = 0; waited < maxMs && !ready() && session.id; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (ready()) return null;
  if (!encryptionKey) return { status: 409, body: { success: false, error: 'Encryption key not ready. Session still initialising.' } };
  return { status: 503, body: { success: false, error: 'Signaling connection not ready (WebSocket is connecting). Retry in 1–2 seconds.', retryAfterMs: 1500 } };
}

app.post('/send', async (req: Request, res: Response) => {
  try {
    const { filePath, protocol } = req.body;
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'filePath is required' });
    }

    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ success: false, error: `File not found: ${absPath}` });
    }

    const stat = fs.statSync(absPath);
    const filename = path.basename(absPath);
    const fileId = `cli_file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    // The end-to-end sealed relay carries every size by default: it always gets through (outbound 443) and is
    // sealed for the receiver's own key. WebTorrent only on request: CLI-to-CLI swarms need a WebRTC path that
    // many networks lack, with no fallback once a transfer has started.
    const targetProtocol = (webTorrentAllowed() && protocol === 'webtorrent'
      ? 'webtorrent'
      : 'websocket') as 'websocket' | 'webtorrent';

    const notReady = await waitSignalReady();
    if (notReady) return res.status(notReady.status).json(notReady.body);

    // Add to transfers
    const newTx = {
      fileId,
      name: filename,
      size: stat.size,
      progress: 0,
      speedKBps: 0,
      etaSeconds: 0,
      protocol: targetProtocol,
      status: 'pending' as const,
      direction: 'upload' as const,
      filePath: absPath,
      bytesTransferred: 0,
      chunksCount: 0,
      totalChunks: 0,
      startTime: Date.now(),
    };
    activeTransfers.push(newTx);
    writeStateFile();

    // Send file offer to Signaling server
    console.log(`[DAEMON] Offering file via ${targetProtocol}: ${filename} (${stat.size} bytes)`);
    wsConn?.send(JSON.stringify({
      type: 'file_offer',
      payload: {
        fileId,
        filename,
        size: stat.size,
        mime: 'application/octet-stream',
        transferType: targetProtocol,
        csrfToken,
      }
    }));

    res.json({ success: true, fileId, protocol: targetProtocol });
  } catch (err: any) {
    console.error('[DAEMON] Send offer failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/receive', async (req: Request, res: Response) => {
  const { fileId, saveDir } = req.body;
  if (!fileId) {
    return res.status(400).json({ success: false, error: 'fileId is required' });
  }

  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) {
    return res.status(404).json({ success: false, error: 'No offer found for this fileId' });
  }

  tx.saveDir = saveDir ? path.resolve(saveDir) : process.cwd();
  tx.status = 'downloading';
  tx.startTime = Date.now();

  console.log(`[DAEMON] Accepting file offer ${fileId}, saving to ${tx.saveDir}`);
  // relayEnc: this daemon opens sgcm1 chunks; relayPk: new senders seal for this per-transfer key (pgcm1).
  let relayPk: string | undefined;
  try {
    const rx = relayReceiver(session.id!, fileId, session.roomSecret);
    remember(relayReceivers, fileId, rx);
    relayPk = (await rx).publicKey;
  } catch (e: any) { console.warn(`[DAEMON] No per-transfer relay key for ${fileId}: ${e?.message || e}`); }
  wsConn?.send(JSON.stringify({
    type: 'file_accept',
    payload: { fileId, relayEnc: RELAY_ENC, relayFmt: RELAY_FORMAT, ...(relayPk ? { relayPk } : {}) }
  }));

  res.json({ success: true });
});

app.post('/chat/send', async (req: Request, res: Response) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, error: 'message required' });
    }
    if (!session.id) {
      return res.status(409).json({ success: false, error: 'No active session. Call /session/start first.' });
    }
    const notReady = await waitSignalReady();
    if (notReady) return res.status(notReady.status).json(notReady.body);

    const encContent = await sealChatContent(message);
    wsConn!.send(JSON.stringify({
      type: 'chat',
      payload: { content: encContent, encrypted: true }
    }));

    // Add to local history
    const chatMsg = {
      messageId: uuidv4(),
      sender: 'Me',
      content: message,
      timestamp: new Date().toISOString(),
    };
    chatHistory.push(chatMsg);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/chat/history', (req: Request, res: Response) => {
  res.json(chatHistory);
});

// ─── /state — raw workspace state snapshot ───
app.get('/state', (req: Request, res: Response) => {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf-8');
      res.type('application/json').send(raw);
    } else {
      res.json({ session: { id: null, isConnected: false }, activeTransfers: [], lastUpdated: null });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public-share helpers ──────────────────────────────────────────────
type PubshareOpts = {
  maxDownloads?: number; // 0 = unlimited (default)
  ttlMs?: number;        // 0 = never expires (default)
  preferToken?: string;  // for re-registration after reconnect
  preferClaim?: string;  // proves ownership of preferToken across sessions
  encrypted?: boolean;
  linkKey?: string;
  tempFile?: string;
  displayName?: string;
  prefixLen?: number;
};

async function registerPubshare(
  fileId: string,
  absPath: string,
  filename: string,
  size: number,
  mime: string,
  opts: PubshareOpts = {},
  timeoutMs = 5000,
): Promise<PubshareEntry> {
  if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
    throw new Error('Signaling WebSocket not connected');
  }
  const maxDownloads = Math.max(0, Math.floor(opts.maxDownloads || 0));
  const expiresAt = opts.ttlMs && opts.ttlMs > 0 ? Date.now() + opts.ttlMs : null;
  const entry: PubshareEntry = {
    token: opts.preferToken || null,
    filePath: absPath, filename, size, mime, fileId, downloadUrl: null,
    maxDownloads, expiresAt, downloadCount: 0, createdAt: Date.now(),
    encrypted: !!opts.encrypted, linkKey: opts.linkKey, tempFile: opts.tempFile,
    displayName: opts.displayName || filename, prefixLen: opts.prefixLen, claim: opts.preferClaim,
  };
  pubshares.set(fileId, entry);
  const ackP = new Promise<PubshareEntry>((resolve, reject) => {
    pubshareRegResolvers.set(fileId, resolve);
    setTimeout(() => {
      if (pubshareRegResolvers.has(fileId)) {
        pubshareRegResolvers.delete(fileId);
        // Cleanup the half-baked entry so /pubshare/list and reconnect-replay
        // don't see a registration that never actually completed.
        pubshares.delete(fileId);
        reject(new Error(
          'Signaler does not recognise pubshare_register — likely running an older server build. ' +
          'Until srift.app picks up the new release, the recipient must join the session in a browser.'
        ));
      }
    }, timeoutMs);
  });
  wsConn.send(JSON.stringify({
    type: 'pubshare_register',
    payload: {
      fileId, filename, size, mime,
      maxDownloads, expiresAt,
      preferToken: opts.preferToken || undefined,
      preferClaim: opts.preferToken && opts.preferClaim ? opts.preferClaim : undefined,
      encrypted: opts.encrypted ? true : undefined,
      prefixLen: opts.encrypted && opts.prefixLen ? opts.prefixLen : undefined,
    },
  }));
  return ackP;
}

// Re-register every active pubshare with the signaler after a reconnect.
// Tokens are preserved so existing download links keep working.
async function reregisterPubsharesAfterReconnect(): Promise<void> {
  if (!pubshares.size) return;
  console.log(`[DAEMON] Re-registering ${pubshares.size} pubshare(s) after WS reconnect…`);
  for (const entry of Array.from(pubshares.values())) {
    if (!entry.token) continue;
    // Drop expired ones; don't bother re-registering
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      pubshares.delete(entry.fileId);
      pubsharesByToken.delete(entry.token);
      if (entry.tempFile) { try { fs.unlinkSync(entry.tempFile); } catch {} }
      continue;
    }
    // Drop already-exhausted entries — re-registering them with maxDownloads=0
    // or with the original cap would either reset the counter or allow another
    // download. Either way it'd violate the user's --max-downloads contract.
    if (entry.maxDownloads && entry.downloadCount >= entry.maxDownloads) {
      pubshares.delete(entry.fileId);
      pubsharesByToken.delete(entry.token);
      if (entry.tempFile) { try { fs.unlinkSync(entry.tempFile); } catch {} }
      continue;
    }
    try {
      const remainingTtl = entry.expiresAt ? Math.max(0, entry.expiresAt - Date.now()) : 0;
      const remainingMax = entry.maxDownloads
        ? Math.max(1, entry.maxDownloads - entry.downloadCount)
        : 0;
      await registerPubshare(
        entry.fileId, entry.filePath, entry.filename, entry.size, entry.mime,
        { maxDownloads: remainingMax, ttlMs: remainingTtl, preferToken: entry.token, preferClaim: entry.claim,
          encrypted: entry.encrypted, linkKey: entry.linkKey, tempFile: entry.tempFile,
          displayName: entry.displayName, prefixLen: entry.prefixLen },
      );
    } catch (e: any) {
      console.warn(`[DAEMON] Failed to re-register pubshare ${entry.fileId}: ${e?.message}`);
    }
  }
}

async function handlePubsharePull(payload: any): Promise<void> {
  const { requestId, token, start, end, isFullDownload } = payload || {};
  if (!requestId || !token) return;
  const entry = pubsharesByToken.get(token);
  if (!entry) {
    wsConn?.send(JSON.stringify({
      type: 'pubshare_end',
      payload: { requestId, ok: false, error: 'unknown token' },
    }));
    return;
  }
  // Open + validate BEFORE counting: a missing, unreadable or modified file
  // fails this link only (the server answers 502 at once) and never burns a
  // --once / --max-downloads use. Other links keep serving.
  let fd: number;
  try {
    fd = fs.openSync(entry.filePath, 'r');
  } catch (e: any) {
    throw new Error(e?.code === 'ENOENT' ? 'the shared file no longer exists on the sender' : `cannot read the shared file (${e?.code || e?.message})`);
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size !== entry.size) throw new Error('the shared file changed after the link was created');
  } catch (e) {
    try { fs.closeSync(fd); } catch {}
    throw e;
  }
  // Limited links are counted when a download STARTS (the server does the same),
  // so a re-registration after a reconnect never re-opens an exhausted link.
  if (isFullDownload && entry.maxDownloads) entry.downloadCount++;
  const cancelFlag = { cancelled: false, token };
  activePulls.set(requestId, cancelFlag);

  const CHUNK = 64 * 1024;
  let pos = start;
  let seq = 0;
  let completedOk = false;
  try {
    while (pos <= end) {
      if (cancelFlag.cancelled) break;
      if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
        throw new Error('Signaling WebSocket disconnected mid-stream');
      }
      const len = Math.min(CHUNK, end - pos + 1);
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, pos);
      if (got !== len) throw new Error('the shared file changed while it was being sent');
      const dataB64 = buf.toString('base64');
      wsConn.send(JSON.stringify({
        type: 'pubshare_chunk',
        payload: { requestId, seq, dataB64 },
      }));
      pos += len;
      seq++;
      // Backpressure: pause briefly if WS buffered amount climbs
      if (wsConn.bufferedAmount > 8 * 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 20));
      } else if (seq % 8 === 0) {
        // Yield every 512 KiB so parallel downloads, new shares and API calls
        // interleave fairly instead of waiting for one big stream.
        await new Promise((r) => setImmediate(r));
      }
    }
    if (!cancelFlag.cancelled) {
      wsConn?.send(JSON.stringify({
        type: 'pubshare_end',
        payload: { requestId, ok: true },
      }));
      completedOk = true;
    }
  } finally {
    try { fs.closeSync(fd); } catch {}
    activePulls.delete(requestId);
  }

  // Unlimited links: count completed downloads that started at byte 0 (stats).
  // Limited links were already counted at start, above. Resumes never count.
  if (completedOk && isFullDownload) {
    entry.completedDownloads = (entry.completedDownloads || 0) + 1;
    if (!entry.maxDownloads) entry.downloadCount++;
    broadcastSSE('pubshare_download', {
      token: entry.token,
      fileId: entry.fileId,
      filename: entry.filename,
      downloadCount: entry.downloadCount,
      maxDownloads: entry.maxDownloads,
    });
    // IMPORTANT: do NOT proactively unregister the token on cap-hit.
    // Keep the local entry around so the server can return a proper
    // 410 Gone ("reached its download limit") on the next request,
    // distinguishable from a 404 ("never existed"). The server's
    // _pubResolveDownload() does the actual release lazily on the
    // first request after exhaustion. The daemon's `/pubshare/list`
    // continues to filter out entries that the server has released
    // (their pubshare_pull calls will fail with "unknown token").
    if (entry.maxDownloads && entry.downloadCount >= entry.maxDownloads) {
      console.log(`[DAEMON] pubshare exhausted (max ${entry.maxDownloads} reached): ${entry.filename}`);
    }
  }
}

// ─── Link creation ────────────────────────────────────────────────────
// Links are relay links: this daemon streams the file on demand over its
// signaling WebSocket. The server forwards bytes and stores nothing, so the
// link works while this daemon runs. --encrypt/--password make it E2EE (key
// in the #k= fragment, never sent to the server).

type ShareRequest = {
  filePath?: string;
  /** Several files/folders at once: one bundle link (default) or one link each. */
  filePaths?: string[];
  /** filePaths only: true (default) = one .tar.gz link; false = one link per path. */
  bundle?: boolean;
  /** filePaths bundle only: archive name (".tar.gz" added). */
  bundleName?: string;
  /** Extra exclude globs when packing folders (.git, node_modules always excluded). */
  exclude?: string[];
  /** Internal: a temp file this share owns (packed archive), removed with the link. */
  _ownedPath?: string;
  sessionName?: string;
  maxDownloads?: number;
  ttlMs?: number;
  mode?: string; // accepted for older clients; only 'relay' (or 'auto') is valid
  encrypt?: boolean;
  password?: string;
  name?: string;
};

function linkWithKey(url: string | null, key?: string): string | null {
  return url && key ? `${url}#k=${key}` : url;
}

// Single-flight: parallel shares must not each create their own session.
let hostSessionInflight: Promise<void> | null = null;
async function ensureHostSession(sessionName?: string): Promise<void> {
  if (hostSessionInflight) return hostSessionInflight;
  hostSessionInflight = ensureHostSessionOnce(sessionName).finally(() => { hostSessionInflight = null; });
  return hostSessionInflight;
}

async function ensureHostSessionOnce(sessionName?: string): Promise<void> {
  // A session the server terminated (critical error, kick) cannot be reused.
  if (!session.id || sessionTerminated) {
    const data = await signalerPost('/create-session', { username: 'AI-Agent', name: sessionName || 'AI-QuickShare' });
    sessionTerminated = false; terminationReason = null;
    session = {
      id: data.sessionId, name: data.name, role: 'host',
      isConnected: false, userId: data.userId, wsToken: data.wsToken, roomSecret: null,
    };
    encryptionKey = await deriveKey(data.sessionId);
    wsUrl = data.wsUrl || `${activeSignalerUrl.replace(/^http/, 'ws')}/ws`;
    if (wsUrl) connectWebSocket(wsUrl);
    writeStateFile();
  }
  // Event-driven: return as soon as the socket is open and host auth is done
  // (replaces a fixed 800 ms sleep that was both slow and racy).
  await waitForHostAuth(8000);
}

async function shareViaRelay(absPath: string, stat: fs.Stats, reqBody: ShareRequest, encrypt: boolean): Promise<ShareResult> {
  await ensureHostSession(reqBody.sessionName);
  const filename = reqBody.name || path.basename(absPath);
  const fileId = `cli_file_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  let servePath = absPath;
  let serveSize = stat.size;
  let linkKey: string | undefined;
  let tempFile: string | undefined;
  let prefixLen: number | undefined;

  if (encrypt) {
    // Pre-encrypt to a private temp file so HTTP Range/resume work unchanged.
    const key = newLinkKey();
    linkKey = b64url(key);
    tempFile = path.join(TEMP_DIR, `${fileId}.sre1`);
    const meta = { name: filename, size: stat.size, mime: 'application/octet-stream' };
    const fd = fs.openSync(tempFile, 'w', 0o600);
    try {
      for await (const part of encryptFile(absPath, key, meta, { password: reqBody.password })) fs.writeSync(fd, part);
    } finally { fs.closeSync(fd); }
    servePath = tempFile;
    serveSize = encryptedSize(stat.size, meta);
    prefixLen = 36 + 4 + Buffer.byteLength(JSON.stringify(meta)) + 16; // header + len + meta ciphertext
  } else {
    // Also offer the plaintext file to peers already in the session (browser UI).
    const targetProtocol: 'webtorrent' | 'websocket' = 'websocket'; // sealed relay: see /send
    activeTransfers.push({
      fileId, name: filename, size: stat.size,
      progress: 0, speedKBps: 0, etaSeconds: 0,
      protocol: targetProtocol, status: 'pending', direction: 'upload',
      filePath: absPath, bytesTransferred: 0, chunksCount: 0, totalChunks: 0,
      startTime: Date.now(),
    });
    writeStateFile();
    wsConn?.send(JSON.stringify({
      type: 'file_offer',
      payload: { fileId, filename, size: stat.size, mime: 'application/octet-stream', transferType: targetProtocol, csrfToken },
    }));
  }

  if (reqBody._ownedPath) {
    // Encrypted: the .sre1 copy is what gets served, so the archive can go now.
    if (encrypt) { try { fs.unlinkSync(reqBody._ownedPath); } catch {} }
    else tempFile = reqBody._ownedPath;
  }

  try {
    const entry = await registerPubshare(
      fileId, servePath, encrypt ? 'encrypted.srift' : filename, serveSize, 'application/octet-stream',
      {
        maxDownloads: typeof reqBody.maxDownloads === 'number' ? reqBody.maxDownloads : 0,
        ttlMs: typeof reqBody.ttlMs === 'number' ? reqBody.ttlMs : 0,
        encrypted: encrypt, linkKey, tempFile, displayName: filename, prefixLen,
      },
    );
    return {
      success: true,
      mode: 'relay',
      sessionId: session.id,
      fileId,
      token: entry.token || '',
      downloadUrl: linkWithKey(entry.downloadUrl, linkKey) || '',
      fileName: filename,
      fileSize: stat.size,
      maxDownloads: entry.maxDownloads,
      expiresAt: entry.expiresAt,
      encrypted: encrypt,
      passwordProtected: !!reqBody.password,
    };
  } catch (e) {
    if (tempFile) { try { fs.unlinkSync(tempFile); } catch {} }
    throw e;
  }
}

/** Request bodies from outside: internal fields (e.g. _ownedPath) are never accepted. */
function publicShareBody(body: any): ShareRequest {
  const out: any = { ...(body && typeof body === 'object' ? body : {}) };
  for (const k of Object.keys(out)) if (k.startsWith('_')) delete out[k];
  return out;
}

const MAX_MULTI_PATHS = 500;
const MULTI_CONCURRENCY = 4;

function shareEncrypt(reqBody: ShareRequest): boolean {
  return reqBody.password ? true : reqBody.encrypt === true;
}

function assertRelayMode(reqBody: ShareRequest): void {
  const requested = reqBody.mode || 'relay';
  if (requested !== 'relay' && requested !== 'auto') {
    throw Object.assign(new Error(`Unsupported mode "${requested}": SRIFT does not store files on a server; links are relay links served by this daemon.`), { status: 400 });
  }
}

function excludesFor(reqBody: ShareRequest): string[] {
  const extra = Array.isArray(reqBody.exclude) ? reqBody.exclude.filter((x) => typeof x === 'string' && x.trim()) : [];
  return [...DEFAULT_EXCLUDES, ...extra];
}

function safeArchiveBase(name: string | undefined, fallback: string): string {
  const base = String(name || '').replace(/\.tar\.gz$|\.tgz$/i, '').replace(/[^\w.\- ()]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  return base || fallback;
}

async function createShare(reqBody: ShareRequest): Promise<ShareResult> {
  if (!reqBody?.filePath) throw Object.assign(new Error('filePath (or filePaths) required'), { status: 400 });
  assertRelayMode(reqBody);
  const absPath = path.resolve(reqBody.filePath);
  let stat: fs.Stats;
  try { stat = fs.statSync(absPath); } catch { throw Object.assign(new Error(`File not found: ${absPath}`), { status: 404 }); }
  if (stat.isDirectory()) {
    // Folders are sent as one .tar.gz (the archive is removed with the link).
    const base = safeArchiveBase(path.basename(absPath), 'folder');
    const out = path.join(TEMP_DIR, `${uuidv4()}-${base}.tar.gz`);
    try { await packDirectory(absPath, out, excludesFor(reqBody)); } catch (e: any) {
      try { fs.unlinkSync(out); } catch {}
      throw Object.assign(new Error(e?.message || String(e)), { status: 400 });
    }
    return shareViaRelay(out, fs.statSync(out), { ...reqBody, name: reqBody.name || `${base}.tar.gz`, _ownedPath: out }, shareEncrypt(reqBody));
  }
  if (!stat.isFile()) throw Object.assign(new Error(`Not a regular file or folder: ${absPath}`), { status: 400 });
  return shareViaRelay(absPath, stat, reqBody, shareEncrypt(reqBody));
}

type MultiShareResult =
  | (ShareResult & { bundle: true; files: number; bytes: number; paths: number; skipped: { path: string; reason: string }[] })
  | { success: boolean; mode: 'relay'; bundle: false; links: (ShareResult & { filePath: string })[]; errors: { filePath: string; error: string }[] };

/**
 * Several files/folders in one request. bundle (default): pack into one
 * .tar.gz and return a single link. bundle:false: one link per path, created
 * in parallel (bounded), with per-path errors instead of failing everything.
 */
async function createMultiShare(reqBody: ShareRequest): Promise<MultiShareResult> {
  assertRelayMode(reqBody);
  const raw = Array.isArray(reqBody.filePaths) ? reqBody.filePaths : [];
  const paths = Array.from(new Set(raw.filter((p) => typeof p === 'string' && p.trim()).map((p) => path.resolve(p))));
  if (!paths.length) throw Object.assign(new Error('filePaths must be a non-empty array of paths'), { status: 400 });
  if (paths.length > MAX_MULTI_PATHS) throw Object.assign(new Error(`Too many paths (${paths.length}); max ${MAX_MULTI_PATHS}. Share a folder instead.`), { status: 400 });
  const missing = paths.filter((p) => !fs.existsSync(p));
  const bundle = reqBody.bundle !== false;

  if (bundle) {
    // Missing/unreadable paths are skipped and reported (packPaths), never fatal
    // unless nothing at all is left to share.
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const base = safeArchiveBase(reqBody.bundleName, `srift-${paths.length}-items-${stamp}`);
    const out = path.join(TEMP_DIR, `${uuidv4()}-${base}.tar.gz`);
    let packed: { files: number; bytes: number; skipped: { path: string; reason: string }[] };
    try { packed = await packPaths(paths, out, base, excludesFor(reqBody)); } catch (e: any) {
      try { fs.unlinkSync(out); } catch {}
      throw Object.assign(new Error(e?.message || String(e)), { status: 400 });
    }
    const r = await shareViaRelay(out, fs.statSync(out), { ...reqBody, name: `${base}.tar.gz`, _ownedPath: out }, shareEncrypt(reqBody));
    if (packed.skipped.length) console.warn(`[DAEMON] bundle skipped ${packed.skipped.length} item(s): ${packed.skipped.map((x) => x.path).join(', ')}`);
    return { ...r, bundle: true, files: packed.files, bytes: packed.bytes, paths: paths.length, skipped: packed.skipped };
  }

  await ensureHostSession(reqBody.sessionName); // once, before the parallel fan-out
  const links: (ShareResult & { filePath: string })[] = [];
  const errors: { filePath: string; error: string }[] = missing.map((p) => ({ filePath: p, error: 'File not found' }));
  const todo = paths.filter((p) => !missing.includes(p));
  const results = await mapLimit(todo, MULTI_CONCURRENCY, async (p) => {
    try { return { p, r: await createShare({ ...reqBody, filePaths: undefined, filePath: p, name: undefined }) }; }
    catch (e: any) { return { p, e: e?.message || String(e) }; }
  });
  for (const x of results) {
    if ('r' in x && x.r) links.push({ ...x.r, filePath: x.p });
    else errors.push({ filePath: x.p, error: (x as any).e });
  }
  return { success: links.length > 0, mode: 'relay', bundle: false, links, errors };
}

// ─── /quick-share — one-shot link for a file ───
//   { filePath | filePaths[], bundle?, bundleName?, exclude?[], encrypt?, password?,
//     maxDownloads?, ttlMs?, name?, sessionName? }
app.post('/quick-share', async (req: Request, res: Response) => {
  try {
    if (Array.isArray(req.body?.filePaths)) {
      const m = await createMultiShare(publicShareBody(req.body));
      if (m.bundle === false && !m.success) {
        return res.status(400).json({ ...m, error: m.errors.map((e) => `${e.filePath}: ${e.error}`).join('; ') });
      }
      return res.json(m.bundle ? { ...m, shareUrl: m.downloadUrl } : m);
    }
    const r = await createShare(publicShareBody(req.body));
    // `shareUrl` kept for older clients that read it.
    res.json({ ...r, shareUrl: r.downloadUrl });
  } catch (err: any) {
    console.error('[DAEMON] /quick-share failed:', err?.message || err);
    res.status(err?.status || 500).json({ success: false, error: err?.message || String(err) });
  }
});

// ─── /pubshare — same as quick-share but requires an existing session ───
app.post('/pubshare', async (req: Request, res: Response) => {
  try {
    const body = publicShareBody(req.body);
    if (!session.id || !session.isConnected) {
      return res.status(409).json({ success: false, error: 'No active session — run `srift session start` or `srift quick-share` first' });
    }
    const r = await createShare(body);
    res.json(r);
  } catch (err: any) {
    console.error('[DAEMON] /pubshare failed:', err?.message || err);
    res.status(err?.status || 500).json({ success: false, error: err?.message || String(err) });
  }
});

// ─── /v1/diag — capability probe (what works from this machine, and fixes) ───
app.get('/v1/diag', async (req: Request, res: Response) => {
  try {
    res.json(await getDiag(req.query.fresh === '1' || req.query.fresh === 'true'));
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ─── /pubshare/list — currently active public download links ───
app.get('/pubshare/list', (_req: Request, res: Response) => {
  const now = Date.now();
  const items: any[] = Array.from(pubshares.values())
    .filter((e) => !e.expiresAt || e.expiresAt > now)
    .map((e) => ({
      token: e.token,
      downloadUrl: linkWithKey(e.downloadUrl, e.linkKey),
      mode: 'relay',
      encrypted: !!e.encrypted,
      fileId: e.fileId,
      fileName: e.displayName || e.filename,
      fileSize: e.size,
      downloadCount: e.downloadCount,
      completedDownloads: e.completedDownloads || 0,
      activeDownloads: Array.from(activePulls.values()).filter((p) => p.token === e.token).length,
      maxDownloads: e.maxDownloads,
      expiresAt: e.expiresAt,
      createdAt: e.createdAt,
    }));
  res.json({ success: true, items });
});

// ─── /pubshare/revoke — invalidate a token immediately ───
app.post('/pubshare/revoke', (req: Request, res: Response) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: 'token required' });
  const entry = pubsharesByToken.get(token);
  if (!entry) return res.status(404).json({ success: false, error: 'Unknown token' });
  try {
    wsConn?.send(JSON.stringify({ type: 'pubshare_unregister', payload: { token } }));
  } catch {}
  pubsharesByToken.delete(token);
  pubshares.delete(entry.fileId);
  if (entry.tempFile) { try { fs.unlinkSync(entry.tempFile); } catch {} }
  res.json({ success: true });
});

// ─── MCP HTTP transport (Streamable HTTP, MCP spec 2026-07-28; older versions negotiated) ───
// Single endpoint that accepts POST JSON-RPC and returns JSON-RPC responses.
// Also supports GET for SSE event stream (server-initiated notifications).
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const message = req.body;
    if (Array.isArray(message)) {
      // batched
      const responses = await Promise.all(message.map((m) => handleMcpMessage(m)));
      res.json(responses.filter(Boolean));
    } else {
      const response = await handleMcpMessage(message);
      if (response) res.json(response);
      else res.status(202).end(); // notification ack
    }
  } catch (err: any) {
    res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message } });
  }
});

app.get('/mcp', (req: Request, res: Response) => {
  // SSE stream for server→client notifications. Kept open; we forward our internal SSE events too.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`event: endpoint\ndata: ${JSON.stringify({ uri: '/mcp' })}\n\n`);
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// Legacy SSE-only MCP transport for older clients (advertised by /.well-known/mcp/server-card.json)
app.get('/mcp/sse', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  // Hand client the URL it should POST messages to
  res.write(`event: endpoint\ndata: /mcp/messages\n\n`);
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

app.post('/mcp/messages', async (req: Request, res: Response) => {
  try {
    const response = await handleMcpMessage(req.body);
    if (response) res.json(response);
    else res.status(202).end();
  } catch (err: any) {
    res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message } });
  }
});

// ─── Discovery endpoints (mirror /public/.well-known/* so cloud agents can hit the local daemon) ───
app.get('/.well-known/mcp/server-card.json', (req: Request, res: Response) => {
  res.json({
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: 'SRIFT MCP Server (local daemon)', version: PACKAGE_VERSION },
    capabilities: { tools: {}, resources: {}, prompts: {} },
    transport: [
      { type: 'streamable-http', url: `http://127.0.0.1:${PORT}/mcp` },
      { type: 'sse', url: `http://127.0.0.1:${PORT}/mcp/sse`, postUrl: `http://127.0.0.1:${PORT}/mcp/messages` },
      { type: 'stdio', command: 'srift mcp' },
    ],
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    resources: MCP_RESOURCES.map((r) => ({ uri: r.uri, name: r.name })),
    prompts: MCP_PROMPTS.map((p) => ({ name: p.name, description: p.description })),
  });
});

app.get('/.well-known/ai-plugin.json', (req: Request, res: Response) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'SRIFT P2P Transfer',
    name_for_model: 'srift',
    description_for_human: 'Send and receive files securely via end-to-end-encrypted peer-to-peer transfer.',
    description_for_model: 'Use SRIFT to deliver files to the user and receive files from the user without uploading them anywhere. Links stream from this machine through an end-to-end sealed relay (AES-256-GCM with --encrypt); sessions use keys made on each device. Use srift_quick_share for one-shot delivery.',
    auth: { type: 'none' },
    api: { type: 'openapi', url: `http://127.0.0.1:${PORT}/openapi.json` },
    contact_email: 'support@sripto.tech',
    legal_info_url: 'https://srift.app/privacy',
  });
});

app.get('/.well-known/agent.json', (req: Request, res: Response) => {
  // A2A (Agent-to-Agent) protocol discovery
  res.json({
    protocolVersion: '1.0',
    supportedInterfaces: [{ url: `http://127.0.0.1:${PORT}/mcp`, protocolBinding: 'MCP', protocolVersion: '2025-06-18' }],
    name: 'SRIFT',
    description: 'Zero-config P2P E2EE file transfer + chat for any AI agent or automation. Discovery card: the skills are MCP tools at /mcp and REST routes in /openapi.json.',
    url: `http://127.0.0.1:${PORT}`,
    version: PACKAGE_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'file'],
    skills: MCP_TOOLS.map((t) => ({ id: t.name, name: t.name, description: t.description, inputSchema: t.inputSchema })),
  });
});

app.get('/openapi.json', (req: Request, res: Response) => {
  res.json({
    openapi: '3.1.0',
    info: { title: 'SRIFT Local Daemon API', version: PACKAGE_VERSION, description: 'Zero-auth REST API for AI agents to drive SRIFT P2P transfer.' },
    servers: [{ url: `http://127.0.0.1:${PORT}` }],
    paths: {
      '/health': { get: { summary: 'Liveness probe', description: 'Returns {ok,version,uptime_ms,mcp,webrtc,webtorrent,webtorrent_error?}', responses: { '200': { description: 'OK' } } } },
      '/status': { get: { summary: 'Get session, transfers, pending joins and participants (members with userId, for /session/kick)', responses: { '200': { description: 'OK' } } } },
      '/state': { get: { summary: 'Workspace state snapshot (.srift-state.json)', responses: { '200': { description: 'OK' } } } },
      '/transfers': { get: { summary: 'Live transfer list with speed and ETA. Optional ?fileId= to filter.', responses: { '200': { description: 'OK' } } } },
      '/transfers/{fileId}': { get: { summary: 'Per-transfer drill-down', parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Transfer not found' } } } },
      '/peers': { get: { summary: 'Peer connection state, RTT, ICE type', responses: { '200': { description: 'OK' } } } },
      '/metrics': { get: { summary: 'Prometheus-format counters (no auth)', responses: { '200': { description: 'text/plain Prometheus format' } } } },
      '/logs': { get: { summary: 'NDJSON daemon log tail. ?lines=N (default 100)', responses: { '200': { description: 'application/x-ndjson' } } } },
      '/reset': { post: { summary: 'Wipe all state and flush encryption keys', responses: { '200': { description: '{ok:true}' } } } },
      '/v1/diag': { get: { summary: 'Network diagnosis (same as `srift doctor --json`); ?fresh=1 re-probes', responses: { '200': { description: 'Diagnosis report' } } } },
      '/daemon/stop': { post: { summary: 'Stop this daemon', responses: { '200': { description: 'OK' } } } },
      '/session/start': { post: { summary: 'Create new session (becomes host); returns sessionId and joinUrl', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { sessionName: { type: 'string' }, username: { type: 'string' }, roomSecret: { type: 'string' } } } } } }, responses: { '200': { description: '{success:true,sessionId,joinUrl}' } } } },
      '/session/join': { post: { summary: 'Join existing session', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' }, username: { type: 'string' }, roomSecret: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'Missing sessionId' }, '404': { description: 'Session not found' } } } },
      '/session/approve': { post: { summary: 'Host approves a pending join request; returns {success, joined, userId} once the guest is in the room (max 8 s)', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['tempUserId'], properties: { tempUserId: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'tempUserId required' }, '403': { description: 'Not host' }, '404': { description: 'No such pending request' } } } },
      '/session/reject': { post: { summary: 'Host rejects a pending join request', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['tempUserId'], properties: { tempUserId: { type: 'string' }, reason: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'tempUserId required' }, '403': { description: 'Not host' } } } },
      '/session/kick': { post: { summary: 'Host kicks a peer', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'userId required' }, '403': { description: 'Not host' } } } },
      '/session/close': { post: { summary: 'Tear down the session and flush keys', responses: { '200': { description: 'OK' } } } },
      '/send': { post: { summary: 'Offer a file to peers (requires active session)', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['filePath'], properties: { filePath: { type: 'string' } } } } } }, responses: { '200': { description: '{success:true,fileId}' } } } },
      '/receive': { post: { summary: 'Accept an incoming file offer', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['fileId'], properties: { fileId: { type: 'string' }, saveDir: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '404': { description: 'No offer for this fileId' } } } },
      '/quick-share': { post: { summary: 'ONE-SHOT: create session if needed and return a direct downloadUrl (https://srift.app/d/<token>) streamed from this machine (nothing stored on a server). Pass filePaths for several files/folders: one .tar.gz link (bundle, default) or one link per path (bundle:false, created in parallel).', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { filePath: { type: 'string', description: 'Absolute path to a file or folder (folders are sent as .tar.gz)' }, filePaths: { type: 'array', items: { type: 'string' }, maxItems: 500, description: 'Several absolute paths (use instead of filePath)' }, bundle: { type: 'boolean', description: 'filePaths: true (default) = one .tar.gz link; false = one link per path' }, bundleName: { type: 'string' }, exclude: { type: 'array', items: { type: 'string' } }, encrypt: { type: 'boolean' }, password: { type: 'string' }, maxDownloads: { type: 'number' }, ttlMs: { type: 'number' }, sessionName: { type: 'string' }, name: { type: 'string', description: 'Recipient-visible file name' } } } } } }, responses: { '200': { description: 'Single/bundle: {success,downloadUrl,token,fileName,fileSize,encrypted,expiresAt,bundle?,files?}. bundle:false: {success,bundle:false,links:[...],errors:[...]}' } } } },
      '/chat/send': { post: { summary: 'Send E2EE chat message', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'message required' }, '409': { description: 'No session' }, '503': { description: 'WS not ready — retry in 1–2s' } } } },
      '/chat/history': { get: { summary: 'Decrypted chat log', responses: { '200': { description: 'Array of {messageId,sender,content,timestamp}' } } } },
      '/api/v1/monitor/events': { get: { summary: 'SSE event stream: connection_state, join_request, file_offer, transfer_progress, chat_received', responses: { '200': { description: 'text/event-stream' } } } },
      '/pubshare': { post: { summary: 'Create a public download link for one file inside the active session (409 without one; /quick-share creates it)', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['filePath'], properties: { filePath: { type: 'string' }, maxDownloads: { type: 'number' }, ttlMs: { type: 'number' }, encrypt: { type: 'boolean' }, password: { type: 'string' }, name: { type: 'string' } } } } } }, responses: { '200': { description: '{success,downloadUrl,token,...}' } } } },
      '/pubshare/list': { get: { summary: 'Active links with download counters', responses: { '200': { description: '{items:[...]}' } } } },
      '/pubshare/revoke': { post: { summary: 'Invalidate a link immediately', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } } }, responses: { '200': { description: '{success:true}' } } } },
      '/openapi.json': { get: { summary: 'This document', responses: { '200': { description: 'OpenAPI 3.1' } } } },
      '/.well-known/mcp/server-card.json': { get: { summary: 'MCP server card', responses: { '200': { description: 'OK' } } } },
      '/.well-known/ai-plugin.json': { get: { summary: 'AI plugin manifest', responses: { '200': { description: 'OK' } } } },
      '/.well-known/agent.json': { get: { summary: 'A2A discovery card', responses: { '200': { description: 'OK' } } } },
      '/mcp': { post: { summary: 'MCP JSON-RPC (Streamable HTTP, spec 2026-07-28; older versions negotiated)', responses: { '200': { description: 'JSON-RPC response' } } }, get: { summary: 'SSE stream for server→client MCP notifications', responses: { '200': { description: 'text/event-stream' } } } },
      '/mcp/sse': { get: { summary: 'Legacy SSE MCP endpoint (older clients)', responses: { '200': { description: 'text/event-stream' } } } },
      '/mcp/messages': { post: { summary: 'Legacy SSE MCP message submission endpoint', responses: { '200': { description: 'OK' } } } },
    },
  });
});

// ─── GET /transfers — live transfer list ───
app.get('/transfers', (req: Request, res: Response) => {
  const fileId = (req.query as any).fileId as string | undefined;
  const list = fileId
    ? activeTransfers.filter((t) => t.fileId === fileId)
    : activeTransfers;
  res.json(list.map((t) => ({
    fileId: t.fileId,
    name: t.name,
    size: t.size,
    progress: parseFloat(t.progress.toFixed(2)),
    speedKBps: parseFloat(t.speedKBps.toFixed(2)),
    etaSeconds: Math.ceil(t.etaSeconds),
    protocol: t.protocol,
    status: t.status,
    direction: t.direction,
    bytesTransferred: t.bytesTransferred,
  })));
});

// ─── GET /transfers/:fileId — per-transfer drill-down ───
app.get('/transfers/:fileId', (req: Request, res: Response) => {
  const tx = activeTransfers.find((t) => t.fileId === req.params.fileId);
  if (!tx) return res.status(404).json({ error: 'Transfer not found' });
  res.json(tx);
});

// ─── GET /peers — peer RTT + connection state ───
app.get('/peers', (req: Request, res: Response) => {
  if (!session.id) return res.json([]);
  const state = wsConn ? wsConn.readyState : 3; // 0=CONNECTING,1=OPEN,2=CLOSING,3=CLOSED
  const stateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
  const peer = {
    sessionId: session.id,
    userId: session.userId,
    role: session.role,
    connectionState: stateNames[state] || 'UNKNOWN',
    transport: 'websocket',
    rttMs: null,
    iceType: 'relay',
    isConnected: session.isConnected,
  };
  res.json(session.id ? [peer] : []);
});

// ─── GET /metrics — Prometheus counters ───
app.get('/metrics', (req: Request, res: Response) => {
  const uptime = ((Date.now() - DAEMON_START_TIME) / 1000).toFixed(0);
  const lines = [
    '# HELP srift_uptime_seconds Daemon uptime in seconds',
    '# TYPE srift_uptime_seconds gauge',
    `srift_uptime_seconds ${uptime}`,
    '# HELP srift_active_transfers Number of active file transfers',
    '# TYPE srift_active_transfers gauge',
    `srift_active_transfers ${activeTransfers.filter((t) => t.status === 'uploading' || t.status === 'downloading').length}`,
    '# HELP srift_total_transfers Total transfers (all statuses)',
    '# TYPE srift_total_transfers counter',
    `srift_total_transfers ${activeTransfers.length}`,
    '# HELP srift_chat_messages_total Total chat messages in history',
    '# TYPE srift_chat_messages_total counter',
    `srift_chat_messages_total ${chatHistory.length}`,
    '# HELP srift_session_active Whether a session is currently active (1 = yes)',
    '# TYPE srift_session_active gauge',
    `srift_session_active ${session.id ? 1 : 0}`,
    '# HELP srift_ws_connected Whether the WebSocket is connected (1 = yes)',
    '# TYPE srift_ws_connected gauge',
    `srift_ws_connected ${session.isConnected ? 1 : 0}`,
  ];
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

// ─── GET /logs — NDJSON log tail ───
app.get('/logs', (req: Request, res: Response) => {
  const lines = parseInt((req.query as any).lines as string || '100', 10);
  try {
    if (!fs.existsSync(logPath)) return res.json([]);
    const content = fs.readFileSync(logPath, 'utf-8');
    const all = content.split('\n').filter(Boolean);
    const tail = all.slice(-Math.min(lines, all.length));
    res.set('Content-Type', 'application/x-ndjson');
    res.send(tail.join('\n'));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /reset — wipe state, flush keys, clean disk artefacts ───
app.post('/reset', (req: Request, res: Response) => {
  console.log('[DAEMON] /reset: full wipe (memory + disk)');

  // 1. Network / transports
  if (wsConn) { try { wsConn.close(); } catch {} wsConn = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (wtClient) { try { wtClient.destroy(); } catch {} wtClient = null; }
  activeTorrents.clear();
  for (const u of [...activeUploads.values()]) stopUpload(u);

  // 2. In-memory session + crypto
  session = { id: null, name: null, role: null, isConnected: false, userId: null };
  activeTransfers = [];
  chatHistory = [];
  pendingJoins = [];
  participants = [];
  csrfToken = null;
  encryptionKey = null;
  wsUrl = null;

  // 3. Disk artefacts — .srift-temp/ chunks were never cleaned by /reset before,
  //    leaving orphan chunk files from previous transfers around forever.
  let cleanedChunks = 0;
  try {
    if (fs.existsSync(TEMP_DIR)) {
      for (const f of fs.readdirSync(TEMP_DIR)) {
        try { fs.unlinkSync(path.join(TEMP_DIR, f)); cleanedChunks++; } catch {}
      }
    }
  } catch {}

  writeStateFile();
  res.json({ ok: true, message: 'State wiped, keys flushed, temp chunks cleaned', cleanedChunks });
});

// SSE Event Stream
app.get('/api/v1/monitor/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);
  console.log(`[DAEMON] SSE Client connected. Active clients: ${sseClients.length}`);

  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
    console.log(`[DAEMON] SSE Client disconnected. Active clients: ${sseClients.length}`);
  });
});

app.post('/daemon/stop', (req: Request, res: Response) => {
  console.log('[DAEMON] Stop request received. Exiting daemon process gracefully...');
  res.json({ success: true });

  // Full teardown so the next daemon start doesn't inherit ghost state:
  //   - Close signaling WS, kill heartbeat
  //   - Destroy WebTorrent client + clear active torrent/upload tracking
  //   - Wipe in-memory session + flush encryption key
  //   - Write a final "stopped" state file so external readers know
  //   - Clean .srift-temp/ chunk files from interrupted transfers
  try { if (wsConn) { wsConn.close(); wsConn = null; } } catch {}
  try { if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; } } catch {}
  try { if (wtClient) { wtClient.destroy(); wtClient = null; } } catch {}
  try { activeTorrents.clear(); for (const u of [...activeUploads.values()]) stopUpload(u); } catch {}
  try { pubshares.clear(); pubsharesByToken.clear(); } catch {}
  try {
    session = { id: null, name: null, role: null, isConnected: false, userId: null };
    activeTransfers = [];
    chatHistory = [];
    pendingJoins = [];
    participants = [];
    encryptionKey = null;
    wsUrl = null;
    writeStateFile();
  } catch {}
  try {
    if (fs.existsSync(TEMP_DIR)) {
      for (const f of fs.readdirSync(TEMP_DIR)) {
        try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
      }
    }
  } catch {}

  if (!EMBEDDED) setTimeout(() => { process.exit(0); }, 500);
});

/**
 * In-process request into the daemon's Express app (embedded mode). Same
 * routes, validation and responses as HTTP, with no socket involved.
 */
export function embeddedDispatch(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const sock = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    const req = new http.IncomingMessage(sock as any);
    req.method = method;
    req.url = pathname;
    req.headers = { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) };
    const res = new http.ServerResponse(req);
    const chunks: Buffer[] = [];
    const add = (c: any, enc?: any) => { if (c !== undefined && c !== null && typeof c !== 'function') chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), typeof enc === 'string' ? enc as BufferEncoding : 'utf8')); };
    (res as any).write = (c: any, enc?: any, cb?: any) => { add(c, enc); if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb(); return true; };
    (res as any).end = (c?: any, enc?: any, cb?: any) => {
      add(c, enc);
      const text = Buffer.concat(chunks).toString('utf8');
      let data: any = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      resolve({ status: res.statusCode, data });
      res.emit('finish');
      if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
      return res;
    };
    try {
      (app as any).handle(req, res, (err: any) => {
        if (err) reject(err); else resolve({ status: 404, data: { success: false, error: `No route: ${method} ${pathname}` } });
      });
      if (payload) req.push(payload);
      req.push(null);
    } catch (e) { reject(e); }
  });
}

if (EMBEDDED) {
  // The host process is the server: remove pre-encrypted temp copies when it
  // ends, including Ctrl-C / SIGTERM (which skip 'exit' by default).
  process.on('exit', () => {
    for (const e of pubshares.values()) if (e.tempFile) { try { fs.unlinkSync(e.tempFile); } catch {} }
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    try { process.once(sig, () => process.exit(sig === 'SIGINT' ? 130 : 143)); } catch { /* unsupported on this platform */ }
  }
}

/** Resolves once the embedded daemon picked its signaler. */
export const embeddedReady: Promise<void> = EMBEDDED
  ? selectSignalerUrl().then(() => { console.log('[DAEMON] Embedded mode (no local port): serving from the host process'); writeStateFile(); })
  : Promise.resolve();

const httpServer = EMBEDDED ? null : app.listen(PORT, '127.0.0.1', async () => {
  await selectSignalerUrl();
  console.log(`[DAEMON] Background daemon listening on http://127.0.0.1:${PORT}`);
  writeStateFile();
  getDiag().then((d) => console.log(`[DAEMON] Network check: ${d.verdict}`))
    .catch((e) => console.warn('[DAEMON] Network check failed:', e?.message));
});

// A failed bind must say why: EADDRINUSE is a real port conflict; EPERM/EACCES
// means the environment (usually a sandbox) forbids local servers.
httpServer?.on('error', (err: any) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[DAEMON] Port ${PORT} is already in use. Set SRIFT_DAEMON_PORT to another port or stop the other process.`);
    process.exit(98);
  }
  if (err?.code === 'EPERM' || err?.code === 'EACCES') {
    console.error(`[DAEMON] Not allowed to listen on 127.0.0.1:${PORT} (${err.code}) — this looks like a sandbox. \`srift quick-share\` and \`srift mcp\` serve from their own process instead (no port needed).`);
    process.exit(77);
  }
  console.error('[DAEMON] Server error:', err);
  process.exit(1);
});
