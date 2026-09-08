# SRIFT Distribution & Registry Playbook

Everything needed to publish, list, and verify SRIFT across npm, the MCP
registry, and the agent directories. Written so a cold session can pick this up
with no prior context.

**Last verified:** 2026-09-08 · npm `2.2.15` · MCP registry `app.srift/srift`

---

## 1. Current state

| Surface | Value | Status |
|---|---|---|
| npm package | [**`srift-transfer`**](https://www.npmjs.com/package/srift-transfer) | ✅ published `2.2.15` |
| CLI command | **`srift`** (bin name ≠ package name) | ✅ |
| Website / API | https://srift.app | ✅ `2.2.15` |
| Hosted MCP | `POST https://srift.app/mcp` | ✅ 8 tools |
| Local MCP | `srift mcp` (stdio) | ✅ 14 tools |
| GitHub | `SRIPTO-Tech/srift-website` (private) | ✅ |
| Open-source mirror | `srivardhan113/SRIFT-Open_Source` | referenced in npm metadata |
| MCP registry | [`app.srift/srift`](https://registry.modelcontextprotocol.io/v0/servers?search=srift) | ✅ **published 2.2.15** (isLatest) |
| Smithery | `srift/srift` | ✅ live ([page](https://smithery.ai/servers/srift/srift)) |
| GitHub topics | 18 topics on the public mirror | ✅ |
| Glama | [connector](https://glama.ai/mcp/connectors/app.srift/srift) · [server](https://glama.ai/mcp/servers/srivardhan113/SRIFT-Open_Source) | ✅ live |
| awesome-mcp-servers | PR submitted | ✅ |

### Known drift to fix

1. **Registry versions are immutable.** `mcp-publisher publish` rejects a
   re-publish of an existing version with
   `400 ... cannot publish duplicate version`. Any correction to the listing
   (repo URL, description, remotes) therefore requires a NEW version — bump,
   publish to npm, then publish to the registry. The auth token also expires;
   re-run `mcp-publisher login dns` with `key.pem` first.

2. **GitHub repo description still says "Military-Grade Encryption."** That is a
   banned claim everywhere else in this project, and it feeds GitHub search,
   Glama's auto-indexer and directory listings. Repo settings are not in the
   codebase, so it has to be changed by hand. Suggested replacement:
   `Secure P2P file transfer, encrypted chat and MCP server for AI agents. AES-256-GCM, no accounts, zero retention.`

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

Do these after npm + MCP registry are live.

### Smithery — biggest source of MCP installs
[smithery.ai/new](https://smithery.ai/new) → sign in with GitHub → point at the
repo. Reads `server.json`. Repo must be public or granted access.

### Glama
[glama.ai/mcp/servers](https://glama.ai/mcp/servers) → Submit. Auto-indexes
public GitHub repos with MCP metadata; submitting just accelerates it.

### awesome-mcp-servers
Fork [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers),
add one alphabetical line under the file-management section, open a PR:

```markdown
- [srift-transfer](https://github.com/SRIPTO-Tech/srift-website) - Secure P2P file transfer and encrypted chat. Zero accounts, hosted endpoint at srift.app/mcp.
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
| Local stdio (`srift mcp`) | **14** | full disk + key access |
| Local HTTP (`127.0.0.1:3822/mcp`) | **14** | same daemon |
| Hosted (`srift.app/mcp`) | **8** | orchestration only |

Hosted omits `srift_quick_share`, `srift_send_file`, `srift_accept_transfer`
(need local disk) and `srift_send_chat`, `srift_chat_history`, `srift_read_state`
(would require deriving session keys server-side). Source of truth:
`lib/mcp/backend-inprocess.mjs` → `SUPPORTED_TOOLS`.

### Encryption — be precise, this has caused real errors

- **Session transfers**: end-to-end encrypted, AES-256-GCM, PBKDF2-SHA256 100k.
- **`quick-share` public links**: **NOT** end-to-end encrypted. The link must be
  fetchable by any browser/`curl`/`wget`, which holds no key — so bytes are
  relayed in readable form. Guarantee is **zero retention**, not zero knowledge.
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
`503 sender is offline`. Nothing is stored server-side.

### Banned claims (enforced by tests)

Never use: `military-grade`, `#1`, `files never touch any server`,
`untraceable`, `complete anonymity`, `trusted by millions`, `zero-knowledge`
(as a product claim). Say `zero-retention` and `AES-256-GCM` instead.

---

## 6. Verification commands

```bash
# Local gate (what CI runs)
npx tsc --noEmit
npm run lint
npm run build
npm test                                  # 172 tests
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
curl -OJ "https://srift.app/d/<token>"
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

## 8. Remaining work

1. ~~Publish npm~~ ✅ `2.2.15`
2. ~~MCP registry~~ ✅ `app.srift/srift` (`2.2.15`)
3. **Smithery / Glama / awesome-mcp-servers / GitHub topics**
4. Google Search Console — no verification code set; `app/layout.tsx` only emits
   one if `GOOGLE_VERIFICATION_CODE` is in the environment
5. Backlinks: Show HN, Product Hunt, r/selfhosted, AlternativeTo
6. Optional product call: make `roomSecret` prominent or default — it is the only
   path to a truthful zero-knowledge claim
