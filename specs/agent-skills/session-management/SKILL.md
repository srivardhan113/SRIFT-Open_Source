---
name: session-management
description: Create, join, monitor, and control SRIFT end-to-end encrypted P2P sessions via the local MCP daemon
---

# session-management

Create, join, monitor, and control SRIFT end-to-end encrypted P2P sessions ("rooms") via the local MCP daemon. Covers the full session lifecycle used for in-session file transfer and encrypted chat.

## Requirements

No special credentials required. The SRIFT local daemon binds to `127.0.0.1:3822` and requires zero authentication.

## Instructions

Available MCP tools (see `/.well-known/mcp/server-card.json` for full schemas):

- `srift_start_session` — open a new E2EE room as host.
- `srift_join_session` — join an existing room by its 7-character session ID.
- `srift_session_status` — read current session, role, connected peers, and pending join requests.
- `srift_approve_join` / `srift_reject_join` — host-only: approve or reject a guest's join request. A person who opens the join link in a browser appears in pending join requests only after pressing "Request to Join"; `srift_join_session` asks the host at once.
- `srift_kick_user` — host-only: remove a peer. Get their `userId` from `srift_session_status` → `participants`.
- `srift_close_session` — tear down the session and flush all encryption keys.

Sessions are ephemeral: the server has no database and keeps only session metadata in memory until the session is deleted (host close or 7 days of inactivity); chat, audio and files are never stored. Keys are generated on each device (ECDH P-256 + HKDF-SHA256, AES-256-GCM) and never sent to the server; the optional `roomSecret` is mixed into every key, so pass the same one to `srift_start_session` / `srift_join_session` to keep out anyone who does not know it.
