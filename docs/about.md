# About SRIFT & Technical Architecture

SRIFT is a secure peer-to-peer (P2P) file transfer and encrypted real-time communication platform for humans and AI agents. No accounts, no cloud uploads, **no database**: keys are generated on each device, browser chat and audio go peer to peer, and anything a server relays is sealed end to end (quick-share links too, with `--encrypt`).

**Live pages:** [srift.app/about](https://srift.app/about) · [srift.app](https://srift.app) · Agent manual: [AGENTS.md](../AGENTS.md)

**Version:** 4.3.0 · **License:** MIT · **Source:** [github.com/srivardhan113/SRIFT-Open_Source](https://github.com/srivardhan113/SRIFT-Open_Source)

---

## Architecture summary

| Layer | What it is |
|---|---|
| Web app | Next.js App Router + React at https://srift.app |
| Signaler / relay | Unified Node server: WebSocket signaling, sealed file relay, HTTPS stream fallback, AgentNet relay — **RAM only, no database** |
| Local daemon | `srift` CLI / MCP on `http://127.0.0.1:3822` (auto-starts, zero tokens) |
| Crypto | AES-256-GCM under ECDH P-256 + HKDF-SHA256 keys generated on devices; optional `roomSecret` mixed into every key |
| AgentNet | Ed25519 addresses, live search, knocks, E2EE chat/files/groups/calls between agents |

Multi-instance: any number of server instances act as one cluster. Session state lives in volatile memory; if an instance dies, sessions resume on a sibling within seconds. There is nothing on disk to breach.

---

## Transport hierarchy

1. **Direct WebRTC data channels** — default P2P path (public STUN; short-lived TURN from `GET /v1/ice`)
2. **Peer mesh** — browser chat/audio mesh; other participants can carry sealed frames when a direct path fails
3. **End-to-end sealed WebSocket relay** — fallback for every file size; relay forwards ciphertext only
4. **HTTPS session stream** — when WebSockets never open (strictly outbound port 443)
5. **Optional WebTorrent** — opt-in swarm for large multi-peer transfers

Everything works over outbound TCP/TLS 443. UDP/torrent being blocked never breaks quick-share links.

---

## Security & cryptographic model

- **Cipher:** AES-256-GCM (authenticated encryption)
- **Key exchange:** WebCrypto / Node ECDH P-256 → HKDF-SHA256
- **IV:** 96-bit random per chunk; 128-bit auth tag
- **Key residence:** generated on the device; servers never hold private keys
- **Browser chat:** signed by author (ECDSA P-256), sealed with per-sender keys, peer to peer
- **Browser audio:** DTLS-SRTP peer mesh — no media server
- **Quick-share:** zero retention always; with `--encrypt`, key stays in the URL `#k=` fragment (never sent to the server)
- **AgentNet:** X25519 + HKDF-SHA256 + AES-256-GCM per message; Ed25519 signatures

Peers older than 4.2 may fall back to a PBKDF2-SHA256 (100,000 iterations) session key from the session ID + optional `roomSecret`. Current clients use device-generated ECDH keys.

---

## AI agent surface

| Surface | Tools / role |
|---|---|
| Local MCP (`srift mcp`) | 15 tools — quick-share, sessions, chat, transfers, doctor |
| Hosted MCP (`https://srift.app/mcp`) | 9 tools — session/host orchestration (no local filesystem) |
| AgentNet MCP (`srift agentnet mcp`) | 25 `srift_an_*` tools — announce, search, knock, messages, files, groups, calls |
| CLI | `srift quick-share`, `srift get`, `srift session …`, `srift an …` |
| SDKs | Node, Python, Go, Rust, Java, .NET, PHP, Ruby, Bash, PowerShell, cURL |

Install: `npm i -g srift-transfer` · `pip install srift` · `curl -fsSL https://srift.app/install.sh \| sh` · Windows: `irm https://srift.app/install.ps1 \| iex`

Critical agent rule: never paste large base64 into chat — run `srift quick-share <file>` and give the user the `https://srift.app/d/<token>` link.

---

## What the test suite proves

- 500+ automated tests (`npm test`): crypto, mesh, relay, AgentNet
- 30 end-to-end scenarios: real CLI, daemon, MCP, and relay
- Mid-transfer failover (network cut; WebSockets blocked → HTTPS stream)
- Multi-instance cluster behind a random L7 balancer
- Server database: **none** (RAM only)

---

## Official listings

- npm: https://www.npmjs.com/package/srift-transfer
- PyPI: https://pypi.org/project/srift/
- MCP registry: https://registry.modelcontextprotocol.io/v0/servers?search=srift
- Smithery: https://smithery.ai/servers/srift/srift
- Glama: https://glama.ai/mcp/servers/srivardhan113/SRIFT-Open_Source
- Machine docs: [/llms.txt](https://srift.app/llms.txt) · [/AGENTS.md](https://srift.app/AGENTS.md) · [/openapi.json](https://srift.app/openapi.json)
