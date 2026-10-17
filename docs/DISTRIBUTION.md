# SRIFT Distribution & Registry Playbook

Everything needed to publish, list, and verify SRIFT across npm, the MCP
registry, and the agent directories. Written so a cold session can pick this up
with no prior context.

**Last verified:** 2026-10-17 · npm `4.4.0` · PyPI `srift` `4.4.0` · MCP registry `app.srift/srift` `4.4.0` · srift.app `4.4.0` · GitHub release `v4.4.0`

Every directory, marketplace and skill index SRIFT can be listed on, with exact submission steps and status, is tracked in `docs/GROWTH-PLAN.md` §8 (audited 2026-10-17).

Search engines: after any content change, `node scripts/indexnow-submit.mjs` pushes every sitemap URL to IndexNow (Bing, Yandex, Naver, Seznam, Yep). It only works once srift.app is verified in Bing Webmaster Tools (2026-10-17: returned 403 `UserForbiddedToAccessSite` because the host is not verified yet). See `docs/GROWTH-PLAN.md` rows O2/O3.

Publish order for a new version:
1. Deploy the server (srift.app) — binaries land under `/dl/<ver>/`.
2. npm `srift-transfer@<ver>` (`packages/cli`).
3. PyPI `srift==<ver>` (`python packages/pypi/build.py`).
4. MCP registry (`mcp-publisher publish`) — after npm + PyPI both exist.
5. Bump Scoop / Homebrew taps; submit winget; AUR by hand.

---

## 1. Current state

| Surface | Value | Status |
|---|---|---|
| npm package | [**`srift-transfer`**](https://www.npmjs.com/package/srift-transfer) | ✅ `4.4.0` (2026-10-17) |
| CLI command | **`srift`** (bin name ≠ package name); agent layer `srift peerknock` / `srift pk` | ✅ |
| Website / API | https://srift.app | ✅ `4.4.0` (Cloud Build trigger on `main`) |
| Hosted MCP | `POST https://srift.app/mcp` | ✅ 9 tools |
| Local MCP | `srift mcp` (stdio) · `srift peerknock mcp` (25 `srift_pk_*` tools) | ✅ 15 + 25 tools |
| GitHub | `SRIPTO-Tech/srift-website` (private) | ✅ release `v4.4.0` published; `srift.mcpb` attached by the workflow |
| Open-source mirror | `srivardhan113/SRIFT-Open_Source` | ✅ synced by `node scripts/sync-mirror.mjs` (docs, specs, packaging, SDKs, CLI, plugin, skills; never lib/, app/, server.mjs, tests, secrets); licence detected as MIT |
| MCP registry | [`app.srift/srift`](https://registry.modelcontextprotocol.io/v0/servers?search=srift) | ✅ `4.4.0` isLatest (publish only after npm has the version) |
| PyPI | [`srift`](https://pypi.org/project/srift/) (CLI + MCP via bundled Node.js, Python SDK) | ✅ `4.4.0` (`python packages/pypi/build.py` + twine; the workflow's trusted-publisher job fails at checkout) |
| Homebrew tap | [`srivardhan113/homebrew-srift`](https://github.com/srivardhan113/homebrew-srift) | ✅ `4.4.0` (pushed by git; hash = sha256 of the npm tarball) |
| Scoop bucket | [`srivardhan113/scoop-srift`](https://github.com/srivardhan113/scoop-srift) | ✅ `4.4.0` (hash = sha256 of `/dl/4.4.0/win-x64/srift.exe`) |
| winget | `SRIFT.Srift` | ✅ 4.3.2 merged · ⏳ 4.4.0 = PR [microsoft/winget-pkgs#454765](https://github.com/microsoft/winget-pkgs/pull/454765) |
| Claude Code plugin | `plugin/` (`.claude-plugin/plugin.json`, `.mcp.json`, 6 skills) · ZIP via `node packaging/claude-plugin/build.mjs` · marketplace: `/plugin install srift --marketplace srivardhan113/SRIFT-Open_Source` | ✅ validates; directory submission is owner-side (claude.ai/directory/manage) |
| Agent Plugins layout (Cursor, Codex, OpenAI) | repo-root `plugin.json` + `mcp.json` + `skills/`; `plugin/plugin.json` + `plugin/mcp.json`; `.agents/plugins/marketplace.json`; OpenAI ZIP via `node packaging/openai-plugin/build.mjs` | ✅ files; OpenAI portal submission owner-side |
| Cursor Directory | [cursor.directory/plugins/srift](https://cursor.directory/plugins/srift) | ⏳ listed 2026-10-17, public once their security scan finishes |
| ClawHub (OpenClaw) | `srift-quick-share`, `srift-peerknock` (from `clawhub/`) | ⏳ submitted 2026-10-17, pending security scans |
| skills.cat | repo submitted (18 skills) | ⏳ processing |
| skills.sh | `.agents/skills/` + root `skills/`; `npx skills add srivardhan113/SRIFT-Open_Source` run once | ⏳ appears after their index |
| mcpservers.org | submitted (free, Communication, registry name `app.srift/srift`) | ⏳ review ≤ 2 weeks |
| Docker MCP Catalog | PR [docker/mcp-registry#5800](https://github.com/docker/mcp-registry/pull/5800) (`servers/srift`, remote) | ⏳ Docker review |
| awesome-mcp-servers | PR [punkpeye#15388](https://github.com/punkpeye/awesome-mcp-servers/pull/15388) (labels green, maintainer nudged) | ⏳ merge |
| awesome-remote-mcp-servers | PR [jaw9c#1418](https://github.com/jaw9c/awesome-remote-mcp-servers/pull/1418) | ⏳ merge |
| Smithery | [`srift/srift`](https://smithery.ai/servers/srift/srift) | ✅ live, score 98, description updated 2026-10-17 (verified badge = paid plan, deferred) |
| Glama | [connector](https://glama.ai/mcp/connectors/app.srift/srift) · [server](https://glama.ai/mcp/servers/srivardhan113/SRIFT-Open_Source) · `glama.json` maintainers | ✅ live, quality A |
| AUR | `srift` (`packaging/aur`, real sha256) | ⏳ needs the owner's AUR SSH push |
| Other library SDKs | crates, Maven, NuGet, Packagist, RubyGems | ⏳ workflow jobs exist but skip until the seven repo secrets are added (owner); direct download from `srift.app/sdk/` works |
| Deferred by owner decision (2026-10-17) | mcp.so ($39), LobeHub (repo+workflow scopes), skillsdirectory and AlternativeTo (new accounts), Perplexity (email-only), Smithery verified badge (paid) | ⏸ ignore for now |
| Live agents directory | https://srift.app/peerknock/agents (+ `GET /api/pk/live/list`) | ✅ built 2026-10-17; in sitemap and llms.txt |
| Search engines | Google Search Console (DNS-verified) · Bing Webmaster (not verified → IndexNow 403) · `/news-sitemap.xml` | ⏳ Bing verification owner-side |

### Known drift to fix

1. **Registry versions are immutable.** `mcp-publisher publish` rejects a
   re-publish of an existing version with
   `400 ... cannot publish duplicate version`. Any correction to the listing
   (repo URL, description, remotes) therefore requires a NEW version — bump,
   publish to npm, then publish to the registry. The auth token also expires;
   re-run `mcp-publisher login dns` with `key.pem` first.

2. **GitHub repo description says "Military-Grade Encryption"**: kept on purpose (owner decision 2026-09-28).

3. **Smithery's own badge endpoint returns HTTP 500** for every URL form
   (`/badge/srift/srift`, `/badge/@srift/srift`, `/badge/srift`). The READMEs use
   a shields.io badge linking to the Smithery page instead. Worth re-testing
   their badge service later.

### The one naming rule that matters

```
npm package name:  srift-transfer      ← install/npx paths only
CLI binary name:   srift               ← what users and MCP configs invoke
```

`npm i -g srift-transfer` installs a command called **`srift`**. Every MCP config
uses `"command": "srift"`. Do not "fix" configs to say `srift-transfer` — that
would break them.

**Why not the name `srift`?** npm rejects it: `403 too similar to existing
package "sift"`. `srift-cli` is blocked too (`sift-cli` exists). Scoped names
(`@scope/x`) bypass the similarity filter if a rename is ever needed.

---

## 2. Publishing to npm

### Release procedure

```bash
# 1. Version bump happens automatically in the pre-commit hook, which keeps
#    package.json, packages/cli/package.json, server.json, cli/index.ts and
#    cli/index.js in lockstep, then runs scripts/sync-version.mjs to propagate
#    to ~20 other files (install scripts, JSON-LD, download URLs).
git commit -m "..."          # bumps patch
git push origin main         # triggers Cloud Build -> Cloud Run

# 2. Publish the CLI (requires interactive 2FA — a human must run this)
cd packages/cli
npm publish
```

To commit **without** bumping (e.g. when npm is already at this version):

```bash
SKIP_VERSION_BUMP=1 git commit -m "..."
```

### Verify after publishing

```bash
npm view srift-transfer version
npx srift-transfer@latest --help        # proves `bin` survived
npx srift-transfer@latest install-mcp   # must print "command": "srift"
```

### Gotchas that have actually bitten us

| Symptom | Cause | Fix |
|---|---|---|
| `403 ... requires two-factor authentication` | npm 2FA is on | Human runs `npm publish`, completes browser/OTP. **Cannot be automated without a granular token with "bypass 2FA".** |
| `403 too similar to existing package` | npm typosquat filter | Use a different or scoped name |
| `npm warn publish "bin[srift]" ... was invalid and removed` | `bin` path had a leading `./` | Use `"bin": {"srift": "dist/index.js"}`. **npm strips it silently** — package installs with no command. CI now fails on any publish warning. |
| Install fails on `node-datachannel`/`utp-native` | `webtorrent` in `dependencies` | Keep it in `optionalDependencies`; the daemon already degrades gracefully |
| `EBADENGINE` | `engines.node` too high | Must not exceed Node 20 (LTS floor) |

---

## 3. MCP registry

### Decide the namespace first — it is baked into the listing

| Namespace | Auth | Effort | Looks like |
|---|---|---|---|
| `io.github.sripto-tech/srift` | GitHub OAuth | ~30 s | a GitHub project |
| `app.srift/srift` | Cloudflare DNS TXT | ~10 min | **a product** |

`server.json` currently declares **`io.github.sripto-tech/srift`**. Change it
before publishing if you want the branded one — `mcp-publisher` reads that file
and rejects a mismatch with your auth.

### Install the publisher (Windows)

```bash
curl -L -o mcp-publisher.tar.gz \
  https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_amd64.tar.gz
tar xzf mcp-publisher.tar.gz mcp-publisher.exe
```

### Option A — branded (`app.srift/srift`)

```bash
openssl genpkey -algorithm Ed25519 -out key.pem
openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64
```

Cloudflare → **srift.app** → DNS → Add record:
- Type `TXT`, Name `@`, Proxy **off**
- Content: `v=MCPv1; k=ed25519; p=<base64 from above>`

Wait ~2 min for propagation, then:

```bash
./mcp-publisher.exe login dns --domain srift.app \
  --private-key $(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')
./mcp-publisher.exe publish
```

> ⚠️ `key.pem` is your registry identity. **Never commit it.** Losing it means
> re-doing DNS verification.

### Option B — fast (`io.github.sripto-tech/srift`)

```bash
./mcp-publisher.exe login github
./mcp-publisher.exe publish
```

### server.json rules

- Schema: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
- **camelCase throughout** (`registryType`, `websiteUrl`, `runtimeArguments`, `environmentVariables`, `isRequired`).
- `description` is capped at **100 characters**.
- `packages[].identifier` **must equal** the npm package name (`srift-transfer`).
  A mismatch makes the listing install a package that doesn't exist — there is a
  test asserting this.
- Versions are auto-synced by the pre-commit hook and `scripts/sync-version.mjs`.

**Order matters:** npm must be published *before* the registry entry, or anyone
who finds the listing hits a 404 install.

---

## 4. Agent directories

Do these after npm + MCP registry are live. Status of every directory (done / pending / deferred) lives in `docs/GROWTH-PLAN.md` §0a and §8; the notes below are the how-to.

### ClawHub (OpenClaw)
`npm i -g clawhub`, `clawhub login` (GitHub device flow, read-only scopes), then `clawhub skill publish ./clawhub/srift-quick-share --slug srift-quick-share --name "SRIFT Quick Share" --version <ver>` and the same for `./clawhub/srift-peerknock`. Releases are held until the ClawHub security scans pass. ClawHub applies MIT-0 to published skill text.

### skills.cat / skills.sh / cursor.directory / mcpservers.org
`npx -y skillscat login` then `npx -y skillscat submit https://github.com/srivardhan113/SRIFT-Open_Source` · `npx skills add srivardhan113/SRIFT-Open_Source` once (registers on skills.sh; the repo root carries `skills/` for it) · cursor.directory/plugins/new scans the repo ROOT for `plugin.json`, `mcp.json`, `skills/` (all generated at the root) · mcpservers.org/submit (free plan, registry name `app.srift/srift`).

### Smithery — biggest source of MCP installs
[smithery.ai/new](https://smithery.ai/new) → sign in with GitHub → point at the
repo. Reads `server.json`. Repo must be public or granted access.

### Glama
[glama.ai/mcp/servers](https://glama.ai/mcp/servers) → Submit. Auto-indexes
public GitHub repos with MCP metadata; submitting just accelerates it.

### awesome-mcp-servers
PR #15388 is open from the fork `srivardhan113/awesome-mcp-servers` (branch `add-srift-4.3.0`, entry under File Systems with emoji tags and both Glama badges; labels has-emoji / has-glama / valid-name are green). Current line:

```markdown
- [srivardhan113/SRIFT-Open_Source](https://github.com/srivardhan113/SRIFT-Open_Source) [badges…] 📇 ☁️ 🏠 🍎 🪟 🐧 - Decentralized, end-to-end encrypted (AES-256-GCM) peer-to-peer file transfer, chat and agent-to-agent messaging: send files as download links, no accounts, no database; hosted endpoint at https://srift.app/mcp.
```

### GitHub topics
Repo → ⚙️ beside **About** → add:
`mcp` `mcp-server` `model-context-protocol` `ai-agents` `file-transfer` `p2p`
`claude` `cursor`

Free, and `topic:mcp-server` is a real discovery path.

---

## 5. Architecture facts a new session needs

### Tool availability differs by transport

| Transport | Tools | Why |
|---|---|---|
| Local stdio (`srift mcp`) | **15** | full disk + key access (daemon in-process if it can't start) |
| Local HTTP (`127.0.0.1:3822/mcp`) | **15** | same daemon |
| Hosted (`srift.app/mcp`) | **9** | orchestration + `srift_net_diagnose` guidance |

Hosted omits `srift_quick_share`, `srift_send_file`, `srift_accept_transfer`
(need local disk) and `srift_send_chat`, `srift_chat_history`, `srift_read_state`
(would require deriving session keys server-side). Source of truth:
`lib/mcp/backend-inprocess.mjs` → `SUPPORTED_TOOLS`.

### Encryption — be precise, this has caused real errors

- **Session transfers and chat**: end-to-end encrypted, AES-256-GCM under ECDH P-256 + HKDF-SHA256 keys
  generated on the devices (4.2+; older peers fall back to a PBKDF2-SHA256 session key).
- **`quick-share` public links**: end-to-end encrypted **only with `--encrypt`**
  (or `--password`; key in the `#k=` fragment, browser/`srift get` decrypt
  locally). Without it the bytes are relayed in readable form over TLS. Either
  way the guarantee is **zero retention** (`Cache-Control: no-store`), not zero knowledge.
- **"Zero-knowledge" is false by default.** `lib/encryption.ts` derives the key
  from `sessionId` alone unless an optional `roomSecret` is supplied — and the
  server knows the sessionId. Only `roomSecret` makes it true. It is off by
  default.
- **P2P exposes peer IPs.** SRIFT is *private*, not *anonymous*. Never claim
  otherwise; a whistleblowing claim in `humans.txt` was removed for this reason.

### quick-share link lifetime

The sender's daemon streams the file from disk on demand. It is `detached` +
`unref()`, so it **survives the command that created the link**. The link dies
only when the daemon stops (sleep/reboot/`srift daemon stop`), returning
`503 sender is offline`. Nothing is stored server-side. In CI or other
ephemeral environments the job must stay alive until the recipient has
downloaded (`--wait` blocks until then; `--wait-timeout` exits 3) — there is
no server-side parking.

### Sandboxes and datacenter agents (embedded daemon)

If the background daemon cannot start (bind `EPERM`, detached spawn or loopback
blocked, port taken), `srift quick-share` and `srift mcp` host the daemon in
their own process (`cli/embedded.ts`): no local port, outbound HTTPS/WSS on 443
only. quick-share then stays running until the download completes and exits;
`--foreground` forces this, `--keep-alive` serves until expiry. The MCP server
switches automatically when the daemon is unreachable. `SRIFT_NO_EMBEDDED=1`
disables the fallback. `srift doctor` / `srift_net_diagnose` report what is blocked.

### Banned claims (enforced by tests)

Never use: `#1`, `files never touch any server`,
`untraceable`, `complete anonymity`, `trusted by millions`, `zero-knowledge`
(as a product claim). Say `zero-retention` and `AES-256-GCM` instead.

---

## 6. Verification commands

```bash
# Local gate (what CI runs)
npx tsc --noEmit
npm run lint
npm run build
npm test                                  # 475+ tests
node scripts/sync-version.mjs --check

# CLI package
node packages/cli/build.mjs
cd packages/cli && npm publish --dry-run  # must emit ZERO warnings

# Live production
curl -s https://srift.app/cli/version.json
curl -s -X POST https://srift.app/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Full round trip
srift quick-share <abs-path> --ttl 15m --json
curl -fLOJ "https://srift.app/d/<token>"
```

> On Windows, pass **absolute Windows paths** (`C:/...`) to the CLI. Git Bash
> `/tmp` resolves to `C:\tmp` and fails.

---

## 7. Infrastructure

- **Deploy**: push to `main` → Cloud Build → Cloud Run (`asia-south1`). ~10 min.
- **Build VM**: `E2_HIGHCPU_32` (32 vCPU / 32 GB), 100 GB disk, build heap 8192 MB.
- **Runtime**: Cloud Run 4Gi / 2 CPU, heap 3072 MB (deliberately below the limit
  so V8 GCs instead of being OOM-killed).
- **CI**: `.github/workflows/ci.yml` — verify + package jobs on every push/PR.
- **Dockerfile**: every `COPY` source must exist; a deleted `proxy.ts` left in
  the COPY list broke every build. There is a test for this now.

---

## 8. Remaining work (as of 2026-10-17)

Done this release: npm / PyPI / MCP registry / srift.app / GitHub release / Homebrew tap / Scoop bucket at 4.4.0; winget PR #454765; Docker catalog PR #5800; awesome-mcp-servers PR #15388 (labels green) and awesome-remote-mcp-servers PR #1418 open; ClawHub, skills.cat, skills.sh, cursor.directory, mcpservers.org submitted; Smithery description updated; release-distribution workflow made valid. Full per-surface tracker: `docs/GROWTH-PLAN.md` §0a and §8.

Owner-only, in order:
1. **Repo secrets** (CARGO_REGISTRY_TOKEN, RUBYGEMS_API_KEY, NUGET_API_KEY, PACKAGIST_API_TOKEN, WINGET_GITHUB_TOKEN, HOMEBREW_TAP_TOKEN, SCOOP_TAP_TOKEN) so the next GitHub release publishes crates / RubyGems / NuGet / Packagist / winget / taps by itself. Deferred by the owner for now; taps and winget were done by hand this time.
2. **AUR**: push `packaging/aur` with the AUR SSH key (`ssh://aur@aur.archlinux.org/srift.git`, regenerate `.SRCINFO`).
3. **Anthropic directory**: claude.ai/directory/manage, MCP connector (`https://srift.app/mcp`), then Plugin bundle (repo path `plugin`). Copy in `docs/GROWTH-PLAN.md` §6.
4. **OpenAI plugin directory**: `node packaging/openai-plugin/build.mjs`, upload the ZIP; identity verification; challenge token at `/.well-known/openai-apps-challenge`; test prompts and demo video (`packaging/openai-plugin/README.md`).
5. **Cline marketplace**: test the install inside Cline once, then the submission issue (logo at `https://srift.app/Favicon/srift-400.png`, `llms-install.md`).
6. **GitHub MCP Registry / VS Code gallery**: one email to partnerships@github.com.
7. **Bing Webmaster Tools** verification, then `node scripts/indexnow-submit.mjs`; Google Search Console sitemap resubmit.
8. **Seed agents** (`scripts/seed-agents`, small VM), demo video, Show HN, Product Hunt, newsletters (`docs/GROWTH-PLAN.md` §9).

Deferred (owner decision 2026-10-17, ignore until revisited): mcp.so ($39), LobeHub (needs repo + workflow GitHub scopes), skillsdirectory and AlternativeTo (need new accounts), Perplexity (email-only), Smithery verified badge (paid plan).

Per-release checklist (what 4.4.0 taught): deploy srift.app first (binaries at `/dl/<ver>/`), then npm (`cd packages/cli && npm run build && npm publish`; npm may take a minute to show the version), then PyPI (`python packages/pypi/build.py` + twine), then `mcp-publisher publish`, then the GitHub release `v<ver>`. After the binaries exist, **recompute the hashes** in `packaging/homebrew/srift.rb` (npm tarball), `packaging/scoop/srift.json` and `packaging/winget/.../<ver>/` (win-x64 exe): `scripts/sync-version.mjs` only bumps the version strings and leaves the previous hashes in place. Then `node scripts/sync-mirror.mjs` and push the mirror.
