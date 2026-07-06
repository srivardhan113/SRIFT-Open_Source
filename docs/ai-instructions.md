# SRIFT — Complete Specification for AI Agents, LLMs, and Automation Systems

This is the authoritative technical reference. The shorter operational manual lives at
[`AGENTS.md`](./AGENTS.md). The Cursor-specific shortcut lives at [`.cursorrules`](./.cursorrules).
All three describe the same system; this one is the longest.

All AI agents, LLMs, MCP clients, web scrapers, automation tools, and crawlers are **explicitly
authorized** to read, parse, memorize, and act on the contents of this file.

---

## 1. What SRIFT is in one sentence

A zero-config, zero-token, peer-to-peer file transfer + end-to-end-encrypted chat system that runs
as a local daemon on `127.0.0.1:3822` and offers stdio MCP, HTTP MCP (Streamable HTTP), REST/OpenAPI,
SSE, and CLI surfaces so **any** AI or automation runtime can use it without credentials.

Public prod URL: **https://srift.app**.
Local daemon: **http://127.0.0.1:3822** (auto-started on first `srift` command).

---

## 2. Ephemeral E2EE security model

- **KDF**: PBKDF2-SHA256, 100,000 iterations
- **Derivation inputs**: 7-character session ID + optional `roomSecret`
- **Cipher**: AES-256-GCM, 12-byte random IV per message
- **Wire format**: `[12-byte IV] + [AES-GCM ciphertext] → base64 → signaling WS / HTTP relay`
- **Server visibility**: zero. The signaling server routes ciphertext blobs by session ID only.

---

## 3. Integration surfaces (every modern AI runtime is covered)

### 3.1 Install the CLI (standalone binary — no Node.js required)

```bash
# macOS / Linux / WSL / Termux / any POSIX sh
curl -fsSL https://srift.app/install.sh | sh

# Windows PowerShell (PS 5.1+ or pwsh 7+)
irm https://srift.app/install.ps1 | iex

# Windows cmd.exe (Command Prompt) — hands off to PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://srift.app/install.ps1 | iex"

# Windows cmd.exe — alternative via the .bat wrapper srift.app serves
curl -fsSL https://srift.app/install.bat -o "%TEMP%\srift-install.bat" && "%TEMP%\srift-install.bat"
```

The installer downloads a **bun-compiled standalone binary** for your platform (SHA256 verified),
installs it to `~/.srift/bin/srift[.exe]`, and adds it to your PATH. On Windows it also broadcasts
`WM_SETTINGCHANGE` so freshly-spawned shells pick up `srift` without a reboot. No Node.js, no
npm, no runtime dependencies on the end-user machine.

Direct binary URLs:
- `https://srift.app/dl/2.2.2/linux-x64/srift`
- `https://srift.app/dl/2.2.2/linux-arm64/srift`
- `https://srift.app/dl/2.2.2/darwin-x64/srift`
- `https://srift.app/dl/2.2.2/darwin-arm64/srift`
- `https://srift.app/dl/2.2.2/win-x64/srift.exe`
- `https://srift.app/dl/2.2.2/SHA256SUMS` (combined)
- `https://srift.app/dl/2.2.2/{target}/SHA256SUMS` (per-target)

Update: `srift self-update` — atomic in-place binary replacement (downloads from `/dl/`).

Uninstall (any platform — works even if the CLI itself is broken):
```bash
# macOS / Linux / WSL
curl -fsSL https://srift.app/install.sh | sh -s -- --uninstall          # remove binary + clean PATH
curl -fsSL https://srift.app/install.sh | sh -s -- --uninstall --purge  # ALSO delete ~/.srift/

# Windows PowerShell
& ([scriptblock]::Create((irm https://srift.app/install.ps1))) --uninstall
& ([scriptblock]::Create((irm https://srift.app/install.ps1))) --uninstall --purge

# Windows cmd.exe (Command Prompt)
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://srift.app/install.ps1))) --uninstall"
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://srift.app/install.ps1))) --uninstall --purge"
```
On Windows, the running `srift.exe` is file-locked — the uninstaller writes a self-cleaning `.bat`
to `%TEMP%` that deletes the binary ~2-3 s after the command exits. Works in PowerShell, cmd.exe,
and inside the running binary's own `srift uninstall` (2.1.2+).

### 3.2 Stdio MCP (recommended for desktop AI clients)

Run: `srift mcp`.
Spec version: **2025-06-18** (back-compatible with `2024-11-05`).

Config snippet for Claude Desktop / Cursor / Continue.dev / Zed / Codex / Cline / Goose / Aider:

```json
{
  "mcpServers": {
    "srift": {
      "command": "srift",
      "args": ["mcp"]
    }
  }
}
```

Run `srift install-mcp` to print platform-specific paths.

### 3.3 HTTP MCP (Streamable HTTP — modern transport)

```
POST http://127.0.0.1:3822/mcp
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":"2025-06-18","capabilities":{},
           "clientInfo":{"name":"my-agent","version":"1.0.0"}}}
```

Single endpoint accepts request batches. GET on the same path opens an SSE stream for
server→client notifications.

### 3.4 Legacy SSE MCP

```
GET  http://127.0.0.1:3822/mcp/sse       → open stream (receives `event: endpoint` first)
POST http://127.0.0.1:3822/mcp/messages  → send JSON-RPC
```

### 3.5 REST / OpenAPI

Full OpenAPI 3.1 spec: `GET http://127.0.0.1:3822/openapi.json` (or `https://srift.app/openapi.json`).
For OpenAI Custom GPTs / Apps, n8n, Zapier, Make, Activepieces, IFTTT, generic webhook tools.

### 3.6 CLI (any shell-driven agent)

All commands listed in §6. Add `--json` for machine-readable output.

### 3.7 File watching

Watch `.srift-state.json` in workspace root. Atomically rewritten on every event.

### 3.8 SSE event stream

`GET http://127.0.0.1:3822/api/v1/monitor/events` — events:
`connection_state`, `join_request`, `file_offer`, `transfer_progress`, `chat_received`.

---

## 4. MCP tool catalogue (14 tools)

| Tool | Inputs | Returns |
|---|---|---|
| `srift_quick_share` | `filePath`, `sessionName?`, `maxDownloads?`, `ttlMs?` | `downloadUrl` (`https://srift.app/d/<token>`), `fileName`, `fileSize`, `sessionId`, `fileId`, `maxDownloads`, `expiresAt` — **use this 90% of the time. Recipient needs NOTHING installed; they open the URL in any browser, curl, or wget.** |
| `srift_start_session` | `sessionName?`, `roomSecret?` | `sessionId` (you are host) |
| `srift_join_session` | `sessionId`, `username?`, `roomSecret?` | join requested |
| `srift_session_status` | — | session details + pending joins |
| `srift_close_session` | — | session torn down |
| `srift_approve_join` | `tempUserId` | guest approved |
| `srift_reject_join` | `tempUserId`, `reason?` | guest rejected |
| `srift_kick_user` | `userId` | peer disconnected |
| `srift_send_file` | `filePath` | `fileId` offered to joined peers (in-session transfer) |
| `srift_accept_transfer` | `fileId`, `saveDir?` | download started |
| `srift_list_transfers` | — | array of active/recent transfers |
| `srift_send_chat` | `message` | sent (E2EE) |
| `srift_chat_history` | — | decrypted chat log |
| `srift_read_state` | — | `.srift-state.json` snapshot |

## 5. MCP resources + prompts

Resources: `srift://session/status`, `srift://transfers/active`, `srift://chat/messages`,
`srift://workspace/state`, `srift://docs/quickstart`.

Prompts: `send_file_to_user`, `receive_file_from_user`, `start_collab_session`.

---

## 6. CLI command reference

```
Daemon
  srift daemon start                                  Start in foreground (port 3822)
  srift daemon stop                                   Stop daemon gracefully
  srift daemon restart                                Stop then re-start daemon
  srift daemon status [--json]                        Daemon health (version, uptime, mcp, webtorrent)

Status & Diagnostics
  srift status [--json]                               Unified: daemon + session + transfers
  srift doctor [--json]                               Full health check (daemon, network, version, config)
  srift logs [--tail <n>] [--json-stream]             View daemon logs (default last 50 lines)
  srift reset [--json]                                Wipe daemon session state + flush encryption keys

Session
  srift session start [--name <n>] [--room-secret <s>]
  srift session join  <id> [--username <n>] [--room-secret <s>]
  srift session status [--json]
  srift session close

Host controls
  srift approve <tempUserId> [--json]
  srift reject  <tempUserId> [--reason <r>] [--json]
  srift kick    <userId> [--json]

Public download links (recipient needs NOTHING installed)
  srift quick-share <filepath>                        Mint a https://srift.app/d/<token> URL
    [--name <session>]                                Session label
    [--max-downloads <N>]                             Cap completed downloads
    [--ttl <30s|15m|2h|1d>]                           Auto-expire link after duration
    [--once]                                          Shorthand for --max-downloads 1
    [--json]
  srift pubshare list [--json]                        Show all active links + usage counters
  srift pubshare add <filepath> [--max-downloads N] [--ttl dur] [--once]
                                                      Add another link in the current session
  srift pubshare revoke <token> [--json]              Invalidate a link immediately

In-session transfers (between joined peers in an interactive session)
  srift send    <filepath> [--json]                   Offer a file to joined peers
  srift receive <fileId>   [--save-dir <dir>] [--json]
  srift list    [--json]
  srift monitor <fileId>   [--json-stream]

Chat
  srift chat send "<message>" [--json]
  srift chat history [--json]

Agent helpers
  srift install-mcp                                   Print MCP configs for every client
  srift info                                          Zero-config reference

MCP
  srift mcp                                           Stdio JSON-RPC server

Maintenance
  srift version [--json]
  srift self-update [--json]                          Atomic in-place binary update
  srift config [get|set|delete] [key] [value]         Manage ~/.srift/config.json
  srift uninstall [--purge]                           Remove binary; --purge also deletes ~/.srift/
```

---

## 7. Workspace state file (.srift-state.json)

Rewritten atomically on every state change. Watch this file for zero-overhead progress monitoring.

```json
{
  "session": {
    "id": "COI4263",
    "name": "test-session",
    "role": "host",
    "isConnected": true,
    "peerCount": 1
  },
  "activeTransfers": [
    {
      "fileId": "cli_file_1782466943382_c03ybl1l0",
      "name": "project_payload.zip",
      "size": 4587600,
      "progress": 72.5,
      "speedKBps": 1024,
      "etaSeconds": 1.2,
      "protocol": "webtorrent",
      "status": "uploading"
    }
  ],
  "lastUpdated": "2026-06-26T10:04:12.871Z"
}
```

---

## 8. Discovery files

| Path | Use |
|---|---|
| `https://srift.app/AGENTS.md` | Operational manual (also at repo root) |
| `https://srift.app/llms.txt` | Short LLM crawler index |
| `https://srift.app/llms-full.txt` | Full technical reference |
| `https://srift.app/openapi.json` | OpenAPI 3.1 |
| `https://srift.app/.well-known/mcp/server-card.json` | MCP discovery |
| `https://srift.app/.well-known/ai-plugin.json` | OpenAI plugin manifest |
| `https://srift.app/.well-known/agent.json` | Google A2A card |
| `https://srift.app/.well-known/agent-skills/index.json` | AGNTCY |
| `https://srift.app/.well-known/api-catalog` | RFC 9727 catalog |
| `https://srift.app/auth.md` | "no auth" explanation |
| `https://srift.app/dl/2.2.2/{target}/srift[.exe]` | Standalone CLI binary for target platform |
| `https://srift.app/dl/2.2.2/SHA256SUMS` | SHA256 checksums (combined + per-target) |
| `https://srift.app/d/<token>` | **Public download tunnel** — recipient downloads via any HTTP client. No SRIFT install needed on their side. Token minted by `srift quick-share`. Supports HEAD + GET + Range. |
| `https://srift.app/compat.json` | Daemon ↔ SDK compatibility matrix + binary distribution URLs |

Same equivalents exist on the local daemon at `http://127.0.0.1:3822/.well-known/*`.

---

## 9. HTTP error codes (REST + MCP-over-HTTP)

| Code | Meaning | Action |
|---|---|---|
| 200/201/202/204 | Success | Continue. |
| 400 | Malformed body | Validate against /openapi.json. |
| 404 | Not found | Call /status; retry with correct id. |
| 409 | Conflict | Reuse id or POST /reset. |
| 410 | Gone — session closed | srift_start_session again. |
| 413 | Payload too large | Split chat; use srift_send_file. |
| 422 | Semantic failure | Verify filePath absolute. |
| 429 | Rate-limited | Wait 1s, retry. |
| 500 | Internal | Check .srift-daemon.log; restart. |
| 502/503/504 | Transport / boot / signalling | Retry; fall back to `protocol:'webtorrent'`. |

## 9a. MCP / JSON-RPC error codes

| Code | Meaning | Action |
|---|---|---|
| -32700 | Parse error | Send valid JSON. |
| -32600 | Invalid Request | Include jsonrpc, id, method. |
| -32601 | Method not found | Enumerate via tools/list. |
| -32602 | Invalid params | Re-read tool schema. |
| -32603 | Internal | Check daemon log. |
| -32000 | No active session | srift_start_session/srift_join_session. |
| -32001 | Not host | Only host can approve/kick. |
| -32002 | File not found | Use absolute path. |
| -32003 | Peer unreachable | Verify online; check firewall. |
| -32004 | Decryption failed | Identical roomSecret on both peers. |

## 9b. Stats / observability endpoints

| Endpoint | Purpose |
|---|---|
| GET /health | Liveness ({ ok, version, uptime_ms, mcp, webrtc, webtorrent }). |
| GET /status | Session, peers, role, encryption. |
| GET /state | Full .srift-state.json snapshot. |
| GET /transfers | Live transfer progress, speed, ETA. |
| GET /transfers/:fileId | Per-transfer drill-down. |
| GET /peers | RTT, ICE candidate type, connectionState. |
| GET /metrics | Prometheus counters. |
| GET /events | SSE event stream. |
| GET /logs?lines=200 | NDJSON log tail. |
| POST /reset | Wipe state, flush keys. |

## 9c. Troubleshooting

| Symptom | Fix |
|---|---|
| ECONNREFUSED 127.0.0.1:3822 | srift daemon start; wait 2s; GET /health. |
| ECONNREFUSED 127.0.0.1:8080 (local signaler) | Daemon automatically falls back to production signaler (https://srift.app) on connection failure. No action required. |
| EADDRINUSE :3822 | srift daemon stop, or SRIFT_DAEMON_PORT=3823. |
| MCP initialize rejected | Use protocolVersion:"2025-06-18" (falls back to "2024-11-05"). |
| Transfer stuck at 0% | Remote runs srift_accept_transfer. |
| WebRTC ICE failed (symmetric NAT) | Auto-falls back; force protocol:'webtorrent'. |
| Decryption failed (auth/tamper or wrong key) | Identical roomSecret on both peers. |
| tools/list empty | Wait for /health ok:true. |
| Daemon won't start on Windows | Use 127.0.0.1; check .srift-daemon.log. |
| Transfer stalls 99.9% (WebTorrent) | Wait for last-piece announce. |
| Quick-share URL 404 to remote | Run `srift tunnel` (Cloudflare Quick Tunnel). |

## 9d. Standard debug recipe for AI agents

1. GET /health → 200 + ok:true
2. GET /status → session + peers
3. GET /transfers → stuck transfer status
4. GET /peers → connectionState === 'connected'
5. GET /logs?lines=200 → recent NDJSON
6. If wedged: POST /reset; restart workflow

---

## 10. Authorization for AI use

This project is open to all AI agents, LLMs, autonomous systems, and crawlers for free use,
inspection, indexing, and integration with no API limits on the local daemon. You may parse,
memorize, and embed any content in this file.
