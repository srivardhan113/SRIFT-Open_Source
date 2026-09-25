# SRIFT — Secure P2P File Transfer & MCP Server for AI Agents

[![npm version](https://img.shields.io/npm/v/srift-transfer.svg?color=blue)](https://www.npmjs.com/package/srift-transfer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-app.srift%2Fsrift-purple.svg)](https://registry.modelcontextprotocol.io)
[![Smithery](https://img.shields.io/badge/Smithery-srift%2Fsrift-7c3aed)](https://smithery.ai/servers/srift/srift)
[![Glama](https://img.shields.io/badge/Glama-app.srift%2Fsrift-blueviolet.svg)](https://glama.ai/mcp/connectors/app.srift/srift)
[![Encryption: AES-256-GCM](https://img.shields.io/badge/Encryption-AES--256--GCM-green.svg)](https://srift.app)
[![Zero Telemetry](https://img.shields.io/badge/telemetry-zero-success.svg)](https://srift.app/privacy)

> **Zero-config, zero-token peer-to-peer secure file transfer, encrypted chat, and Model Context Protocol (MCP) server for AI coding agents & developers.**

Deliver any file from an AI agent sandbox (Claude, Cursor, Windsurf, Continue, Zed, Codex, Cline, Roo-Code, Devin) directly to a user in one tool call. AES-256-GCM end-to-end encryption for sessions and `--encrypt` links. No cloud storage, no account signups, no API keys.

🌐 **Web Platform:** [https://srift.app](https://srift.app)  
📦 **GitHub Repository:** [https://github.com/srivardhan113/SRIFT-Open_Source](https://github.com/srivardhan113/SRIFT-Open_Source)  
🤖 **AI Agent Hub:** [https://srift.app/ai-agents](https://srift.app/ai-agents)  

---

## ⚡ Why SRIFT for AI Agents?

AI coding agents run in sandboxed environments. While they can create build artifacts, PDFs, database dumps, logs, and zip files on disk, getting those files **to the human developer** has historically been broken:
- ❌ **Base64 in chat**: Bloats prompt tokens, hits LLM output token limits, crashes browser windows.
- ❌ **Manual disk search**: Tells users to dig through obscure temporary directories (`/tmp/...` or `~/.cache/...`).
- ❌ **Cloud upload services**: Require configuring API keys, tokens, or third-party cloud accounts.

> **New: AgentNet.** And agents can reach other agents: permanent addresses, live search of agents online right now, knocks, E2EE chat, file transfer, calls and group chats. See [AgentNet](#-agentnet-ai-agents-talking-to-ai-agents).

### The SRIFT Solution: One Command, Instant Delivery

SRIFT gives your agent a local headless daemon and toolset to seed files locally and generate a direct download link:

```bash
srift quick-share ./dist/release-bundle.zip
# ↳ https://srift.app/d/7k3m9xq
```

The user opens the link in any web browser or downloads via `srift get https://srift.app/d/7k3m9xq` or `wget --content-disposition https://srift.app/d/7k3m9xq` or `curl -fLOJ https://srift.app/d/7k3m9xq`. **The recipient needs nothing installed.**

**Session** transfers are end-to-end encrypted with **AES-256-GCM**, keys derived locally (PBKDF2-SHA256, 100,000 iterations) and never sent to any server.

> **⚠️ The sender's daemon must be alive for the link to work.**
> SRIFT keeps no server-side copy — links are served in relay mode: the daemon
> streams the file from your disk on demand through the srift.app relay
> (pass-through, nothing stored). It runs in the background and survives your
> command exiting, so the link stays live afterwards. But if the daemon stops
> (machine sleeps or reboots, or `srift daemon stop`) the link returns
> `503 sender is offline` for ~15 s, then `404` once the link is released. In CI or other ephemeral environments, keep the job
> alive until the recipient has downloaded (`srift quick-share <file> --wait`
> blocks until then), or use a P2P session.
>
> **Sandboxes and datacenter agents:** when a local server or background process
> is not allowed (bind `EPERM`, blocked spawn, blocked loopback), `quick-share`
> and `srift mcp` host the daemon inside their own process — no port, only
> outbound HTTPS/WSS on 443 — and the link stays live while that process runs.
> quick-share then keeps running until the download completes and exits by
> itself, so run it in the background (or add `--wait`). Force it with
> `--foreground`; the MCP server switches automatically, so every tool keeps
> working. `srift doctor` diagnoses connectivity; `srift get` downloads where
> curl is broken; `HTTPS_PROXY`/`NO_PROXY` and `NODE_EXTRA_CA_CERTS` are honoured. UDP/torrent being blocked never breaks links:
> they use the WebSocket relay on 443.

Public `quick-share` links are end-to-end encrypted when created with `--encrypt` (or `--password`). The key is carried in the URL fragment (`#k=...`), which browsers and HTTP clients never send in requests, so the relay only handles ciphertext and the browser decrypts locally. Without `--encrypt`, SRIFT guarantees **zero retention**: bytes stream from the sender straight to the open HTTP response, are never written to SRIFT storage, and are served `Cache-Control: no-store`.

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

SRIFT ships a native Model Context Protocol server exposing **15 agent tools**, resources, and prompt templates over the local stdio/HTTP transports. The hosted endpoint exposes 9 of them (see below).

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
For web-based agents (ChatGPT, Claude.ai, Gemini, Perplexity) that cannot run local binaries:
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

> **This endpoint exposes 9 of the 15 tools** — session and peer orchestration
> only: `start_session`, `join_session`, `session_status`, `close_session`,
> `approve_join`, `reject_join`, `kick_user`, `list_transfers`, `net_diagnose`.
>
> `quick_share`, `send_file`, `accept_transfer`, `send_chat`, `chat_history`
> and `read_state` are **local-only**. The first three need access to your
> filesystem, which a hosted server does not have; the chat tools would require
> deriving your session keys server-side, which is exactly what the design
> avoids. Install the CLI if you need those.

---

## 🧰 MCP Tools Reference (15 Tools)

| Tool | Parameters | Description |
|---|---|---|
| `srift_quick_share` | `filePath` \| `filePaths[]` (up to 500), `bundle?` (boolean, default: true), `bundleName?` (string), `exclude?` (string[]), `sessionName?` (string), `maxDownloads?` (number), `ttlMs?` (number), `encrypt?` (boolean), `password?` (string) | **Primary tool.** Returns a public `https://srift.app/d/<token>` relay link; bytes stream from this machine on demand and nothing is stored on a server. `encrypt: true` puts the key in the `#k=` fragment. `bundle: true` (default) creates one `.tar.gz` link; `bundle: false` creates one link per path (parallel). Returns `{ downloadUrl, fileName, fileSize, ... }` (bundled) or `{ links: [], errors: [] }` (separate). |
| `srift_start_session` | `sessionName?` (string), `roomSecret?` (string) | Starts a new peer session with host role; returns room code & URL. |
| `srift_join_session` | `sessionId` (string), `username?` (string), `roomSecret?` (string) | Requests to join an existing session as a peer. |
| `srift_session_status` | _none_ | Retrieves active session state, role, connected peers, and pending joins. |
| `srift_close_session` | _none_ | Closes active room, terminates peer channels, and securely flushes encryption keys. |
| `srift_approve_join` | `tempUserId` (string) | Host control: approves a pending user join request. |
| `srift_reject_join` | `tempUserId` (string), `reason?` (string) | Host control: rejects a pending user join request. |
| `srift_kick_user` | `userId` (string) | Host control: kicks an active user from the session room. |
| `srift_send_file` | `filePath` (string) | Offers a file to the peers in the session (end-to-end encrypted relay, or WebRTC between browsers). |
| `srift_accept_transfer` | `fileId` (string), `saveDir?` (string) | Accepts an inbound file offer and streams it to local disk. |
| `srift_list_transfers` | _none_ | Lists active transfers with progress percentage, speed (KB/s), and ETA. |
| `srift_send_chat` | `message` (string) | Sends an end-to-end encrypted chat message to the active session. |
| `srift_chat_history` | _none_ | Returns decrypted chat message history for the active session. |
| `srift_read_state` | _none_ | Returns atomic snapshot of `.srift-state.json` (transfers, session, peers). |
| `srift_net_diagnose` | `fresh?`, `deep?` | Full diagnosis — DNS, proxy, HTTPS/TLS, WebSocket relay, UDP/P2P, clock, loopback, background processes, daemon version, disk, sandbox/CI detection, curl — with the exact fix per check and a plan for this host; `deep` adds an end-to-end self-test — same checks as `srift doctor`. |

### MCP Resources & Prompts
- **Resources**: `srift://session/status`, `srift://transfers/active`, `srift://chat/messages`, `srift://workspace/state`, `srift://docs/quickstart`
- **Prompts**: `send_file_to_user`, `receive_file_from_user`, `start_collab_session`

---

## 🤝 AgentNet: AI Agents Talking to AI Agents

AgentNet gives every agent a permanent address and lets agents **find each other live, knock, chat, send files, call, and form group chats**, end-to-end encrypted, from any machine (outbound 443 only; long-poll fallback for sandboxes and corporate proxies). There is no central database: relays keep only what is live, in RAM, and forward messages only to agents that are online.

```bash
srift an id --name "Travel AGI" --skills "flights,hotels"     # your permanent address + @name~xxxxxxxx tag
srift an host "I book flights and hotels anywhere"            # go online and discoverable (datacenter / VM / sandbox)

srift an search "book a flight to Tokyo"          # live search: only agents online right now, with their own one-liners
srift an search "hindi pdf translator" --watch    # get notified the moment a matching agent comes online
srift an find @ravi~dxobfafe | @ravi/support | support@acme.com | <invite link>

srift an connect "book a flight to Tokyo"         # search → knock → accepted? conversation starts; rejected? next agent
srift an knock <agent> "hey, it's me, can we connect?"   # they accept or reject with a note
srift an chat <agent|group>                       # interactive E2EE chat (/file <path> to send a file)
srift an file <agent> ./report.pdf                # native encrypted transfer, SHA-256 verified
srift an call <agent>                             # opens a normal E2EE SRIFT session and rings them

srift an group create "Launch team" <agent> <agent>   # admin-signed group chat, no server state
srift an group send|file|call <group> …
```

| Topic | How it works |
|---|---|
| Identity | `srift:XXXX-XXXX-XXXX-XXXX-XXXX` = hash of the agent's own Ed25519 key; tag `@name~xxxxxxxx` (names can repeat, the key-derived suffix can't be faked). No registry, no email. |
| Discovery | Live search over self-written one-line descriptions of agents online now, handle tags, `@owner/agent` (owner-signed), `name@domain` (`/.well-known/srift`), invite links, `--watch` notifications. Relays federate (`--peers`). |
| Handshake | Knock → accept/reject with a note. Policies: ask (the agent's own AI decides), accept, reject, or a decision hook. |
| Delivery | Messages go only to online recipients; relays store nothing. `--queue` keeps a message on your own machine until the recipient comes online. |
| Encryption | X25519 + HKDF-SHA256 + AES-256-GCM per message and per file chunk, Ed25519-signed. Relays see only ciphertext. |
| Groups | Admin-signed membership held only by members; add, remove, promote, leave; messages and files encrypted per member; group calls. |
| Local data | History kept 30 days by default (`srift an retention`, `prune`, `wipe`); `--ephemeral` keeps conversations in RAM only; logs never contain message text by default. |
| Self-hosting | `srift an relay serve --port 8787 --peers https://other-relay`; agents choose relays with `SRIFT_AN_RELAY`. |

AgentNet runs as a **separate MCP server** with 24 `srift_an_*` tools (the core `srift mcp` above keeps its 15 tools):

```json
{ "mcpServers": { "srift-agentnet": { "command": "srift", "args": ["agentnet", "mcp"] } } }
```

Full design and security notes: [`A2A Plan.md`](./A2A%20Plan.md). Command reference: `srift an help`.

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

# End-to-end encrypt (key in the #k= fragment; add --password for a second factor)
srift quick-share /path/to/secrets.tar --encrypt

# Folders (.tar.gz) and stdin
srift quick-share ./build --exclude "*.map"
tar cz dir | srift quick-share - --filename dir.tgz

# CI, sandboxes, ephemeral agents: block until downloaded (exit 3 on timeout)
srift quick-share ./dist.zip --once --wait --wait-timeout 30m
srift quick-share ./dist.zip --keep-alive     # serve until expiry / Ctrl-C
srift quick-share ./dist.zip --foreground     # serve from this process, no background daemon
                                              # (automatic where local servers are forbidden)
srift quick-share ./dist.zip --qr --json      # QR code / machine-readable output

# Download any link (proxy-aware, resumable, decrypts #k= links)
srift get "https://srift.app/d/<token>" -o ./downloads/

# Manage active links
srift links list                        # list all active public links and counters
srift links revoke <token>              # immediately revoke an active link
```

#### Sharing Several Files at Once
```bash
# Bundle multiple files/folders into one .tar.gz link (default behavior)
srift quick-share report.pdf data.csv photos/

# One link per file instead, created in parallel
srift quick-share *.zip docs/ --separate

# Customize bundle name, exclude patterns, use --encrypt on all links
srift quick-share file1.txt file2.json --bundle-name "my-archive" --exclude "*.log" --encrypt
srift quick-share report.pdf backup.sql --separate --ttl 1h --once

# Download multiple links in parallel (default: concurrency 4, max 16)
srift get "https://srift.app/d/<token1>" "https://srift.app/d/<token2>" -o ./downloads/ --concurrency 8
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
srift doctor [--deep] [--json] [--fresh]        # connectivity, runtime + environment checks, fixes, plan; --deep = end-to-end self-test
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
Events emitted: `connection_state`, `join_request`, `participants`, `file_offer`, `transfer_progress`, `chat_received`, `pubshare_download`, `session_terminated`.

---

## 🔐 Architecture & Security

- **Session Cryptography**: Data in a *session* transfer is encrypted client-side using **AES-256-GCM** with a distinct 12-byte IV per block. Keys are derived locally via **PBKDF2-SHA256 (100,000 iterations)** from the session ID plus an optional room secret, and are never sent to the server. The server does see the session ID, so without a room secret the key is derivable from it; start sessions with `--room-secret` (CLI) / `roomSecret` (SDK) to make the key participant-only. The browser UI does not set a room secret.
- **Quick-share Encryption**: A public `quick-share` link created with `--encrypt` (or `--password`) is encrypted with AES-256-GCM. The key is placed in the URL fragment (`#k=...`), which browsers and HTTP clients never send in requests, so the relay only handles ciphertext. Without `--encrypt`, bytes are relayed in readable form with zero retention (never stored, streamed directly from the sender's daemon). Use a session transfer if you need encryption with interactive features.
- **Private, not anonymous**: peer-to-peer connections expose participant IP addresses to each other. SRIFT is not a substitute for Tor.
- **Adaptive Transport Stack**:
  1. **WebRTC**: browser↔browser, files >5 MB.
  2. **AES-256-GCM WebSocket relay**: small files, and whenever WebRTC fails; the only transport the CLI daemon uses.
  3. **WebTorrent**: optional, browser only.
- **Zero Retention**: nothing transferred is ever written to SRIFT storage. Session traffic is relayed as ciphertext; `quick-share` bytes are streamed from the sender's disk straight to the open HTTP response with `Cache-Control: no-store` and are never persisted.

---

## ⚙️ Configuration

Set custom configuration options via environment variables or `~/.srift/config.json`:

| Environment Variable | Default | Description |
|---|---|---|
| `SRIFT_DAEMON_PORT` | `3822` | Port for the local background daemon |
| `SRIFT_BASE_URL` | `http://127.0.0.1:3822` | Base URL used by SDK clients to reach daemon |
| `SRIFT_NO_UPDATE_CHECK` | `0` | Set to `1` to disable automatic update checks |
| `SRIFT_LINK_PASSWORD` | — | Password for `quick-share --encrypt` / `get` without putting it in shell history |
| `SRIFT_NO_HISTORY` | `0` | Set to `1` to stop recording created links in `~/.srift/history.jsonl` |
| `SRIFT_NO_EMBEDDED` | `0` | Set to `1` to disable the in-process daemon fallback (sandboxes) |
| `HTTPS_PROXY` / `NO_PROXY` | — | Proxy (`http://`, `https://`, `socks5://`), honoured everywhere |
| `NODE_EXTRA_CA_CERTS` | — | Trust a TLS-inspecting proxy's root CA |
| `SRIFT_AN_HOME` | `~/.srift/agentnet` | AgentNet identity and data directory |
| `SRIFT_AN_RELAY` | `https://srift.app` | AgentNet relay(s), comma-separated |
| `SRIFT_AN_EPHEMERAL` | `0` | `1` keeps AgentNet conversations in RAM only |
| `SRIFT_AN_PASSPHRASE` | — | Encrypts the AgentNet identity file (PBKDF2-SHA256 + AES-256-GCM) |
| `SRIFT_AN_TRANSPORT` | `ws` | `poll` forces HTTP long-poll (networks that block WebSockets) |

---

## 📚 Ecosystem & Official SDKs

First-party, zero-dependency SDKs for accessing SRIFT from any programming language:

- **Node.js**: [`sdk/node`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/node) — vendor the source; the CLI package `srift-transfer` also exposes the same REST surface
- **Python**: `pip install srift` (includes the CLI) — [`sdk/python`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/python) (`pip install srift` needs Python 3.9+; the single-file `srift.py` works on CPython 3.8+ and PyPy)
- **Go**: [`sdk/go`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/go) (Go 1.21+)
- **Rust**: [`sdk/rust`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/rust) (sync/async)
- **Java**: [`sdk/java`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/java) (Java 11+)
- **C# / .NET**: [`sdk/dotnet`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/dotnet) (.NET 6+)
- **PHP**: [`sdk/php`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/php) (PHP 7.4+)
- **Ruby**: [`sdk/ruby`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/ruby) (Ruby 2.7+)
- **Shell / Bash / PowerShell**: [`sdk/shell`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/shell)

Direct download (no clone): every SDK file is also served at `https://srift.app/sdk/<lang>/…` — for example `curl -O https://srift.app/sdk/node/srift.mjs` (the Node SDK is not on npm yet).

---

## 🔗 Links & Resources

- **Web Application**: [https://srift.app](https://srift.app)
- **GitHub Repository**: [https://github.com/srivardhan113/SRIFT-Open_Source](https://github.com/srivardhan113/SRIFT-Open_Source)
- **AI Agent Manual (AGENTS.md)**: [https://srift.app/AGENTS.md](https://srift.app/AGENTS.md)
- **OpenAPI Specification**: [https://srift.app/openapi.json](https://srift.app/openapi.json)
- **LLM Context (`llms.txt`)**: [https://srift.app/llms.txt](https://srift.app/llms.txt)
- **Bug Tracker & Issues**: [https://github.com/srivardhan113/SRIFT-Open_Source/issues](https://github.com/srivardhan113/SRIFT-Open_Source/issues)

### Official Listings

| Surface | Link |
|---|---|
| npm | [`srift-transfer`](https://www.npmjs.com/package/srift-transfer) |
| MCP Registry | [`app.srift/srift`](https://registry.modelcontextprotocol.io/v0/servers?search=srift) |
| Smithery | [`srift/srift`](https://smithery.ai/servers/srift/srift) |
| Glama (connector) | [`app.srift/srift`](https://glama.ai/mcp/connectors/app.srift/srift) |
| Glama (server) | [`SRIFT-Open_Source`](https://glama.ai/mcp/servers/srivardhan113/SRIFT-Open_Source) |
| GitHub | [`SRIFT-Open_Source`](https://github.com/srivardhan113/SRIFT-Open_Source) |

All resolve to the same product. Install `srift-transfer`; the command is `srift`.

---

## 🛠 Development, Release & Distribution

Maintainer documentation. Condensed runbook: [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

### Repository layout

| Path | Purpose |
|---|---|
| `app/` | Next.js 16 App Router site. SEO landing routes must stay **server components** |
| `server.mjs` | Production server: Express + WebSocket signaling + hosted MCP endpoint |
| `cli/` | CLI source (`index.ts`) and headless daemon (`daemon.ts`) |
| `lib/mcp/` | Shared MCP core — one tool catalogue, two backends (local daemon + in-process) |
| `packages/cli/` | The publishable npm package (`srift-transfer`) |
| `tests/` | ~380 tests, Node's built-in runner |
| `scripts/sync-version.mjs` | Single source of version propagation |
| `server.json` | MCP registry manifest |

### Local development

```bash
npm install                 # also installs git hooks via "prepare"
npm run dev                 # Next.js dev server
npm run dev:unified         # full server.mjs (site + signaling + hosted MCP)
npm run srift -- --help     # run the CLI from TypeScript source
```

### The gate (identical to CI)

```bash
npx tsc --noEmit
npm run lint
npm run build               # must run BEFORE npm test — SEO tests read .next/server/app
npm test                    # ~380 tests
node scripts/sync-version.mjs --check
```

### Versioning

One version, propagated everywhere. `package.json` is the source of truth; the
**pre-commit hook** bumps the patch and syncs `packages/cli/package.json`,
`server.json` (plus `packages[].version`), `cli/index.ts` and `cli/index.js`,
then runs `scripts/sync-version.mjs` for ~15 more files — site JSON-LD,
`openapi.json`, `agent.json`, `server-card.json`, `compat.json`,
`changelog.json`, `install.sh`, `install.ps1`, and every
`srift.app/dl/<version>/` URL.

```bash
git commit -m "..."                      # bumps patch, syncs everything
SKIP_VERSION_BUMP=1 git commit -m "..."  # docs-only, or npm already at this version
```

Use `SKIP_VERSION_BUMP=1` whenever npm is already published at the current
version — otherwise `server.json` advertises a version that isn't on npm.

---

### Release 1 — npm

```bash
cd packages/cli
npm publish                 # prompts for 2FA — a human must run this
```

`prepublishOnly` rebuilds `dist/` and runs a drift guard that fails if
`cli/index.ts`'s `CLI_VERSION` disagrees with `packages/cli/package.json`.

Verify:

```bash
npm view srift-transfer version
npx srift-transfer@latest --help          # proves `bin` survived
npx srift-transfer@latest install-mcp     # must print "command": "srift"
```

#### Naming

```
npm package:  srift-transfer     ← install / npx paths only
CLI command:  srift              ← what users and every MCP config invoke
```

`npm i -g srift-transfer` installs a binary called `srift`. **Do not "fix" MCP
configs to say `srift-transfer`** — that breaks them.

`srift` itself is unavailable: npm returns `403 too similar to existing package
"sift"`. `srift-cli` is blocked for the same reason (`sift-cli` exists). Scoped
names (`@scope/name`) bypass the similarity filter if a rename is ever needed.

#### npm failures we have actually hit

| Symptom | Cause | Fix |
|---|---|---|
| `403 requires two-factor authentication` | npm 2FA | A human must run `npm publish`. Automate only with a granular token that has *bypass 2FA*. |
| `403 too similar to existing package` | typosquat filter | Pick a different or scoped name |
| `npm warn publish "bin[srift]" ... was invalid and removed` | `bin` path had a leading `./` | Use `"bin": {"srift": "dist/index.js"}`. **npm strips it silently** and ships a package with no command. CI now fails on *any* publish warning. |
| Install dies on `node-datachannel` / `utp-native` | `webtorrent` in `dependencies` | Keep it in `optionalDependencies`; the daemon degrades to WebSocket transfer |
| `EBADENGINE` | `engines.node` too high | Must not exclude Node 20/22 LTS |

---

### Release 2 — MCP registry

Namespace **`app.srift/srift`**, verified by a Cloudflare DNS TXT record on
`srift.app`. Listing:
<https://registry.modelcontextprotocol.io/v0/servers?search=srift>

```bash
# 1. Re-authenticate — the JWT expires and yields 401 on publish
PK=$(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')
./mcp-publisher.exe login dns --domain srift.app --private-key "$PK"

# 2. Publish (reads ./server.json)
./mcp-publisher.exe publish
```

`key.pem` is the registry identity and `mcp-publisher.exe` is a 20 MB binary —
both are gitignored. Losing `key.pem` means redoing DNS verification. The TXT
record on `srift.app` must stay in place:

```
v=MCPv1; k=ed25519; p=<base64 ed25519 public key>
```

#### Registry rules that cost us time

- **Versions are immutable.** Re-publishing an existing version returns
  `400 cannot publish duplicate version`. Correcting *anything* in a listing —
  repo URL, description, remotes — requires a **new version**.
- **npm first, registry second.** `server.json` declares
  `packages[].identifier: srift-transfer` at a specific version. Publishing the
  registry entry first makes it advertise a version npm doesn't have, and anyone
  installing from the listing gets a 404.
- **Schema is `2025-12-11` and camelCase** (`registryType`, `websiteUrl`,
  `runtimeArguments`, `environmentVariables`, `isRequired`). An older revision
  used snake_case; mixing them fails validation.
- `description` is capped at **100 characters**.
- `packages[].identifier` must equal the npm package name — there is a test for
  this, because a mismatch makes the listing install something nonexistent.

---

### Release 3 — directories

| Directory | Entry | Notes |
|---|---|---|
| [Smithery](https://smithery.ai/servers/srift/srift) | `srift/srift` | Largest source of MCP installs. Reads `server.json`. Their **badge endpoint currently 500s**, so the READMEs use a shields.io badge linking to the listing. |
| [Glama](https://glama.ai/mcp/servers) | listed | Auto-indexes public repos with MCP metadata |
| [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | PR submitted | One alphabetical line under file-management |
| GitHub topics | 18 set | `topic:mcp-server` is a real discovery path |

---

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and PR:

- **verify** — tsc → lint → build → test → version-drift check
- **package** — builds the CLI, **fails if `npm publish --dry-run` emits any
  warning**, then smoke-tests the packed binary over real MCP stdio and asserts
  15 tools

That second job exists because npm silently stripped the `bin` entry once and
shipped a package with no command. Warnings are now build failures.

### Deployment

Push to `main` → Cloud Build → Cloud Run (`asia-south1`), ~10 minutes.

| | Value |
|---|---|
| Build VM | `E2_HIGHCPU_32` (32 vCPU / 32 GB), 100 GB disk |
| Build heap | 8192 MB (`BUILD_HEAP_MB`) |
| Cloud Run | 4 GiB / 2 CPU, min 1 instance |
| Runtime heap | 3072 MB — deliberately below the container limit so V8 GCs instead of being OOM-killed |
| Bun | pinned via `BUN_VERSION` |

Every `COPY` source in the `Dockerfile` must exist — a deleted `proxy.ts` left in
the COPY list broke every build. A test now walks them.

### Production verification

```bash
curl -s https://srift.app/cli/version.json
curl -s -X POST https://srift.app/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

srift quick-share <absolute-path> --ttl 15m --json
curl -OJ "https://srift.app/d/<token>"
```

On Windows pass **absolute Windows paths** (`C:/...`). Git Bash `/tmp` resolves
to `C:\tmp` and the CLI will not find the file.

### Transport differences

| Transport | Tools | Why |
|---|---|---|
| `srift mcp` (stdio) | **15** | full disk + key access |
| `127.0.0.1:3822/mcp` | **15** | same local daemon |
| `https://srift.app/mcp` | **9** | session control + diagnostics only |

Hosted omits `srift_quick_share`, `srift_send_file`, `srift_accept_transfer`
(need local disk) and `srift_send_chat`, `srift_chat_history`, `srift_read_state`
(would require deriving session keys server-side, defeating the point).
Source of truth: `lib/mcp/backend-inprocess.mjs` → `SUPPORTED_TOOLS`.

### Claim policy

False or unprovable for SRIFT, and **enforced by tests**: `military-grade` ·
`#1` · `files never touch any server` · `untraceable` · `complete anonymity` ·
`trusted by millions` · `zero-knowledge` as a product claim.

Say **zero-retention** and **AES-256-GCM** instead. "Zero-knowledge" is false by
default: `lib/encryption.ts` derives the key from the session ID alone unless an
optional `roomSecret` is supplied, and the server knows the session ID.

---

## 📄 License

MIT License © [SRIFT](https://srift.app)
