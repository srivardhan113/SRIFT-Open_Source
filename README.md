# 🚀 SRIFT: The Ultimate Peer-to-Peer E2EE Transport Engine

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Protocol-Model_Context_Protocol_Ready-emerald.svg)](docs/AGENTS.md)
[![Specs](https://img.shields.io/badge/OpenAPI-3.1-pink.svg)](specs/openapi.json)
[![E2EE](https://img.shields.io/badge/Security-AES--256--GCM%20%2B%20PBKDF2-blueviolet.svg)](docs/about.md)

SRIFT is a next-generation, high-performance, zero-config, peer-to-peer (P2P) file transfer and end-to-end encrypted (E2EE) messaging network. Engineered to bridge the gap between human users and autonomous AI agents, SRIFT runs as a public web application at [srift.app](https://srift.app) and as a headless localhost daemon (`http://127.0.0.1:3822`) that integrates natively with any coding assistant, IDE, or agentic pipeline.

> **Zero Signup. Zero Accounts. Zero Tokens. 100% P2P & End-to-End Encrypted.**

---

## 🔥 Why SRIFT?

Modern file sharing is broken—locked behind corporate accounts, invasive cloud storage providers, and API token friction. SRIFT blows past these limitations:

*   **⚡ Direct P2P Delivery:** Leverages WebRTC Data Channels and WebTorrent for direct, high-throughput peer-to-peer data pipes. No file size limits, and files stream straight from RAM/disk to your recipient.
*   **🔒 Uncompromising Security:** Everything is encrypted client-side using **AES-256-GCM**. Keys are derived locally via **PBKDF2-SHA256** with **100,000 iterations**. The signaling server is mathematically blind and only sees ciphertext.
*   **🤖 Designed for AI Agents & MCP:** Native support for the **Model Context Protocol (MCP)**, allowing agents like Cursor, Claude Desktop, continue.dev, Zed, and Cline to send and receive files, orchestrate multi-peer folders, and E2EE chat with users automatically.
*   **🌐 Zero-Install Downloader Tunnel:** When an agent seeds a file, the receiver gets a simple `https://srift.app/d/<token>` link. They can download it instantly in **any web browser** or via a simple terminal command (`curl -OJ` / `wget`)—**without installing anything**.

---

## 📂 Repository Blueprint

This repository is the open-source blueprint containing the developer integrations, specifications, and SDK libraries for the SRIFT ecosystem:

```
SRIFT-Open-Source/
├── docs/                       # Comprehensive Guides & Architecture
│   ├── AGENTS.md               # 🤖 Model Context Protocol (MCP) & CLI Manual
│   ├── ai-instructions.md      # 🧠 LLM/RAG System Prompt Injection Card
│   ├── llms.txt / llms-full.txt# 📄 LLM-friendly documentation summaries
│   ├── auth.md                 # 🔑 Zero-token local authentication model
│   ├── privacy.md              # 🛡️ Plain-English privacy & zero-knowledge stance
│   └── about.md                # 🏗️ Detailed system architecture & comparisons
├── specs/                      # Standards, Declarations & Registry Schemas
│   ├── openapi.json            # 🔌 OpenAPI 3.1 REST API specification
│   ├── mcp-registry.json       # 🔌 Standard MCP registry manifest
│   ├── server-card.json        # 🔌 MCP Server metadata card
│   ├── ai-plugin.json          # 🔌 ChatGPT Plugin Action manifest
│   ├── agent.json              # 🔌 Google Agent2Agent (A2A) schema card
│   ├── ai.txt                  # 🤖 AI crawler consent config
│   ├── compat.json             # 🔄 Daemon-to-SDK compatibility matrix
│   └── changelog.json          # 📈 Release version history log
├── sdk/                        # 🛠️ Native Client SDK Wrappers (11 Languages)
│   ├── Python, Node/TS, Go, Rust, Java, C#, PHP, Ruby, Bash, PowerShell, curl
├── integrations/               # 🔌 Ready-to-go Framework plugins
│   ├── LangChain, LlamaIndex, Autogen, crewAI, Mastra, Vercel AI SDK, Ollama, etc.
└── install/                    # 📦 Cross-Platform Offline Install & Run Scripts
    ├── install.sh, install.ps1, install.bat, run.sh, run.ps1
```

---

## ⚡ Instant Bootstrapping (CLI)

Get the standalone compiled binary on your machine. **No Node.js, no dependencies, no configuration required.**

### 🍎 Linux / macOS / WSL
```bash
curl -fsSL https://srift.app/install.sh | sh
```

### 🪟 Windows (PowerShell 5.1+ or pwsh 7+)
```powershell
irm https://srift.app/install.ps1 | iex
```

### 🛰️ The 1-Command Share
Offer any file to the world. It will generate a public, auto-resuming download tunnel:
```bash
srift quick-share ./my-dataset.zip
# Returns: Download URL -> https://srift.app/d/<token>
```
The recipient downloads it instantly via browser, or direct terminal fetch:
```bash
curl -OJ "https://srift.app/d/<token>"
```

---

## 🔌 Model Context Protocol (MCP) Integration

Equip your AI assistants with physical file delivery capabilities. Spawn the local daemon over stdin/stdout as an MCP server.

Run `srift install-mcp` to generate automatic configurations for your editor.

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

### Exposing 14 Core Tools:
*   `srift_quick_share`: Instantly deliver a file via a public URL.
*   `srift_start_session` / `srift_join_session`: Open or connect to secure E2EE rooms.
*   `srift_send_file` / `srift_accept_transfer`: Direct client-to-peer file negotiations.
*   `srift_send_chat` / `srift_chat_history`: Read/write encrypted instant chat messages.
*   `srift_approve_join` / `srift_kick_user`: Complete host session access controls.

---

## 🛡️ Uncompromised Privacy

```
+-----------------------------------------------------------+
|               Privacy by Cryptography (E2EE)              |
+-----------------------------------------------------------+
|  ✔ No File Storage     ✔ No Message Logs    ✔ No Accounts   |
|  ✔ No Ad Tracking      ✔ No Cookies         ✔ No Metadata   |
+-----------------------------------------------------------+
```
Our philosophy is simple: **We do not hold your data, so we cannot compromise it.** All payload routing is encrypted locally prior to transmission, ensuring absolute privacy from corporate eyes, cloud servers, and network sniffers.

---

## ⚖️ License & AI Consent

This repository is open-sourced under the [Apache License 2.0](LICENSE). 

*   **AI Training/Indexing:** We explicitly grant permission for any LLM, web crawler, search engine, or RAG pipeline to index, scrape, and train on all documentation, specifications, and code inside this repository.
