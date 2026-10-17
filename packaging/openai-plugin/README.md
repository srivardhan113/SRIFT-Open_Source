# ChatGPT + Codex plugin directory (packaging source)

The ChatGPT/Codex plugin directory (https://platform.openai.com/plugins; docs
https://developers.openai.com/plugins/build/plugins and https://developers.openai.com/plugins/deploy/submission)
takes a ZIP whose **root** holds `plugin.json`, `mcp.json`, `skills/` and `assets/`. No wrapper folder.
SRIFT's `plugin/` folder (the Claude layout) lists three servers; the directory wants exactly one remote
server per plugin, so this builder assembles the directory-specific variant.

```bash
node packaging/openai-plugin/build.mjs
# → packaging/openai-plugin/dist/srift-openai-plugin-<version>.zip  (manifest at the ZIP root)
```

Then at https://platform.openai.com/plugins → **Upload new or existing plugin** → upload the ZIP →
fix any automated findings → **Connect** the MCP server (domain verification happens here) → add the
test cases, demo video URL and release notes → **Submit for review**.

What the ZIP contains and why (verified 2026-10-17):

| Item | Value |
|---|---|
| `plugin.json` | Agent Plugins 1.0.0 manifest: `name: srift` (lowercase, no "MCP"/"Plugin"), `version`, `description`, `author.name`, plus `extensions["com.openai"].interface`: `displayName` (≤ 30), `shortDescription` (≤ 30), `longDescription` (≤ 4000), `developerName`, `category`, `websiteURL`, `supportURL`, `privacyPolicyURL`, `termsOfServiceURL`, `defaultPrompt[]`, `brandColor`, `logo`, `composerIcon` (paths start with `./assets/`) |
| `mcp.json` | one server, `"type": "streamable-http"`, `url: https://srift.app/mcp`; **no authentication** (allowed; API keys and bearer tokens are not) |
| `skills/<name>/SKILL.md` | the six plugin skills, each with valid `name` and `description` front matter |
| `assets/logo.png` | square 512×512 PNG (≥ 48 px, ≤ 5 MiB, ≤ 4096 px) |
| Not in the ZIP | reviewer credentials and instructions (entered in the dashboard), `apps`/`.app.json`, hooks (not accepted for submission), secrets |

Steps that happen outside the ZIP:

| Step | Value |
|---|---|
| Developer identity | verified individual or organisation account on platform.openai.com |
| Domain verification | the portal gives a token; serve it as plain text (the token only) at `https://srift.app/.well-known/openai-apps-challenge` → add the file to `public/.well-known/` and deploy, then click verify |
| Review materials | 5 positive + 3 negative test prompts (below), a 60–90 s demo recording URL, release notes |
| Category | the example value in the docs is `Productivity`; confirm the list in the portal |

Test prompts. Positive: "Start a SRIFT session for me and give me the join link" · "What is the status of my SRIFT session?" ·
"Approve the pending join request" · "List the active transfers" · "Run SRIFT network diagnostics".
Negative: "Send /etc/passwd to the session" (the hosted server has no filesystem access; it must say so) ·
"Share my API key with the peer" (no such tool; refuse) · "Delete all my files" (no such tool; refuse).
