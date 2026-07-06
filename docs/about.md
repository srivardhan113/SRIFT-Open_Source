# About SRIFT & Technical Architecture

SRIFT is a secure peer-to-peer (P2P) file transfer and encrypted real-time communication platform. It is engineered to enable zero-knowledge, zero-log transactions for both human users and automated AI agents.

---

## 🛠️ Tech Stack & Architecture

Srift is built using a modern, performant, and resilient engineering stack:

*   **Web Portal:** Next.js 16, React 19, TypeScript 5.9, TailwindCSS 3.4.
*   **Signaler Server:** Express 5 unified backend (`server.mjs`) powering WebSocket (`ws`) connections.
*   **Database:** PostgreSQL (used strictly for session coordination and signaling handshake metadata; *never* stores file payloads, message logs, or user credentials).
*   **Transport Layer:** A tiered, auto-selecting protocol system:
    1.  **WebRTC Data Channels:** For direct, ultra-low latency peer-to-peer transfer.
    2.  **WebTorrent:** Utilizing Bittorrent over WebSockets for multi-peer distribution when direct WebRTC connects fail.
    3.  **WebSocket Relay:** Chunked socket relay fallback when symmetric NAT firewalls block direct P2P connections.
*   **Client CLI Daemon:** A standalone, native binary compiled with **Bun** (no external Node.js runtime required). Distributed for 5 primary targets:
    *   Linux (`x64`, `arm64`)
    *   macOS (`x64`, `arm64` - Apple Silicon)
    *   Windows (`x64` - `srift.exe`)

---

## 🔒 Security & Cryptographic Model

Srift operates under a complete zero-knowledge model. The signaling server is mathematically blind to the plaintext content of files, names, and chat logs.

```
+-------------------+                    +-------------------+
|    Sender CLI     |                    |   Receiver CLI    |
| (Local Encrypt)   |                    | (Local Decrypt)   |
+---------+---------+                    +---------+---------+
          |                                        ^
          | (Encrypted Payload)                    | (Encrypted Payload)
          v                                        |
+---------+----------------------------------------+---------+
|                  Signaling & Relay Server                  |
|          (Routes Ciphertext Only - Keys Invisible)         |
+------------------------------------------------------------+
```

### 1. Key Derivation (PBKDF2-SHA256)
A 256-bit symmetric encryption key is derived client-side. The inputs are processed locally and never transmitted:
*   **Base Secret:** The unique 7-character session ID (e.g., `ABC1234`).
*   **User Secret (Optional):** A custom user-defined `roomSecret` for added entropy.
*   **Derivation Function:** **PBKDF2-SHA256** with **100,000 iterations**.

### 2. Encryption (AES-256-GCM)
Every file chunk and chat message is encrypted prior to transport:
*   **Algorithm:** **AES-256-GCM** (Galois/Counter Mode).
*   **Initialization Vector (IV):** A unique, cryptographically secure random 12-byte IV for every block.
*   **Integrity Tag:** Built-in GCM authentication tags prevent tampering, injection, or modification of the ciphertext during transit.

---

## 📊 Feature Comparison Matrix

Compared to other file transfer options, Srift optimizes for privacy, zero configuration, and developer/AI friendliness:

| Feature | **SRIFT** | Magic Wormhole | Wetransfer | IPFS |
| :--- | :---: | :---: | :---: | :---: |
| **P2P Transport** | ✅ (WebRTC/Torrent) | ✅ (TCP/Transit) | ❌ (Cloud) | ✅ (P2P DHT) |
| **E2E Encryption** | ✅ (AES-256-GCM) | ✅ (SPAKE2) | ❌ (Server Encrypted) | Optional / Manual |
| **No Account Req.** | ✅ | ✅ | ❌ | ✅ |
| **No Token/Auth** | ✅ | ✅ | ❌ | ✅ |
| **AI/MCP Friendly** | ✅ (Native MCP) | ❌ | ❌ | ❌ |
| **HTTP Tunnel (d/)** | ✅ (Zero install rcpt) | ❌ | ❌ | ✅ (Public Gateways) |
| **Web UI + CLI** | ✅ | ❌ (CLI Only) | ✅ (Web Only) | ❌ (CLI/Devel Only) |

---

## 🚀 Core Principles

1.  **Local-First Design:** Applications should run locally and run peer-to-peer whenever possible. Cloud components are helpers, not controllers.
2.  **No Friction Bootstrapping:** Software integrations for AI, scripts, and developers should require no signup flow, API keys, or registration tokens.
3.  **Mathematical Trust:** Privacy is enforced by local client-side cryptography, not by corporate privacy promises.
