# Replit integration

## Share a file from a Repl

In the Replit shell (or from the Replit Agent):

```bash
npm install -g srift-transfer        # or: pip install srift
srift quick-share ./build.zip        # → https://srift.app/d/<token>
```

The recipient opens the link in any browser. The file streams from the Repl while it runs; nothing
is stored on a server. Add `--encrypt` for end-to-end encryption, `--wait` to keep serving until
the download finishes.

## Replit Agent / MCP

Give the agent the SRIFT MCP server (`srift mcp`, or `npx -y srift-transfer mcp` without a global
install). The daemon listens on `127.0.0.1:3822` inside the Repl; it has no authentication, so
don't map port 3822 to the internet.

## Agent docs

Agents that read `AGENTS.md` or `.cursorrules` can bootstrap them into a project with
`srift bootstrap`.
