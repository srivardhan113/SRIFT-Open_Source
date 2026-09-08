import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import { WebSocket } from 'ws';
import { webcrypto } from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { handleMcpMessage, MCP_TOOLS, MCP_RESOURCES, MCP_PROMPTS } from './mcp.ts';

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

// Redirect console logs to .srift-daemon.log in the daemon itself to protect from parent process exit crashes
const logPath = path.join(process.cwd(), '.srift-daemon.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
const logMessage = (level: string, message: string) => {
  logStream.write(`[${new Date().toISOString()}] [${level}] ${message}\n`);
};
console.log = (...args: any[]) => {
  logMessage('INFO', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' '));
};
console.error = (...args: any[]) => {
  logMessage('ERROR', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' '));
};
console.warn = (...args: any[]) => {
  logMessage('WARN', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' '));
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
      const id = setTimeout(() => controller.abort(), 1000);
      await fetch(DEFAULT_SIGNALER_URL, { signal: controller.signal });
      clearTimeout(id);
      console.log(`[DAEMON] Local signaler detected at ${DEFAULT_SIGNALER_URL}`);
    } catch (e) {
      console.log(`[DAEMON] Local signaler at ${DEFAULT_SIGNALER_URL} is unreachable. Falling back to production signaler: https://srift.app`);
      activeSignalerUrl = 'https://srift.app';
    }
  }
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
  filePath?: string;
  saveDir?: string;
  peerId?: string;
  bytesTransferred: number;
  chunksCount: number;
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

let sseClients: any[] = [];
let wsConn: WebSocket | null = null;
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
  createdAt: number;
};
const pubshares: Map<string, PubshareEntry> = new Map(); // by fileId
const pubsharesByToken: Map<string, PubshareEntry> = new Map();
const activePulls: Map<string, { cancelled: boolean }> = new Map();
// Resolvers waiting for pubshare_register_ack, keyed by fileId
const pubshareRegResolvers: Map<string, (entry: PubshareEntry) => void> = new Map();

async function getWtClient() {
  if (!wtClient) {
    const WTCtor = await loadWebTorrent();
    wtClient = new WTCtor();
  }
  return wtClient;
}
function getWtClientOrNull() {
  // Synchronous accessor — returns existing instance, never creates.
  return wtClient;
}

// Temporary folder for chunks
const TEMP_DIR = path.join(process.cwd(), '.srift-temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

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

// ─── Tracker list for WebTorrent ───
function getTrackers(sessionId: string): string[] {
  const list: string[] = [];
  try {
    const signalerUrl = wsUrl || activeSignalerUrl;
    const trackerUrl = signalerUrl.replace(/^http/, 'ws').replace(/\/ws$/, '/announce');
    if (trackerUrl) list.push(trackerUrl);
  } catch {}
  list.push('wss://tracker.webtorrent.dev');
  return list;
}

// ─── Workspace State File ───
function writeStateFile() {
  const statePath = path.join(process.cwd(), '.srift-state.json');
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
    })),
    lastUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(stateData, null, 2), 'utf-8');
}

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

  console.log(`[DAEMON] Connecting to Signaler WS: ${wsTargetUrl}`);
  wsConn = new WebSocket(wsTargetUrl);

  wsConn.on('open', () => {
    console.log('[DAEMON] WebSocket connection open');
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
          payload: { userId: session.userId, sessionId: session.id }
        }));
      } else if (session.role === 'guest') {
        if (session.userId) {
          wsConn?.send(JSON.stringify({
            type: 'init_joiner',
            payload: { userId: session.userId, sessionId: session.id }
          }));
        } else {
          const username = process.env.SRIFT_USERNAME || 'CLI-Agent';
          wsConn?.send(JSON.stringify({
            type: 'request_join',
            payload: { sessionId: session.id, tempUserId: session.tempUserId, username }
          }));
        }
      }
    }, 100);

    // Start Heartbeat
    lastHeartbeatAckAt = Date.now();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (wsConn?.readyState === WebSocket.OPEN) {
        wsConn.send(JSON.stringify({ type: 'heartbeat', payload: { ts: Date.now() } }));
      }
    }, 30000);
  });

  wsConn.on('message', async (dataStr: string) => {
    try {
      const msg = JSON.parse(dataStr);
      const { type, payload } = msg;

      switch (type) {
        case 'init_host_ack':
          if (payload.status === 'ok') {
            csrfToken = payload.csrfToken;
            console.log('[DAEMON] Host authentication OK, CSRF Token obtained');
            // After (re)auth, replay any public-share registrations so the
            // existing download URLs keep working across transient WS drops.
            reregisterPubsharesAfterReconnect().catch((e) =>
              console.warn('[DAEMON] pubshare replay failed:', e?.message));
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
            payload: { userId: session.userId, sessionId: session.id }
          }));
          writeStateFile();
          break;

        case 'init_joiner_ack':
          if (payload.status === 'ok') {
            csrfToken = payload.csrfToken;
            console.log('[DAEMON] Approved joiner authentication OK');
          }
          break;

        case 'heartbeat_ack':
          lastHeartbeatAckAt = Date.now();
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
            writeStateFile();
            broadcastSSE('session_terminated', { reason: terminationReason });
          }
          break;

        case 'join_request':
          console.log(`[DAEMON] Peer join request: tempUserId=${payload.tempUserId}, username=${payload.username}`);
          pendingJoins.push({ tempUserId: payload.tempUserId, username: payload.username });
          broadcastSSE('join_request', payload);
          break;

        case 'chat':
          try {
            const decContent = await decrypt(payload.content);
            const chatMsg = {
              messageId: payload.messageId || uuidv4(),
              sender: payload.username || 'Peer',
              content: decContent,
              timestamp: payload.timestamp || new Date().toISOString(),
            };
            chatHistory.push(chatMsg);
            broadcastSSE('chat_received', chatMsg);
            console.log(`[DAEMON] Chat from ${chatMsg.sender}: ${chatMsg.content}`);
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
          startUpload(payload.fileId, payload.userId);
          break;

        case 'webtorrent_info_hash':
          handleWebTorrentInfoHash(payload);
          break;

        case 'file_chunk':
          handleIncomingChunk(payload);
          break;

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

  wsConn.on('close', () => {
    console.log('[DAEMON] WebSocket connection closed');
    session.isConnected = false;
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

  wsConn.on('error', (err) => {
    console.error('[DAEMON] WebSocket error:', err);
  });
}

// ─── File Upload Dispatcher ───
function startUpload(fileId: string, targetUserId: string) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;

  if (tx.protocol === 'webtorrent') {
    startWebTorrentUpload(fileId, targetUserId);
  } else {
    startWebSocketUpload(fileId, targetUserId);
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

  client.seed(tx.filePath, { announce: trackers }, (torrent: any) => {
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
let activeUploads: Map<string, {
  filePath: string;
  totalChunks: number;
  chunkSize: number;
  targetUserId: string;
  currentChunk: number;
  bytesSent: number;
  startTime: number;
}> = new Map();

async function startWebSocketUpload(fileId: string, targetUserId: string) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx || !tx.filePath) return;

  const chunkSize = 64 * 1024; // 64KB
  const stat = fs.statSync(tx.filePath);
  const totalChunks = Math.max(1, Math.ceil(stat.size / chunkSize));

  tx.status = 'uploading';
  tx.startTime = Date.now();
  tx.totalChunks = totalChunks;
  writeStateFile();

  activeUploads.set(fileId, {
    filePath: tx.filePath,
    totalChunks,
    chunkSize,
    targetUserId,
    currentChunk: 0,
    bytesSent: 0,
    startTime: Date.now(),
  });

  // Stream first chunk
  sendNextChunk(fileId);
}

function sendNextChunk(fileId: string) {
  const upload = activeUploads.get(fileId);
  if (!upload) return;

  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;

  if (upload.currentChunk >= upload.totalChunks) {
    // Done
    wsConn?.send(JSON.stringify({
      type: 'file_complete',
      payload: { fileId, targetUserId: upload.targetUserId }
    }));
    tx.status = 'completed';
    tx.progress = 100;
    tx.speedKBps = 0;
    tx.etaSeconds = 0;
    writeStateFile();
    activeUploads.delete(fileId);
    console.log(`[DAEMON] File upload complete: ${tx.name}`);
    return;
  }

  const start = upload.currentChunk * upload.chunkSize;
  const stat = fs.statSync(upload.filePath);
  const end = Math.min(start + upload.chunkSize, stat.size);
  const buffer = Buffer.alloc(end - start);

  const fd = fs.openSync(upload.filePath, 'r');
  fs.readSync(fd, buffer, 0, end - start, start);
  fs.closeSync(fd);

  const chunkBase64 = buffer.toString('base64');

  wsConn?.send(JSON.stringify({
    type: 'file_chunk',
    payload: {
      fileId,
      chunk: chunkBase64,
      chunkIndex: upload.currentChunk,
      totalChunks: upload.totalChunks,
      targetUserId: upload.targetUserId,
    }
  }));

  tx.bytesTransferred = end;
  tx.progress = (end / stat.size) * 100;

  // Calculate speed
  const elapsed = (Date.now() - upload.startTime) / 1000;
  if (elapsed > 0) {
    tx.speedKBps = (end / 1024) / elapsed;
    tx.etaSeconds = (stat.size - end) / (tx.speedKBps * 1024);
  }

  writeStateFile();
  broadcastSSE('transfer_progress', {
    fileId,
    fileName: tx.name,
    size: tx.size,
    bytesTransferred: end,
    progress: tx.progress,
    speedBytesPerSecond: tx.speedKBps * 1024,
    timeRemainingSeconds: tx.etaSeconds,
    status: 'uploading',
  });
}

function handleChunkAck(payload: any) {
  const { fileId, chunkIndex } = payload;
  const upload = activeUploads.get(fileId);
  if (!upload) return;

  if (upload.currentChunk === chunkIndex) {
    upload.currentChunk++;
    sendNextChunk(fileId);
  }
}

function handleIncomingChunk(payload: any) {
  const { fileId, chunk, chunkIndex, totalChunks, from } = payload;
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;

  tx.status = 'downloading';
  tx.totalChunks = totalChunks;
  tx.peerId = from;

  const chunkBuffer = Buffer.from(chunk, 'base64');
  tx.bytesTransferred += chunkBuffer.length;
  tx.chunksCount++;

  // Save chunk to temp folder
  const chunkPath = path.join(TEMP_DIR, `${fileId}_chunk_${chunkIndex}`);
  fs.writeFileSync(chunkPath, chunkBuffer);

  tx.progress = (tx.bytesTransferred / tx.size) * 100;
  const elapsed = (Date.now() - tx.startTime) / 1000;
  if (elapsed > 0) {
    tx.speedKBps = (tx.bytesTransferred / 1024) / elapsed;
    tx.etaSeconds = (tx.size - tx.bytesTransferred) / (tx.speedKBps * 1024);
  }

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

  // Ack
  wsConn?.send(JSON.stringify({
    type: 'file_chunk_ack',
    payload: { fileId, chunkIndex, status: 'received' }
  }));
}

function handleFileComplete(payload: any) {
  const { fileId } = payload;
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;

  // Assemble file
  const destDir = tx.saveDir || process.cwd();
  const destPath = path.join(destDir, tx.name);

  // Ensure destination directory exists
  try {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
  } catch (err: any) {
    console.error(`[DAEMON] Failed to create destination directory ${destDir}:`, err);
    tx.status = 'error';
    writeStateFile();
    return;
  }

  const writeStream = fs.createWriteStream(destPath);

  writeStream.on('error', (err) => {
    console.error(`[DAEMON] Write stream error for ${destPath}:`, err);
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
  });

  writeStream.on('finish', () => {
    console.log(`[DAEMON] File successfully downloaded and assembled: ${destPath}`);
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
  });

  for (let i = 0; i < tx.totalChunks; i++) {
    const chunkPath = path.join(TEMP_DIR, `${fileId}_chunk_${i}`);
    if (fs.existsSync(chunkPath)) {
      try {
        const chunkBuf = fs.readFileSync(chunkPath);
        writeStream.write(chunkBuf);
        fs.unlinkSync(chunkPath); // delete chunk
      } catch (err: any) {
        console.error(`[DAEMON] Error reading/writing chunk ${i}:`, err);
        writeStream.emit('error', err);
        return;
      }
    }
  }
  writeStream.end();
}

// ─── Express App Setup ───
const app = express();
app.use(cors());
app.use(express.json());

const DAEMON_START_TIME = Date.now();
const PACKAGE_VERSION = '2.1.8';

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

    // Call Signaler API
    const response = await fetch(`${activeSignalerUrl}/create-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uName, name: sName }),
    });

    if (!response.ok) {
      throw new Error(`Signaler returned status ${response.status}`);
    }

    const data = (await response.json()) as any;
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
    res.json({ success: true, sessionId: data.sessionId });
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

    const response = await fetch(`${activeSignalerUrl}/join-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, username: uName }),
    });

    if (!response.ok) {
      let errBody: any = {};
      try { errBody = await response.json(); } catch {}
      const errMsg = errBody.error || `Signaler returned status ${response.status}`;
      // Map signaler HTTP status to sensible daemon status
      const statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
      return res.status(statusCode).json({ success: false, error: errMsg });
    }

    const data = (await response.json()) as any;
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

app.post('/session/approve', (req: Request, res: Response) => {
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
  res.json({ success: true });
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
    const targetProtocol = ((protocol === 'webtorrent' || (stat.size > 10 * 1024 * 1024 && protocol !== 'websocket'))
      ? 'webtorrent'
      : 'websocket') as 'websocket' | 'webtorrent';

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

app.post('/receive', (req: Request, res: Response) => {
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
  wsConn?.send(JSON.stringify({
    type: 'file_accept',
    payload: { fileId }
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
    if (!encryptionKey) {
      return res.status(409).json({ success: false, error: 'Encryption key not ready. Session still initialising.' });
    }

    // Check WS state: 0=CONNECTING, 1=OPEN
    if (!wsConn || wsConn.readyState !== 1 /* OPEN */) {
      // Still connecting — queue is not supported, return 503 so caller can retry
      return res.status(503).json({
        success: false,
        error: 'Signaling connection not ready (WebSocket is connecting). Retry in 1–2 seconds.',
        retryAfterMs: 1500,
      });
    }

    const encContent = await encrypt(message);
    wsConn.send(JSON.stringify({
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
  const statePath = path.join(process.cwd(), '.srift-state.json');
  try {
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, 'utf-8');
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
      continue;
    }
    // Drop already-exhausted entries — re-registering them with maxDownloads=0
    // or with the original cap would either reset the counter or allow another
    // download. Either way it'd violate the user's --max-downloads contract.
    if (entry.maxDownloads && entry.downloadCount >= entry.maxDownloads) {
      pubshares.delete(entry.fileId);
      pubsharesByToken.delete(entry.token);
      continue;
    }
    try {
      const remainingTtl = entry.expiresAt ? Math.max(0, entry.expiresAt - Date.now()) : 0;
      const remainingMax = entry.maxDownloads
        ? Math.max(1, entry.maxDownloads - entry.downloadCount)
        : 0;
      await registerPubshare(
        entry.fileId, entry.filePath, entry.filename, entry.size, entry.mime,
        { maxDownloads: remainingMax, ttlMs: remainingTtl, preferToken: entry.token },
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
  const cancelFlag = { cancelled: false };
  activePulls.set(requestId, cancelFlag);

  const CHUNK = 64 * 1024;
  let pos = start;
  let seq = 0;
  let completedOk = false;
  const fd = fs.openSync(entry.filePath, 'r');
  try {
    while (pos <= end) {
      if (cancelFlag.cancelled) break;
      if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
        throw new Error('Signaling WebSocket disconnected mid-stream');
      }
      const len = Math.min(CHUNK, end - pos + 1);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, pos);
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

  // Only count "full" downloads (no Range) toward maxDownloads — partial
  // requests like resumes shouldn't burn a slot. Server already filters
  // these by setting isFullDownload=true only on plain GETs.
  if (completedOk && isFullDownload) {
    entry.downloadCount++;
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

// ─── /quick-share — one-shot: ensure session + seed file + return share URL ───
app.post('/quick-share', async (req: Request, res: Response) => {
  try {
    const { filePath, sessionName, maxDownloads, ttlMs } = req.body;
    if (!filePath) return res.status(400).json({ success: false, error: 'filePath required' });

    // 1) Create session if none active
    if (!session.id) {
      const sName = sessionName || 'AI-QuickShare';
      const createRes = await fetch(`${activeSignalerUrl}/create-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'AI-Agent', name: sName }),
      });
      if (!createRes.ok) throw new Error(`Signaler returned ${createRes.status}`);
      const data = (await createRes.json()) as any;
      session = {
        id: data.sessionId, name: data.name, role: 'host',
        isConnected: false, userId: data.userId, wsToken: data.wsToken, roomSecret: null,
      };
      encryptionKey = await deriveKey(data.sessionId);
      wsUrl = data.wsUrl || `${activeSignalerUrl.replace(/^http/, 'ws')}/ws`;
      if (wsUrl) connectWebSocket(wsUrl);
      writeStateFile();
      // Brief delay so signaling can finish connecting before we register the file offer
      await new Promise((r) => setTimeout(r, 800));
    }

    // 2) Seed the file
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) return res.status(404).json({ success: false, error: `File not found: ${absPath}` });
    const stat = fs.statSync(absPath);
    const filename = path.basename(absPath);
    const fileId = `cli_file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const targetProtocol: 'webtorrent' | 'websocket' = stat.size > 10 * 1024 * 1024 ? 'webtorrent' : 'websocket';

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

    // Also publish a direct HTTPS download link via the signaler tunnel.
    // This is what the recipient actually clicks/curls — no install, no
    // join-session approval flow needed on the receiving side.
    let downloadUrl: string | null = null;
    let expiresAt: number | null = null;
    let cappedMaxDownloads: number = 0;
    try {
      const entry = await registerPubshare(
        fileId, absPath, filename, stat.size, 'application/octet-stream',
        {
          maxDownloads: typeof maxDownloads === 'number' ? maxDownloads : 0,
          ttlMs: typeof ttlMs === 'number' ? ttlMs : 0,
        },
      );
      downloadUrl = entry.downloadUrl;
      expiresAt = entry.expiresAt;
      cappedMaxDownloads = entry.maxDownloads;
    } catch (e: any) {
      console.warn('[DAEMON] pubshare registration failed (link unavailable):', e?.message);
    }

    const publicBase = process.env.SRIFT_PUBLIC_BASE || 'https://srift.app';
    res.json({
      success: true,
      sessionId: session.id,
      fileId,
      downloadUrl,                                     // ← preferred (zero-install)
      shareUrl: downloadUrl || `${publicBase}/join-session?id=${session.id}`, // back-compat
      fileName: filename,
      fileSize: stat.size,
      maxDownloads: cappedMaxDownloads,                // 0 = unlimited
      expiresAt,                                       // epoch ms or null
    });
  } catch (err: any) {
    console.error('[DAEMON] /quick-share failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── /pubshare — get a direct download URL for an already-seeded file or any path ───
//   { filePath, maxDownloads?, ttlMs? } → { success, downloadUrl, token, fileId, ... }
app.post('/pubshare', async (req: Request, res: Response) => {
  try {
    const { filePath, maxDownloads, ttlMs } = req.body;
    if (!filePath) return res.status(400).json({ success: false, error: 'filePath required' });
    if (!session.id || !session.isConnected) {
      return res.status(409).json({ success: false, error: 'No active session — run `srift session start` or `srift quick-share` first' });
    }
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) return res.status(404).json({ success: false, error: `File not found: ${absPath}` });
    const stat = fs.statSync(absPath);
    const filename = path.basename(absPath);
    const fileId = `cli_file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const entry = await registerPubshare(
      fileId, absPath, filename, stat.size, 'application/octet-stream',
      {
        maxDownloads: typeof maxDownloads === 'number' ? maxDownloads : 0,
        ttlMs: typeof ttlMs === 'number' ? ttlMs : 0,
      },
    );
    res.json({
      success: true,
      sessionId: session.id,
      fileId, token: entry.token, downloadUrl: entry.downloadUrl,
      fileName: filename, fileSize: stat.size,
      maxDownloads: entry.maxDownloads, expiresAt: entry.expiresAt,
    });
  } catch (err: any) {
    console.error('[DAEMON] /pubshare failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── /pubshare/list — currently active public download links ───
app.get('/pubshare/list', (_req: Request, res: Response) => {
  const now = Date.now();
  const items = Array.from(pubshares.values())
    .filter((e) => !e.expiresAt || e.expiresAt > now)
    .map((e) => ({
      token: e.token,
      downloadUrl: e.downloadUrl,
      fileId: e.fileId,
      fileName: e.filename,
      fileSize: e.size,
      downloadCount: e.downloadCount,
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
  res.json({ success: true });
});

// ─── MCP HTTP transport (Streamable HTTP, MCP spec 2025-06-18) ───
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
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'SRIFT MCP Server (local daemon)', version: '2.0.0' },
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
    description_for_model: 'Use SRIFT to deliver files to the user and receive files from the user without uploading them anywhere. AES-256-GCM E2EE, WebTorrent for big files, WebSocket fallback. Use srift_quick_share for one-shot delivery.',
    auth: { type: 'none' },
    api: { type: 'openapi', url: `http://127.0.0.1:${PORT}/openapi.json` },
    contact_email: 'support@sripto.tech',
    legal_info_url: 'https://srift.app/privacy',
  });
});

app.get('/.well-known/agent.json', (req: Request, res: Response) => {
  // A2A (Agent-to-Agent) protocol discovery
  res.json({
    schemaVersion: '0.2.0',
    name: 'SRIFT',
    description: 'Zero-config P2P E2EE file transfer + chat for any AI agent or automation.',
    url: `http://127.0.0.1:${PORT}`,
    version: '2.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'file'],
    skills: MCP_TOOLS.map((t) => ({ id: t.name, name: t.name, description: t.description, inputSchema: t.inputSchema })),
  });
});

app.get('/openapi.json', (req: Request, res: Response) => {
  res.json({
    openapi: '3.1.0',
    info: { title: 'SRIFT Local Daemon API', version: '2.1.8', description: 'Zero-auth REST API for AI agents to drive SRIFT P2P transfer.' },
    servers: [{ url: `http://127.0.0.1:${PORT}` }],
    paths: {
      '/health': { get: { summary: 'Liveness probe', description: 'Returns {ok,version,uptime_ms,mcp,webrtc,webtorrent}', responses: { '200': { description: 'OK' } } } },
      '/status': { get: { summary: 'Get session + transfers + pending joins', responses: { '200': { description: 'OK' } } } },
      '/state': { get: { summary: 'Workspace state snapshot (.srift-state.json)', responses: { '200': { description: 'OK' } } } },
      '/transfers': { get: { summary: 'Live transfer list with speed and ETA. Optional ?fileId= to filter.', responses: { '200': { description: 'OK' } } } },
      '/transfers/{fileId}': { get: { summary: 'Per-transfer drill-down', parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Transfer not found' } } } },
      '/peers': { get: { summary: 'Peer connection state, RTT, ICE type', responses: { '200': { description: 'OK' } } } },
      '/metrics': { get: { summary: 'Prometheus-format counters (no auth)', responses: { '200': { description: 'text/plain Prometheus format' } } } },
      '/logs': { get: { summary: 'NDJSON daemon log tail. ?lines=N (default 100)', responses: { '200': { description: 'application/x-ndjson' } } } },
      '/reset': { post: { summary: 'Wipe all state and flush encryption keys', responses: { '200': { description: '{ok:true}' } } } },
      '/session/start': { post: { summary: 'Create new session (becomes host)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { sessionName: { type: 'string' }, roomSecret: { type: 'string' } } } } } }, responses: { '200': { description: '{success:true,sessionId}' } } } },
      '/session/join': { post: { summary: 'Join existing session', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' }, username: { type: 'string' }, roomSecret: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'Missing sessionId' }, '404': { description: 'Session not found' } } } },
      '/session/approve': { post: { summary: 'Host approves a pending join request', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['tempUserId'], properties: { tempUserId: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'tempUserId required' }, '403': { description: 'Not host' }, '404': { description: 'No such pending request' } } } },
      '/session/reject': { post: { summary: 'Host rejects a pending join request', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['tempUserId'], properties: { tempUserId: { type: 'string' }, reason: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'tempUserId required' }, '403': { description: 'Not host' } } } },
      '/session/kick': { post: { summary: 'Host kicks a peer', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'userId required' }, '403': { description: 'Not host' } } } },
      '/session/close': { post: { summary: 'Tear down the session and flush keys', responses: { '200': { description: 'OK' } } } },
      '/send': { post: { summary: 'Offer a file to peers (requires active session)', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['filePath'], properties: { filePath: { type: 'string' } } } } } }, responses: { '200': { description: '{success:true,fileId}' } } } },
      '/receive': { post: { summary: 'Accept an incoming file offer', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['fileId'], properties: { fileId: { type: 'string' }, saveDir: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '404': { description: 'No offer for this fileId' } } } },
      '/quick-share': { post: { summary: 'ONE-SHOT: create session if needed, register the file for public HTTPS download, and return a direct downloadUrl (https://srift.app/d/<token>) the recipient can curl/wget/browse with zero install.', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['filePath'], properties: { filePath: { type: 'string', description: 'Absolute path to file' }, sessionName: { type: 'string' } } } } } }, responses: { '200': { description: '{success,sessionId,fileId,downloadUrl,shareUrl,fileName,fileSize}' } } } },
      '/chat/send': { post: { summary: 'Send E2EE chat message', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' }, '400': { description: 'message required' }, '409': { description: 'No session' }, '503': { description: 'WS not ready — retry in 1–2s' } } } },
      '/chat/history': { get: { summary: 'Decrypted chat log', responses: { '200': { description: 'Array of {messageId,sender,content,timestamp}' } } } },
      '/api/v1/monitor/events': { get: { summary: 'SSE event stream: connection_state, join_request, file_offer, transfer_progress, chat_received', responses: { '200': { description: 'text/event-stream' } } } },
      '/mcp': { post: { summary: 'MCP JSON-RPC (Streamable HTTP, spec 2025-06-18)', responses: { '200': { description: 'JSON-RPC response' } } }, get: { summary: 'SSE stream for server→client MCP notifications', responses: { '200': { description: 'text/event-stream' } } } },
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
  activeUploads.clear();

  // 2. In-memory session + crypto
  session = { id: null, name: null, role: null, isConnected: false, userId: null };
  activeTransfers = [];
  chatHistory = [];
  pendingJoins = [];
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
  try { activeTorrents.clear(); activeUploads.clear(); } catch {}
  try {
    session = { id: null, name: null, role: null, isConnected: false, userId: null };
    activeTransfers = [];
    chatHistory = [];
    pendingJoins = [];
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

  setTimeout(() => {
    process.exit(0);
  }, 500);
});

app.listen(PORT, '127.0.0.1', async () => {
  await selectSignalerUrl();
  console.log(`[DAEMON] Background daemon listening on http://127.0.0.1:${PORT}`);
  writeStateFile();
});
