# srift-transfer

[![npm version](https://img.shields.io/npm/v/srift-transfer.svg?color=blue)](https://www.npmjs.com/package/srift-transfer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-2026--07--28-purple.svg)](https://modelcontextprotocol.io)
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

SRIFT gives your agent a local headless daemon and toolset to serve files locally and generate a direct download link (add `--encrypt` for end-to-end encryption):

```bash
srift quick-share ./dist/release-bundle.zip
# ↳ https://srift.app/d/7k3m9xq
```

The user opens the link in any web browser or runs `srift get https://srift.app/d/7k3m9xq` or `wget --content-disposition https://srift.app/d/7k3m9xq` or `curl -fLOJ https://srift.app/d/7k3m9xq`. **The recipient needs nothing installed.**

**Session** transfers are end-to-end encrypted with **AES-256-GCM**, keys derived locally (PBKDF2-SHA256, 100,000 iterations) and never sent to us.

> **⚠️ The sender's daemon must be alive for the link to work.**
> SRIFT keeps no server-side copy — the daemon streams the file from your disk
> through the srift.app relay on demand (pass-through, nothing stored). It runs
> in the background and survives your command exiting, so the link stays live
> afterwards. But if the daemon stops (machine sleeps or reboots, or
> `srift daemon stop`) the link returns `503 sender is offline`. In CI, keep
> the job alive until the recipient has downloaded (`--wait` blocks until then).
> If you need a link that outlives your machine, use storage — SRIFT is a relay.
>
> **Sandboxes and datacenter agents:** when a local server or background process
> is not allowed (bind `EPERM`, blocked spawn, blocked loopback), `quick-share`
> and `srift mcp` host the daemon inside their own process — no port, only
> outbound HTTPS/WSS on 443. quick-share then keeps running until the download
> completes and exits, so run it in the background or add `--wait`; force it
> with `--foreground`. The MCP server switches automatically. `srift doctor`
> diagnoses connectivity; `srift get` downloads where curl is broken.

Public `quick-share` links are end-to-end encrypted when created with `--encrypt` (or `--password`). The key is carried in the URL fragment (`#k=...`), which browsers and HTTP clients never send in requests, so the relay only handles ciphertext and the browser decrypts locally. Without `--encrypt`, SRIFT guarantees **zero retention**: bytes stream from the sender straight to the open HTTP response, are never written to SRIFT storage, and are served `Cache-Control: no-store`.

### 🤖 Autonomous Agent-to-Agent (A2A) Communication & Multi-Agent Swarms

AI agents can communicate directly among themselves without human intervention. In multi-agent systems (CrewAI, AutoGen, LangGraph, OpenAI Swarm):
- Agent 1 initializes a secure room: `srift session start --name "Swarm-Sync"`
- Agent 2 joins the room: `srift session join <sessionId>`
- Agents exchange end-to-end encrypted messages and state updates: `srift chat send "{\"task\":\"analysis_complete\",\"status\":\"ready\"}"`
- Agents transfer intermediate state files, memory checkpoints, or embeddings directly peer-to-peer: `srift send ./agent_state.bin`

### 🖥️ Headless Server & Cloud Container File Delivery via npm / npx

In headless cloud environments, Docker containers, Kubernetes pods, and CI/CD pipelines (GitHub Actions, GitLab CI), getting files out to developers typically requires S3 credentials or open SSH ports. With SRIFT, servers can instantly emit public download links:

```bash
# In any CI/CD job, Docker container, or remote GPU server (RunPod, Lambda Labs, EC2):
npx srift-transfer quick-share ./build/app-release.tar.gz --once --ttl 1h --wait
# ↳ https://srift.app/d/9x2m4kp   (blocks until downloaded; the link is served from this job)
```
- **Zero inbound firewall ports required** (connects via outbound WebSocket relay & WebRTC).
- **Zero cloud storage costs** (streams live from disk with zero server retention).
- **Supports auto-expiry** (`--ttl 1h`) and single-use self-destruct (`--once`).

### 🌐 Universal Environment Deployment: npm or Hosted /mcp

SRIFT runs across all server operating systems and deployment targets:
- **Local & Server Environments (Linux, macOS, Windows, Docker, Kubernetes)**:
  Install via npm (`npm install -g srift-transfer` or `npx`) or standalone binary (`curl -fsSL https://srift.app/install.sh | sh`). Exposes all 15 MCP tools, CLI commands, and local HTTP REST daemon.
- **Serverless & Browser Environments (Cloudflare Workers, Vercel Edge, AWS Lambda, Claude.ai, ChatGPT)**:
  Use the hosted zero-install MCP endpoint: `POST https://srift.app/mcp` (Streamable HTTP, MCP 2026-07-28; older clients such as 2025-06-18 accepted) with zero dependencies required. It exposes 9 session/control tools.


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

#### Cline & Roo Code
Add to `cline_mcp_settings.json` (or Roo Code MCP settings):
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

#### Smithery Registry (One-Click CLI Install)
Install automatically for Claude Desktop or Cursor via Smithery:
```bash
npx -y @smithery/cli install srift/srift --client claude
npx -y @smithery/cli install srift/srift --client cursor
```

#### Glama Registry
Connect using the Glama connector: `app.srift/srift` or add streamable HTTP `https://srift.app/mcp`.


#### Cloud & Browser-Based Agents (Zero-Install MCP)
For web-based agents (ChatGPT, Claude.ai, Gemini, Perplexity) that cannot run local binaries.

> **The hosted endpoint exposes 9 of the 15 tools** — session and peer orchestration only
> (`start_session`, `join_session`, `session_status`, `close_session`, `approve_join`,
> `reject_join`, `kick_user`, `list_transfers`, `net_diagnose`).
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

## 🧰 MCP Tools Reference (15 Tools)

| Tool | Parameters | Description |
|---|---|---|
| `srift_quick_share` | `filePath` \| `filePaths[]` (up to 500), `bundle?` (boolean, default: true), `bundleName?` (string), `exclude?` (string[]), `sessionName?` (string), `maxDownloads?` (number), `ttlMs?` (number), `encrypt?` (boolean), `password?` (string) | **Primary tool.** Returns a public `https://srift.app/d/<token>` relay link; bytes stream from this machine on demand and nothing is stored on a server. `bundle: true` (default) creates one `.tar.gz` link; `bundle: false` creates one link per path (parallel). Returns `{ downloadUrl, fileName, fileSize, ... }` (bundled) or `{ links: [], errors: [] }` (separate). |
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
| `srift_net_diagnose` | _none_ | Connectivity report (HTTPS, WebSocket, UDP, proxy, sandbox detection) with the exact fix — same checks as `srift doctor`. |

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

Full design and security notes: [the AgentNet design](https://github.com/srivardhan113/SRIFT-Open_Source/blob/main/A2A%20Plan.md). Command reference: `srift an help`.

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

# End-to-end encrypt (key in the #k= fragment; --password adds a second factor)
srift quick-share /path/to/secrets.tar --encrypt

# CI, sandboxes, ephemeral agents
srift quick-share ./dist.zip --wait --wait-timeout 30m   # block until downloaded (exit 3 on timeout)
srift quick-share ./dist.zip --keep-alive                # serve until expiry / Ctrl-C
srift quick-share ./dist.zip --foreground                # serve from this process, no background daemon

# Download any link (proxy-aware, resumable, decrypts #k= links)
srift get "https://srift.app/d/<token>" -o ./downloads/

# Manage active links
srift pubshare list                     # list all active public links and counters
srift pubshare revoke <token>           # immediately revoke an active link
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
srift doctor [--json]                           # connectivity diagnosis with exact fixes
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
- **Privacy First**: The daemon binds to `127.0.0.1` only. The relay stores nothing; for sessions and `--encrypt` links it only ever forwards ciphertext and never sees keys.

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

## 📄 License

MIT License © [SRIFT](https://srift.app)
