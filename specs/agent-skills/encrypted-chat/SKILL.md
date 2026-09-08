# encrypted-chat

Send and read end-to-end encrypted chat messages within an active SRIFT session, plus manage in-session file transfers, via the local MCP daemon.

## Requirements

An active SRIFT session (see the `session-management` skill to open or join one first). No special credentials required.

## Instructions

Available MCP tools (see `/.well-known/mcp/server-card.json` for full schemas):

- `srift_send_chat` — send an E2EE chat message to peers in the current session.
- `srift_chat_history` — read decrypted chat history for the current session.
- `srift_send_file` — offer a file to peers already inside the session (in-session transfer, distinct from `quick-share`'s standalone link flow).
- `srift_accept_transfer` — accept and download an inbound file offer.
- `srift_list_transfers` — list all active and recent transfers with progress.
- `srift_read_state` — read the raw `.srift-state.json` snapshot for debugging/observability.

All messages and file payloads are encrypted client-side with AES-256-GCM before leaving the device; the daemon never has access to plaintext.
