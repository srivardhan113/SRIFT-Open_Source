# Scoop bucket for SRIFT

Uses the prebuilt Windows binary served from `https://srift.app/dl/<version>/win-x64/srift.exe`
(built by `Dockerfile` via `bun build --compile`, see `server.mjs` `/cli/version.json`
and `/dl` route) rather than the npm package — no Node.js dependency for
Windows users, which is what Scoop users installing a single CLI generally
expect.

`srift.json`'s `hash` is a placeholder. The per-target `SHA256SUMS` file next
to the binary (`.../win-x64/SHA256SUMS`) contains exactly one line —
`<sha256>  srift.exe` (GNU `sha256sum` text-mode format, two spaces) — so
`checkver`/`autoupdate`'s `hash.regex` extracts it directly; no manual hash
maintenance once a release exists. Before first publish, replace the
placeholder by hand:

```bash
curl -s https://srift.app/dl/3.0.0/win-x64/SHA256SUMS
```

## One-time setup (maintainer)

```bash
gh repo create srivardhan113/scoop-srift --public \
  --description "Scoop bucket for the SRIFT CLI"
git clone https://github.com/srivardhan113/scoop-srift
mkdir -p scoop-srift/bucket
cp packaging/scoop/srift.json scoop-srift/bucket/srift.json
cd scoop-srift && git add bucket/srift.json && git commit -m "Add srift manifest" && git push
```

## End-user install

```powershell
scoop bucket add srift https://github.com/srivardhan113/scoop-srift
scoop install srift
```

## Keeping it current

Scoop's own `checkver`/`autoupdate` (run via `scoop-hold`-style CI or the
`Scoop/Scoop` community `excavator` if adopted upstream) can refresh this
automatically. Until then, `.github/workflows/release-distribution.yml`'s
`scoop` job runs `scoop checkver` / `scoop autoupdate` against this manifest
and commits the result to `scoop-srift/bucket/srift.json` using the same
`HOMEBREW_TAP_TOKEN`-style PAT (see that workflow for the exact secret name).
