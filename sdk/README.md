# SRIFT SDKs — every language, every runtime

Each SDK is a **thin, zero-dependency** (or stdlib-only) client for the local SRIFT daemon at
`http://127.0.0.1:3822`. All of them ship the same surface area: session lifecycle, file transfer,
chat, and discovery.

| Language | Path | Runtime targets |
|---|---|---|
| **Python** | [`python/srift.py`](python/srift.py) | CPython 3.8+, PyPy, Conda, Poetry, uv, Lambda, Cloud Run, Colab, Jupyter, Modal, RunPod, Replit |
| **Node.js / JS / TS** | [`node/srift.mjs`](node/srift.mjs) | Node 18+, Bun, Deno, Cloudflare Workers, Vercel Edge, Netlify, Electron, React Native |
| **Go** | [`go/srift.go`](go/srift.go) | Go 1.21+, TinyGo, GopherJS, Wasm |
| **Rust** | [`rust/srift.rs`](rust/srift.rs) | stable Rust, sync (ureq) or async (reqwest), incl. wasm32-wasi, Tauri |
| **Java** | [`java/Srift.java`](java/Srift.java) | Java 11+, GraalVM, Kotlin, Scala, Clojure, Groovy, JBang |
| **C# / .NET** | [`dotnet/Srift.cs`](dotnet/Srift.cs) | .NET 6+, MAUI, Blazor, Unity, Godot, Xamarin |
| **PHP** | [`php/srift.php`](php/srift.php) | PHP 7.4+ / 8.x, Apache, Nginx-FPM, Swoole, RoadRunner, FrankenPHP, Octane |
| **Ruby** | [`ruby/srift.rb`](ruby/srift.rb) | Ruby 2.7+, JRuby, TruffleRuby, Rails, Sinatra |
| **Bash / Zsh / Sh** | [`shell/srift.sh`](shell/srift.sh) | Bash 3+, Zsh, Ksh, Dash, BusyBox sh — any POSIX |
| **PowerShell** | [`shell/srift.ps1`](shell/srift.ps1) | Win PowerShell 5.1+, pwsh 7+ on Win/macOS/Linux |
| **curl** | [`curl/recipes.sh`](curl/recipes.sh) | anything with curl |

## Universal contract

Every SDK exposes (with idiomatic naming) these operations:

- `quick_share(filePath, sessionName?)` — **one-shot session+seed+share URL**
- `status()`, `state()`
- `start_session(name?, roomSecret?)`, `join_session(id, ...)`, `close_session()`
- `approve_join(tempUserId)`, `reject_join(tempUserId, reason?)`, `kick_user(userId)`
- `send_file(filePath, protocol?)`, `accept_transfer(fileId, saveDir?)`
- `send_chat(message)`, `chat_history()`

Plus, where the runtime supports it: an SSE event-stream iterator and an MCP-over-HTTP client.

## Environment selection

All SDKs honour the `SRIFT_BASE_URL` env var (defaults to `http://127.0.0.1:3822`). Use this to
target a daemon running in a different container or VM.

## Need a language we missed?

The daemon REST API is documented at [`/openapi.json`](https://srift.app/openapi.json). Any
HTTP-capable runtime (incl. embedded MCUs, browser JS, mobile native, Pascal, Lua, Crystal,
Nim, Zig, Elixir, OCaml, Haskell, F#, Swift, Objective-C, etc.) can call it directly with the
recipes in [`curl/recipes.sh`](curl/recipes.sh) as a starting template.
