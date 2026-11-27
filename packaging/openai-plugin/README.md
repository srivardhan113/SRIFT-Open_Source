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
| `skills/srift-rooms/SKILL.md` | one skill written for this plugin (`packaging/openai-plugin/skills/`): the hosted tools and how to act with them. The shared `plugin/skills/` are NOT bundled: they describe the local CLI (installs, Peerknock, filesystem), which ChatGPT cannot use, and the directory's skill scan flagged two of them (2026-10-22) |
| `assets/logo.png` | square 512×512 PNG (≥ 48 px, ≤ 5 MiB, ≤ 4096 px) |
| Not in the ZIP | reviewer credentials and instructions (entered in the dashboard), `apps`/`.app.json`, hooks (not accepted for submission), secrets |

Steps that happen outside the ZIP:

| Step | Value |
|---|---|
| Developer identity | verified individual or organisation account on platform.openai.com |
| Domain verification | the portal gives a token; serve it as plain text (the token only) at `https://srift.app/.well-known/openai-apps-challenge` → add the file to `public/.well-known/` and deploy, then click verify |
| Domain token | `public/.well-known/openai-apps-challenge` (served by the `agentReadinessRoutes` map in `server.mjs`; dotfolders never reach `express.static`). Set 2026-10-22; replace the file if the portal issues a new token |
| Review materials | exactly 5 positive + 3 negative test cases (below), a 60–90 s demo recording URL, release notes |
| Category | `Productivity` (the listing text now names tasks, intended users and limitations of the hosted tools only) |

### Paste into the review form

Positive test cases (prompt → tools triggered → expected behaviour):

1. "Open a private SRIFT room so I can send a big file to my friend" → `srift_start_session` → returns the room ID and a `https://srift.app/join-session?id=…` link and says the friend opens it in a browser.
2. "Who is in my SRIFT room and is anyone waiting to join?" → `srift_session_status` → lists participants and pending join requests (or says there are none).
3. "Let Priya into my room" → `srift_session_status`, `srift_approve_join` → finds Priya among pending requests and approves her; if she is not waiting, says so instead of approving anyone else.
4. "Which files were shared in my SRIFT room?" → `srift_list_transfers` → lists each file with its name, size, who offered it and its status (offered, accepted or cancelled), or says none were shared.
5. "Close my SRIFT room" → `srift_close_session` → closes the room for everyone and confirms it (the server never held the room's keys).

Negative test cases (prompt → expected behaviour):

1. "Upload the file I attached to my SRIFT room" → explains that it cannot send files; the people in the room send files from their own device via the join link.
2. "Read the files my friend sent me in SRIFT" → explains that file contents are end-to-end encrypted between devices and never reach the server or ChatGPT.
3. "Remove everyone from every SRIFT room" → does not act on rooms it did not open in this conversation; asks which participant in which room.

Release notes: "First submission. Lets ChatGPT open private, end-to-end encrypted SRIFT rooms, share the join link, approve or remove participants, see which files were shared and close the room. Hosted server https://srift.app/mcp, no sign-in."

Reviewer notes (answers to the 2026-10-22 automated findings):

- `srift_net_diagnose` is `readOnlyHint: true` on purpose: on the hosted server this plugin uses, it only returns guidance text and has no side effect. (The self-test that creates a temporary link exists only in the local SRIFT CLI, which is not part of this plugin.)
- Privacy policy: https://srift.app/privacy (privacy summary, data processing, retention, rights, contact; terms at https://srift.app/privacy#terms). Please assess it manually if the automated check could not complete.
- Skills: the only bundled skill is `srift-rooms`; it installs nothing, runs no commands and treats room data as untrusted.
- No sign-in, no test account needed.
