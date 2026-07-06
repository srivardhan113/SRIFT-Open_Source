# SRIFT Open Source Assets & Integrations

> The zero-config, zero-token, peer-to-peer file transfer and E2EE chat platform built for both humans and AI agents.

This repository contains the public specifications, client SDKs, framework integrations, installer scripts, and AI-agent discovery models for **SRIFT**.

SRIFT runs as a public web app at [srift.app](https://srift.app) and as a local headless daemon (`http://127.0.0.1:3822`) that AI agents and tools can interact with directly.

---

## 📂 Repository Structure

This repository is organized as follows:

*   📂 **`docs/`**
    *   [`AGENTS.md`](docs/AGENTS.md): The primary developer and AI-agent manual for Model Context Protocol (MCP) and CLI integrations.
    *   [`ai-instructions.md`](docs/ai-instructions.md): System prompt instructions optimized for LLM/RAG injection.
    *   [`llms.txt`](docs/llms.txt) & [`llms-full.txt`](docs/llms-full.txt): LLM-friendly documentation summaries.
    *   [`auth.md`](docs/auth.md): Technical detail on Srift's zero-token, zero-account local auth model.
    *   [`privacy.md`](docs/privacy.md): Core privacy principles, data management policies, and compliance statements.
    *   [`about.md`](docs/about.md): Comprehensive tech stack overview, developer principles, and comparison matrices.
*   📂 **`specs/`**
    *   [`openapi.json`](specs/openapi.json): OpenAPI 3.1 REST API specification for the local daemon.
    *   [`mcp-registry.json`](specs/mcp-registry.json): Ready-to-go MCP registry integration manifest.
    *   [`server-card.json`](specs/server-card.json): Auto-discovery server card detailing tools, resources, and endpoints.
    *   [`ai-plugin.json`](specs/ai-plugin.json): OpenAI Plugin manifest for ChatGPT Actions integration.
    *   [`agent.json`](specs/agent.json): Google Agent2Agent (A2A) schema card.
    *   [`ai.txt`](specs/ai.txt): AI crawler permissions and training consent configurations.
    *   [`compat.json`](specs/compat.json): Version and platform compatibility matrix for the CLI and SDKs.
    *   [`changelog.json`](specs/changelog.json): Version update log history.
*   📂 **`sdk/`**
    *   Contains native client SDK libraries and wrappers to interface with the local daemon:
        *   🐍 **Python** (`srift.py`)
        *   🟢 **Node.js / TS** (`srift.mjs`)
        *   🐹 **Go** (`srift.go`)
        *   🦀 **Rust** (`srift.rs`)
        *   ☕ **Java** (`Srift.java`)
        *   🎯 **C#** (`Srift.cs`)
        *   🐘 **PHP** (`srift.php`)
        *   💎 **Ruby** (`srift.rb`)
        *   🐚 **Bash** & **PowerShell** (`srift.sh`, `srift.ps1`)
*   📂 **`integrations/`**
    *   Ready-to-use boilerplate and configuration guides for popular agent frameworks (LangChain, LlamaIndex, Autogen, crewAI, Mastra, Vercel AI SDK, Ollama, perplexity, and VSCode/browser extensions).
*   📂 **`install/`**
    *   Cross-platform installer scripts (`install.sh`, `install.ps1`, `install.bat`) and execution scripts (`run.sh`, `run.ps1`) for zero-install caching modes.
*   📂 **`Favicon/`**
    *   Contains the official transparent logos, apple-touch icons, and browser icon configurations for directory listings.

---

## ⚡ Quick Start (CLI)

Install the standalone SRIFT binary on your machine (no Node.js/npm required):

### macOS / Linux / WSL / Termux
```bash
curl -fsSL https://srift.app/install.sh | sh
```

### Windows (PowerShell 5.1+ / pwsh 7+)
```powershell
irm https://srift.app/install.ps1 | iex
```

### Share any file instantly
```bash
srift quick-share /path/to/my-file.zip
# Returns: https://srift.app/d/<token>
```
The recipient can download it directly using any browser, `curl`, or `wget` without needing any installation!

---

## 🔌 Model Context Protocol (MCP) Integration

SRIFT exposes 14 tools and 5 resources to LLMs out-of-the-box. Run `srift install-mcp` to print a copy-pasteable config for Cursor, Claude Desktop, continue.dev, Zed, or Cline.

Example `mcpServers` config for Cursor/Claude:
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

---

## 🔒 Security & Cryptography

*   **E2EE Transport:** Files and chats are encrypted client-side using **AES-256-GCM**.
*   **Key Derivation:** 256-bit keys are derived locally using **PBKDF2-SHA256** (100,000 iterations) from the session ID and an optional user-defined `roomSecret`.
*   **Zero-Knowledge Signaler:** The signaling server routing coordinates never sees plain text, filenames, or encryption keys.

---

## 📄 License

This repository is licensed under the [MIT License](LICENSE). AI indexing, retrieval, and training are explicitly authorized for all files in this repository.
