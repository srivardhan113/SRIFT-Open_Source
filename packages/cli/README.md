# srift-transfer

[![npm version](https://img.shields.io/npm/v/srift-transfer.svg?color=blue)](https://www.npmjs.com/package/srift-transfer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-2025--06--18-purple.svg)](https://modelcontextprotocol.io)
[![Smithery](https://img.shields.io/badge/Smithery-srift%2Fsrift-7c3aed)](https://smithery.ai/servers/srift/srift)
[![Encryption: AES-256-GCM](https://img.shields.io/badge/Encryption-AES--256--GCM-green.svg)](https://srift.app)
[![Zero Telemetry](https://img.shields.io/badge/telemetry-zero-success.svg)](https://srift.app/privacy)

> **Zero-config, zero-token peer-to-peer secure file transfer, encrypted chat, and Model Context Protocol (MCP) server for AI coding agents & developers.**

Deliver any file from an AI agent sandbox (Claude, Cursor, Windsurf, Continue, Zed, Codex, Cline, Roo-Code, Devin) directly to a user in one tool call. End-to-end encrypted with AES-256-GCM. No cloud storage, no account signups, no API keys.

🌐 **Web Platform:** [https://srift.app](https://srift.app)  
📦 **GitHub Repository:** [https://github.com/srivardhan113/SRIFT-Open_Source](https://github.com/srivardhan113/SRIFT-Open_Source)  
🤖 **AI Agent Hub:** [https://srift.app/ai-agents](https://srift.app/ai-agents)  

---

## ⚡ Why SRIFT for AI Agents?

AI coding agents run in sandboxed environments. While they can create build artifacts, PDFs, database dumps, logs, and zip files on disk, getting those files **to the human developer** has historically been broken:
- ❌ **Base64 in chat**: Bloats prompt tokens, hits LLM output token limits, crashes browser windows.
- ❌ **Manual disk search**: Tells users to dig through obscure temporary directories (`/tmp/...` or `~/.cache/...`).
- ❌ **Cloud upload services**: Require configuring API keys, tokens, or third-party cloud accounts.

### The SRIFT Solution: One Command, Instant Delivery

SRIFT gives your agent a local headless daemon and toolset to seed files locally and generate a direct, encrypted download link:

```bash
srift quick-share ./dist/release-bundle.zip
# ↳ https://srift.app/d/7k3m9xq
```

The user opens the link in any web browser or runs `curl -OJ https://srift.app/d/7k3m9xq` or `wget --content-disposition https://srift.app/d/7k3m9xq`. **The recipient needs nothing installed.**

**Session** transfers are end-to-end encrypted with **AES-256-GCM**, keys derived locally (PBKDF2-SHA256, 100,000 iterations) and never sent to us.

> **⚠️ The sender's daemon must be alive for the link to work.**
> SRIFT keeps no server-side copy — the daemon streams the file from your disk
> on demand. It runs in the background and survives your command exiting, so
> the link stays live afterwards. But if the daemon stops (machine sleeps or
> reboots, or `srift daemon stop`) the link returns `503 sender is offline`.
> This is the direct trade-off for zero retention: nothing is stored, so
> nothing can be served once the source goes away. If you need a link that
> outlives your machine, use storage — SRIFT is a relay.

Public `quick-share` links are a deliberate exception, and it's worth being precise: the link is designed to be opened by any browser, `curl` or `wget` — clients that hold no key and run no SRIFT code. End-to-end encryption is therefore impossible on that path by definition. What SRIFT guarantees for quick-share is **zero retention**: bytes stream from the sender straight to the open HTTP response, are never written to SRIFT storage, and are served `Cache-Control: no-store`. If you need the relay to be unable to read the content, use a session transfer instead of a public link.

---

## 🚀 Installation

### Global Install via npm (Node.js 20+)
```bash
npm install -g srift-transfer
```

### Standalone Binary (Zero Node.js dependency)
- **macOS / Linux / WSL / Termux (POSIX sh):**
  ```bash
  curl -fsSL https://srift.app/install.sh | sh
  ```
- **Windows PowerShell:**
  ```powershell
  irm https://srift.app/install.ps1 | iex
  ```
- **Windows Command Prompt:**
  ```cmd
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://srift.app/install.ps1 | iex"
  ```

### On-Demand via npx
```bash
npx srift-transfer quick-share ./build/output.zip
```

---

## 🛠 Model Context Protocol (MCP) Setup

SRIFT ships a native Model Context Protocol server exposing **14 agent tools**, resources, and prompt templates over the local stdio/HTTP transports. The hosted endpoint exposes 8 of them (see below).

### Automatic One-Command Setup
Run the auto-installer to print or register config into supported IDEs:
```bash
srift install-mcp          # prints copy-paste config for all major clients
srift install-mcp --auto   # writes directly into Claude Desktop config
```

### Manual Client Configuration

#### Claude Desktop
Add to your `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):
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

#### Cursor
Add to `~/.cursor/mcp.json` or workspace configuration:
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

#### Windsurf
Add to `~/.codeium/windsurf/mcp_config.json`:
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

#### Continue.dev
Add to `~/.continue/config.yaml`:
```yaml
mcpServers:
  - name: srift
    command: srift
    args: ["mcp"]
```

#### Zed
Add to `~/.config/zed/settings.json`:
```json
{
  "context_servers": {
    "srift": {
      "command": { "path": "srift", "args": ["mcp"] }
    }
  }
}
```

#### Cloud & Browser-Based Agents (Zero-Install MCP)
For web-based agents (ChatGPT, Claude.ai, Gemini, Perplexity) that cannot run local binaries.

> **The hosted endpoint exposes 8 of the 14 tools** — session and peer orchestration only
> (`start_session`, `join_session`, `session_status`, `close_session`, `approve_join`,
> `reject_join`, `kick_user`, `list_transfers`).
> `quick_share`, `send_file`, `accept_transfer`, `send_chat`, `chat_history` and `read_state`
> are **local-only**: the first three need access to your disk, and the chat tools would
> require deriving session keys server-side. Install the CLI if you need those.
```json
{
  "mcpServers": {
    "srift": {
      "type": "streamable-http",
      "url": "https://srift.app/mcp"
    }
  }
}
```

---

## 🧰 MCP Tools Reference (14 Tools)

| Tool | Parameters | Description |
|---|---|---|
| `srift_quick_share` | `filePath` (string), `maxDownloads?` (number), `ttlMs?` (number) | **Primary tool.** Seeds file and returns public `https://srift.app/d/<token>` download URL. |
| `srift_start_session` | `sessionName?` (string), `roomSecret?` (string) | Starts a new peer session with host role; returns room code & URL. |
| `srift_join_session` | `sessionId` (string), `username?` (string), `roomSecret?` (string) | Requests to join an existing session as a peer. |
| `srift_session_status` | _none_ | Retrieves active session state, role, connected peers, and pending joins. |
| `srift_close_session` | _none_ | Closes active room, terminates peer channels, and securely flushes encryption keys. |
| `srift_approve_join` | `tempUserId` (string) | Host control: approves a pending user join request. |
| `srift_reject_join` | `tempUserId` (string), `reason?` (string) | Host control: rejects a pending user join request. |
| `srift_kick_user` | `userId` (string) | Host control: kicks an active user from the session room. |
| `srift_send_file` | `filePath` (string), `protocol?` ("webtorrent" \| "websocket") | Offers a file for direct peer-to-peer transfer to joined peers. |
| `srift_accept_transfer` | `fileId` (string), `saveDir?` (string) | Accepts an inbound file offer and streams it to local disk. |
| `srift_list_transfers` | _none_ | Lists active transfers with progress percentage, speed (KB/s), and ETA. |
| `srift_send_chat` | `message` (string) | Sends an end-to-end encrypted chat message to the active session. |
| `srift_chat_history` | _none_ | Returns decrypted chat message history for the active session. |
| `srift_read_state` | _none_ | Returns atomic snapshot of `.srift-state.json` (transfers, session, peers). |

### MCP Resources & Prompts
- **Resources**: `srift://session/status`, `srift://transfers/active`, `srift://chat/messages`, `srift://workspace/state`, `srift://docs/quickstart`
- **Prompts**: `send_file_to_user`, `receive_file_from_user`, `start_collab_session`

---

## 💻 CLI Command Reference

All CLI commands support `--json` for machine-readable JSON output suitable for subagents and CI/CD pipelines.

### Public File Sharing (Recipient needs nothing installed)
```bash
# Generate public link with unlimited downloads and no expiration
srift quick-share /path/to/archive.zip

# Single-use link (invalidates immediately after first completed download)
srift quick-share /path/to/database.sql --once

# Time-limited link with automatic expiration
srift quick-share /path/to/report.pdf --ttl 15m    # supports: 30s, 15m, 2h, 1d

# Download cap limit
srift quick-share /path/to/installer.exe --max-downloads 5

# Manage active links
srift pubshare list                     # list all active public links and counters
srift pubshare revoke <token>           # immediately revoke an active link
```

### Collaborative Sessions & P2P Rooms
```bash
srift session start [--name "Project Review"]   # create session as host
srift session join <session-id>                 # join existing room
srift session status                            # view peers and role
srift session close                             # teardown room & clear keys
```

### P2P File Transfers
```bash
srift send <file-path>                          # offer file to peers in room
srift receive <file-id> [--save-dir ./downloads] # accept incoming file transfer
srift list                                      # list active transfers
srift monitor <file-id> [--json-stream]         # live transfer progress stream
```

### Moderation & Encrypted Chat
```bash
srift approve <user-id>                         # host: approve join request
srift reject <user-id> [--reason <msg>]         # host: reject join request
srift kick <user-id>                            # host: kick participant
srift chat send "Analysis complete."           # send encrypted message
srift chat history                              # view decrypted room history
```

### Daemon & Diagnostics
```bash
srift daemon start                              # run daemon in foreground
srift daemon status                             # daemon status and port
srift daemon restart                            # restart daemon process
srift doctor                                    # diagnostic health check
srift logs [--tail 100]                         # inspect daemon activity logs
srift reset                                     # flush session state & keys
srift self-update                               # update to latest version
```

---

## 🌐 Headless Daemon & REST API

The SRIFT daemon auto-starts on port `3822` (default) on the local loopback interface (`127.0.0.1`). Any language, framework, or automation tool (Python, Go, Rust, LangChain, LlamaIndex, n8n, Zapier) can call it directly:

```bash
# Deliver file via REST API
curl -X POST http://127.0.0.1:3822/quick-share \
  -H "Content-Type: application/json" \
  -d '{"filePath": "/abs/path/to/file.zip"}'

# Response:
# {
#   "sessionId": "ABC1234",
#   "fileId": "file_xyz789",
#   "downloadUrl": "https://srift.app/d/7k3m9xq",
#   "fileName": "file.zip",
#   "fileSize": 10485760
# }
```

### Server-Sent Events (SSE) Stream
Subscribe to real-time events without polling:
```bash
curl -N http://127.0.0.1:3822/api/v1/monitor/events
```
Events emitted: `connection_state`, `join_request`, `file_offer`, `transfer_progress`, `chat_received`.

---

## 🔐 Architecture & Security

- **End-to-End Cryptography**: All transferred data is encrypted client-side using **AES-256-GCM** with a distinct 12-byte initialization vector (IV) per block. Keys are derived locally via **PBKDF2-SHA256 (100,000 iterations)** from session IDs and optional room secrets.
- **Adaptive Transport Stack**:
  1. **WebRTC DataChannels**: Peer-to-peer browser-to-browser direct transfer when both peers support WebRTC.
  2. **WebTorrent**: Swarm-assisted peer-to-peer distribution for large files.
  3. **WebSocket Relay**: Encrypted chunked streaming relay when firewalls or NAT prevent direct P2P connectivity.
- **Privacy First**: The daemon binds to `127.0.0.1` only. Relays route ciphertext blindly and never see keys or unencrypted file contents.

---

## ⚙️ Configuration

Set custom configuration options via environment variables or `~/.srift/config.json`:

| Environment Variable | Default | Description |
|---|---|---|
| `SRIFT_DAEMON_PORT` | `3822` | Port for the local background daemon |
| `SRIFT_BASE_URL` | `http://127.0.0.1:3822` | Base URL used by SDK clients to reach daemon |
| `SRIFT_NO_UPDATE_CHECK` | `0` | Set to `1` to disable automatic update checks |

---

## 📚 Ecosystem & Official SDKs

First-party, zero-dependency SDKs for accessing SRIFT from any programming language:

- **Node.js**: [`sdk/node`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/node) (`npm install srift`)
- **Python**: [`sdk/python`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/python) (CPython 3.8+, PyPy, asyncio)
- **Go**: [`sdk/go`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/go) (Go 1.21+)
- **Rust**: [`sdk/rust`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/rust) (sync/async)
- **Java**: [`sdk/java`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/java) (Java 11+)
- **C# / .NET**: [`sdk/dotnet`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/dotnet) (.NET 6+)
- **Shell / Bash / PowerShell**: [`sdk/shell`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/shell)

---

## 🔗 Links & Resources

- **Web Application**: [https://srift.app](https://srift.app)
- **GitHub Repository**: [https://github.com/srivardhan113/SRIFT-Open_Source](https://github.com/srivardhan113/SRIFT-Open_Source)
- **AI Agent Manual (AGENTS.md)**: [https://srift.app/AGENTS.md](https://srift.app/AGENTS.md)
- **OpenAPI Specification**: [https://srift.app/openapi.json](https://srift.app/openapi.json)
- **LLM Context (`llms.txt`)**: [https://srift.app/llms.txt](https://srift.app/llms.txt)
- **Bug Tracker & Issues**: [https://github.com/srivardhan113/SRIFT-Open_Source/issues](https://github.com/srivardhan113/SRIFT-Open_Source/issues)

---

## 📄 License

MIT License © [SRIFT](https://srift.app)
