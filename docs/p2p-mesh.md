# Session peer mesh (audio + chat)

Browsers in a session talk to each other directly. The server admits members (host approval), makes
first contact, and relays sealed frames only when no peer-to-peer path exists. It holds no audio, no
message content, no chat history and no keys.

Code: `lib/p2p/` — `protocol.ts` (wire format, routing, overlay, audio packets), `crypto.ts` (keys),
`session-mesh.ts` (the node), `audio-frames.ts` (frame fallback codec), `store.ts` (device storage),
`browser-mesh.ts` (one mesh per tab, rendezvous = the session WebSocket). Consumers:
`lib/audio-conference-context.tsx`, `components/dashboard/chat-tab.tsx`, `app/dashboard/page.tsx`.
Server side: the `mesh_relay` case in `server.mjs`. Tests: `tests/p2p/` (real WebRTC data channels via
node-datachannel).

## Transport ladder (per pair of members, best first)

| Rung | Carries | Needs from the network | Blocked by |
|---|---|---|---|
| 1. Direct WebRTC | audio (DTLS-SRTP), chat/signals (data channels) | UDP to the peer (host or STUN srflx candidates) | UDP egress filtering (corporate firewalls, many cloud sandboxes and CI runners, some VPNs); symmetric NAT on **both** ends (carrier-grade NAT, some mobile networks) |
| 1b. TURN | same as 1 | short-lived credentials from `GET /v1/ice` (`lib/server/turn.mjs`: Cloudflare, own coturn, Metered, server-side static `TURN_ICE_SERVERS`; all configured providers in parallel). `NEXT_PUBLIC_TURN_*` exists only for self-hosters without a server-side provider: it is inlined into the browser bundle, so srift.app never sets it; `turns:…:443` passes most firewalls | no provider configured; TLS-inspecting proxies with strict allowlists |
| 2. Through peers | chat, signals, sender keys, **audio as sealed Opus frames** | one member with a link to both ends | nobody in the session reachable by both ends |
| 3. Session socket (`mesh_relay`) | all of the above, sealed | `wss://<host>/` on 443, or plain HTTPS (`/v1/stream/http/*`) when WebSockets never open | domain allowlists that exclude the host, no outbound internet |

Rung 3 is also how members make first contact. A browser that cannot hold the session WebSocket
cannot join a session at all (admission and host approval run over it), same as before this change.
When a WebSocket fails twice in a row (it never opens because a proxy strips `Upgrade`, or it is cut
before the session authenticates), the page and the CLI daemon switch to the HTTPS session stream
(`lib/http-stream-client.ts` ↔ `lib/server/http-stream.mjs`; the CLI reaches it through its proxy-aware
client, `cli/http-stream.ts`): sequence-numbered, acknowledged batches plus a long poll, routed by the
cluster to the session's home and handled by the same server code as a WebSocket. Both try a WebSocket
again every 10 minutes and move back when it holds. Browsers reconnect without an attempt limit (and at
once when the device comes back online); frames emitted while reconnecting are queued (≤ 30 s) and sent
after re-authentication. AgentNet agents have their own poll transport (`SRIFT_AN_TRANSPORT=poll`); the CLI
has embedded mode for sandboxes.

Transfers survive drops: the CLI relay re-sends an unacknowledged chunk after 15 s and right after a
reconnect (receivers de-duplicate and re-acknowledge), and reports failure only after ~10 minutes without
progress; the browser relay re-sends every unacknowledged chunk after 8 s without an ack. A browser WebRTC
file link that goes `disconnected` gets 5 s to recover before the relay takes over (the relay then starts
the file from the beginning; a shared byte-offset assembly for mid-file hand-over is not built yet).
`/d/` downloads that stop flowing for 60 s are closed so the client resumes with a Range request.

Once admitted, a browser keeps its peer links when the WebSocket drops: audio and chat between
directly linked members continue, and the mesh re-announces itself when the socket reconnects.
Server instance moves (cluster hand-off, 1012 close) therefore do not interrupt calls.

The hosted MCP endpoint (`/mcp`, HTTPS POST) and quick-share are unchanged. CLI daemons and MCP agents
do not speak the mesh; browsers send them a chat copy over the socket whenever such a member is present,
so `srift_send_chat` / `srift_chat_history` keep working in both directions. The copy is sealed for the
members' own keys (`pk1`, `lib/e2e-keys.ts`) when every one of them has advertised a key (`e2e_key`,
current CLIs and tabs), in the session-key format otherwise (older clients).

## Topology

- Up to 10 members: full mesh. Two members = one direct connection.
- 11–256 members: members sit on a ring ordered by hashed id and link at offsets ±1, ±2, ±n/4, ±n/2
  (≤ 8 links each, connected, short diameter). Links are symmetric: both ends compute the same answer.
- Presence (`hi`, every 10 s and on change) carries each member's neighbour list, so every node knows
  the overlay graph and routes along shortest paths. Chat is flooded (gossip, dedupe by id, TTL 8).

### Audio at 20+ participants

Each speaker encodes once per direct neighbour (SRTP) and once for everyone else (frames). Frames to
non-neighbours are multicast along the overlay: the speaker sends one copy per first hop, and forwarding
members split the target list, so upload per speaker is bounded by its degree, not by the room size.
Bitrate per stream: 32 kbps (≤ 4), 24 kbps (≤ 10), 16 kbps (more). Muted participants send nothing.

Limits: every listener decodes every unmuted speaker, and forwarding members carry transit audio. On a
typical laptop this is comfortable to ~25 open microphones; beyond that the room needs push-to-talk or
moderated speaking (not implemented). Each overlay hop adds its link's one-way latency on top of an
80 ms jitter buffer.

## Security

- Per device and session (never leave the device; erased when the session ends, the user leaves or is
  removed): ECDSA P-256 identity key, ECDH P-256 agreement key, random AES-256-GCM sender key.
- Pair key = HKDF-SHA256(ECDH, salt = session, info = both ids). Seals signals (SDP and ICE candidates,
  so the relay never sees peer IP addresses from signalling), sender-key hand-offs and history requests.
- Sender key seals chat and audio frames once for all members; handed to each member under its pair key
  and rotated whenever a member leaves. Chat records are also signed by their author, so relaying
  members cannot alter or forge them; senders' keys are pinned per id (trust on first use).
- Direct media is DTLS-SRTP; its fingerprints travel inside pair-sealed signals.
- Presence is signed, bound to the session id and ordered by timestamp (no replay across sessions).
- Admission: only ids on the server's member list (host-approved) are accepted into the mesh; a kicked
  member is dropped and refused, and everyone rotates keys.

What the server can still see or do: who is in a session and when, IP addresses of its WebSocket
clients, sizes and timing of relayed frames. At **first contact** it relays public keys: an actively
malicious server could substitute them (man in the middle). `SessionMesh.safetyCodeFor(peer)` returns a
12-digit code both people can compare out of band to rule that out (not yet shown in the UI).
The chat copy for CLI/agent members and WebSocket-relayed file chunks use participant-only keys
(`pk1` / `pgcm1`, ECDH P-256 + HKDF-SHA256 + AES-256-GCM, `lib/e2e-keys.ts`) whenever the other side has
advertised one; the server forwards only public keys and ciphertext. With older clients they fall back to
the session key derived from the session id (plus the optional room secret), which the server could
derive. As with the mesh, an actively malicious server could substitute public keys at first contact.

## Offline and history

There is no server queue by design. A member receives messages only while online in the session. A
member who joins or reconnects asks a peer for the conversation so far (`rq` → `hist`), so history
survives as long as at least one member who has it is present. It is kept on each device until the
session ends, then erased.
