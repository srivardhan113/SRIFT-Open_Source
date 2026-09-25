# SRIFT Quick Share — GitHub Action

Share a build artifact, test-failure trace, log bundle, or report from a
workflow run and get back a `https://srift.app/d/<token>` link as a step
output. No cloud storage bucket, no API key, no account.

```yaml
- name: Share failure logs
  if: failure()
  id: share
  uses: srivardhan113/SRIFT-Open_Source/packages/github-action@main
  with:
    path: ./test-results
    ttl: 2h
    once: true
    wait-for-download: 30m   # keep the runner serving until the file is downloaded

- name: Post link
  if: failure()
  run: echo "Logs: ${{ steps.share.outputs.url }}"
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `path` | *(required)* | File or directory to share. Directories are packed into a `.tar.gz` by the CLI. |
| `ttl` | `24h` | Auto-expire after this duration (`30s`, `15m`, `2h`, `1d`). |
| `max-downloads` | — | Invalidate after N downloads. |
| `once` | `false` | Shorthand for `max-downloads: 1`. |
| `encrypt` | `true` | AES-256-GCM encrypt the file. Key lives in the URL fragment, never sent to the server. |
| `password` | — | Extra password required to download, in addition to the key. |
| `wait-for-download` | `0` | Keep this step running until the link has been downloaded at least once, or until this duration passes (`30m`, `2h`, …). `0` returns immediately. On timeout the step logs a warning and continues; the link stops working when the job ends. |
| `mask-url` | `true` | `::add-mask::` the `url` output so it can't leak into logs. |
| `node-version` | `20` | Node version used to run `npx srift-transfer`. |
| `version` | `latest` | npm dist-tag/version of `srift-transfer` to run. Pin an exact version for reproducible CI. |

## Outputs

| Output | Description |
|---|---|
| `url` | Full download URL. **Secret-equivalent** when `encrypt` is true — it embeds the decryption key after `#`. Treat it like a credential: don't echo it into a public step summary or PR comment. This action already withholds it from the job summary when `mask-url` is true. |
| `token` | Opaque token (the URL's path segment, no key material). Safe to log/print even when `url` is masked. |
| `expires-at` | ISO-8601 expiry timestamp, if `ttl` set one. |

## The runner must stay up until the download

SRIFT stores nothing server-side. `quick-share` starts a background daemon on
the runner that streams the (optionally encrypted) bytes through the srift.app
relay only when the recipient requests them. The daemon keeps running across
later steps, but it dies when the job ends — after that the link returns
`503 sender is offline`. Keep the job alive until the recipient has downloaded:
set `wait-for-download` (e.g. `30m`, bounded by the job's `timeout-minutes`), or
have the consuming side run `srift get "<url>"` before this job finishes.

Only outbound HTTPS/WSS on port 443 is needed — no inbound ports. On runners
or containers that forbid local servers or background processes, the CLI serves
the link from its own process instead of a background daemon (no local port). For
long-lived hand-offs, use a regular artifact store instead.

## Self-test

`.github/workflows/action-selftest.yml` (this repo, `workflow_dispatch`-only)
exercises the action end-to-end against a throwaway file: run it from the
Actions tab to sanity-check a change to `action.yml` before tagging a release
of this action.

## Versioning

Reference a tag (e.g. `@v1`) once one exists, or `@main` for latest. This
action has no build step of its own — it only shells out to the published
`srift-transfer` npm package, so there's nothing to compile/release for the
action itself beyond tagging.
