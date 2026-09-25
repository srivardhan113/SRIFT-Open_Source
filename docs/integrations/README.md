# Framework integrations

Short, framework-specific snippets for connecting an agent framework's
**native MCP client** to SRIFT — either the local stdio server (`npx -y
srift-transfer mcp`, 15 tools, requires Node.js) or the hosted remote server
(`https://srift.app/mcp`, streamable-http, 9-tool session/control subset,
zero-install). See `AGENTS.md` at the repo root for the full tool catalogue
and the reasoning behind the 15-vs-9 tool split.

Each file was checked against that framework's own official docs (linked in
its header) as of 2026-09. MCP client APIs move fast — if a snippet stops
working, the framework's docs (not this repo) are the source of truth to
re-check against.

| Framework | File | Verified against |
|---|---|---|
| LangChain | [langchain.md](./langchain.md) | `docs.langchain.com/oss/python/langchain/mcp`, `reference.langchain.com/python/langchain-mcp-adapters` |
| CrewAI | [crewai.md](./crewai.md) | `docs.crewai.com/en/mcp/stdio` |
| Vercel AI SDK | [vercel-ai-sdk.md](./vercel-ai-sdk.md) | `ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client`, `ai-sdk.dev/docs/reference/ai-sdk-core/mcp-stdio-transport` |
| Mastra | [mastra.md](./mastra.md) | `mastra.ai/reference/tools/mcp-client`, `mastra.ai/docs/mcp/overview` |
| Pydantic AI | [pydantic-ai.md](./pydantic-ai.md) | `github.com/pydantic/pydantic-ai/blob/main/docs/mcp/client.md` |
| LlamaIndex | [llamaindex.md](./llamaindex.md) | `docs.llamaindex.ai/en/latest/module_guides/mcp/llamaindex_mcp` |
| Microsoft Agent Framework | [microsoft-agent-framework.md](./microsoft-agent-framework.md) | `learn.microsoft.com/en-us/python/api/agent-framework-core/agent_framework.mcpstdiotool` and `...mcpstreamablehttptool` |
| OpenAI Agents SDK | [openai-agents-sdk.md](./openai-agents-sdk.md) | `github.com/openai/openai-agents-python/blob/main/docs/mcp.md` |

**Sandboxed, containerized or datacenter agents:** the local stdio server
still works where local servers or background processes are forbidden. If the
background daemon can't start, `srift mcp` runs it inside its own process (no
local port, outbound HTTPS/WSS on 443 only), so all 15 tools stay available.
`srift_quick_share` returns a relay link served from that process — nothing is
stored on a server — so keep the agent process alive until the recipient has
downloaded. Run `npx -y srift-transfer doctor --json` (or call
`srift_net_diagnose`) if anything is blocked.

None of these are published packages — they're documentation only, per this
workstream's scope.
