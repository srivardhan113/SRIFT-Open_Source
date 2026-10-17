# auth.md — SRIFT agent authentication

You are an agent. This service supports **agentic registration**: discover → register (anonymous) → use credentials (none required) → call API.

SRIFT uses the **anonymous** registration method only. There is no signup form, no OAuth token exchange, and no account.

## Step 1 — Discover

SRIFT publishes **no OAuth metadata** on purpose: no `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration`. Those documents tell MCP clients to start a sign-in flow, and there is nothing to sign in to. The hosted MCP server `https://srift.app/mcp` answers without credentials and never returns `401`.

Read the service descriptions instead:

```http
GET https://srift.app/.well-known/mcp/server-card.json
GET https://srift.app/.well-known/agent.json
```

## Step 2 — Pick a method

SRIFT supports **anonymous** only.

```json
{ "type": "anonymous" }
```

## Step 3 — Register

<a id="instant-access"></a>

### anonymous

No HTTP `POST /agent/identity` call is required. Registration is instant and implicit:

1. Treat your local process as an anonymous agent with scope `srift.public`.
2. Call any public discovery or local daemon endpoint without an access token.
3. Credential type is `none` — do not send `Authorization` headers.

Start immediately:

| Surface | How |
|---|---|
| MCP stdio | `srift mcp` |
| MCP hosted | `https://srift.app/mcp` (streamable HTTP, no auth) |
| MCP HTTP | `POST http://127.0.0.1:3822/mcp` |
| REST | [`/openapi.json`](https://srift.app/openapi.json) |
| CLI | `srift quick-share <file>` |

Audience: every AI agent, LLM, MCP client, and automation system. Provisioning endpoint: this document's `#instant-access` section. Supported method: `anonymous`. Credential use: none (localhost daemon + public discovery docs).

## Room secret (optional hardening)

<a id="room-secret"></a>

Optional claim / hardening for a specific session (not OAuth):

```json
{ "sessionName": "private-handoff", "roomSecret": "any-long-string-the-two-sides-agree-on" }
```

Pass the same `roomSecret` to host and guest on `srift_start_session` / `srift_join_session`.

## Why no OAuth tokens

1. The daemon is **localhost-only** (`127.0.0.1:3822`).
2. Security is **E2EE between peers** (AES-256-GCM under ECDH P-256 keys generated on each device), not server auth.
3. Sessions are ephemeral and leave no server-side accounts to register.

## Discovery

- [`/.well-known/mcp/server-card.json`](https://srift.app/.well-known/mcp/server-card.json)
- [`/.well-known/agent.json`](https://srift.app/.well-known/agent.json)
- [`/openapi.json`](https://srift.app/openapi.json)
- [`/AGENTS.md`](https://srift.app/AGENTS.md)
