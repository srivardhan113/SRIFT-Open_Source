# Claude plugin packaging (claude.ai upload + directory)

Three ways the same `plugin/` folder reaches Claude users; all verified against
https://claude.com/docs/plugins/build and https://claude.com/docs/plugins/submit on 2026-10-17.

| Path | What to do |
|---|---|
| **Upload a ZIP to your own claude.ai account** (test, or share the file) | `node packaging/claude-plugin/build.mjs` → `packaging/claude-plugin/dist/srift-claude-plugin-<version>.zip` → claude.ai → **Customize → Plugins → Add → Upload plugin**. The ZIP holds the plugin folder as its single top-level entry, with the manifest at `srift/.claude-plugin/plugin.json`, which is one of the two layouts the upload accepts. |
| **Anthropic directory** (public listing) | claude.ai/directory/manage → Submit new → **Plugin bundle** → repository `srivardhan113/SRIFT-Open_Source`, plugin path `plugin`. The directory reads the folder from GitHub, so `plugin/` must exist in the public mirror. |
| **Your own marketplace** (any Claude user, no review) | The repo root `.claude-plugin/marketplace.json` lists `./plugin`. Users run `/plugin marketplace add srivardhan113/SRIFT-Open_Source` then `/plugin install srift@srift`, or in one step `/plugin install srift --marketplace srivardhan113/SRIFT-Open_Source`. |

Local check before any of them: `claude plugin validate ./plugin` (passes as of 2026-10-17).

What the folder contains and why it passes the directory checks: manifest with `name`, `version`,
`description` (≤ 200 chars), `author`, `license`, `icon`, `privacyPolicy`; README ≥ 40 words with the
privacy link; LICENSE (MIT); `.mcp.json` with two local servers started from a checked-in file
(`scripts/claude-mcp.mjs`, pinned `npx srift-transfer@<version>` fallback) and one remote `type: http`
server; six skills under `skills/<name>/SKILL.md`; no `bin/`, no lockfile, no `.npmrc`.
