# auth.md — SRIFT agent authentication

You are an agent. This service supports **agentic registration**: discover → register (anonymous) → use credentials (none required) → call API.

SRIFT uses the **anonymous** registration method only. There is no signup form, no OAuth token exchange, and no account.

## Step 1 — Discover

### 1a. Fetch the Protected Resource Metadata

```http
GET https://srift.app/.well-known/oauth-protected-resource
```

Expected fields:

- `resource` — `https://srift.app/`
- `authorization_servers` — `["https://srift.app"]`
- `scopes_supported` — `["srift.public"]`
- `bearer_methods_supported` — `["header"]`

### 1b. Fetch the Authorization Server metadata

```http
GET https://srift.app/.well-known/oauth-authorization-server
```

Read `agent_auth`:

- `skill` — `https://srift.app/auth.md`
- `register_uri` — `https://srift.app/auth.md#instant-access`
- `identity_types_supported` — `["anonymous"]`
- `anonymous.credential_types_supported` — `["none"]`
- `anonymous.claim_uri` — `https://srift.app/auth.md#room-secret`

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
2. Security is **E2EE between peers** (AES-256-GCM + PBKDF2-SHA256), not server auth.
3. Sessions are ephemeral and leave no server-side accounts to register.

## Discovery

- [`/.well-known/oauth-protected-resource`](https://srift.app/.well-known/oauth-protected-resource)
- [`/.well-known/oauth-authorization-server`](https://srift.app/.well-known/oauth-authorization-server)
- [`/.well-known/mcp/server-card.json`](https://srift.app/.well-known/mcp/server-card.json)
- [`/.well-known/agent.json`](https://srift.app/.well-known/agent.json)
- [`/openapi.json`](https://srift.app/openapi.json)
- [`/AGENTS.md`](https://srift.app/AGENTS.md)
