# Pydantic AI + SRIFT

Verified against `github.com/pydantic/pydantic-ai/blob/main/docs/mcp/client.md`.
Current Pydantic AI builds `MCPToolset` on top of the `fastmcp` client, which
takes a transport object directly; the older `MCPServerStdio` /
`MCPServerStreamableHTTP` classes referenced in some third-party posts still
exist in places but the snippet below reflects the docs page as fetched.

```bash
pip install pydantic-ai
```

## Local stdio (full 15-tool catalogue, requires Node.js)

```python
from fastmcp.client.transports import StdioTransport
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPToolset

srift = MCPToolset(StdioTransport(command="npx", args=["-y", "srift-transfer", "mcp"]))
agent = Agent("openai:gpt-4o", toolsets=[srift])

result = await agent.run("Send this report to the user via SRIFT quick-share.")
```

## Hosted (zero-install, 9-tool session/control subset)

```python
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPToolset

srift = MCPToolset("https://srift.app/mcp")
agent = Agent("openai:gpt-4o", toolsets=[srift])
```

If your installed `pydantic-ai` version predates `MCPToolset`, use
`MCPServerStdio(command=..., args=...)` / `MCPServerStreamableHTTP(url=...)`
from `pydantic_ai.mcp` instead, passed the same way via `toolsets`.
