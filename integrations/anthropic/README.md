# Anthropic / Claude integration

| Claude surface | How to wire SRIFT |
|---|---|
| **Claude Desktop** | Native MCP. Add config (see `srift install-mcp`). Stdio. |
| **Claude API tool use** | Declare tools, route to local daemon. See `tool_use.py`. |
| **Claude in Chrome / Computer use** | Use the public web app at https://srift.app — Claude can drive the browser. |
| **Claude Code** | `claude mcp add srift -- srift mcp` (or `npx -y srift-transfer mcp`). |
| **Claude Agent SDK** | Build a custom subagent that wraps SRIFT tools. |
| **Anthropic Workbench** | Paste the `TOOLS` list from `tool_use.py`, or generate tools from https://srift.app/openapi.json. |

## Discovery files Claude already respects

- `/AGENTS.md`
- `/.well-known/mcp/server-card.json`
- `/llms.txt`
- `/llms-full.txt`
