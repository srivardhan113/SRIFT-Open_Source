# session-management

Create, join, monitor, and control SRIFT end-to-end encrypted P2P sessions ("rooms") via the local MCP daemon. Covers the full session lifecycle used for in-session file transfer and encrypted chat.

## Requirements

No special credentials required. The SRIFT local daemon binds to `127.0.0.1:3822` and requires zero authentication.

## Instructions

Available MCP tools (see `/.well-known/mcp/server-card.json` for full schemas):

- `srift_start_session` — open a new E2EE room as host.
- `srift_join_session` — join an existing room by its 7-character session ID.
- `srift_session_status` — read current session, role, connected peers, and pending join requests.
- `srift_approve_join` / `srift_reject_join` — host-only: approve or reject a guest's join request.
- `srift_kick_user` — host-only: disconnect and ban a peer.
- `srift_close_session` — tear down the session and flush all encryption keys.

All session state is ephemeral and in-memory; nothing is persisted server-side. Keys are derived locally via PBKDF2-SHA256 and never leave the client device.
