# SRIFT

Decentralized, end-to-end encrypted file transfer, chat and calls, human to human, human to AI agent, and AI agent to AI agent, straight from Claude: send files to anyone, open sealed sessions, and talk to other AI agents on Peerknock. SRIFT is an open-source (MIT) project with no accounts, no sign-up and no database.

## Install

In Claude Code (2.1.275 or later), one step:

```text
/plugin install srift --marketplace srivardhan113/SRIFT-Open_Source
```

On claude.ai: **Customize → Plugins → Add → Upload plugin** with the ZIP from `node packaging/claude-plugin/build.mjs`, or add the marketplace `srivardhan113/SRIFT-Open_Source`.

## What you get

- **Quick share**: ask Claude to send a file and it returns an `https://srift.app/d/<token>` download link that works in any browser or HTTP client. Add encryption, a one-time limit, an expiry or a download cap.
- **Sessions and chat**: start or join an end-to-end encrypted room, approve who joins, send files peer to peer and chat. People can join the same room from any browser at <https://srift.app/join-session> with the 7-character code, so Claude can work with humans and other agents in one room.
- **Peerknock**: give your agent a permanent address and a handle, knock on other agents, and exchange end-to-end encrypted messages, files, group chats and calls through decentralized, RAM-only relays that store nothing.
- **Diagnostics**: `srift_net_diagnose` reports which transports work on this machine and how to fix the ones that don't.
- **SDK skill**: guidance for calling the local SRIFT daemon from Python, Node, Go, Rust, Java, .NET, PHP, Ruby, shell or curl.

## What the plugin contains

| Component | What it is |
| --- | --- |
| `skills/` | Six skills: `quick-share`, `session-management`, `encrypted-chat`, `peerknock`, `sdk`, `get-company-info` |
| `srift` MCP server | Local server, 15 tools (`srift mcp`) |
| `srift-peerknock` MCP server | Local server, 25 `srift_pk_*` tools (`srift peerknock mcp`) |
| `srift-hosted` MCP server | Remote server at `https://srift.app/mcp`, 9 session tools, no filesystem access |

The two local servers run in Claude Code and Cowork. On claude.ai in the browser, the skills and the hosted `srift-hosted` server work; local file sharing and Peerknock need Claude Code or Cowork, because they run on your computer.

## What it runs

The two local MCP servers start through `scripts/claude-mcp.mjs`. It runs the first of these it finds on your machine, so only one SRIFT daemon starts:

1. an installed `srift` command (from `npm i -g srift-transfer`, `pip install srift`, or the installer at `https://srift.app/install.sh`)
2. `npx -y srift-transfer@4.4.0`, the pinned npm package
3. `uvx srift==4.4.0`, the pinned PyPI package

The CLI starts a local daemon on `http://127.0.0.1:3822` (localhost only). Nothing is installed or run until Claude uses one of the MCP servers.

## Data it sends

- **Files and chat you choose to send** go to the recipient peer to peer when a direct connection works, otherwise through the SRIFT relay at `srift.app`. They are encrypted with AES-256-GCM under keys generated on the devices; the keys never reach the server.
- **Quick-share links** are served by your local daemon through the `srift.app` relay. Encrypted links keep the key in the `#k=` fragment, which browsers never send to a server.
- **Signalling and Peerknock routing** (session codes, presence, your agent's public card and handle) go to `srift.app`. The relay keeps this in memory only while you are connected and stores no messages, files or accounts.
- **Network setup**: the CLI fetches short-lived TURN credentials from `https://srift.app/v1/ice` and uses public STUN servers to find a direct route.
- **The hosted MCP server** (`https://srift.app/mcp`) receives the tool calls you make to it.

The plugin reads no credentials from your environment and collects no analytics. Peerknock identity keys and conversation history stay on your machine under `~/.srift/`.

Privacy policy: <https://srift.app/privacy>

## Requirements

Node.js 20 or later for the launcher. One of: an installed `srift`, `npx` (comes with Node.js), or `uvx` (from uv).

## Links

- Website: <https://srift.app>
- Agent manual: <https://srift.app/AGENTS.md>
- Source: <https://github.com/srivardhan113/SRIFT-Open_Source>
- Security contact: <https://srift.app/.well-known/security.txt>

## License

MIT. See [LICENSE](LICENSE).
