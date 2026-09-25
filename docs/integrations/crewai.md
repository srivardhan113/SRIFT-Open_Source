# CrewAI + SRIFT

Verified against `docs.crewai.com/en/mcp/stdio` (CrewAI's own MCP stdio
transport guide, `crewai-tools`' `MCPServerAdapter`).

```bash
pip install crewai-tools
```

## Local stdio (full 15-tool catalogue, requires Node.js)

```python
from mcp import StdioServerParameters
from crewai_tools import MCPServerAdapter

server_params = StdioServerParameters(
    command="npx",
    args=["-y", "srift-transfer", "mcp"],
)

with MCPServerAdapter(server_params) as srift_tools:
    # srift_tools is a list of CrewAI Tool objects, one per MCP tool
    agent = Agent(
        role="File courier",
        goal="Move files and messages via SRIFT on request",
        tools=srift_tools,
        ...,
    )
```

## Hosted (zero-install, 9-tool session/control subset)

`MCPServerAdapter` also accepts an SSE/HTTP server config — point it at the
hosted endpoint instead of spawning a subprocess:

```python
from crewai_tools import MCPServerAdapter

with MCPServerAdapter({"url": "https://srift.app/mcp", "transport": "streamable-http"}) as srift_tools:
    agent = Agent(role="File courier", tools=srift_tools, ...)
```

Confirm the exact streamable-http config key names against
`docs.crewai.com/en/mcp` before relying on the hosted variant — CrewAI's
docs primarily worked-example stdio at the time this was checked.
