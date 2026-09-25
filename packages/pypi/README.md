# srift

[![PyPI version](https://img.shields.io/pypi/v/srift.svg?color=blue)](https://pypi.org/project/srift/)
[![npm version](https://img.shields.io/npm/v/srift-transfer.svg?color=blue)](https://www.npmjs.com/package/srift-transfer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python](https://img.shields.io/badge/python-%3E%3D3.9-brightgreen.svg)](https://www.python.org/)

> **Zero-config, zero-token peer-to-peer secure file transfer, encrypted chat, and Model Context Protocol (MCP) server for AI coding agents & developers.**

Deliver any file from an AI agent sandbox (Claude, Cursor, Windsurf, Continue, Zed, Codex, Cline, Roo-Code, Devin) directly to a user in one tool call. AES-256-GCM end-to-end encryption for sessions and `--encrypt` links. No cloud storage, no account signups, no API keys.

> **Python package.** `pip install srift` gives you the same `srift` command as the npm package
> [`srift-transfer`](https://www.npmjs.com/package/srift-transfer), with no separate Node.js install:
> it runs the official CLI bundle with your system `node` (20+) or a bundled Node.js runtime.
> Details in "How the Python package works" below.

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
> `srift daemon stop`) the link returns `503 sender is offline` for ~15 s, then
> `404` once the link is released. In CI, keep
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
- Agents transfer intermediate state files, memory checkpoints, or embeddings over the encrypted relay: `srift send ./agent_state.bin`

### 🖥️ Headless Server & Cloud Container File Delivery via pip / uvx

In headless cloud environments, Docker containers, Kubernetes pods, and CI/CD pipelines (GitHub Actions, GitLab CI), getting files out to developers typically requires S3 credentials or open SSH ports. With SRIFT, servers can instantly emit public download links:

```bash
# In any CI/CD job, Docker container, or remote GPU server (RunPod, Lambda Labs, EC2):
uvx srift quick-share ./build/app-release.tar.gz --once --ttl 1h --wait
# ↳ https://srift.app/d/9x2m4kp   (blocks until downloaded; the link is served from this job)
```
- **Zero inbound firewall ports required** (connects out over the WebSocket relay on port 443).
- **Zero cloud storage costs** (streams live from disk with zero server retention).
- **Supports auto-expiry** (`--ttl 1h`) and single-use self-destruct (`--once`).

### 🌐 Universal Environment Deployment: npm or Hosted /mcp

SRIFT runs across all server operating systems and deployment targets:
- **Local & Server Environments (Linux, macOS, Windows, Docker, Kubernetes)**:
  Install via PyPI (`pip install srift` or `uvx srift`), npm (`npm install -g srift-transfer`) or standalone binary (`curl -fsSL https://srift.app/install.sh | sh`). Exposes all 15 MCP tools, CLI commands, and local HTTP REST daemon.
- **Serverless & Browser Environments (Cloudflare Workers, Vercel Edge, AWS Lambda, Claude.ai, ChatGPT)**:
  Use the hosted zero-install MCP endpoint: `POST https://srift.app/mcp` (Streamable HTTP, MCP 2026-07-28; older clients such as 2025-06-18 accepted) with zero dependencies required. It exposes 9 session/control tools.


## 🚀 Installation

### From PyPI (Python 3.9+, no Node.js required)
```bash
# Run once with no persistent install (recommended for MCP hosts):
uvx srift mcp

# Or install the `srift` command:
pipx install srift
pip install srift
```

### From npm (Node.js 20+)
```bash
npm install -g srift-transfer
```

### Standalone Binary (no Python or Node.js)
- **macOS / Linux / WSL / Termux (POSIX sh):**
  ```bash
  curl -fsSL https://srift.app/install.sh | sh
  ```
- **Windows PowerShell:**
  ```powershell
  irm https://srift.app/install.ps1 | iex
  ```

### MCP config without a persistent install
```json
{ "mcpServers": { "srift": { "command": "uvx", "args": ["srift", "mcp"] } } }
```
No `uv`? Use `"command": "pipx", "args": ["run", "srift", "mcp"]`. For AgentNet: `"args": ["srift", "agentnet", "mcp"]`.

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
| `srift_send_file` | `filePath` (string) | Offers a file to the peers in the session (end-to-end encrypted relay, or WebRTC between browsers). |
| `srift_accept_transfer` | `fileId` (string), `saveDir?` (string) | Accepts an inbound file offer and streams it to local disk. |
| `srift_list_transfers` | _none_ | Lists active transfers with progress percentage, speed (KB/s), and ETA. |
| `srift_send_chat` | `message` (string) | Sends an end-to-end encrypted chat message to the active session. |
| `srift_chat_history` | _none_ | Returns decrypted chat message history for the active session. |
| `srift_read_state` | _none_ | Returns atomic snapshot of `.srift-state.json` (transfers, session, peers). |
| `srift_net_diagnose` | `fresh?`, `deep?` | Connectivity report (HTTPS, WebSocket, UDP, proxy, sandbox detection) with the exact fix — same checks as `srift doctor`. |

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
srift doctor [--deep] [--json] [--fresh]        # connectivity diagnosis with exact fixes
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

- **Cryptography**: Session transfers and `--encrypt` links are encrypted client-side with **AES-256-GCM** (distinct 12-byte IV per block); plain quick-share links are TLS-only in transit (zero retention). Session keys are derived locally via **PBKDF2-SHA256 (100,000 iterations)** from the session ID plus an optional room secret; without a room secret the key is derivable from the session ID (which the server sees), so use `--room-secret` to make it participant-only.
- **Adaptive Transport Stack**:
  1. **WebRTC**: browser↔browser, files >5 MB.
  2. **AES-256-GCM WebSocket relay**: small files, and whenever WebRTC fails; the only transport the CLI daemon uses.
  3. **WebTorrent**: optional, browser only.
- **Privacy First**: The daemon binds to `127.0.0.1` only. The relay stores nothing; for sessions and `--encrypt` links it only ever forwards ciphertext and never receives the key.

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

- **Node.js**: [`sdk/node`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/node) (`curl -O https://srift.app/sdk/node/srift.mjs` — not on npm yet)
- **Python**: `pip install srift` (includes the CLI) — [`sdk/python`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/python) (`pip install srift` needs Python 3.9+; the single-file `srift.py` works on CPython 3.8+ and PyPy)
- **Go**: [`sdk/go`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/go) (Go 1.21+)
- **Rust**: [`sdk/rust`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/rust) (sync/async)
- **Java**: [`sdk/java`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/java) (Java 11+)
- **C# / .NET**: [`sdk/dotnet`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/dotnet) (.NET 6+)
- **PHP**: [`sdk/php`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/php) (PHP 7.4+)
- **Ruby**: [`sdk/ruby`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/ruby) (Ruby 2.7+)
- **Shell / Bash / PowerShell**: [`sdk/shell`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/shell)

---

## 🐍 How the Python package works

- It is a thin wrapper, not a Python reimplementation: it ships the same JavaScript bundle as the npm package
  (built from the same `cli/index.ts` + `cli/daemon.ts` sources, dependencies inlined) and runs it with your
  system `node` if it is 20 or newer, otherwise with the Node.js runtime from
  [`nodejs-wheel-binaries`](https://pypi.org/project/nodejs-wheel-binaries/).
- argv, stdin, stdout, stderr and the exit code are passed straight through, including the byte-exact
  JSON-RPC stdio stream of `srift mcp` and `srift agentnet mcp`.
- `webtorrent` (an optional large-file accelerator) is not bundled because of its native addons; SRIFT falls
  back to WebSocket-chunked transfer, so behaviour is otherwise identical to npm.
- The same package includes the Python **SDK** (a zero-dependency client for the local daemon's HTTP API):
  `from srift import Srift` — see [`sdk/python`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/python).

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
| PyPI | [`srift`](https://pypi.org/project/srift/) |
| npm | [`srift-transfer`](https://www.npmjs.com/package/srift-transfer) |
| MCP Registry | [`app.srift/srift`](https://registry.modelcontextprotocol.io/v0/servers?search=srift) |
| Smithery | [`srift/srift`](https://smithery.ai/servers/srift/srift) |
| Glama (connector) | [`app.srift/srift`](https://glama.ai/mcp/connectors/app.srift/srift) |
| Glama (server) | [`SRIFT-Open_Source`](https://glama.ai/mcp/servers/srivardhan113/SRIFT-Open_Source) |
| GitHub | [`SRIFT-Open_Source`](https://github.com/srivardhan113/SRIFT-Open_Source) |

All resolve to the same product. `pip install srift` (or `npm i -g srift-transfer`); the command is `srift`.

---

## 📄 License

MIT License © [SRIFT](https://srift.app)

<!-- mcp-name: app.srift/srift -->
