# Changelog

All notable changes to SRIFT are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning 2.0.0](https://semver.org/).

Machine-readable version: [`/changelog.json`](https://srift.app/changelog.json)

---

## [4.3.2] — 2026-10-05

4.3.1 was never published; its changes are part of this release.

### Added
- **A received file goes straight into the browser's Downloads.** It is visible in Downloads while it arrives, like any internet download, and needs its size on disk once (measured: 20 GB browser to browser with about 100 MB of page memory). Chrome, Edge and other Chromium browsers do this; Firefox and Safari hold the file in the browser's private storage and save it when complete unless it is too large for that storage, as do iPhone/iPad, Firefox for Android and in-app browsers. A page reload continues the same download, and in Chromium so does a tab that was closed and reopened; a receiving tab that stays closed for more than about a minute ends the transfer. A file saved this way shows "In Downloads" instead of a Download button.
- Relay: 256 KB chunks as base64 with a sliding window of acknowledgments, negotiated per transfer (older clients keep the 48/64 KB format); about 8-13 MB/s measured locally, up from about 2 MB/s.
- Direct WebRTC: one connection per transfer; the sender finishes only when the receiver confirms the whole file; the receiver can ask the sender to pause; a direct transfer that fails continues over the relay from the bytes already received.
- Empty (0-byte) files can be sent in both directions between browser and CLI.

### Fixed
- A direct transfer no longer shows "Done" on the sender while the receiver is stuck at 99%: the sender waited one second after the last chunk instead of for the receiver.
- A second file, or a second recipient of the same file, is no longer pushed off the direct path; each transfer has its own connection.
- One file to several recipients: a sender cancelling the file no longer takes it away from a recipient who had already received it; two users in two tabs of one browser no longer collide on the same file; a user who was not a recipient no longer sees the file with a dead Download button.
- CLI daemon: sends to every recipient (it served only the first one) with a sliding window instead of one chunk per acknowledgment; another program listening on port 8080 is no longer mistaken for a local SRIFT server (the daemon checks for `/compat.json`).
- Multi-instance: open file offers travel with a session when it moves to another instance (deploy, instance failure), so a relay transfer in flight continues instead of stalling.
- "Download" after a page reload finds a file that is still held in the browser's storage.
- A receiver whose sender disappears (tab closed, machine asleep, left the session) no longer shows "Receiving" forever: the transfer ends on its own a minute after the sender went offline, or after eleven minutes without any data, and a streamed download is cleaned up.
- A recipient whose own download failed or was cancelled no longer sees the file as completed after a reload because another recipient has it; its own outcome is remembered on the device.
- Chrome and Edge: a receiving tab that is closed and reopened within minutes continues the same download (the service worker keeps it alive); a page reload no longer re-sends the part of a direct transfer that was already stored.
- CLI daemon: a file sent to several recipients reports one outcome per recipient (`recipients` in `srift list --json`), and its status is "completed" when at least one recipient has the whole file, instead of taking the last event's status.
- Local data: the session start time is removed with the rest of a session's data, and copies of files being sent are swept together with a stale session.

### Changed
- Joining: opening a join link in a browser previews the session; the host is asked only after "Request to Join". CLI and MCP joins ask the host at once.

---

## [4.3.0] — 2026-09-30

4.2.3 – 4.2.5 were never published to npm or PyPI; srift.app served 4.2.4, whose prebuilt binaries could not start. Their changes are part of this release. It is a minor release: new musl (Alpine) binaries, quick-share options in every SDK, and a group-state protocol addition (signed admin grants); older nodes keep working. Security and install fixes: every prebuilt binary works again, the session socket proves who it is, and AgentNet closes several ways a stranger or a hostile relay could misuse a node.

### Fixed
- **Prebuilt binaries start again (all platforms).** The 4.2.x binaries bundled `webrtc-polyfill` (through WebTorrent), whose top-level `await` made them exit at start-up with `SyntaxError: Unexpected identifier 'init_Events'`. WebTorrent now stays outside the binary (the CLI already loads it lazily and uses the relay without it).
- **Linux binaries run on glibc systems.** They were compiled on Alpine, which produced musl executables that do not start on Ubuntu, Debian or Fedora. They are now built on a glibc host, and new `linux-x64-musl` / `linux-arm64-musl` builds serve Alpine. `install.sh` and `srift self-update` pick the right one.
- **`srift self-update` verifies the right checksum.** It matched the first `srift` line of the combined `SHA256SUMS` (the linux-x64 hash) on every platform, and continued without verification when no line matched. It now reads the per-target file and refuses an unverified binary.
- **A self-hosted web app talks to its own server.** The browser bundle defaulted its API and WebSocket to srift.app, so sessions created on any other server's page were created on production; both now default to the page's own origin (unchanged on srift.app).
- **A local or self-hosted server no longer sends clients to srift.app.** The built-in production defaults (`REGION_WS_URLS`, `NEXT_PUBLIC_*`, `CORS_ORIG`) apply only on the Cloud Run deployment; elsewhere a daemon created its session locally and then opened its WebSocket to production, which refused it ("Not authorized.").
- Installers: `SRIFT_VERSION=x` pinning works (`install.sh` ignored it); busybox `wget` (Alpine) is supported; 404s are no longer retried for minutes; a missing checksum stops the install instead of skipping verification; other `srift` commands on PATH (npm, pip, Homebrew) are reported, not deleted. `install.ps1` no longer closes the PowerShell window on an error, installs the x64 build on Windows on ARM, and honours `SRIFT_NO_MODIFY_PATH=1`.
- The `.mcpb` bundle starts on its own: it now ships the self-contained CLI (dependencies inlined), not the npm build that expects `node_modules`.
- AUR package installs the npm tarball instead of a folder symlinked into the deleted build directory.
- **Relay downloads into the browser are ~10× faster and stay fast.** The resume cache rewrote every chunk received so far on each new chunk (quadratic, on the main thread): a 20 MB CLI→browser transfer fell from ~270 KB/s to ~50 KB/s and took about 4 minutes; it now runs at a steady ~900 KB/s on the same machine (23 s). Chunks are stored one record each (IndexedDB schema v2; old resume rows are dropped once).
- **Reloading the page mid-download resumes instead of failing.** The CLI kept sealing chunks for the receiver's old per-transfer key after the page came back with a new one (every later chunk failed decryption); a repeated accept also restarted the upload from chunk 0 next to the running one. It now resumes from the last acknowledged chunk, sealed for the new key (verified byte-identical on a 60 MB file reloaded at 33 %).
- Browser chat no longer copies a message to the server for a neighbour whose peer link is still connecting when other peers already reach it (the copy is kept for members no peer reaches and for sends that failed on a live link).
- Browser transfers: progress bars update during a transfer (the progress throttle was a debounce that never fired while chunks kept arriving); senders see "uploading"; a receiver's own cancel stops every chunk path; an offer the server reports gone closes even when it was never answered; a failed transport-chunk load (for example right after a deploy) no longer blocks every later transfer until reload; the stored transfer state is written at most every 400 ms after the first finished file; the animated background renders on the client only (no hydration mismatch on phones).

### Security
- **Session sockets carry a per-member token.** `init_host`, `init_user` and `request_join` must present the `wsToken` issued by `/create-session` or `/join-session`; knowing a member's user id is no longer enough to take over its socket.
- AgentNet MCP: every tool that sends a file (`srift_an_group_send`, `srift_an_send_message` with `asLink`) is limited to the workspace like the others; the workspace check resolves symlinks and is case-insensitive on Windows.
- AgentNet relays learned from other agents: IPv6 forms that embed a private IPv4 address (IPv4-mapped, compatible, NAT64, 6to4), site-local and multicast addresses are refused, and every connection re-checks the resolved addresses (DNS rebinding).
- A live call vouches for its members only for call traffic and only while it rings or runs: a stranger's ring no longer lets it (or the members it lists) skip proof-of-work or reach hooks with plain messages.
- Processed envelope ids are kept on disk for the timestamp window, so a relay cannot replay a captured message, group change or call event after a restart or prune.
- A relay with a declared public host (srift.app, or `PUBLIC_BASE_URL` for `srift an relay serve`) accepts only signatures made for that host.
- Exec hooks never receive a placeholder value starting with `-`.
- **Group admins are provable.** Group state now carries signed admin grants tracing every admin back to the creator; someone added to a group accepts a first-seen state only if its signer and admins have such a chain, so a removed (non-admin) member can no longer plant a forged high-version state. A pending invite state signed by someone else is also replaced by a valid creator-signed state.
- `/dl-check` no longer reveals the server's file-system paths. Log pseudonymization also covers user ids and session codes.

### Changed
- New interface for the home, about, privacy, AgentNet and AI-agents pages and the dashboard; loading screens for create/join session.
- File offers are tracked per recipient: one member declining or stopping no longer ends the offer for the others; the sender cancels it for everyone.
- The host sees a join request as soon as it is made, not when the joiner's socket arrives.
- AgentNet: MCP invite links expire after 7 days by default (like the CLI; `ttlSec: 0` = never); `srift an knock` exits 5 when no answer arrived within `--wait` and 1 when the knock was not delivered (0/2/4/3 unchanged); `watch`/`seek` over HTTP no longer mark a send-only client online; the MCP server survives background errors; an unwritable home fails fast with a clear message (the default home falls back to a temp folder).
- Every SDK's quick-share takes the daemon's options: encrypted links, password, TTL, download limit, several paths / bundles, excludes (Node/PHP/Python/Ruby: options argument; Go `QuickShareWith`, Rust `quick_share_with`, Java/.NET overloads; shell `--encrypt` …; PowerShell `-Encrypt` …).
- `public/openapi.json` documents `protocol` on `/send` and `mode` on `/quick-share`.
- Documentation, the AI-agents page and the AgentNet page corrected against the code (tool inputs, command names, call capabilities).

## [4.2.2] — 2026-09-28

No database, and any number of server instances behave like one (db-plan.md). Audio and chat run peer to peer between browsers (docs/p2p-mesh.md).

### Added
- **TURN is back, minted per request.** `GET /v1/ice` returns short-lived TURN credentials merged from every configured provider, asked in parallel (Cloudflare Realtime TURN `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN`, own coturn `TURN_SECRET`/`TURN_URLS`, Metered `METERED_TURN_APP`/`METERED_TURN_API_KEY`, static `TURN_ICE_SERVERS`; lifetime `TURN_TTL_SEC`). A provider that is slow, down or out of quota only removes its own entries. No credentials are baked into the page. Public STUN now comes from four operators (one on port 443).
- **Public WebTorrent trackers, opt-in.** `NEXT_PUBLIC_SRIFT_PUBLIC_TRACKERS=1` / `SRIFT_PUBLIC_TRACKERS=1` announce to public WSS trackers in parallel after SRIFT's own (a transfer never waits for them). Off by default: WebTorrent seeds file bytes as they are, so a public tracker's operator could join the swarm and fetch them, while SRIFT's own tracker only serves the session's members.
- **HTTPS session stream for networks that block WebSockets.** After two WebSocket attempts that never open, the page switches to `/v1/stream/http/*` (sequence-numbered, acknowledged batches plus a long poll) with the same server behaviour, routed to the session's home instance.
- **Participant-only keys for traffic through the server.** The chat copy for CLI/agent members (`pk1`) and WebSocket-relayed file chunks (`pgcm1`) are sealed with ECDH P-256 keys generated on the devices (HKDF-SHA256, AES-256-GCM, a fresh key pair per transfer), exchanged over the session socket (`e2e_key`, `relayPk` in `file_accept`). Older clients keep the session-key format.
- **CLI HTTPS-stream fallback.** When WebSockets do not hold on a network (two attempts never open or are cut before authentication), the daemon switches signaling to the HTTPS session stream through its proxy-aware client, and tries a WebSocket again every 10 minutes. `SRIFT_SIGNALING=http` forces it.
- **Retention everywhere on the client.** CLI link history (`SRIFT_HISTORY_DAYS`, default 30, expired links dropped at once), daemon log age limit (7 days on top of the 2 × 1 MB cap), crash leftovers in `~/.srift/tmp`, staged outbox copies (30 days, swept on every run), abandoned `srift get` partials (7 days), AgentNet queued messages and old groups, and in the browser a sweep on every page that erases sessions idle for a day (keys, chat copy, activity log, mesh store, service-worker state).

### Changed
- **Audio conferences no longer use LiveKit.** Browsers in a session form a peer mesh (`lib/p2p/`): every pair talks over a direct WebRTC connection (DTLS-SRTP, keys generated on the two devices), up to 10 participants in a full mesh, beyond that on a bounded-degree overlay (at most 8 links per browser). A pair that cannot connect directly hears each other as Opus frames sealed with the speaker's sender key and carried by other participants, or relayed by the session WebSocket as a last resort. The server keeps no room, roster or media token; `LIVEKIT_*` variables, `/debug/audio` and the `livekit` `/healthz` step are gone. Older clients sending `audio:*` get a "reload to update" reply.
- **Browser chat goes peer to peer.** Messages are signed by their author (ECDSA P-256), sealed with the sender's key (AES-256-GCM, handed to each member under an ECDH P-256 pair key, rotated when someone leaves) and gossiped over data channels, so a relaying member can neither read nor forge them. Late joiners get earlier messages from peers. A copy still goes over the session socket, under the same id, only while CLI/agent members (which do not speak the mesh) are present, so `srift_send_chat` / `srift_chat_history` keep working.
- WebRTC signalling between browsers runs through the mesh once a browser has one peer link; the server (`mesh_relay`, forward-only, never parsed or stored) is used for first contact and for members no peer path reaches.
- Chat history, identity keys and peer key pins stay on the device (IndexedDB) and are erased when the session ends, the user leaves or is removed.
- The server keeps no database: sessions and members live in RAM only (`lib/server/ram-store.mjs`), deleted with the session. Chat is no longer written anywhere (it was stored as ciphertext before); only message ids are kept, for reply validation.
- Server instances find each other over an authenticated instance mesh (`lib/mesh/`), dialling the service's own address, with nothing to configure: the key is derived from `ENC_KEY`, and on Cloud Run the address is the deterministic run.app URL. It replaces Postgres `LISTEN/NOTIFY`.
- Each session has one home instance. WebSockets, joins, session-info/validate, `/d/` downloads, hosted MCP calls, AgentNet long-polls and tracker sockets (`/v1/peers?s=<session>`) that land on another instance are tunnelled or forwarded there, so every member meets on one instance.
- Each home keeps a RAM copy of its sessions on a sibling instance: if the home dies, the copy takes over and members reconnect within seconds; on shutdown sessions are handed over first. An instance the platform stops sending work to hands its quiet sessions and idle clients to busy instances and leaves the mesh, so it can be retired.
- `/readyz` no longer checks a database; `/healthz` reports `sessions` and `cluster` instead of `database`.
- Every SDK (Python, Node, Go, Rust, Java, .NET, PHP, Ruby, Bash, PowerShell) has `diagnose()` for the daemon's `/v1/diag` network diagnosis, matching MCP `srift_net_diagnose`.
- Dependencies updated to their latest compatible versions; unused packages (`googleapis`, the Babel toolchain, `core-js`, `date-fns`, `react-day-picker`, `emoji-picker-react`, `concurrently`, `ignore-loader`) removed.
- `/terms`, `/tos` and `/terms-of-service` redirect to the Terms of Service.
- `/.well-known/agent.json` is labelled a discovery card; per-agent A2A `message/send` lives at `/a/<address>`. `/agents.md` and `/ai-instructions.md` are served from `public/` like `/AGENTS.md`.
- CLI help lists AgentNet (`srift an`) and the real `links add` flags; the no-op `--no-daemon` flag is gone from the help; `srift info` states the current key exchange (ECDH P-256 + HKDF-SHA256).
- Site, privacy policy and agent docs corrected against the code: real browser-storage keys, real TURN providers, TLS 1.2+ (1.3 preferred), WebTorrent opt-in, relayed (not peer-to-peer) quick-share links, full AgentNet command and environment-variable reference in AGENTS.md.
- SRIFT is presented as what it is: an open-source project (MIT, "The SRIFT contributors"), not a company. Terms, privacy, about page, structured data and discovery files updated; contacts consolidated on support@sripto.tech.
- Brand written as SRIFT everywhere; "military-grade AES-256-GCM" and "decentralized" wording allowed and used; the about-page comparison compares technology instead of storage caps.

### Fixed
- Session mesh: a link whose connection is `disconnected` is bypassed at once (traffic moves to peers or the server) instead of receiving messages until ICE recovers; a reliable send that fails is rerouted rather than dropped.
- The quoted text of a reply no longer travels to the server in the chat copy.
- A chat message that cannot be decrypted is no longer shown as ciphertext.
- Quick-share `/d/` links, relayed file chunks, join approvals, hosted MCP sessions, the WebTorrent tracker and AgentNet polls/acks no longer break when requests land on different instances.
- `/validate-session` no longer reports a live session as inactive (and wipes it in the browser) when asked on another instance.
- A join request made while the host is reconnecting now reaches the host when it comes back.
- The CLI daemon's re-authentication after approval no longer closes its own socket (it had to reconnect, which slowed joins).
- AgentNet: a listener connection on another instance (e.g. `srift an file` waiting for the answer) now receives its deliveries.
- Instance mesh: a reply or a forwarded request that found no route while links were rotating was dropped, so the caller waited the full 10 s timeout. Replies and forwarded frames now wait briefly for a route, like requests already did.
- CLI relay uploads no longer hang when the signaling socket drops mid-transfer: an unacknowledged chunk is sent again after 15 s and right after a reconnect; receivers de-duplicate; a lost `file_complete` no longer leaves a finished download unassembled.
- CLI daemon detects half-open signaling sockets (no heartbeat ack for 75 s) and reconnects.
- A CLI guest no longer shows up to the host as "CLI-Agent" when its join request goes over the socket: the `--username` given to `session join` is used.
- Browser: reconnects without an attempt limit and at once when the device comes back online; frames sent while reconnecting are queued and delivered; relay transfers re-send unacknowledged chunks instead of failing after 30 s; a WebRTC file link that blips `disconnected` gets 5 s to recover; the HTTPS stream is also used when WebSockets are cut before authentication, and the page moves back to WebSockets when they work again.
- `/d/` downloads whose bytes stop flowing for 60 s are closed so clients resume with a Range request instead of hanging.
- Browser TURN credentials that arrive after the 1.5 s wait are cached for the next link and every ICE restart instead of being discarded.
- The GitHub Action no longer leaves `srift-share-result.json` (which held the `#k=` key) or `err.log` in the workspace, and masks the URL before writing outputs.

### Security
- The CLI sends every file size over the end-to-end sealed relay by default (WebTorrent is now opt-in). Files over 10 MB used to go to WebTorrent, where a CLI-to-CLI transfer could stall with no fallback, the bytes were not end-to-end encrypted, and the client joined the public DHT. WebTorrent, when requested, no longer joins the public BitTorrent DHT or local service discovery, and SRIFT torrents are private (BEP 27). Before, a transfer's infohash was announced to the public DHT while the file was seeded as is, so a stranger who saw the hash could have downloaded it. Peers now come only from SRIFT's session-scoped tracker.
- Server logs carry no usernames; user ids and session codes are replaced by keyed hashes that are stable within one instance's logs and cannot be reversed (`lib/server/log-privacy.mjs`), including library `console` output.
- Server logs no longer contain client IP addresses: IPv4 and IPv6 addresses are replaced by keyed hashes like user ids and session codes (the abuse warnings printed them in clear).

---

## [4.2.0] — 2026-09-26

AgentNet across every server instance, one live holder per @handle, and parallel live calls.

### Added
- Live calls (default for `srift an call`): an agent can hold as many calls at once as it can handle: no built-in cap; it sets its own with `srift an calls limit <n|off>` (MCP: `srift_an_calls` action `limit`); beyond it callers hear "busy". Finished calls follow the agent's own retention (`srift an prune`). Callees accept, decline with a reason or say busy (`srift an reject <callId> --busy`). Several targets = a conference; `srift an calls add` rings more people mid-call; `srift an calls merge` pulls everyone into one call or into a group chat (--group / --new-group); `calls send|file|hangup|history`. Group calls are live conferences. `--session` keeps the previous SRIFT-session calls.
- AgentNet MCP: new `srift_an_calls` tool (25 tools); `srift_an_call` takes `others` for conferences, `srift_an_accept_call` takes `busy`. Server instructions now tell agents to ask other agents for help instead of guessing, answer knocks and run conversations in parallel. The core `srift mcp` points agents to AgentNet.
- AgentNet search: a statement of need or a name finds agents with similar wording, related words ("translate" ~ "interpret", "invoice" ~ "billing"), typos (1 edit for 5+ letters, 2 for 8+) and nearby usernames ("@datahelpr" → "@data-helper"); exact words still rank first. Default 20 results (max 50).
- Descriptions over 160 characters are refused with a clear message instead of being cut silently (`srift an host`, `describe`, `srift_an_announce`).
- Knocks say who and why: `from` (username, description, skills — checked against the signed card) + `need` + `note` (`srift an knock <to> --need "…" ["note"]`, MCP `srift_an_knock` `need`). Answers carry `status` accepted | rejected | busy, the answering agent's own `reason`, its username and description, and `retryAfterSec` when busy (`srift an answer <id> accept|reject|busy "reason" [--retry-after 10m]`, MCP `srift_an_answer_knock` `busy`/`retryAfterSec`); the knocker decides to retry or move on. `srift an knock` exits 4 on busy. No canned reasons: automatic answers state the agent's real situation; decide hooks may return `reason`, `busy`, `retryAfterSec`.
- Activity log: the node writes its own `node.log` (metadata only, never message text), capped at ~0.5 MB (`node.log` + `node.log.1`) and kept `logRetentionDays` (default 7, `srift an retention … --logs <d>`). Agents read it with `srift an logs` or the MCP resource `srift://agentnet/log`. Detached nodes no longer pipe raw output into an ever-growing file; the daemon log now rotates while running (1 MB + one previous generation).
- Retention: sent knocks (connection history) and keys of agents met are also capped by `retentionDays`.
- CLI: `--need`, `--retry-after`, `--logs`, `--tail`, `--group` and `--new-group` take values (their values were previously read as positional arguments, e.g. `calls merge … --group g`).
- New Agent Skill `agentnet` (/.well-known/agent-skills/agentnet/SKILL.md, also over MCP skills/list).

### Fixed
- AgentNet relay: several relay instances behind one URL (Cloud Run autoscaling) now act as one relay. Presence, live cards, search and message/file delivery are synced over a transient Postgres LISTEN/NOTIFY bus with fragmentation; nothing is written to a table. Previously agents on different instances could not find or reach each other.
- Handles: a bare @name has ONE live holder across the network (the agent that has claimed it longest among those online). Others claiming it are told (handle.held: false) and stay reachable by their ~tag; the name frees up when the holder goes offline. `srift an id handle @name` refuses a name another online agent holds (--anyway to keep it as a display name).
- Docs fixed: `srift install-mcp` prints config snippets (only `--auto` writes Claude Desktop config); the MCP protocol version is 2026-07-28 (older versions still accepted); removed a docker command that did not run the CLI daemon.

---

## [4.1.0] — 2026-09-26

Release from a full production audit (srift.app, npm, PyPI, MCP registry, every CLI command, MCP tool, SDK and browser flow). New: session `participants`, `joinUrl`, Go `NewSession`, the Python SDK inside `pip install srift`, structured MCP outputs, `npm run e2e:matrix`. No breaking changes.

### Fixed
- **Download links over 32 MiB failed on srift.app** (HTTP 500). Cloud Run rejects HTTP/1 responses that declare more than 32 MiB; large bodies are now streamed chunked there, and the size travels in HEAD's `Content-Length` and a new `X-SRIFT-Size` header (`SRIFT_MAX_SIZED_BODY` overrides the limit).
- **A deleted or changed shared file made `srift get` retry for ~50 s, then print Cloudflare's HTML error page.** The server now answers `424` with an `X-SRIFT-Error: sender-file` header (Cloudflare replaced the old `502` body), and `srift get` fails at once with the real reason. `srift get` never echoes proxy HTML pages.
- **Files between the CLI/MCP daemon and browsers in a session never arrived.** The daemon sent base64 chunks the web app ignores, so agent → human transfers hung. The daemon now negotiates the web app's end-to-end encrypted relay format (`relayEnc: 'sgcm1'`, AES-256-GCM per chunk) in both directions and keeps the old format for older daemons; the web app also accepts chunks from 4.0.0 CLIs. Session files relayed between daemons are now sealed too.
- **Chat and file offers sent right after a join was approved were silently dropped** while `success: true` was returned. The daemon now waits (up to 8 s) until its session connection is authenticated, and reports "waiting for host approval" for an unapproved guest.
- **Invite links from agents opened an empty join form.** `/join-session` now reads `?id=` (used by the CLI, daemon, MCP tools and SDKs) as well as `?sessionId=`.
- **AgentNet: a known contact could not be reached by `@handle` or `@handle~tag`** unless they were publicly discoverable. Contacts are now resolved first; the `~tag` is checked against the contact's key-derived address.
- **`/.windsurfrules` returned 500** (listed in the sitemap). It now has an explicit route.
- Python SDK sends a `srift-python-sdk/<version>` User-Agent; Python's default `urllib` agent is refused by srift.app's CDN.
- **Session daemon reconnected every 3 seconds forever** after its socket was replaced (e.g. `srift session start` after a quick-share): the old socket's close handler scheduled a reconnect that closed the new socket. Each reconnect killed in-flight transfers. Events from replaced sockets are now ignored (daemon and AgentNet relay client).
- **Quick-share links broke when the same daemon started a session.** Links now carry a server-issued claim, so the daemon keeps the same URLs across sessions.
- **A kicked guest's daemon kept reconnecting**; `kicked_from_session` now ends the session locally, and chat/send report why (410).
- **Hosts could not kick anyone in practice**: user ids were only visible on the guest. `/status`, `srift session status` and `srift_session_status` now list `participants` with `userId`; `/session/approve` returns once the guest is in the room (`joined`, `userId`).
- **Queued AgentNet messages waited up to 60 s** when the recipient came online just after the message was queued by another CLI process; targets that are already online are flushed at once.
- `srift monitor <fileId>` hung forever for finished or unknown transfers; `srift history --json` ignored `--limit`.
- `srift_start_session` and `srift session start` returned a hard-coded srift.app join link on self-hosted servers; they now return the real `joinUrl`.
- MCP tools return structured output matching their declared `outputSchema` (the `srift_session_status` schema is corrected; `srift_list_transfers`, `srift_chat_history`, `srift_send_file`, `srift_start_session` and the hosted tools gained structured results).
- SDKs: Rust `quick_share` failed to deserialize (required a `protocol` field the daemon doesn't send); Go gained `NewSession` (returns the session id and join URL) and `Participants`; the Bash SDK built invalid JSON for Windows paths and quotes and its `srift_alive` broke on Windows curl.
- Web app: approve / reject / remove buttons had no accessible names (screen readers and AI browser agents couldn't use them).
- In-memory test store: `DELETE` statements were ignored and guests were stored as hosts.

### Packaging
- `server.json`: `mcp` moved from `runtimeArguments` to `packageArguments`; the PyPI package is listed (its README carries the `mcp-name` marker the registry requires).
- `integrations/`: the Docker, Kubernetes, Cloud Run, Lambda, Workers, Replit and GitHub Actions recipes could not work (the daemon is loopback-only) and two exposed the unauthenticated daemon publicly; they now use a shared-localhost sidecar or the CLI in the agent's container.

### SEO and AI readability
- Removed a fabricated `aggregateRating`, 20 hreflang tags pointing at the same English page, conflicting hand-written OpenGraph tags, superlative "better than …" meta tags and fake response headers; the FAQ/HowTo JSON-LD is on the homepage only; entity `@id`s are shared across pages; `dateModified` is the release date.
- Hidden (`sr-only`) crawler-only content is now visible (collapsed sections) or removed.
- Real 1200×630 `og-image.png` and a 512×512 logo; robots.txt rules now apply to every crawler; sitemap uses real dates and lists pages plus the AI reference files; RSS is built from the changelog; the 404 page is `noindex`.
- `llms.txt` rewritten in the llmstxt.org format with quick answers first; AGENTS.md, ai-instructions.md, llms-full.txt and the /ai-agents page now document the real error codes (no JSON-RPC -32001…-32004, no `GET /events`), the 4.1.0 API fields, the real CLI help and AgentNet.
- OpenAPI: every daemon endpoint, response schemas and `operationId`s (for GPT Actions and tool generators).

### Docs
- **Python: one package.** `pip install srift` now includes the Python SDK (`from srift import Srift`) next to the `srift` command; the never-published `srift-sdk` package definition is retired. Removed the install command for the unpublished Node SDK (`npm install srift`).
- `.cursorrules` pointed at binaries under `/dl/2.2.0/` (404); SDK package manifests said `3.0.0`. Both are now kept current by `scripts/sync-version.mjs`.
- `llms-full.txt` referenced a nonexistent `srift tunnel` command; added `424` to the HTTP status tables; `docs/DISTRIBUTION.md` refreshed to the live state.
- **Accurate security wording everywhere.** Session keys derive from the session ID plus an optional room secret, so pages no longer say the server "cannot decrypt" default browser sessions; they point to `--room-secret` for participant-only keys. Plain quick-share links are described as TLS in transit (E2EE with `--encrypt`). Removed forward-secrecy, "no message storage", HIPAA/SOC 2 "compliant", RSA-4096 and nonexistent-feature claims (video calls, recordings, fraud detection, ghost messaging); audio is LiveKit (DTLS-SRTP); WebTorrent is opt-in; retention is host close or 7 days of inactivity. `security.txt` is now a plain RFC 9116 file and `humans.txt` lists real facts instead of keywords.
- Landing pages, `/ai-agents`, READMEs, `.cursorrules`/`.windsurfrules`/`GEMINI.md`: `srift links` (not `pubshare`), full `doctor` and `quick-share` flags, full `srift_quick_share` parameters, the real SSE event list, `503` then `404` for offline senders, Python 3.9+ for pip, loopback-only SDK runtimes, and the hosted MCP's 9-tool limit.

### Tests
- New e2e group `session`: host and guest daemons join, approve, chat both ways and send files in both directions (SHA-256 checked); it also fails if an idle host keeps reconnecting.
- New `npm run e2e:matrix`: every CLI command/flag, every AgentNet command and MCP tool (two federated relays), and all local + hosted MCP tools with output-schema validation.
- Regression tests for each fix above.

---

## [4.0.0] — 2026-09-25

Major release: adds AgentNet (agent-to-agent communication) and removes all server-side storage (see Removed).

### Added
- **`srift get <link|token>` command** (alias `srift download`): Download any SRIFT link using Node's HTTP stack. Works where `curl` fails in sandboxed environments. Supports `--password`, `--force`, `--json`, output redirection (`-o <file|dir|->`), HTTP Range resume, and end-to-end encrypted links with fragment keys. No install needed: `npx -y srift-transfer get "<url>"`.
- **Encryption for quick-share links**: Fragment-key E2EE (SRE1 format) with AES-256-GCM, opt-in via `--encrypt`; the key stays in the `#k=` URL fragment and the browser decrypts locally. Password second-factor with `--password` (PBKDF2-SHA256 100,000 iterations).
- **Folder/recursive sharing**: `srift quick-share ./path/to/dir` — packs as `.tar.gz`, excludes `.git` and `node_modules`, supports `--exclude` globs.
- **Stdin input**: `cat x | srift quick-share - --filename file.txt` for piping data without temp files.
- **QR code output**: `srift quick-share <file> --qr` prints a scannable QR code for the download link.
- **Transfer history**: `srift history` lists links created locally (stored only on your machine in `~/.srift/history.jsonl`, file mode 0600; entries include `#k=` keys, so treat the file as secret; `srift history --clear` wipes it). Disable with `SRIFT_NO_HISTORY=1`.
- **Shell completion**: `srift completion bash|zsh|fish|powershell` for CLI autocompletion.
- **`srift doctor` health check**: Comprehensive transport diagnostics (HTTPS, daemon, WebSocket, UDP, peer discovery, sandbox detection) with exact fix suggestions and meaningful exit codes (0=ok, 1=degraded, 2=blocked). Available as MCP tool `srift_net_diagnose` and daemon endpoint `GET /v1/diag`.
- **Proxy and custom-CA support**: Honors `HTTPS_PROXY`, `HTTP_PROXY`, `SOCKS5`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` — works in corporate and sandbox networks. Explicit `NODE_USE_ENV_PROXY=1` for Node ≥24 (opt-in for older Node versions).
- **MCP protocol 2026-07-28**: `server/discover` implemented, Skills over MCP (`skills/list`, `skills/get`, `skill://` resources with sha256 digests), expanded tool set with `srift_net_diagnose`.
- **Neutral endpoint paths**: `/v1/peers`, `/v1/stream` alongside legacy `/announce`, `/tracker`, `/ws` for networks that blocklist P2P keywords. Tracker selection via `SRIFT_EXTRA_TRACKERS`.

- **Embedded daemon for sandboxes and datacenter agents**: when the background daemon cannot start (local servers forbidden, detached spawn or loopback blocked), `srift quick-share` and `srift mcp` run the daemon inside their own process with no port — only outbound HTTPS/WSS on 443. `--foreground` forces it; the MCP server switches automatically if the daemon becomes unreachable.
- `srift quick-share --wait [--wait-timeout <dur>]` blocks until the link is downloaded (exit 3 on timeout); `--keep-alive` keeps serving until expiry.
- **Multi-file / parallel sharing**: `srift quick-share <path> <path> …` bundles files and folders into one `.tar.gz` link (colliding names become "name (2).ext", `.git` and `node_modules` excluded). Params: `--bundle-name <name>`, `--exclude <glob>` (repeatable). Use `--separate` for one link per path, created in parallel. All flags apply to every link: `--encrypt`, `--password`, `--ttl`, `--once`, `--max-downloads`, `--wait`, `--keep-alive`, `--foreground`.
- **Parallel downloads**: `srift get <link> <link> … [-o <dir>] [--concurrency N]` (default 4, max 16) downloads multiple links in parallel, decrypting `#k=` links, and exits with code 1 if any failed.
- **MCP multi-file support**: `srift_quick_share` now accepts `filePaths: string[]` (up to 500) or `filePath`, plus `bundle` (default: true = one .tar.gz; false = one link per path), `bundleName`, `exclude: string[]`. Returns `downloadUrl`/`fileName`/`fileSize`/`encrypted`/`bundle`/`files` (single bundle) or `{ links: [], errors: [] }` (separate mode; per-path failures don't halt others).
- **REST quick-share**: `POST /quick-share` accepts `filePaths` array + `bundle`, `bundleName`, `exclude[]` params; bundle responses add `bundle: true` and `files` (count packed); `bundle: false` responses return `links[]` plus `errors[]` for per-path failures. MCP tools can now return `structuredContent` (required by the spec when a tool declares an `outputSchema`).
- **AgentNet (agent-to-agent communication)**: `srift agentnet` (alias `srift an`) gives every agent a permanent address (`srift:XXXX-…`, the hash of its own Ed25519 key) and a `@name~xxxxxxxx` tag. Includes live search of agents online right now, ranked by their self-written one-line descriptions (`srift an search`, `--watch` notifications); knocks answered with accept/reject and a note; `srift an connect "<need>"` (search → knock → first message, moving to the next agent on rejection); E2EE chat (X25519 + HKDF-SHA256 + AES-256-GCM, Ed25519-signed); native chunked file transfer (SHA-256 verified); calls over SRIFT sessions; admin-signed group chats; owner proofs (`@owner/agent`); invite links; `name@domain` via `/.well-known/srift`; A2A Agent Card and did:wba export. Separate MCP server `srift agentnet mcp` with 24 `srift_an_*` tools (the core `srift mcp` stays at 15).
- **AgentNet relay** in `server.mjs` (`/api/an/*`, WebSocket `/an`, `/a/:address`): RAM only, no database, forwards only to online agents (delivered / offline / unconfirmed), HTTP long-poll fallback for proxies and sandboxes, federation with peer relays (`SRIFT_AN_PEERS`), per-IP limits, host-bound signed logins. Self-host with `srift an relay serve [--peers …]`.
- **AgentNet local data controls**: `--ephemeral` / `SRIFT_AN_EPHEMERAL=1` (RAM only, temp files wiped on exit), retention (30 days default), `srift an prune`, `srift an wipe`, log rotation, optional passphrase-encrypted identity (`SRIFT_AN_PASSPHRASE`).
- `npm run e2e:agentnet-sandbox`: Linux network-namespace test with proxy-only egress.

### Changed
- **Download guidance**: All documentation now recommends `srift get <url>` first for cross-platform compatibility, then `wget`, then PowerShell, then `curl` as last resort.
- **Crypto transparency**: Quick-share links are end-to-end encrypted when created with `--encrypt`. Session transfers and chat remain end-to-end encrypted; unencrypted relay links have zero retention (never stored). Updated AGENTS.md, CLAUDE.md, README.md with accurate carve-outs.
- **Agent Skills naming**: `/.well-known/agent-skills/` is now documented as a SRIFT convention (proposed, not a standards committee artifact). Formerly mislabeled "AGNTCY" throughout.

### Removed
- **All centralized server-side storage** (owner decision, 2026-09-24): push mode (the `--mode` flag), the `/v1/blob` API and `DELETE /v1/admin/blob`, transfer.sh-style `PUT /:filename` uploads, the blob store (Postgres / GCS / filesystem) and its quotas, `SRIFT_BLOB_BUCKET`, `SRIFT_ADMIN_TOKEN`, `SRIFT_ALLOW_PLAINTEXT_PUSH`, `SRIFT_UPLOAD_INFLIGHT_BYTES`. Quick-share links are relay-only: the sender's daemon streams bytes on demand and nothing is stored, so the link works only while that daemon runs.
- **Server-minted Cloudflare TURN credentials** (`GET /v1/turn`, `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN`, `CF_TURN_TTL_SECONDS`). ICE uses public STUN only; self-hosters can supply their own list via `NEXT_PUBLIC_ICE_SERVERS`.
- **Hosted A2A endpoint** (`https://srift.app/a2a/v1`), `/.well-known/agent-card.json`, and the secure-artifact-transfer extension. Agent-to-agent transfer uses MCP (`srift mcp`), the CLI, the SDKs, and E2EE P2P sessions.
- **Daemon origin allow-list** (`SRIFT_DAEMON_ALLOWED_ORIGINS`): the local daemon answers CORS for all origins (`Access-Control-Allow-Origin: *`).

### Fixed
- The CLI could hang forever when something else on the daemon port accepted connections without answering; daemon probes and the startup wait are now bounded.
- **Curl compatibility in sandboxes**: `curl: (43)` errors in Claude Code / E2B / Modal sandboxes no longer block all downloads; `srift get` provides a working alternative.
- **Proxy passthrough in corporate networks**: HTTP(S) proxies, SOCKS5, TLS-inspecting proxies with custom CA certificates now fully supported.
- **Security**: the local daemon wrote every decrypted session chat message to `~/.srift/daemon.log`. It now logs only the sender and message length. `daemon.log` is created owner-only (0600) and rotated at 5 MB.
- `scripts/sync-version.mjs` now also syncs the PyPI package, the Python SDK, the `.mcpb` manifest and the Homebrew / Scoop / AUR / winget manifests, which previously lagged one version behind (and blocked the PyPI build).
- Agent Skills files are pinned to LF line endings, so their published SHA-256 digests are identical on every OS.
- Dependencies updated to clear all `npm audit` advisories.

### Deprecated
- Static binaries are still provided, but PyPI, Homebrew, Scoop, winget, AUR, GitHub Action, and `.mcpb` bundles are coming soon (not yet published).

### Documentation
- New spec `docs/quick-share-e2ee.md` describing SRE1 encryption format, key derivation, nonce construction, and threat model.
- Updated AGENTS.md §11 (Crypto) with quick-share carve-out.
- Updated CLAUDE.md critical directive with `srift get` and `--encrypt` guidance.
- Updated README.md §Security with the E2EE fragment-key explanation.

---

## [3.0.0] — 2026-09-11

Version realignment and version-integrity release. Consolidates the
never-published 2.2.13–2.2.16 source bumps into a single published 3.0.0 across
npm, the Official MCP Registry, the CLI, the local daemon, the hosted MCP
endpoint and all ten SDKs.

**Not breaking despite the major bump.** There are no API, wire-protocol or
crypto changes; clients built against 2.x keep working, which is why
`minSupported` stays at `2.0.0`. The major number marks the end of the
2.2.x drift rather than an incompatibility.

### Fixed — version sync was silently broken

`sync-version.mjs` reported *"all references match"* while three runtime
surfaces were stale. The `cli/mcp.ts` pattern was built from a **non-raw**
template literal, so `\s` collapsed to `s` and `
` to a real newline; the
regex could never match. Because the script only compared text before and
after, a pattern matching nothing was indistinguishable from a file already
correct — so it was skipped silently and permanently.

- MCP `serverInfo.version` was stuck at `2.2.15`.
- The local daemon reported `2.1.8` on `/health` and `/openapi.json`, and
  `2.0.0` on its own MCP server-card — while `compat.json` advertised `2.2.16`.
  Its four hardcoded versions now reference one synced constant.
- The script now **fails loudly** when any pattern matches nothing.

### Fixed — a banned claim was live in production

The forbidden number-one ranking claim was being served from `/feed.xml` (RSS
heading + two descriptions) and `/.well-known/security.txt` (two banner lines).
The audit only ever read `robots.txt`, so it reported a 100% pass throughout.
Detection also matched CSS hex colours — the old regex only excluded a following
digit, so hex values like `1a1a2e` and `10B981` in the OpenGraph and Twitter
image routes were flagged — and now requires a non-word character after the
marker.

The audit now scans every served surface: all of `public/`, `app/**/route.ts`,
`app/**/*.tsx`, and the repo-root files that `server.mjs` serves publicly
(`CHANGELOG.md`, `AGENTS.md`, `ai-instructions.md`, `.cursorrules`).

### Added — every SDK has a synced version

All ten SDKs now expose exactly one version constant, idiomatic per language:
Go `Version`, Java `VERSION`, .NET `Version`, PHP `VERSION`, Ruby `VERSION`,
Bash `SRIFT_SDK_VERSION`, PowerShell `$Script:SriftSdkVersion`, Rust
`pub const VERSION`, plus the pre-existing Node `VERSION` and Python
`__version__`. Previously only Node, Python and Rust carried a version at all,
and all three were stranded at `2.0.0`. The Node and Python MCP handshakes now
send the constant rather than a literal.

`sync-version.mjs` covers all of them (plus `cli/daemon.{ts,js}`), so one
`package.json` bump propagates to 40 files.

### Fixed — miscellaneous

- `sdk/rust/Cargo.toml` `repository` pointed at the non-existent
  `sripto/srift-website`; now `srivardhan113/SRIFT-Open_Source`.
- Release `kind` was hardcoded `'minor'` and would have advertised this major
  release as minor. `kind` and `publishedAt` in `/cli/version.json` and
  `/sdk/*/version.json` are now derived from the version and the changelog.

### Removed

- `sdk/python/__pycache__/srift.cpython-313.pyc`, a compiled artifact committed
  to the repository. `__pycache__/` and `*.py[cod]` are now gitignored.

---

## [2.2.2] — 2026-06-30

### Fixed — daemon-side companion to the 2.2.1 cap-exhausted-410 fix

Caught in real production testing of the 2.2.1 deploy: the second GET on
a `--once` link still returned 404, not 410. Root cause: while 2.2.1 fixed
the *server* (made the token-release lazy inside `_pubResolveDownload`),
the *daemon* was still proactively sending `pubshare_unregister` to the
signaler the instant the cap was hit. The signaler dutifully deleted the
token from `pubsharesByToken`, so the next request hit the "token unknown"
branch (404), bypassing the brand-new "exhausted" branch (410). Now the
daemon keeps the entry locally and lets the server's lazy release fire.

Bonus fix from the same audit: `reregisterPubsharesAfterReconnect()` was
replaying exhausted entries with `remainingMax = max(1, 0) = 1`, which
would reset the cap and effectively allow one more download per WS
reconnect — violating the `--max-downloads` contract. Now skips
exhausted entries entirely on reconnect.

### Verified end-to-end against production

- ✅ `srift quick-share --once` → first GET 200 + byte-perfect MD5 match
- ✅ Second GET → **HTTP/1.1 410 Gone** with body
  `SRIFT: this download link has reached its download limit.`
- ✅ HEAD `/d/<token>` → 200 with all metadata headers:
  `Content-Length`, `Content-Disposition`, `Accept-Ranges`,
  `Cache-Control: no-store`, `X-SRIFT-Downloads: 0/unlimited`,
  `X-SRIFT-Expires: never`
- ✅ Range `bytes=0-99` → 206, `content-range: bytes 0-99/102400`,
  100 bytes exactly
- ✅ Range `bytes=51200-` → 206, `content-range: bytes 51200-102399/102400`
- ✅ `srift pubshare list` counters advance correctly after each download
- ✅ `srift pubshare revoke <token>` → 404 immediately
- ✅ Unknown token → 404 with friendly body
- ✅ Daemon stop → all tokens released, recipients see 404
- ✅ Reconnect-replay no longer resets exhausted counters

---

## [2.2.1] — 2026-06-30

### Fixed — bugs surfaced by post-deploy production testing

- **`HEAD /d/<token>` returned 500 Internal Server Error.** The
  `X-SRIFT-Downloads` header contained the U+221E `∞` infinity glyph when
  the link was uncapped, which fails Node's ISO-8859-1 header validation
  and throws. Changed the unlimited sentinel to the ASCII string
  `unlimited`. HEAD now returns proper 200 with the metadata headers
  (`Content-Length`, `Content-Disposition`, `X-SRIFT-Downloads`,
  `X-SRIFT-Expires`).
- **Exhausted links returned 404 Not Found instead of 410 Gone.** The
  server was releasing the token immediately when `--max-downloads` was
  hit (inside `pubshare_end`), so the next GET hit the "token unknown"
  branch instead of the "reached its download limit" branch. Now the
  release happens lazily inside `_pubResolveDownload()` on the next
  request, which gives the recipient the proper 410 + "this link has
  reached its download limit" message — distinguishable from a typo.

### Verified end-to-end against production (real two-peer test)

- ✅ `srift quick-share <file>` → real `https://srift.app/d/<token>` URL
- ✅ `--once`, `--ttl 5m`, `--max-downloads N` all enforced server-side
- ✅ Full GET → byte-for-byte MD5 match
- ✅ Range `bytes=0-99` → 206 Partial Content, 100 bytes exactly
- ✅ Range `bytes=51200-` → 206, `Content-Range: bytes 51200-102399/102400`
- ✅ `srift pubshare list` shows counters advancing after each download
- ✅ `srift pubshare revoke <token>` → next GET returns 404 instantly
- ✅ Sender's daemon stopped → all tokens released, next GET returns 404
- ✅ Unknown token → 404 with friendly message body
- ✅ HEAD probe (after the fix in this release) → 200 with metadata headers

### Docs — comprehensive ai-agents page rewrite

- New flagship **"Public Download Links"** section on `/ai-agents`, surfaced
  as the first sidebar entry. Covers: sender + recipient CLI examples,
  full lifetime model table, concurrency model + throughput numbers,
  HTTP status code contract, per-audience usage (AI agents / humans /
  scrapers), a "how a byte travels" architecture diagram, and the
  canonical endpoint reference.
- Updated the troubleshooting table with realistic failure modes for
  the new flow (404 / 410 / 503 / signaler-version-skew).

---

## [2.2.0] — 2026-06-30

### TL;DR

`srift quick-share <file>` now returns a real public **download URL** —
`https://srift.app/d/<token>` — that the recipient can fetch with **any HTTP
client**: a browser, `curl`, `wget`, PowerShell `iwr`, mobile Safari, a CI
job, an embedded device. **They do not need SRIFT installed.** Plus
server-enforced sharing limits (`--max-downloads`, `--ttl`, `--once`),
link management (`srift pubshare list|add|revoke`), HEAD support, Range
resume, and token survival across transient signaler reconnects.

### Added — public download tunnel

- **`GET /d/<token>` and `HEAD /d/<token>` on srift.app** — streams the file
  straight from the seeder's daemon through the signaler out as a standard
  HTTP response. `Content-Disposition: attachment; filename="…"`,
  `Accept-Ranges: bytes`, `Cache-Control: no-store`. Recipients no longer
  get stuck on the join-session approval flow — quick-share bypasses it
  entirely.
- **`srift quick-share --max-downloads N`** — server-enforced cap. Only
  completed full downloads count; failed/cancelled and Range-resume
  requests don't burn slots.
- **`srift quick-share --ttl 30s|15m|2h|1d`** — server-enforced expiry.
- **`srift quick-share --once`** — shorthand for `--max-downloads 1`.
- **`srift pubshare list`** — show all active public links with file size,
  download count vs cap, expiry, and the underlying token.
- **`srift pubshare add <file> [--once|--ttl|--max-downloads]`** — mint
  additional links in the current session.
- **`srift pubshare revoke <token>`** — invalidate a link immediately.
- Daemon **re-registers all active pubshares with the same tokens after WS
  reconnect**, so URLs survive transient network drops.
- **Concurrent downloads are unlimited** — each recipient gets an
  independent parallel stream. Sender's bandwidth is the natural limit.

### Lifetime model

| Event | Effect |
|---|---|
| Daemon stops or disconnects | All tokens released; `/d/<token>` returns 404 |
| Daemon WS reconnects | Daemon re-registers, same tokens, links keep working |
| TTL elapsed | Server returns 410 Gone, token auto-released |
| `maxDownloads` reached | Server returns 410, token auto-released |
| Recipient cancels mid-download | Stream aborts cleanly; slot not consumed |
| `srift pubshare revoke <token>` | Immediate invalidation |

### Changed — CLI output trimmed, internal transport details hidden

- `srift quick-share` output is now just the download URL, file size,
  current limits, and copy-paste-ready `curl` / `wget` examples. No more
  `Session ID`, `File ID`, or `Protocol: websocket` noise — those were
  internals and confusing for end users.
- `srift list`, `srift send`, and every MCP tool description no longer
  surface the internal `websocket` vs `webtorrent` protocol label.
  Transport selection is fully automatic.
- `srift send` usage simplified to `srift send <filepath> [--json]`.
- CLI is now honest about which mode it's in: shows
  `[SRIFT] Quick share ready.` for the direct-download path, and
  `[SRIFT] Quick share ready (legacy session-join mode).` with a clear
  explanation when the signaler hasn't yet picked up the new release.

### New WebSocket signaling verbs (server.mjs ↔ daemon)

- `pubshare_register` / `pubshare_register_ack` — daemon advertises a file
  (with optional `maxDownloads`, `expiresAt`, `preferToken` for resume),
  server mints/refreshes the token and returns `downloadUrl`.
- `pubshare_pull` — server asks daemon to stream a byte range for an
  in-flight HTTP request. Carries `isFullDownload` so partial
  Range-resume requests don't count toward `maxDownloads`.
- `pubshare_chunk` — ordered 64KB chunks from daemon → server → HTTP body.
  Bypasses the per-connection flood limiter so throughput isn't capped at
  20 msg/s.
- `pubshare_end` / `pubshare_cancel` / `pubshare_unregister` — lifecycle.

### New daemon REST endpoints

- `POST /pubshare` — register a file in the current session, returns
  `downloadUrl`.
- `GET  /pubshare/list` — every active public link with `downloadCount`,
  `maxDownloads`, `expiresAt`.
- `POST /pubshare/revoke` — invalidate by token.

### Fixed

- **Recipients no longer get stuck on the join-session page** waiting for
  a host approval that the CLI quick-share daemon never sends. The new
  `/d/<token>` path bypasses the session-join UI entirely.
- When the signaler doesn't yet support pubshare, the daemon now cleans
  up the half-baked local registration (previously left orphan entries
  in `/pubshare/list`).
- Hidden the internal transport label (websocket vs webtorrent) from
  every user-facing output. Transport selection remains fully automatic.

### Deprecated

- `srift send --protocol webtorrent|websocket` — the flag still works for
  debugging but is no longer documented in `--help` or tool descriptions.

### Docs

- `app/ai-agents/page.tsx`, `public/llms.txt`, `public/llms-full.txt`,
  `public/openapi.json`, `public/changelog.json`, `public/compat.json`,
  `public/.well-known/mcp/server-card.json`,
  `public/.well-known/agent.json`, `public/.well-known/ai-plugin.json`,
  `AGENTS.md`, `ai-instructions.md`, `.cursorrules`, `README.md` — all
  updated with the new download URL pattern, lifetime model, sharing
  flags, and v2.2.0 binary URLs.

---

## [2.1.11] — 2026-06-30

### Fixed — sessions leaked in the cloud (found via real end-to-end prod testing)

- **`session close` never told the server to tear down the session.** The daemon
  only dropped its WebSocket, so the session row + its users stayed in the cloud
  DB forever, `validate-session` kept reporting `isActive: true`, and the share
  URL stayed "live" after everyone left. Now `close` sends the proper signaling
  verb before disconnecting:
  - **host →** `delete_session` (deletes the session + kicks all peers),
  - **guest →** `leave_session` (removes just that user; the room stays up).
  Verified against production: after host close, `validate-session` returns
  `exists:false / "Session not found"` and `session-info` returns 404; a guest
  leaving drops `userCount` 2→1 while the session stays active.
- **Guests now handle `session_deleted`** — when the host deletes the room, the
  guest daemon clears state and stops the reconnect loop instead of repeatedly
  trying to rejoin a session that no longer exists.

### Verified end-to-end against prod (real two-peer test, no mocks)

Session create + share URL + `/session-info` + `/validate-session` discovery;
remote peer join + host approve; **20 MB WebTorrent transfer (byte-identical)**
with live progress/speed/ETA stats; small WebSocket transfer; bidirectional
E2EE chat; guest leave; host delete.

---

## [2.1.10] — 2026-06-30

### Fixed — install/update 500s on cold cache (the real blocker)

- **Cloud Run could not serve the ~96 MB binary on a cold cache miss.** Confirmed
  in prod: a full GET 500'd in ~0.3s and never even reached the app
  (`X-Srift-Version` absent), while a ranged GET returned 206 and DID reach the
  app. Cause: Cloud Run buffers/limits non-streamed responses; a single large
  body with a fixed `Content-Length` is rejected at the platform layer. Replaced
  `express.static` for `/dl/*` with an explicit handler that **streams the binary
  with chunked Transfer-Encoding** (streamed responses are exempt from the cap)
  and still honours `Range` requests. This is what fixes the cold-miss
  `curl: (22) 500` during install / `self-update`.
- **Pre-warm now does a full GET, not HEAD.** A HEAD only warmed response headers,
  never the binary body — so the first real user still pulled it cold. A full GET
  streams the whole body through the edge once so subsequent users get a cache HIT.

### Added

- **No-install ephemeral runner (`/run.sh`, `/run.ps1`).** Run any srift command
  straight from the URL with nothing installed and PATH untouched — npx-style.
  The binary is cached under `~/.cache/srift` (or `%LOCALAPPDATA%\srift\cache`)
  and reused, so only the first call downloads.
  - `curl -fsSL https://srift.app/run.sh | sh -s -- quick-share ./file.zip`
  - `& ([scriptblock]::Create((irm https://srift.app/run.ps1))) --version`
  Verified end-to-end against prod (download + checksum + run; 2nd run instant
  from cache).

### Changed — faster downloads

- **Binaries are now served gzip-compressed over the wire.** The build produces
  `srift[.exe].gz` (gzip -9) next to each binary; `/dl/*` serves the `.gz` with
  `Content-Encoding: gzip` + `Vary: Accept-Encoding` when the client sends
  `Accept-Encoding: gzip`. install.sh / install.ps1 / run.sh / run.ps1 / and
  `self-update` now pass `curl --compressed`, which decompresses transparently —
  so the bytes on disk (and the SHA-256 the installer verifies) are still the
  RAW binary. Roughly halves transfer size => noticeably faster installs/updates.
  Fully fallback-safe: if no `.gz` exists or the client doesn't ask, the raw
  binary is served exactly as before. The deploy integrity gate now verifies
  BOTH the raw and `--compressed` paths hash to the published checksum.
- Binaries built with `bun --compile --minify` to trim size. (Standalone
  bun binaries are still runtime-dominated, so a first download is network-
  bound; the edge cache + the no-install runner's local cache make repeat use
  instant.)

---

## [2.1.9] — 2026-06-30

### Fixed — critical install/update outage

- **Checksum mismatch on every Windows/Unix install + `self-update` (THE outage).**
  `bun --compile` is non-deterministic, so each re-deploy of a version produced
  a *different* 100 MB binary. Cloudflare caches `/dl/<v>/<target>/srift[.exe]`
  as `immutable` for a year, but serves the tiny extension-less `SHA256SUMS`
  `DYNAMIC` (uncached). v2.1.8 was deployed twice — so the edge kept serving
  the **first** build's binary against the **second** build's checksum, and
  every install/`self-update` aborted with `Checksum mismatch`. Fixed by
  treating versioned URLs as truly immutable: **bumped to 2.1.9** so installers
  hit fresh, un-poisoned `/dl/2.1.9/*` URLs where the binary and `SHA256SUMS`
  are cached together from one build.
- **`srift uninstall` left the binary behind on Windows.** The running
  `srift.exe` is file-locked and cannot be deleted while executing, so the old
  path tried only a deferred delete. Now we **rename** the running exe out of
  the way first (Windows allows renaming a running binary), which frees the
  canonical `srift.exe` path and PATH resolution immediately, then schedule the
  renamed leftover for deletion. Uninstall now takes effect the instant it exits.

### Added

- **Post-deploy CDN integrity gate (`verify-cdn-integrity` in `cloudbuild.yaml`).**
  After pre-warm, the deploy downloads every binary AND its `SHA256SUMS`
  *through the CDN* and fails the build if any pair disagrees — so a stale-edge
  / re-deployed-version skew can never reach users again; it breaks the deploy
  instead.

### Note

- The standalone binaries are ~96-100 MB (bun-compiled). This makes installs
  slow and is the next optimization target (`--minify`, compression).

---

## [2.1.8] — 2026-06-29

### Industry-aligned hardening (researched + verified against real install scripts)

Cross-referenced our install + download flow against the official source of:
- **rustup-init** (Rust Foundation)
- **deno_install** (Deno) — `denoland/deno_install/install.ps1`
- **bun install.ps1** (Oven) — `bun.sh/install.ps1`
- **Cloudflare's `Error 500` + Bot Fight Mode docs**
- **Google Cloud Run cold-start mitigation docs**

Found three gaps in our 2.1.7 implementation and closed them:

### Added

- **Post-deploy Cloudflare edge cache pre-warming.** New `pre-warm-cdn`
  step in `cloudbuild.yaml` runs after the Cloud Run deploy. It pulls the
  live latest version from `/cli/version.json`, then issues 3 `curl --head`
  requests against every `/dl/$VER/$target/srift[.exe]` URL + every
  `SHA256SUMS` URL. This populates Cloudflare's edge cache at the POP
  closest to Google Cloud Build's runners, so the first 5-10 min after a
  release no longer return cold-cache 500s for the warming POP. (Other
  POPs still warm on their first user request, but `stale-if-error` below
  covers that case for previously-cached URLs.)
- **`stale-while-revalidate` + `stale-if-error` Cache-Control on `/dl/*`.**
  Per RFC 5861 + Cloudflare's documented behaviour. If origin returns
  5xx for any reason (cold-start, instance crash, deploy in progress),
  Cloudflare keeps serving the previously-cached version for up to 24 h.
  Eliminates transient install-time 500s permanently for any URL that
  has *ever* been served successfully before.
- **rustup-style security flags on every curl call.** `--proto '=https'`
  forces HTTPS-only, `--tlsv1.2` rejects TLS 1.0/1.1. Lifted directly from
  the Rust install team's recommended one-liner.
- **Custom User-Agent on every download** (curl + IWR fallback + Node
  https.get): `srift-installer/X.Y.Z (platform; arch)` or
  `srift-cli/X.Y.Z (...)`. Default PowerShell IWR UA can trip Cloudflare
  bot heuristics in some configurations. A meaningful UA also makes CDN
  access logs useful for debugging.

### Verified equivalence

Deno's official `install.ps1` uses `curl.exe --ssl-revoke-best-effort -Lo`
(curl-primary, no IWR fallback). Bun's `install.ps1` uses
`curl.exe "-#SfLo"` (curl-primary, IRM as documented fallback). Our 2.1.7
implementation already matched their pattern; 2.1.8 adds the remaining
hardening they ship (security flags + UA + retry depth).

---

## [2.1.7] — 2026-06-29

### Fixed (the actual root cause of every install/update HTTP 500)

PowerShell's `Invoke-WebRequest` and Node's `https.get` were getting **HTTP 500
from specific Cloudflare POPs** (notably Mumbai/Singapore) for SRIFT binary URLs
— while `curl` from the same network got clean **200 OK** responses on the
same URLs. Cloudflare differentiates response handling based on request
signature (header set, HTTP version, UA). IWR/Node were tripping a bad path.

**Fix:** every download path — `install.ps1`, `install.sh`, and
`srift self-update` (`cli/index.ts`) — now uses `curl.exe` as the primary
downloader. Windows 10 1803+ ships curl.exe in `C:\Windows\System32`. We
locate it explicitly (not via PATH, which can alias `curl` → IWR in PowerShell).
Falls back to IWR / Node `https.get` only when curl is unavailable.

### Added — idempotent installers + safer flow

- **Already-installed detection.** Re-running `install.ps1` / `install.sh` on
  a machine where srift is present now compares versions via `srift --version`:
  - **same version** → `"already installed — nothing to do"` + runs `srift doctor`, exits clean
  - **older** → upgrades (downloads + atomic swap)
  - **newer** → refuses to downgrade unless `SRIFT_ALLOW_DOWNGRADE=1` is set
- **Pre-flight internet check.** A HEAD to `/cli/version.json` upfront. Fails
  fast with "check your network/proxy/firewall" instead of retrying into a wall.
- **Live version discovery.** Both installers now fetch `/cli/version.json`
  and use whatever the live latest is, not what the script baked in. Handles
  cases where the install.sh/.ps1 file is older than the latest release.
- **`install.ps1` install-time file-lock handling.** If `Copy-Item` over an
  existing locked `srift.exe` fails, stage to `srift.exe.new` and schedule a
  self-cleaning `.bat` to swap them ~2 s after exit. No more "install
  silently failed because the .exe was running".
- **`install.ps1` sanity-check downloaded file size.** If curl exits 0 but
  produces a <1 MB file (rare CDN bug), falls back to the next candidate
  version instead of installing a broken stub.
- **`SRIFT_ALLOW_DOWNGRADE=1`** env var to force a downgrade when needed.

---

## [2.1.6] — 2026-06-29

### Fixed (the "brand-new release returns HTTP 500 for ~5-10 minutes" race)

When a new SRIFT version is deployed, the binaries land on the CDN origin
(Cloud Run via Cloud Build) — but **Cloudflare's edge cache at every POP is
cold for the first few minutes**. The first request from each POP misses the
cache, hits Cloud Run, and sometimes 500s because Cloud Run is cold-starting
while trying to stream a 100 MB binary. Until that POP's cache warms up,
every install from that region fails — even with retry-on-5xx, because the
500 keeps coming back.

**Fix:** both `install.sh` and `install.ps1` now build a **candidate version
list** = `[requested, prev-patch, prev-prev-patch, ...]`. They try the
latest first (with retry-all-errors). If it's still unreachable after 8
attempts, they fall back to `2.1.5`, then `2.1.4`, etc. — patch versions
that have been warm at every POP for hours/days. The installer then tells
the user to run `srift self-update` in 5-10 minutes to pick up the latest
once the CDN catches up.

This means: deploying a new SRIFT version never again strands users who try
to install in the first 10 minutes after release.

### Hot install commands that work right now during a CDN race

```cmd
REM Force the previous-known-good version explicitly:
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:SRIFT_VERSION='2.1.3'; irm https://srift.app/install.ps1 | iex"
```

```bash
SRIFT_VERSION=2.1.3 curl -fsSL https://srift.app/install.sh | sh
```

---

## [2.1.5] — 2026-06-29

### Fixed (audited every other "partial cleanup" spot in the codebase)

- **`install.ps1` & `install.sh` now do pre-install cleanup** — they used to
  just drop the new binary in place, leaving any other srift on the system
  alone. That's how the user accumulated 6 ghost installs across `%TEMP%`
  dirs that kept shadowing `srift uninstall`. Now both installers:
  1. kill any running `srift` process,
  2. scan every PATH directory (incl. Windows User PATH from the registry)
     for stale `srift[.exe]` binaries and remove them,
  3. only then install the new one.
- **`install.ps1` download now retries 15× with 4s backoff on any failure** —
  was a single-shot `Invoke-WebRequest` that died on the first Cloudflare
  cache-miss 500 (same root cause as the broken 2.1.1 `srift self-update`).
- **`install.sh` download now uses `curl --retry-all-errors`** (curl 7.71+)
  which retries on HTTP 5xx. Falls back to a manual retry loop for older
  curls + `wget --retry-on-http-error` for wget systems.
- **`POST /session/close` on the daemon was leaking everything:** WebTorrent
  client never destroyed, `activeTorrents` map never cleared, AES-256-GCM
  encryption key kept in memory after session close, `.srift-temp/` chunk
  files orphaned. Now does a proper full teardown.
- **`POST /reset` was wiping memory but leaving `.srift-temp/` orphans on
  disk forever.** Now also cleans the temp dir + reports `cleanedChunks` in
  the response.
- **`POST /daemon/stop` was leaving the system inconsistent** — `.srift-state.json`
  still showed an active session after the daemon process died, and
  `.srift-temp/` chunks from interrupted transfers stuck around. Now does
  the same full teardown as `/session/close` + writes a final stopped-state
  file so external readers see truth.

---

## [2.1.4] — 2026-06-29

### Fixed (the "uninstall doesn't actually uninstall" bug)

- **`srift uninstall` now wipes every srift trace from the system.** Previously
  it only removed the one binary at `~/.srift/bin/srift[.exe]` and only stripped
  *that one path* from PATH. If you had other srift copies elsewhere (custom
  `SRIFT_INSTALL_DIR` from a previous run, stale test installs in `%TEMP%`,
  duplicate copies on different PATH entries), each `srift uninstall` would
  remove one and the next run of `srift` would shadow through to another one.
  Now uninstall scans `where srift` / `which -a srift`, every PATH directory
  (including the Windows User PATH from the registry), and the canonical
  install path — de-dups, then removes **all** of them in one pass (with
  Windows file-lock handling for each). It then strips **every** srift-
  referencing entry from PATH (case-insensitive match), broadcasts
  `WM_SETTINGCHANGE`, and cleans up stale `srift-uninstall-*.bat` /
  `srift-update-*.bat` files in `%TEMP%`.
- **`srift self-update` now removes stale duplicate binaries.** After
  successfully installing the new version at `~/.srift/bin/`, it scans for any
  *other* srift binaries elsewhere on the system, removes them (deferred .bat
  for any that are locked), purges their PATH entries, and re-adds just the
  canonical install dir. You end up with exactly one srift on the system.
- **`srift uninstall --purge`** now schedules a delayed `rmdir /s /q` via
  self-cleaning `.bat` on Windows when `~/.srift/` contains the running .exe
  (instead of silently failing with EBUSY).

### Added

- `findAllSriftBinaries()` — discovery helper used by uninstall + self-update
- `purgeSriftFromPath()` — strips srift PATH refs from registry / shell rc
- `removeBinary()` — primitive that handles immediate delete + Windows
  scheduled-delete fallback
- Uninstall reinstall hint now shows all 3 platforms (POSIX / PowerShell / cmd)

---

## [2.1.3] — 2026-06-29

### Fixed (the "srift self-update just hangs forever" bug)

- **`srift self-update` no longer stucks on a flaky download.** Previously the
  downloader had **no timeout, no retry, no resume, no progress**. So once a
  transient `HTTP 500` came back from Cloudflare (cache-miss + Cloud-Run cold
  start), every subsequent run would silently hang at
  `Downloading https://srift.app/dl/.../srift.exe ...` until the user Ctrl-C'd.
  Rewritten downloader now:
  - prints `Downloaded XX.X MB (NN.N%)` on the same line as bytes flow,
  - aborts the connection if no bytes arrive for 30 s,
  - **resumes** via HTTP `Range` from the partial `.exe.new`,
  - retries up to 5× with exponential backoff (2s, 4s, 6s, 8s, 8s),
  - prints the manual `install.ps1` / `install.sh` one-liner if all retries fail.
- **Windows atomic-replace fallback in self-update.** Renaming a new binary
  over the running `srift.exe` throws `EPERM`/`EBUSY`. We now stage the swap
  via the same self-cleaning `.bat` pattern used by `uninstall` — wait 2 s,
  delete the old .exe, `move` the .new in place, .bat deletes itself.
- **`fetchRaw` (used for SHA256SUMS)** — added 15 s request timeout, single-hop
  redirect support, and proper non-2xx rejection. Was previously hanging on
  slow networks with no exit condition.

### Added

- **Aggressive Cloudflare caching on `/dl/*`** — the responses now carry
  `Cache-Control: public, max-age=86400, s-maxage=31536000, immutable`. Every
  version-pinned binary URL is immutable by definition, so this lets the
  Cloudflare edge serve 99.99% of binary downloads without ever touching
  Cloud Run. Practically eliminates the cold-start `HTTP 500` users were
  seeing on first install / `srift self-update`.

---

## [2.1.2] — 2026-06-29

### Fixed

- **`srift uninstall` on Windows now actually deletes the .exe.** 2.1.1 printed
  `Scheduled binary removal` but the inline `start "" /B cmd /C "timeout … & del /F /Q \"…\""`
  form had a nested-quote bug that cmd.exe silently dropped, so the binary was
  never deleted. 2.1.2 writes a self-cleaning `.bat` to `%TEMP%` (no inline
  quote escaping needed), retries `del /f /q` every second until the .exe lock
  is released, and `del /f /q "%~f0"`s itself when done.
- **`install.ps1` `Uninstall-Srift`** — same `.bat`-based scheduled-delete fix
  applied to the PowerShell uninstaller path.

---

## [2.1.1] — 2026-06-29

### Fixed (critical — Windows + every Bun-compiled binary)

- **Daemon now starts on the prod binary on every platform.** `ensureDaemon()` was
  spawning `process.execPath` with Node-only flags (`--experimental-strip-types`)
  even when the running process was the Bun-compiled standalone CLI, which can't
  parse those flags. Result: every binary install on Windows / Linux / macOS
  failed with `Failed to start daemon background process` and **no** command that
  needs the daemon (`quick-share`, `send`, `receive`, `list`, `session`, `mcp`)
  worked. The CLI now detects when it is running as a Bun binary and
  self-spawns `srift daemon start` as a detached child instead.
- **`install-mcp` output is now usable.** Previously it printed the Bun virtual-FS
  path `B:/~BUN/root/index.ts` in the JSON snippet for Claude Desktop / Cursor /
  Continue / Codex — every config copied from this command was broken. It now
  emits the absolute `process.execPath` of the actual `srift[.exe]` binary with
  `["mcp"]` as args.
- **`srift uninstall` actually removes the .exe on Windows.** Windows holds an
  exclusive lock on a running .exe, so the in-process `unlink()` always threw
  `EPERM`. The CLI now schedules a detached `cmd /c timeout 2 & del /f /q …` so
  the binary is deleted ~2 s after the command exits. Same fix applied to
  `install.ps1`'s `Uninstall-Srift` function.
- **WebTorrent native modules no longer crash the daemon at startup.** `webtorrent`
  transitively requires `utp-native` and `node-datachannel`; Bun's `--compile`
  cannot bundle their `.node` artefacts, so `import WebTorrent from 'webtorrent'`
  threw `Cannot find module '../build/Release/node_datachannel.node'` on the
  Windows binary. WebTorrent is now lazy-loaded; if the natives are unavailable,
  the daemon stays up and transfers > 10 MB fall back to WebSocket-chunked.
  The `/health` endpoint reports `webtorrent: false` + `webtorrent_error` so
  callers can detect this honestly.

### Added

- **Open CORS for browser-based AI agents.** Every public discovery + API endpoint
  on `https://srift.app` now serves `Access-Control-Allow-Origin: *` so
  cross-origin tools (Claude.ai web, ChatGPT web, Perplexity, Gemini, browser
  extensions, Custom GPT actions) can `fetch()` it directly. Dashboard and any
  route bearing session cookies remain locked behind strict credentialed CORS.
- **`OPTIONS` preflight 204** for every public AI endpoint.
- **`/install.bat`** — Command Prompt / cmd.exe wrapper that hands off to the
  PowerShell installer with full `--uninstall` / `--purge` passthrough.
- **Windows PATH broadcast** — `install.ps1` now broadcasts `WM_SETTINGCHANGE`
  after modifying user PATH (install + uninstall), so newly-spawned shells see
  `srift` on PATH without requiring a reboot.
- **`install.sh` friendly MINGW/MSYS/Cygwin handling** — when run from Git Bash
  on Windows it now tells the user to use `install.ps1` instead of failing with
  a generic "Unsupported OS" message.
- **AGENTS.md §9b** — explicit cross-origin / browser-based agent access policy.
- **`public/llms.txt`** — added open-CORS paragraph in the authorization block.

---

## [2.2.0] — 2026-06-29 (rolled into 2.1.1 above)

### Added

**New CLI commands:**
- `srift status [--json]` — unified view: daemon health, active session, and transfer list in one call
- `srift daemon restart` — gracefully stop the daemon (POST /reset then stop) and re-start it
- `srift daemon status [--json]` — show only daemon health (version, uptime, mcp, webtorrent)
- `srift reset [--json]` — wipe session state and flush encryption keys via `POST /reset`
- `srift logs [--tail <n>] [--json-stream]` — view daemon logs via `GET /logs` (default 50 lines)
- `srift uninstall [--purge]` — remove the srift binary and clean PATH entries; `--purge` also deletes `~/.srift/`

**CLI robustness:**
- `ensureDaemon()`: increased wait from 3s to 5s (50 × 100ms iterations)
- `ensureDaemon()`: added port-already-in-use detection with actionable error message
- `ensureDaemon()`: timeout error now includes `srift daemon start`, `srift logs`, and `srift doctor` hints
- Unknown command now prints `Did you mean: srift <closest-command>` suggestion
- New `--no-daemon` global flag to skip auto-start for status-only invocations
- `daemonRequest()` shared helper for typed HTTP requests to the local daemon

**Install scripts:**
- `install.sh`: added `--uninstall [--purge]` option — `curl -fsSL https://srift.app/install.sh | sh -s -- --uninstall`
- `install.sh`: post-install step now runs `srift doctor` to verify the installation end-to-end
- `install.sh`: binary verify now prints OS/arch/file-size debug info if the binary fails to run
- `install.ps1`: added `--uninstall [--purge]` option
- `install.ps1`: same post-install doctor check and debug output
- Both scripts: next-steps banner updated with `srift status` and uninstall command

**Documentation:**
- `AGENTS.md §6`: full CLI command reference updated with all new commands
- `ai-instructions.md §6`: same
- `.cursorrules`: same
- `public/llms.txt`: new "CLI commands" section added before observability endpoints
- `public/compat.json`: `releaseDate` bumped to 2026-06-29
- `public/changelog.json`: new 2.2.0 entry
- `app/ai-agents/page.tsx`: "Maintenance & Updates" CLI group updated with all new commands

---

## [2.1.0] — 2026-06-28

### Added

**Daemon API — all documented endpoints now fully implemented:**
- `GET /health` — liveness probe (`{ok, version, uptime_ms, mcp, webtorrent}`)
- `GET /transfers` — list active transfers with state, progress, and speed
- `GET /transfers/:fileId` — single-transfer detail
- `GET /peers` — connected peer list with RTT and connection method
- `GET /metrics` — Prometheus-format counters (transfers, bytes, errors)
- `GET /logs?n=50` — NDJSON daemon log tail
- `POST /reset` — flush state + encryption keys (full daemon-side wipe)
- `GET /api/v1/monitor/events` — SSE stream (`connection_state`, `join_request`, `file_offer`, `transfer_progress`, `chat_received`)

**Response headers on every daemon response:**
- `X-Srift-Daemon: <version>` — daemon version
- `X-Srift-Wire: 2` — wire protocol version
- `X-Srift-Min-Sdk: 2.0.0` — minimum compatible SDK

**Versioning infrastructure:**
- `GET /sdk/<lang>/version.json` — per-SDK freshness endpoint (11 languages)
- `GET /cli/version.json` — CLI binary freshness check with per-platform download URLs
- `GET /compat.json` — daemon ↔ SDK compatibility matrix
- `GET /changelog.json` — machine-readable changelog

**SDK distribution:**
- `GET /install.sh` — universal POSIX installer (macOS, Linux, WSL, Termux, ARM)
  - Auto-detects OS + CPU architecture
  - SHA-256 checksum verification
  - Automatic PATH configuration (bash/zsh/fish)
  - `SRIFT_VERSION`, `SRIFT_INSTALL_DIR`, `SRIFT_NO_VERIFY` env overrides
- `GET /install.ps1` — Windows PowerShell installer (PowerShell 5.1+, pwsh 7+)
  - Same feature parity as install.sh

**New CLI commands:**
- `srift version [--json]` — print CLI version, daemon version, Node version, update availability
- `srift self-update [--json]` — atomic in-place binary update with SHA-256 verification
- `srift doctor [--json]` — health check: daemon, network, version, config
- `srift config [get|set|delete] [key] [value]` — manage `~/.srift/config.json`

**Background update checks:**
- After every CLI command, a silent background HTTP check fires against `/cli/version.json`
- If an update is available, a one-line nudge is printed to stderr
- Throttled to once per 24h (configurable via `srift config set updateCheckIntervalHours 48`)
- Opt-out: `srift config set updateCheck false` or `SRIFT_NO_UPDATE_CHECK=1`

**Agent discovery:**
- `GET /.cursorrules` — now served at production (was 404 before)
- `GET /CHANGELOG.md` — served at production (linked from AGENTS.md)

**SDK downloads now include:**
- `Content-Disposition: attachment; filename="<file>"` — forces correct filename on save
- `X-Srift-Version: <version>` — SDK version tag
- `X-Srift-Min-Daemon: 2.0.0` — minimum compatible daemon
- `Link: <…>; rel="latest-version"` — machine-readable canonical URL

### Fixed

- **`/ai-agents` page — daemon ping**: `pingDaemon()` was fetching `/health` (404 on daemon). Fixed to `/healthz`.
- **`/ai-agents` page — STATS_ENDPOINTS**: `/events` corrected to `/api/v1/monitor/events`.
- **`/ai-agents` page — TROUBLESHOOTING**: `srift daemon --start` / `--stop` → `srift daemon start` / `stop` (flags were wrong; CLI only accepts subcommands).
- **`/ai-agents` page — HTTP_ERRORS**: Same daemon flag corrections.
- **SDK install commands**: Java, C#, PHP, Ruby now show explicit `curl -O https://srift.app/sdk/<lang>/<file>` commands (were showing require/import without download step).
- **Node SDK install**: Changed from `npm install srift` (package not yet published) to `curl -O https://srift.app/sdk/node/srift.mjs`.
- **Go SDK install**: Changed from `go get sripto.tech/sdk/go/srift` (module not yet published) to `curl -O https://srift.app/sdk/go/srift.go`.
- **Rust SDK install**: Changed from Cargo.toml snippet to `curl -O https://srift.app/sdk/rust/srift.rs`.
- **PowerShell SDK install**: Added `Invoke-WebRequest` download step (was showing `Import-Module ./srift.ps1` with no download).
- **PowerShell SDK path**: `sdk/powershell/srift.ps1` now served (file previously only existed at `sdk/shell/srift.ps1`).
- **`POST /session/approve`**: Returns `404 {error: "Unknown tempUserId"}` for invalid IDs (was silently succeeding).
- **`POST /chat/send`**: Returns `503 {error, retryAfterMs}` when WebSocket connecting (was returning 500).

### Security

- SHA-256 checksum verification for binary downloads in `install.sh` and `install.ps1`
- No auto-update of SDK library files (supply chain risk). Only the CLI binary self-updates.

---

## [2.0.0] — 2026-06-26

### Added

- Initial public release
- MCP server (stdio + HTTP streamable transport, spec 2025-06-18 + fallback 2024-11-05)
- REST daemon API on `http://127.0.0.1:3822`
- 11 SDKs: Python, Node.js/TS, Go, Rust, Java, C#, PHP, Ruby, Bash, PowerShell, curl
- 26 integrations: OpenAI, Anthropic, Gemini, Grok, Cohere, LangChain, AutoGen, CrewAI, and more
- WebRTC (WebTorrent) + WebSocket fallback for P2P file transfer
- AES-256-GCM + PBKDF2-SHA256 (100k iter) end-to-end encryption
- OpenAPI 3.1.0 spec with 25 endpoints at `/openapi.json`
- Discovery endpoints: `/.well-known/mcp/server-card.json`, `/.well-known/ai-plugin.json`, `/.well-known/agent.json`
- CLI: `srift quick-share`, `session`, `send`, `receive`, `monitor`, `approve`, `reject`, `kick`, `chat`, `mcp`, `install-mcp`, `info`
- AGENTS.md, .cursorrules, ai-instructions.md, public/llms.txt for AI agent discovery

---

## Versioning Policy

| Bump | When |
|------|------|
| **PATCH** `x.y.Z` | Bug fixes, documentation, no behaviour change |
| **MINOR** `x.Y.0` | New endpoints, new SDK features — backwards compatible |
| **MAJOR** `X.0.0` | Breaking API changes, wire protocol bump, auth scheme change |

**API stability promise:**
- Routes under `/api/v1/` are stable until a major bump.
- Breaking changes get a 90-day deprecation window with `Deprecation` + `Sunset` response headers.
- All SDKs (Python/Node/Go/etc.) follow the same SemVer as the daemon.

[2.1.8]: https://srift.app/changelog#2-1-8
[2.1.7]: https://srift.app/changelog#2-1-7
[2.1.6]: https://srift.app/changelog#2-1-6
[2.1.5]: https://srift.app/changelog#2-1-5
[2.1.4]: https://srift.app/changelog#2-1-4
[2.1.3]: https://srift.app/changelog#2-1-3
[2.1.2]: https://srift.app/changelog#2-1-2
[2.1.1]: https://srift.app/changelog#2-1-1
[2.2.0]: https://srift.app/changelog#2-2-0
[2.1.0]: https://srift.app/changelog#2-1-0
[2.0.0]: https://srift.app/changelog#2-0-0
