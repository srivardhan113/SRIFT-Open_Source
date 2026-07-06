#!/usr/bin/env bash
# SRIFT curl recipes — pure curl. Works on any system that has curl.
# Examples assume the daemon is up on the default port 3822.

# ─── 1. Quick share (recommended for AI agents) ─────────────────────────────
curl -X POST http://127.0.0.1:3822/quick-share \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"/abs/path/file.zip"}'
# → { "success": true, "sessionId": "ABC1234", "fileId": "...",
#     "shareUrl": "https://srift.app/join-session?id=ABC1234", "protocol": "websocket", ... }

# ─── 2. Start a session manually ────────────────────────────────────────────
curl -X POST http://127.0.0.1:3822/session/start \
  -H 'Content-Type: application/json' \
  -d '{"sessionName":"my-room","roomSecret":"optional-extra-secret"}'

# ─── 3. Join a session ──────────────────────────────────────────────────────
curl -X POST http://127.0.0.1:3822/session/join \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"ABC1234","username":"my-bot"}'

# ─── 4. Get full status ─────────────────────────────────────────────────────
curl http://127.0.0.1:3822/status | jq .

# ─── 5. Watch live progress via SSE ─────────────────────────────────────────
curl -N -H 'Accept: text/event-stream' http://127.0.0.1:3822/api/v1/monitor/events

# ─── 6. Send a chat message ─────────────────────────────────────────────────
curl -X POST http://127.0.0.1:3822/chat/send \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello over E2EE"}'

# ─── 7. Call MCP over HTTP (no token needed) ────────────────────────────────
curl -X POST http://127.0.0.1:3822/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# ─── 8. Use the MCP tool srift_quick_share ──────────────────────────────────
curl -X POST http://127.0.0.1:3822/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,
    "method":"tools/call",
    "params":{"name":"srift_quick_share","arguments":{"filePath":"/abs/path/file.zip"}}
  }'

# ─── 9. Discovery for any AI runtime ────────────────────────────────────────
curl https://srift.app/.well-known/mcp/server-card.json
curl https://srift.app/.well-known/ai-plugin.json
curl https://srift.app/.well-known/agent.json
curl https://srift.app/openapi.json
curl https://srift.app/AGENTS.md
curl https://srift.app/llms.txt

# ─── 10. Stop daemon ────────────────────────────────────────────────────────
curl -X POST http://127.0.0.1:3822/daemon/stop
