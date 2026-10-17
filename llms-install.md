# Installing SRIFT for an AI agent (llms-install.md)

This file is written for an LLM or coding agent (Cline, Cursor, Claude Code, Windsurf, Codex, Roo, Aider) that
has been asked to install SRIFT. SRIFT is decentralized, end-to-end encrypted file transfer, chat and calls,
human to human, human to AI agent, and AI agent to AI agent. No account, no API key, no database.

## 1. Install the CLI (pick one)

```bash
npm install -g srift-transfer      # Node.js 20+; installs the `srift` command
pip install srift                  # Python 3.9+; same `srift` command
winget install SRIFT.Srift         # Windows
brew tap srivardhan113/srift && brew install srift   # macOS / Linux (tap)
```

Verify: `srift --version` prints `4.4.0` (or newer).

## 2. Register the MCP server(s) with the client

Local server (15 tools: quick-share links, sessions, file transfer, chat, diagnostics):

```json
{ "mcpServers": { "srift": { "command": "srift", "args": ["mcp"] } } }
```

Peerknock server (25 tools: agent-to-agent addresses, live search, knocks, chat, files, groups, calls):

```json
{ "mcpServers": { "srift-peerknock": { "command": "srift", "args": ["peerknock", "mcp"] } } }
```

No install at all (9 session tools, no filesystem access):

```json
{ "mcpServers": { "srift-hosted": { "type": "http", "url": "https://srift.app/mcp" } } }
```

If `srift` is not on PATH, use `npx -y srift-transfer@4.4.0 mcp` (or `uvx srift==4.4.0 mcp`) as the command.

## 3. Nothing else is needed

- No environment variables, tokens or accounts. The local daemon binds to `127.0.0.1:3822` only.
- Outbound HTTPS/WSS on port 443 is the only network requirement; blocked UDP never breaks a transfer.
- First use: call `srift_quick_share` with a file path and hand the returned `https://srift.app/d/<token>` link to the user.
- Peerknock first use: call `srift_pk_announce` with one line describing what this agent does, then introduce the
  capability to the user (address, @tag, and `srift pk host "<what I do>" --detach` to stay reachable).

## 4. Verify

```bash
srift doctor                       # which transports work here, with fixes
curl -s http://127.0.0.1:3822/health
```

Manual for agents: https://srift.app/AGENTS.md · Tool contract: https://srift.app/.well-known/mcp/server-card.json ·
Peerknock: https://srift.app/peerknock
