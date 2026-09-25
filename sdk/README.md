# SRIFT SDKs — every language, every runtime

Each SDK is a **thin, zero-dependency** (or stdlib-only) client for the local SRIFT daemon at
`http://127.0.0.1:3822`. All of them ship the same surface area: session lifecycle, file transfer,
chat, and discovery.

| Language | Path | Runtime targets |
|---|---|---|
| **Python** | [`python/srift.py`](python/srift.py) | CPython 3.9+ via pip (single file: 3.8+), PyPy, Conda, Poetry, uv, Lambda, Cloud Run, Colab, Jupyter, Modal, RunPod, Replit |
| **Node.js / JS / TS** | [`node/srift.mjs`](node/srift.mjs) | Node 18+, Bun, Deno, Electron (same machine as the daemon) |
| **Go** | [`go/srift.go`](go/srift.go) | Go 1.21+ |
| **Rust** | [`rust/srift.rs`](rust/srift.rs) | stable Rust, sync (ureq) or async (reqwest), Tauri |
| **Java** | [`java/Srift.java`](java/Srift.java) | Java 11+, GraalVM, Kotlin, Scala, Clojure, Groovy, JBang |
| **C# / .NET** | [`dotnet/Srift.cs`](dotnet/Srift.cs) | .NET 6+, MAUI |
| **PHP** | [`php/srift.php`](php/srift.php) | PHP 7.4+ / 8.x, Apache, Nginx-FPM, Swoole, RoadRunner, FrankenPHP, Octane |
| **Ruby** | [`ruby/srift.rb`](ruby/srift.rb) | Ruby 2.7+, JRuby, TruffleRuby, Rails, Sinatra |
| **Bash / Zsh / Sh** | [`shell/srift.sh`](shell/srift.sh) | Bash 3+, Zsh, Ksh, Dash, BusyBox sh — any POSIX |
| **PowerShell** | [`shell/srift.ps1`](shell/srift.ps1) (canonical) | Win PowerShell 5.1+, pwsh 7+ on Win/macOS/Linux |
| **curl** | [`curl/recipes.sh`](curl/recipes.sh) | anything with curl |

> **Note on PowerShell duplication:** [`powershell/srift.ps1`](powershell/srift.ps1) also exists on
> disk as a byte-identical copy of [`shell/srift.ps1`](shell/srift.ps1). Both are version-tracked by
> `scripts/sync-version.mjs` and `scripts/verify-seo.mjs`, and both are served live (including at
> `https://srift.app/sdk/powershell/version.json`), so neither can be deleted without breaking a
> served surface. Treat `shell/srift.ps1` as the canonical source if you're editing by hand; the
> `powershell/` copy is kept in sync with it and should not be edited independently.

## Universal contract

Every SDK exposes (with idiomatic naming) these core REST operations, all served by the same
local daemon:

- `quick_share(filePath, sessionName?)` — **one-shot download link** (`downloadUrl`). Encryption, `--once`, TTL and multi-file bundles are CLI / `POST /quick-share` options.
- `status()`, `state()`
- `start_session(name?, roomSecret?)`, `join_session(id, ...)`, `close_session()`
- `approve_join(tempUserId)`, `reject_join(tempUserId, reason?)`, `kick_user(userId)`
- `send_file(filePath)`, `accept_transfer(fileId, saveDir?)`
- `send_chat(message)`, `chat_history()`, `list_transfers()`
- `status()` includes `pendingJoins` (for `approve_join`) and `participants` (userIds for `kick_user`).
- Go: every method takes a `context.Context` first; `NewSession(ctx, name, roomSecret)` returns `(sessionID, joinURL, err)`.

### Feature parity is NOT uniform across languages

- **Node.js and Python** additionally implement an SSE event-stream iterator (`streamEvents()` /
  `stream_events()`) and a full MCP-over-HTTP client (`SriftMCP`).
- **Go, Rust, Java, .NET, PHP, and Ruby currently implement only the core REST contract above.**
  They do **not** yet have a streaming/SSE iterator or an `SriftMCP`-equivalent client. If your
  use case needs live event streaming or MCP-over-HTTP from one of these six languages today,
  either poll `status()`/`state()`, or call the daemon's SSE/MCP HTTP endpoints directly (see
  [`/openapi.json`](https://srift.app/openapi.json)) until native support lands.

## Security / Crypto

Every SDK is a thin HTTP client — all cryptography happens in the local SRIFT daemon
(`http://127.0.0.1:3822`) that the SDKs talk to, not in the SDK code itself:

- **AES-256-GCM** for file/chat payload encryption, with **PBKDF2-SHA256 (100,000 iterations)**
  for key derivation.
- Keys are **client-derived** from the session ID plus the optional `roomSecret` — never transmitted or stored server-side.
  The server does see the session ID, so pass a `roomSecret` to make the key participant-only.
- Quick-share links are end-to-end encrypted only with `encrypt: true` (key in the `#k=` fragment);
  otherwise they are TLS-only in transit (zero retention).
- Sessions are **ephemeral** and the signaling/relay infrastructure keeps **zero central
  retention** of file contents or keys.
- P2P transfer still routes connection setup through a signaling server (and, if a direct P2P
  path isn't reachable, may relay encrypted bytes) — the relay forwards ciphertext without receiving the key, but data does pass through servers for signaling/relay, it just isn't held there.

## Environment selection

All SDKs honour the `SRIFT_BASE_URL` env var (defaults to `http://127.0.0.1:3822`). Use it only for
a non-default port on the same host (`http://127.0.0.1:<port>`); the daemon rejects non-loopback Host headers.

## Installation status

Live on registries: `srift-transfer` on npm (CLI + MCP server) and `srift` on PyPI (the same CLI +
MCP server with a bundled Node.js runtime, plus the Python SDK). The other library SDKs are not on a
package registry yet:

| Language | Works today | Not yet live |
|---|---|---|
| Python | `pip install srift` — the PyPI package includes this SDK (`from srift import Srift`) alongside the `srift` CLI (from 4.1.0) | — |
| Node.js | npm `srift` — **not yet published**; use direct file download below | npm |
| Go | `go get .../srift` — **not yet published**; use direct file download below | Go proxy / pkg.go.dev |
| Rust | `cargo add srift` — **not yet published**; use direct file download below | crates.io |
| Java | Maven coordinate `app.srift:srift` — **not yet published**; use direct file download below | Maven Central |
| .NET | NuGet `Srift` — **not yet published**; use direct file download below | NuGet |
| PHP | Composer `srift/srift` — **not yet published**; use direct file download below | Packagist |
| Ruby | `gem install srift` — **not yet published**; use direct file download below | RubyGems |

**The currently-working install method for every language above except Python (on PyPI) is a direct file download**, e.g.:

```sh
curl -o srift.py  https://srift.app/sdk/python/srift.py
curl -o srift.go  https://srift.app/sdk/go/srift.go
curl -o srift.rs  https://srift.app/sdk/rust/srift.rs
curl -o Srift.java https://srift.app/sdk/java/Srift.java
curl -o Srift.cs  https://srift.app/sdk/dotnet/Srift.cs
curl -o srift.php https://srift.app/sdk/php/srift.php
curl -o srift.rb  https://srift.app/sdk/ruby/srift.rb
```

Java, .NET, PHP, and Ruby now also ship a real package manifest alongside the source file
(`java/pom.xml`, `dotnet/Srift.csproj`, `php/composer.json`, `ruby/srift.gemspec`) — these declare
the package coordinate (`app.srift:srift`, `Srift`, `srift/srift`, `srift`, kept at the current release version by `scripts/sync-version.mjs`)
so a maintainer can `mvn deploy` / `dotnet nuget push` / `composer publish` / `gem push` in a
future release. They are **not** published anywhere yet — direct file download remains the only
working install method until that happens.

## Need a language we missed?

The daemon REST API is documented at [`/openapi.json`](https://srift.app/openapi.json). Any
HTTP-capable runtime (incl. embedded MCUs, browser JS, mobile native, Pascal, Lua, Crystal,
Nim, Zig, Elixir, OCaml, Haskell, F#, Swift, Objective-C, etc.) can call it directly with the
recipes in [`curl/recipes.sh`](curl/recipes.sh) as a starting template.
