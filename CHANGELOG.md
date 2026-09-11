# Changelog

All notable changes to SRIFT are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning 2.0.0](https://semver.org/).

Machine-readable version: [`/changelog.json`](https://srift.app/changelog.json)

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
