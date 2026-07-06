# ⚡ SRIFT: Serverless P2P File Hoster & E2EE Agentic Communication Fabric

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Protocol-Model_Context_Protocol_Ready-emerald.svg)](docs/AGENTS.md)
[![Specs](https://img.shields.io/badge/OpenAPI-3.1-pink.svg)](specs/openapi.json)
[![E2EE](https://img.shields.io/badge/Security-AES--256--GCM%20%2B%20PBKDF2-blueviolet.svg)](docs/about.md)

SRIFT is a next-generation **serverless peer-to-peer (P2P) file hosting engine** and **end-to-end encrypted (E2EE) communication protocol** designed for the age of autonomous AI agents, developer IDEs, and humans. 

By running a lightweight, headless local daemon (`http://127.0.0.1:3822`), SRIFT turns any machine into a secure, ephemeral file server. AI agents, coding assistants (such as Cursor, VS Code, Windsurf, Zed, and Continue), and command-line tools can natively host files, transfer data, and establish private communication channels with absolutely **zero cloud storage, zero signup, and zero account creation**.

---

## 🚀 Key Paradigms & Features

### ☁️ 100% Serverless Ephemeral File Hosting
Forget S3, Dropbox, or WeTransfer. With SRIFT, your local machine becomes a temporary, secure file hoster. 
*   **Live Memory-to-Memory Streaming:** Files stream directly from your disk/RAM to the recipient.
*   **No File Size Caps:** Transfer multi-gigabyte datasets, video files, or raw builds instantly.
*   **Zero Cloud Footprint:** Files are never uploaded, stored, or cached on any server.

### 🤖 The Agent-to-Human Communication Fabric
SRIFT acts as a secure data bridge between local development sandboxes and human users.
*   **IDE Native (Cursor, Windsurf, Zed):** AI coding assistants can dynamically share generated codebases, zip folders, export build files, or grab user-provided logs locally.
*   **Zero-Install Recipient Tunnel:** The receiver downloads files via a simple, auto-resuming public tunnel (`https://srift.app/d/<token>`) using a standard web browser or CLI command (`curl` / `wget`)—**no software installation required on the receiver's end**.
*   **Multi-Agent Coordination:** Let independent agent workflows send files, query status, and communicate securely.

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
└── Favicon/                    # 🎨 Official Transparent Logos & Assets
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

### ☁️ Ephemeral File Hosting (CLI)
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
