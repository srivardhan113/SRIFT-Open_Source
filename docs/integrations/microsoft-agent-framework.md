# Microsoft Agent Framework + SRIFT

Verified against `learn.microsoft.com/en-us/python/api/agent-framework-core/agent_framework.mcpstdiotool`
and `...agent_framework.mcpstreamablehttptool`.

```bash
pip install agent-framework
```

## Local stdio (full 15-tool catalogue, requires Node.js)

```python
from agent_framework import MCPStdioTool

srift = MCPStdioTool(
    name="srift",
    command="npx",
    args=["-y", "srift-transfer", "mcp"],
)

async with srift:
    agent = chat_client.create_agent(
        instructions="You can move files and messages via SRIFT.",
        tools=srift,
    )
    result = await agent.run("Quick-share ./report.pdf")
```

## Hosted (zero-install, 9-tool session/control subset)

```python
from agent_framework import MCPStreamableHTTPTool

srift = MCPStreamableHTTPTool(
    name="srift",
    url="https://srift.app/mcp",
)

async with srift:
    agent = chat_client.create_agent(tools=srift)
```

Both tool types load SRIFT's MCP tools into the agent framework's function
registry on connect (`async with` establishes the session and tears it down
on exit).
