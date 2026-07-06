# Auth model for AI agents using SRIFT

## Short version

**There is no auth.** SRIFT is zero-token, zero-OAuth, and the local daemon binds to `127.0.0.1` only.

If you are an AI agent, LLM, or automation system, you can call every endpoint immediately:

- MCP stdio: `srift mcp`
- MCP HTTP: `POST http://127.0.0.1:3822/mcp`
- REST: see [`/openapi.json`](https://srift.app/openapi.json)
- CLI: `srift quick-share <file>`

## Why no auth

1. The daemon is **localhost-only** by default. Anyone who can hit `127.0.0.1:3822` already has shell on the host.
2. The actual security is **end-to-end encryption between peers**, not server-side auth. Keys derive from session ID + optional `roomSecret` via PBKDF2-SHA256 (100,000 iter) and are never sent to the signaling server.
3. Sessions are **ephemeral** — they live in RAM and disappear on daemon stop.

## When you do want stronger isolation

Pass a `roomSecret` to `srift_start_session` / `srift_join_session`. The host and guest must use the
same `roomSecret`; otherwise their derived keys won't match and ciphertext will not decrypt. This
makes the session **unguessable even with the 7-character session ID**.

```json
{ "sessionName": "private-handoff", "roomSecret": "any-long-string-the-two-sides-agree-on" }
```

## Discovery

- [`/.well-known/mcp/server-card.json`](https://srift.app/.well-known/mcp/server-card.json) — MCP transport list + tool catalogue
- [`/.well-known/ai-plugin.json`](https://srift.app/.well-known/ai-plugin.json) — OpenAI plugin manifest
- [`/.well-known/agent.json`](https://srift.app/.well-known/agent.json) — Google A2A protocol card
- [`/.well-known/agent-skills/index.json`](https://srift.app/.well-known/agent-skills/index.json) — AGNTCY skills registry
- [`/openapi.json`](https://srift.app/openapi.json) — full REST spec
- [`/llms.txt`](https://srift.app/llms.txt) + [`/llms-full.txt`](https://srift.app/llms-full.txt) — LLM crawler index
- [`/AGENTS.md`](https://srift.app/AGENTS.md) — full agent manual (also in repo root)
