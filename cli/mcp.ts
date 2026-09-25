/**
 * SRIFT Model Context Protocol (MCP) Server — local daemon transport.
 *
 * Implements MCP protocol version 2026-07-28 (dual-era: also serves
 * 2025-06-18 and 2024-11-05 clients via the legacy `initialize` handshake —
 * see lib/mcp/core.mjs for the negotiation logic), plus the Skills
 * extension (io.modelcontextprotocol/skills, SEP-2640).
 *
 * Transports supported:
 *   1. stdio (JSON-RPC over stdin/stdout)        — for Claude Desktop, Cursor, Continue, Codex, Zed, etc.
 *   2. HTTP + SSE (handled by daemon.ts at /mcp) — for cloud agents, OpenAI Apps, ChatGPT, web clients
 *
 * The tool/resource/prompt CATALOGUE and the JSON-RPC dispatcher live in
 * ../lib/mcp/core.mjs (single source of truth, shared with the hosted
 * server.mjs transport). This file only implements the LOCAL-DAEMON BACKEND
 * (proxying tool calls to the background daemon over HTTP) and the stdio
 * transport loop.
 *
 * Tools exposed (zero auth, zero tokens, full coverage — all 15):
 *   - Session: srift_start_session, srift_join_session, srift_session_status, srift_close_session
 *   - Host control: srift_approve_join, srift_reject_join, srift_kick_user
 *   - Transfers: srift_send_file, srift_accept_transfer, srift_list_transfers, srift_quick_share
 *   - Chat: srift_send_chat, srift_chat_history
 *   - Workspace: srift_read_state
 *   - Diagnostics: srift_net_diagnose
 *
 * Resources exposed:
 *   - srift://session/status
 *   - srift://transfers/active
 *   - srift://chat/messages
 *   - srift://workspace/state
 *   - srift://docs/quickstart
 *
 * Prompts exposed (canned multi-step workflows):
 *   - send_file_to_user
 *   - receive_file_from_user
 *   - start_collab_session
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { runDiagnostics } from './probe.ts';
import { relaySelfTest } from './selftest.ts';
import { recordHistory } from './history.ts';
import { embeddedCall, startEmbeddedDaemon, isEmbeddedDaemon } from './embedded.ts';
import {
  MCP_TOOLS,
  MCP_RESOURCES,
  MCP_PROMPTS,
  QUICKSTART_DOC,
  createMcpHandler,
} from '../lib/mcp/core.mjs';

const DAEMON_PORT = parseInt(process.env.SRIFT_DAEMON_PORT || '3822', 10);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

const SERVER_INFO = {
  name: 'srift-mcp-server',
  title: 'SRIFT Secure P2P File Transfer',
  version: '4.1.0',
};

// Re-export the shared catalogue so daemon.ts (server-card, etc.) keeps working unchanged.
export { MCP_TOOLS, MCP_RESOURCES, MCP_PROMPTS };

// ─── Daemon HTTP helper ───────────────────────────────────────────────────────
export function callDaemon(endpoint: string, method: 'GET' | 'POST', body?: any): Promise<any> {
  const emb = embeddedCall(method, endpoint, body);
  if (emb) return emb.then((r) => {
    if (r.status >= 200 && r.status < 300) return r.data ?? { success: true };
    throw new Error((r.data && r.data.error) || ('HTTP ' + r.status));
  });
  return new Promise((resolve, reject) => {
    const url = `${DAEMON_URL}${endpoint}`;
    const options: http.RequestOptions = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve({ success: true }); }
        } else {
          try {
            const errJson = JSON.parse(data);
            reject(new Error(errJson.error || `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        }
      });
    });
    req.on('error', (err) => {
      // No reachable daemon (sandbox forbids local servers, daemon died, loopback
      // blocked): host the daemon inside this MCP process and retry once.
      if (process.env.SRIFT_NO_EMBEDDED === '1' || isEmbeddedDaemon()) {
        reject(new Error(`Daemon connection failed: ${err.message}`));
        return;
      }
      startEmbeddedDaemon()
        .then(() => callDaemon(endpoint, method, body))
        .then(resolve, (e) => reject(new Error(`Daemon connection failed (${err.message}); embedded fallback failed: ${e?.message || e}`)));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Local-daemon backend (all 15 tools, full local filesystem + E2EE access) ─
async function callTool(name: string, args: any): Promise<string | { text: string; structured?: Record<string, unknown> }> {
  switch (name) {
    case 'srift_start_session': {
      const res = await callDaemon('/session/start', 'POST', {
        sessionName: args.sessionName,
        roomSecret: args.roomSecret,
      });
      const joinUrl = res.joinUrl || `https://srift.app/join-session?id=${res.sessionId}`;
      return {
        text: `Session created.\nSession ID: ${res.sessionId}\nShare URL: ${joinUrl}\nYou are the HOST. Approve incoming joins with srift_approve_join.`,
        structured: { sessionId: res.sessionId, url: joinUrl, role: 'host' },
      };
    }
    case 'srift_join_session': {
      const res = await callDaemon('/session/join', 'POST', args);
      return {
        text: `Join requested for session ${args.sessionId}. Status: ${res.success ? 'awaiting host approval' : 'failed'}.`,
        structured: { sessionId: args.sessionId, status: res.success ? 'awaiting_approval' : 'failed' },
      };
    }
    case 'srift_session_status': {
      const res = await callDaemon('/status', 'GET');
      return JSON.stringify({ session: res.session, pendingJoins: res.pendingJoins, participants: res.participants || [] }, null, 2);
    }
    case 'srift_close_session':
      await callDaemon('/session/close', 'POST');
      return { text: 'Session closed. Keys flushed.', structured: { success: true } };
    case 'srift_approve_join':
      await callDaemon('/session/approve', 'POST', args);
      return { text: `Approved ${args.tempUserId}.`, structured: { success: true, tempUserId: args.tempUserId } };
    case 'srift_reject_join':
      await callDaemon('/session/reject', 'POST', args);
      return { text: `Rejected ${args.tempUserId}.`, structured: { success: true, tempUserId: args.tempUserId } };
    case 'srift_kick_user':
      await callDaemon('/session/kick', 'POST', args);
      return { text: `Kicked ${args.userId}.`, structured: { success: true, userId: args.userId } };
    case 'srift_send_file': {
      const res = await callDaemon('/send', 'POST', args);
      return {
        text: `File offered.\nFile ID: ${res.fileId}\nThe peer must call srift_accept_transfer with this fileId.`,
        structured: { fileId: res.fileId, fileName: path.basename(String(args.filePath || '')), fileSize: (() => { try { return fs.statSync(args.filePath).size; } catch { return undefined; } })() },
      };
    }
    case 'srift_accept_transfer':
      await callDaemon('/receive', 'POST', args);
      return { text: `Transfer ${args.fileId} accepted. Downloading…`, structured: { success: true, fileId: args.fileId } };
    case 'srift_list_transfers': {
      const res = await callDaemon('/status', 'GET');
      const transfers = res.activeTransfers || [];
      return { text: JSON.stringify(transfers, null, 2), structured: { transfers } };
    }
    case 'srift_quick_share': {
      const multi = Array.isArray(args?.filePaths) && args.filePaths.length > 0;
      if (!multi && !args?.filePath) throw new Error('filePath (one file/folder) or filePaths (several) is required');
      const body: any = {
        sessionName: args.sessionName,
        maxDownloads: args.maxDownloads,
        ttlMs: args.ttlMs,
        encrypt: args.encrypt,
        password: args.password,
        exclude: Array.isArray(args.exclude) ? args.exclude : undefined,
      };
      if (multi) { body.filePaths = args.filePaths; body.bundle = args.bundle !== false; body.bundleName = args.bundleName; }
      else body.filePath = args.filePath;
      const res: any = await callDaemon('/quick-share', 'POST', body);
      if (res && res.success === false && !Array.isArray(res.links)) throw new Error(res.error || 'quick-share failed');
      const links: any[] = res.bundle === false ? (res.links || []) : [res];
      for (const l of links) {
        try { recordHistory({
          at: new Date().toISOString(), mode: 'relay', fileName: l.fileName,
          fileSize: l.fileSize, downloadUrl: l.downloadUrl, token: l.token, encrypted: !!l.encrypted,
          expiresAt: l.expiresAt ?? null, maxDownloads: l.maxDownloads || 0,
        }); } catch { /* best-effort */ }
      }
      const tail = [
        '',
        'The local daemon (or this MCP process) streams the file on demand — nothing is stored on a server. The link stops working if that process stops (machine sleeps/reboots).',
        'If this call fails or a download stalls, call srift_net_diagnose — it names the blocked transport and the fix.',
      ];
      const howTo = (url: string, encrypted: boolean) => {
        const out = [
          `  srift get "${url}"                    (Node-based; works where curl is blocked${encrypted ? '; decrypts' : ''})`,
          `  npx -y srift-transfer get "${url}"    (same, nothing to install)`,
        ];
        if (!encrypted) {
          const bare = String(url).split('#')[0];
          out.push(`  wget --content-disposition "${bare}"`, `  iwr "${bare}" -OutFile <name>           (PowerShell)`, `  curl -fLOJ "${bare}"`);
        }
        return out;
      };
      const pick = (l: any) => ({
        filePath: l.filePath, downloadUrl: l.downloadUrl, fileName: l.fileName, fileSize: l.fileSize,
        encrypted: !!l.encrypted, expiresAt: l.expiresAt ?? null, maxDownloads: l.maxDownloads || 0,
      });

      if (res.bundle === false) {
        const lines = [`${links.length} link(s) ready${res.errors?.length ? `, ${res.errors.length} failed` : ''} (one per file):`];
        for (const l of links) lines.push(`- ${l.fileName} (${l.fileSize} bytes)${l.encrypted ? ' [e2ee — give the WHOLE URL]' : ''}: ${l.downloadUrl}`);
        for (const e of res.errors || []) lines.push(`- FAILED ${e.filePath}: ${e.error}`);
        lines.push('', 'The user can download them all at once with:', `  srift get ${links.map((l) => `"${l.downloadUrl}"`).join(' ')}`);
        return { text: [...lines, ...tail].join('\n'), structured: { bundle: false, links: links.map(pick), errors: res.errors || [] } };
      }

      const url = res.downloadUrl || res.shareUrl;
      const lines = [
        `Link ready.`,
        `Download URL: ${url}`,
        `File:         ${res.fileName} (${res.fileSize} bytes)${res.bundle ? ` — .tar.gz bundle of ${res.files} file(s)` : ''}`,
        ...(res.skipped?.length ? [`Skipped:      ${res.skipped.map((x: any) => `${x.path} (${x.reason})`).join('; ')}`] : []),
        `Encryption:   ${res.encrypted ? 'end-to-end (key is after # in the URL; give the user the WHOLE URL)' : 'TLS in transit only'}${res.passwordProtected ? ' + password (tell the user separately)' : ''}`,
        `Expires:      ${res.expiresAt ? new Date(res.expiresAt).toISOString() : 'when the daemon stops or the link is revoked'}`,
        ``,
        `Give the URL to the user. They can open it in any browser${res.encrypted ? ' (it decrypts locally)' : ''}, or run:`,
        ...howTo(url, !!res.encrypted),
      ];
      return { text: [...lines, ...tail].join('\n'), structured: { ...pick(res), downloadUrl: url, ...(res.bundle ? { bundle: true, files: res.files, skipped: res.skipped || [] } : {}) } };
    }
    case 'srift_net_diagnose': {
      // In-process, so the report reflects THIS MCP host (sandbox, proxy,
      // loopback/spawn limits). deep: real end-to-end relay self-test.
      const deep = !!args?.deep;
      const report = await runDiagnostics({
        fresh: !!args?.fresh || deep,
        clientVersion: SERVER_INFO.version,
        ...(deep ? { selfTest: () => relaySelfTest(callDaemon, { via: 'MCP host', userAgent: 'srift-mcp' }) } : {}),
      });
      return JSON.stringify(report, null, 2);
    }
    case 'srift_send_chat':
      await callDaemon('/chat/send', 'POST', args);
      return { text: `Sent (E2EE): "${args.message}"`, structured: { success: true, timestamp: new Date().toISOString() } };
    case 'srift_chat_history': {
      const res = await callDaemon('/chat/history', 'GET');
      const messages = Array.isArray(res) ? res : (res?.messages || []);
      return { text: JSON.stringify(res, null, 2), structured: { messages } };
    }
    case 'srift_read_state': {
      const res = await callDaemon('/state', 'GET');
      return JSON.stringify(res, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function readResource(uri: string): Promise<string> {
  if (uri === 'srift://session/status') {
    const res = await callDaemon('/status', 'GET');
    return JSON.stringify(res.session, null, 2);
  }
  if (uri === 'srift://transfers/active') {
    const res = await callDaemon('/status', 'GET');
    return JSON.stringify(res.activeTransfers || [], null, 2);
  }
  if (uri === 'srift://chat/messages') {
    const res = await callDaemon('/chat/history', 'GET');
    return JSON.stringify(res, null, 2);
  }
  if (uri === 'srift://workspace/state') {
    const res = await callDaemon('/state', 'GET');
    return JSON.stringify(res, null, 2);
  }
  if (uri === 'srift://docs/quickstart') {
    return QUICKSTART_DOC;
  }
  throw new Error(`Resource not found: ${uri}`);
}

const localDaemonBackend = { callTool, readResource };

// Full, unrestricted dispatcher — all 15 tools / 5 resources / 3 prompts.
// Used by both the stdio transport below AND daemon.ts's HTTP transport.
export const handleMcpMessage = createMcpHandler({
  backend: localDaemonBackend,
  serverInfo: SERVER_INFO,
  instructions: 'SRIFT is a zero-config local P2P file transfer + E2EE chat tool. Use srift_quick_share to deliver files to the user in one step. Use srift_start_session to open a long-lived room. Read srift://docs/quickstart for the full guide.',
});

// ─── Stdio transport ──────────────────────────────────────────────────────────
export function startMcpServer() {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let boundary = buffer.indexOf('\n');
    while (boundary !== -1) {
      const line = buffer.substring(0, boundary).trim();
      buffer = buffer.substring(boundary + 1);
      boundary = buffer.indexOf('\n');
      if (line) {
        try {
          const message = JSON.parse(line);
          handleMcpMessage(message).then((response) => {
            if (response) process.stdout.write(JSON.stringify(response) + '\n');
          });
        } catch (err) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: null,
            error: { code: -32700, message: 'Parse error: ' + (err as Error).message },
          }) + '\n');
        }
      }
    }
  });
  process.on('SIGINT', () => process.exit(0));
}
