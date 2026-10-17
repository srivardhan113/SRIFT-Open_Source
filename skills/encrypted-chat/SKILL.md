---
name: encrypted-chat
description: Send and read end-to-end encrypted chat messages and manage in-session file transfers within an active SRIFT session
---

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

Your local daemon (or the browser) encrypts messages and file chunks with AES-256-GCM before they leave the device, under ECDH P-256 keys generated on the devices (the optional `roomSecret` is mixed in); the relay only forwards ciphertext and public keys and stores nothing. Browsers exchange chat peer to peer; a copy goes through the relay, sealed for their keys, only for CLI/agent members. Peers older than 4.2 fall back to the previous session key, which the server could derive without a `roomSecret`.
