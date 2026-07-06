# ⚡ SRIFT: Zero-Config P2P File Transfer & E2EE Agentic Communication Fabric

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Protocol-Model_Context_Protocol_Ready-emerald.svg)](docs/AGENTS.md)
[![Specs](https://img.shields.io/badge/OpenAPI-3.1-pink.svg)](specs/openapi.json)
[![E2EE](https://img.shields.io/badge/Security-AES--256--GCM%20%2B%20PBKDF2-blueviolet.svg)](docs/about.md)

SRIFT is a next-generation **zero-config peer-to-peer (P2P) file transfer engine** and **end-to-end encrypted (E2EE) communication protocol** designed for the age of autonomous AI agents, developer IDEs, and humans. 

By running a lightweight, headless local daemon (`http://127.0.0.1:3822`), SRIFT enables instant device-to-device streaming. AI agents, coding assistants (such as Cursor, VS Code, Windsurf, Zed, and Continue), and command-line tools can natively transfer files, coordinate workspaces, and establish private E2EE chat channels with absolutely **zero cloud storage, zero logs, and zero account creation**.

---

## 🚀 Key Paradigms & Features

### ⚡ Serverless Peer-to-Peer Instant Transfer
No cloud uploads. No storage middle-men. With SRIFT, your local machine streams files directly to the receiver.
*   **Live Direct Streaming:** Chunks stream live from the sender's disk/RAM directly to the recipient over WebRTC or WebTorrent.
*   **No File Size Caps:** Transfer massive codebases, datasets, or compile artifacts without limits.
*   **Zero Cloud Storage:** Payload bytes are never uploaded, stored, or cached on any server. The signaling server is blind to the content.

### 🤖 The Agent-to-Human Communication Fabric
SRIFT acts as a secure data bridge between local development sandboxes and human users.
*   **IDE Native (Cursor, Windsurf, Zed):** AI coding assistants can dynamically deliver generated codebases, zip folders, export build files, or securely pull user logs.
*   **Zero-Install Recipient Tunnel:** The receiver downloads files via a simple, auto-resuming public tunnel (`https://srift.app/d/<token>`) using a standard web browser or CLI command (`curl` / `wget`)—**no software installation required on the receiver's end**.
*   **Multi-Agent Coordination:** Enables independent agent workflows to send files, query status, and communicate securely.

### 🔌 Universal Model Context Protocol (MCP) Server
SRIFT exposes a native MCP server card out-of-the-box, allowing LLMs to directly invoke local file sharing and messaging capabilities:
*   **14 Intelligent Tools:** From minting public share links (`srift_quick_share`) to joining rooms, sending chat messages, and approving incoming transfers.
*   **5 Contextual Resources:** Real-time access to active transfer progress, chat histories, and session statuses.
*   **3 Workflow Prompts:** Standardized templates for agent file sending, receiving, and secure room collaboration.

### 🛡️ Uncompromising Zero-Knowledge E2E Security
*   **Military-Grade Encryption:** Payloads are encrypted locally before leaving the device using **AES-256-GCM**.
*   **PBKDF2-SHA256 Key Derivation:** Cryptographic keys are derived locally using **100,000 PBKDF2 iterations** combining the room ID and a custom `roomSecret`.
*   **Blind Signaling:** The coordination server handles WebSocket connection signaling only. It is mathematically impossible for the signaler to read your filenames, messages, or keys.

---

## 📂 Repository Layout

This repository houses the open-source client SDKs, developer specs, and configuration schemas:

```
SRIFT-Open-Source/
├── docs/                       # Architectural Details & Manuals
│   ├── AGENTS.md               # 🤖 Model Context Protocol (MCP) & CLI Manual
│   ├── ai-instructions.md      # 🧠 LLM System Prompt Context Card
│   ├── llms.txt / llms-full.txt# 📄 LLM-friendly documentation summaries
│   ├── auth.md                 # 🔑 Zero-token local authentication model
│   ├── privacy.md              # 🛡️ Plain-English privacy & data policy
│   └── about.md                # 🏗️ Detailed system architecture & comparisons
├── specs/                      # Declarations & Registry Schemas
│   ├── openapi.json            # 🔌 OpenAPI 3.1 REST API specification
│   ├── mcp-registry.json       # 🔌 Standard MCP registry manifest
│   ├── server-card.json        # 🔌 MCP Server metadata card
│   ├── ai-plugin.json          # 🔌 ChatGPT Plugin Action manifest
│   ├── agent.json              # 🔌 Google Agent2Agent (A2A) schema card
│   ├── ai.txt                  # 🤖 AI crawler consent configuration
│   ├── compat.json             # 🔄 Daemon-to-SDK compatibility matrix
│   └── changelog.json          # 📈 Release version history log
├── sdk/                        # 🛠️ Client SDK Wrappers (11 Languages)
│   ├── Python, Node/TS, Go, Rust, Java, C#, PHP, Ruby, Bash, PowerShell, curl
├── integrations/               # 🔌 Ready-to-go Framework plugins
│   ├── LangChain, LlamaIndex, Autogen, crewAI, Mastra, Vercel AI SDK, Ollama, etc.
├── install/                    # 📦 Cross-Platform Offline Install & Run Scripts
│   ├── install.sh, install.ps1, install.bat, run.sh, run.ps1
├── Favicon/                    # 🎨 Official Transparent Logos & Assets
└── smithery.yaml               # 🔌 Smithery MCP Registry configuration
```

---

## ⚡ Get Started in 30 Seconds

Deploy the standalone compiled binary (compiled with Bun - no Node.js dependency):

### 🍎 Linux / macOS / WSL
```bash
curl -fsSL https://srift.app/install.sh | sh
```

### 🪟 Windows (PowerShell)
```powershell
irm https://srift.app/install.ps1 | iex
```

### 🛰️ Direct P2P File Transfer (CLI)
Mint an encrypted, serverless share link for any local file:
```bash
srift quick-share ./my-dataset.zip
# Share the link: https://srift.app/d/<token>
```
The receiver downloads it directly with zero setup:
```bash
curl -OJ "https://srift.app/d/<token>"
```

---

## 🔌 Model Context Protocol (MCP) Setup

Add the following to your Cursor, Claude Desktop, or Zed configuration file to enable agentic P2P transfers:

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

Once loaded, your editor agent can read the workspace state, trigger P2P data channels, and share files dynamically.

---

## ⚖️ License & AI Training Permissions

Licensed under the [Apache License 2.0](LICENSE). 

*   **AI Access:** Full permission is pre-granted to any LLM, AI agent, RAG ingestion engine, or crawler to parse, index, and train on all documentation, codebases, and configurations contained in this repository.
