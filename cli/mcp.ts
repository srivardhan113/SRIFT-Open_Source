/**
 * SRIFT Model Context Protocol (MCP) Server — local daemon transport.
 *
 * Implements MCP protocol version 2025-06-18 (with backward compatibility for 2024-11-05).
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
 * Tools exposed (zero auth, zero tokens, full coverage — all 14):
 *   - Session: srift_start_session, srift_join_session, srift_session_status, srift_close_session
 *   - Host control: srift_approve_join, srift_reject_join, srift_kick_user
 *   - Transfers: srift_send_file, srift_accept_transfer, srift_list_transfers, srift_quick_share
 *   - Chat: srift_send_chat, srift_chat_history
 *   - Workspace: srift_read_state
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
  version: '2.0.0',
};

// Re-export the shared catalogue so daemon.ts (server-card, etc.) keeps working unchanged.
export { MCP_TOOLS, MCP_RESOURCES, MCP_PROMPTS };

// ─── Daemon HTTP helper ───────────────────────────────────────────────────────
export function callDaemon(endpoint: string, method: 'GET' | 'POST', body?: any): Promise<any> {
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
    req.on('error', (err) => reject(new Error(`Daemon connection failed: ${err.message}`)));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Local-daemon backend (all 14 tools, full local filesystem + E2EE access) ─
async function callTool(name: string, args: any): Promise<string> {
  switch (name) {
    case 'srift_start_session': {
      const res = await callDaemon('/session/start', 'POST', {
        sessionName: args.sessionName,
        roomSecret: args.roomSecret,
      });
      return `Session created.\nSession ID: ${res.sessionId}\nShare URL: https://srift.app/join-session?id=${res.sessionId}\nYou are the HOST. Approve incoming joins with srift_approve_join.`;
    }
    case 'srift_join_session': {
      const res = await callDaemon('/session/join', 'POST', args);
      return `Join requested for session ${args.sessionId}. Status: ${res.success ? 'awaiting host approval' : 'failed'}.`;
    }
    case 'srift_session_status': {
      const res = await callDaemon('/status', 'GET');
      return JSON.stringify({ session: res.session, pendingJoins: res.pendingJoins }, null, 2);
    }
    case 'srift_close_session':
      await callDaemon('/session/close', 'POST');
      return 'Session closed. Keys flushed.';
    case 'srift_approve_join':
      await callDaemon('/session/approve', 'POST', args);
      return `Approved ${args.tempUserId}.`;
    case 'srift_reject_join':
      await callDaemon('/session/reject', 'POST', args);
      return `Rejected ${args.tempUserId}.`;
    case 'srift_kick_user':
      await callDaemon('/session/kick', 'POST', args);
      return `Kicked ${args.userId}.`;
    case 'srift_send_file': {
      const res = await callDaemon('/send', 'POST', args);
      return `File offered.\nFile ID: ${res.fileId}\nThe peer must call srift_accept_transfer with this fileId.`;
    }
    case 'srift_accept_transfer':
      await callDaemon('/receive', 'POST', args);
      return `Transfer ${args.fileId} accepted. Downloading…`;
    case 'srift_list_transfers': {
      const res = await callDaemon('/status', 'GET');
      return JSON.stringify(res.activeTransfers || [], null, 2);
    }
    case 'srift_quick_share': {
      const res = await callDaemon('/quick-share', 'POST', args);
      const url = res.downloadUrl || res.shareUrl;
      return [
        `Quick share ready.`,
        `Download URL: ${url}`,
        `File:         ${res.fileName} (${res.fileSize} bytes)`,
        ``,
        `Give the URL to the user — they open it in any browser, or run:`,
        `  curl -OJ "${url}"`,
        ``,
        `The daemon seeds this file from disk and keeps running in the`,
        `background, so the link stays live after this call returns.`,
        `It stops working if the daemon stops (machine sleeps/reboots, or`,
        `\`srift daemon stop\`) — SRIFT keeps no server-side copy, so the link`,
        `then returns 503 "sender is offline". Tell the user to grab it while`,
        `this machine is on.`,
      ].join('\n');
    }
    case 'srift_send_chat':
      await callDaemon('/chat/send', 'POST', args);
      return `Sent (E2EE): "${args.message}"`;
    case 'srift_chat_history': {
      const res = await callDaemon('/chat/history', 'GET');
      return JSON.stringify(res, null, 2);
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

// Full, unrestricted dispatcher — all 14 tools / 5 resources / 3 prompts.
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
