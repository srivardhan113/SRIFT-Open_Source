---
name: quick-share
description: Zero-install file delivery: seed a file and get a public download URL, no session setup required on the recipient's end
---

# quick-share

Zero-install file delivery via SRIFT's local MCP server. Returns a public `https://srift.app/d/<token>` relay link that any recipient can open in a browser — no SRIFT install, no signup, no session-join UI required on their end. The bytes stream from the sender's machine through the srift.app relay on demand (pass-through, `Cache-Control: no-store`); nothing is stored on any server, so the link works while the sender's daemon (or process) runs.

## Requirements

No credentials. The SRIFT local daemon binds to `127.0.0.1:3822` with zero authentication. Only outbound HTTPS/WSS on port 443 is needed.

## Instructions

1. Call the MCP tool `srift_quick_share` with `{ filePath: "/absolute/path/to/file" }` (single file) or `{ filePaths: [...] }` (up to 500 files/folders). Optional params: `bundle` (default: true = one .tar.gz link; false = one link per path, created in parallel), `bundleName`, `exclude` (string[] for glob patterns to skip), `sessionName`, `maxDownloads`, `ttlMs`, `encrypt`, `password`.
2. The tool returns a `downloadUrl` (e.g. `https://srift.app/d/<token>`) when bundled, or `{ links: [], errors: [] }` when separate. With `encrypt: true` (or a `password`) each link is end-to-end encrypted with AES-256-GCM: the key rides in the `#k=` URL fragment, is never sent to a server, and the browser decrypts locally. Without it, links are protected by TLS in transit only — use `encrypt` for anything sensitive.
3. Hand the URL(s) to the recipient. In order of preference, they can run:
   - `srift get <url> [<url> ...]` (or `npx -y srift-transfer get <url>`; proxy-aware, resumable, decrypts `#k=` links, supports multiple URLs with `--concurrency N`, works where curl is broken)
   - `wget --content-disposition <url>`
   - PowerShell `iwr <url> -OutFile <name>`
   - `curl -OJ <url>`
   - or just open it in any browser.
4. Keep the sending side running until the recipient has downloaded. From a shell, `srift quick-share <file> [<file> ...] --wait` blocks until then (`--wait-timeout 30m` exits with code 3 on timeout); `--keep-alive` serves until the TTL expires.

## Sandboxed and datacenter agents

If the background daemon cannot start (the sandbox forbids local servers, blocks detached spawns or loopback, or the port is taken), `srift mcp` and `srift quick-share` host the daemon inside their own process: no local port, outbound HTTPS/WSS on 443 only. The MCP server switches automatically, so this tool keeps working. From a shell, run quick-share in the background (it exits after the download) or with `--wait`; `--foreground` forces in-process serving. Blocked UDP never breaks links. Run `srift doctor` (or the `srift_net_diagnose` tool) to diagnose connectivity; `HTTPS_PROXY`/`NO_PROXY` and `NODE_EXTRA_CA_CERTS` are honoured.

See `/openapi.json` and `/.well-known/mcp/server-card.json` for the full tool contract.
