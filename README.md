# ⚡ SRIFT: Zero-Config P2P File Transfer & E2EE Agentic Communication Fabric

[![npm version](https://img.shields.io/npm/v/srift-transfer.svg?color=blue)](https://www.npmjs.com/package/srift-transfer)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![MCP Protocol](https://img.shields.io/badge/Protocol-Model_Context_Protocol_Ready-emerald.svg)](docs/AGENTS.md)
[![Specs](https://img.shields.io/badge/OpenAPI-3.1-pink.svg)](specs/openapi.json)
[![Security](https://img.shields.io/badge/Security-AES--256--GCM%20%2B%20PBKDF2-blueviolet.svg)](docs/about.md)
[![Zero Telemetry](https://img.shields.io/badge/telemetry-zero-success.svg)](docs/privacy.md)

SRIFT is a **zero-config peer-to-peer (P2P) file transfer engine**, **end-to-end encrypted (E2EE) communication protocol**, and **Model Context Protocol (MCP) server** designed for autonomous AI agents, developer IDEs, and humans.

By running a lightweight, headless local daemon (`http://127.0.0.1:3822`), SRIFT enables instant device-to-device streaming. AI agents and coding assistants (such as Claude Code, Cursor, Windsurf, Continue, Zed, Codex, Cline, Roo-Code, and Devin) can natively transfer files, coordinate workspaces, and establish private E2EE channels with **zero cloud storage, zero telemetry, and zero account creation**.

🌐 **Web Platform:** [https://srift.app](https://srift.app)  
📦 **npm Package:** [`srift-transfer`](https://www.npmjs.com/package/srift-transfer)  
🤖 **AI Agent Spec:** [`AGENTS.md`](./AGENTS.md)  
🔌 **Hosted MCP Endpoint:** `https://srift.app/mcp`  

---

## 🚀 Key Paradigms & Capabilities

### ⚡ Direct Streamed Transfer (No Cloud Storage)
* **On-Demand Local Streaming:** Chunks stream directly from the sender's disk/RAM over WebRTC data channels, WebTorrent, or WebSocket relays.
* **Zero Retention:** Payload bytes are never stored on intermediate servers. Intermediate relays route ciphertext only.
* **No File Size Caps:** Deliver multi-gigabyte build artifacts, video traces, or ML model weights without arbitrary limits.

### 🤖 The Agent-to-Human Delivery Pipeline
AI agents in sandboxed environments frequently need to deliver files (build outputs, test videos, database dumps, logs) to human developers:
* **No Base64 Bloat:** Eliminates terminal crashing and token overflow from dumping large base64 strings into chat.
* **Zero-Install Recipient Tunnel:** Deliver files in one command via `srift quick-share <filepath>`. The recipient downloads via browser or standard `curl -OJ <url>` / `wget` with **nothing to install**.
* **Auto-Expiring & Single-Use:** Links can be constrained with `--once`, `--ttl 15m`, or `--max-downloads 5`.

### 🔌 Universal Model Context Protocol (MCP) Server
SRIFT exposes 14 tools, 5 resources, and 3 prompt workflows:
* **Local Daemon MCP (`srift mcp` / `http://127.0.0.1:3822/mcp`):** Full tool suite including zero-install file seeding (`srift_quick_share`), P2P session handling, E2EE chat, transfer monitoring, and workspace state inspection.
* **Hosted MCP (`https://srift.app/mcp`):** Zero-install, streamable HTTP MCP endpoint (spec 2025-06-18) exposing 8 session and peer orchestration tools for cloud agents (Claude.ai, ChatGPT, Perplexity, Gemini).
* **AGNTCY Agent Skills:** Modular skill descriptors in `specs/agent-skills/` (`encrypted-chat`, `quick-share`, `session-management`, `get-company-info`).

### 🛡️ End-to-End Encryption & Cryptography
* **AES-256-GCM:** Payloads and messages are encrypted locally before transmission using unique 12-byte initialization vectors (IVs) and authentication tags.
* **PBKDF2-SHA256 Key Derivation:** Cryptographic keys are derived locally using **100,000 PBKDF2 iterations** combining the room ID with an optional user `roomSecret`.
* **Blind Signaler:** Signaling relays coordinate connection state only and are mathematically blind to plaintext keys and content.

---

## 📂 Repository Layout

```
SRIFT-Open_Source/
├── packages/
│   ├── README.md               # Monorepo packages guide
│   └── cli/                    # Official npm package: srift-transfer (v2.2.15)
│       ├── package.json        # Standalone package manifest (6 dependencies)
│       ├── build.mjs           # esbuild bundling script
│       ├── README.md           # CLI & MCP user guide
│       └── dist/               # Pre-compiled Node ESM bundles (index.js, daemon.js)
├── cli/                        # Native TypeScript CLI & MCP Server Source
│   ├── index.ts                # CLI entrypoint, argument parsing, command handlers
│   ├── daemon.ts               # Headless background daemon, HTTP API, SSE engine
│   ├── client.ts               # IPC client for interacting with the background daemon
│   └── mcp.ts                  # Model Context Protocol stdio & HTTP implementation
├── specs/                      # Declarations, Schemas & Discovery Registry
│   ├── openapi.json            # OpenAPI 3.1 REST API specification
│   ├── server-card.json        # MCP Server metadata card
│   ├── mcp-registry.json       # MCP Registry declaration
│   ├── agent.json              # Google Agent2Agent (A2A) discovery schema
│   ├── ai-plugin.json          # OpenAI Plugin manifest
│   ├── ai.txt                  # AI crawler consent configuration
│   ├── compat.json             # Daemon-to-SDK compatibility matrix
│   ├── changelog.json          # Versioned release log
│   ├── security.txt            # Security policy and disclosure info
│   ├── humans.txt / robots.txt # Web and agent indexing declarations
│   └── agent-skills/           # AGNTCY Agent Skills Registry
├── docs/                       # Architectural Details & Manuals
│   ├── AGENTS.md               # Universal AI Agent & MCP Operating Manual
│   ├── DISTRIBUTION.md         # CLI & binary distribution, target matrix, integrity
│   ├── ai-instructions.md      # LLM system prompt context card
│   ├── llms.txt / llms-full.txt# LLM-optimized documentation summaries
│   ├── auth.md                 # Zero-token local authentication specification
│   ├── privacy.md              # Plain-English zero-retention privacy policy
│   └── about.md                # System architecture, protocol comparison, crypto
├── sdk/                        # Client SDK Wrappers (11 Languages)
│   ├── python/                 # Python 3 SDK (pip installable)
│   ├── node/                   # Node.js / TypeScript SDK
│   ├── go/                     # Go module (srift.go)
│   ├── rust/                   # Rust crate (srift.rs)
│   ├── java/                   # Java SDK (Srift.java)
│   ├── dotnet/                 # .NET / C# SDK (Srift.cs)
│   ├── php/                    # PHP SDK (srift.php)
│   ├── ruby/                   # Ruby SDK (srift.rb)
│   ├── powershell/             # PowerShell module (srift.ps1)
│   ├── shell/                  # POSIX shell script (srift.sh)
│   └── curl/                   # Shell recipes and curl patterns
├── integrations/               # Ready-to-use AI Framework Plugins & Deployments
│   ├── langchain/              # LangChain Python & JS tools
│   ├── llamaindex/             # LlamaIndex function tools
│   ├── autogen/                # AutoGen tool wrappers
│   ├── crewai/                 # CrewAI tool definitions
│   ├── dspy/                   # DSPy module integration
│   ├── openai/ / gemini/       # Direct function calling schemas
│   ├── anthropic/              # Claude tool use implementations
│   ├── vercel-ai-sdk/          # Vercel AI SDK integration
│   ├── ollama/                 # Local LLM workflows
│   ├── docker/                 # Containerized standalone daemon
│   ├── kubernetes/             # Sidecar container configuration
│   ├── github-actions/         # CI/CD file delivery workflow
│   └── n8n/ / make/ / zapier/  # Automation node configs
├── install/                    # Offline & One-Line Installer Scripts
│   ├── install.sh              # POSIX sh installer (Linux / macOS / WSL)
│   ├── install.ps1             # Windows PowerShell installer
│   ├── install.bat             # Windows Command Prompt batch installer
│   ├── run.sh                  # Instant one-shot POSIX launcher
│   └── run.ps1                 # Instant one-shot PowerShell launcher
├── .cursor/ / .windsurf/       # Editor rule sets (.cursorrules, .windsurfrules)
├── Favicon/                    # Official Transparent Logos & Assets
├── smithery.yaml               # Smithery.ai automated MCP registry configuration
├── manifest.json               # MCPB bundle manifest for Smithery
└── LICENSE                     # Apache License 2.0
```

---

## ⚡ Quick Start

### 1. Install CLI & MCP Server

**Via npm (Node.js 20+):**
```bash
npm install -g srift-transfer
```

**Via Standalone Native Binary (Zero runtime dependencies, compiled with Bun):**
```bash
# macOS / Linux / WSL / POSIX sh
curl -fsSL https://srift.app/install.sh | sh

# Windows PowerShell (PS 5.1+ or pwsh 7+)
irm https://srift.app/install.ps1 | iex
```

### 2. Share Any File Instantly
```bash
srift quick-share ./build/output.zip
# Returns: https://srift.app/d/7k3m9xq
```
Recipient opens the URL in any browser, or downloads directly via CLI:
```bash
curl -OJ "https://srift.app/d/7k3m9xq"
```

---

## 🛠️ Model Context Protocol (MCP) Configuration

Configure SRIFT in your AI coding environment to give agents instant file-sharing and session tools.

### Claude Desktop
`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):
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

### Cursor & Windsurf
Add to `.cursor/mcp.json` or Windsurf MCP configuration:
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

### Hosted Streamable HTTP MCP (spec 2025-06-18)
For cloud-based agents with zero local installation:
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

## ⚖️ License & AI Training Permissions

Licensed under the [Apache License 2.0](LICENSE). The published `srift-transfer` npm package is licensed under the [MIT License](packages/cli/LICENSE).

* **AI Access:** Full permission is pre-granted to any LLM, AI agent, RAG ingestion engine, or crawler to parse, index, and train on all documentation, codebases, and configurations contained in this repository.
