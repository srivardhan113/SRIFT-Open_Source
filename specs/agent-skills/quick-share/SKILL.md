# quick-share

Zero-install file delivery via SRIFT's local MCP daemon. Ensures a session exists, seeds a file, and returns a public `https://srift.app/d/<token>` URL that any recipient can open in a browser — no SRIFT install, no signup, no session-join UI required on their end.

## Requirements

No special credentials required. The SRIFT local daemon binds to `127.0.0.1:3822` and requires zero authentication.

## Instructions

1. Ensure the SRIFT daemon is running (`srift daemon start`, or it auto-starts on first `srift` command).
2. Call the MCP tool `srift_quick_share` with `{ filePath: "/absolute/path/to/file" }`.
3. The tool returns a `downloadUrl` (e.g. `https://srift.app/d/<token>`) that transfers the file peer-to-peer, end-to-end encrypted with AES-256-GCM.
4. Hand the URL to the recipient. They open it in any browser or run `curl -OJ <url>` / `wget --content-disposition <url>`.

See `/openapi.json` and `/.well-known/mcp/server-card.json` for the full tool contract.
