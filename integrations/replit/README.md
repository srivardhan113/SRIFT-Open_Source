# Replit integration

## Repl Agent
The Replit Agent can run SRIFT directly. Add to `.replit`:
```toml
[deployment]
run = ["npm", "run", "start:unified"]

[[ports]]
localPort = 3822
externalPort = 80
```

Then any agent inside the Repl can call `http://127.0.0.1:3822/quick-share`.

## Ghostwriter / AI

Ghostwriter respects `AGENTS.md` and `.cursorrules` automatically — both files are already in the
SRIFT repo root.

## Sharing files **from** a Repl

Inside the Replit shell:
```bash
npm run srift -- quick-share ./build.zip
# → https://srift.app/join-session?id=ABC1234
```

User opens the URL in any browser; transfer streams P2P.
