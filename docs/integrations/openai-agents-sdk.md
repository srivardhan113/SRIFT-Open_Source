# OpenAI Agents SDK + SRIFT

Verified against `github.com/openai/openai-agents-python/blob/main/docs/mcp.md`
(Python SDK). A JS/TS `openai-agents-js` port exists with the same class
names (`MCPServerStdio`, `MCPServerStreamableHttp`) — see
`openai.github.io/openai-agents-js/guides/mcp/` if you're on Node instead.

```bash
pip install openai-agents
```

## Local stdio (full 15-tool catalogue, requires Node.js)

```python
import asyncio
from agents import Agent, Runner
from agents.mcp import MCPServerStdio

async def main():
    async with MCPServerStdio(
        name="SRIFT",
        params={"command": "npx", "args": ["-y", "srift-transfer", "mcp"]},
    ) as server:
        agent = Agent(name="Assistant", mcp_servers=[server])
        result = await Runner.run(agent, "Quick-share ./report.pdf")
        print(result.final_output)

asyncio.run(main())
```

## Hosted (zero-install, 9-tool session/control subset)

```python
import asyncio
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

async def main():
    async with MCPServerStreamableHttp(
        name="SRIFT",
        params={"url": "https://srift.app/mcp"},
    ) as server:
        agent = Agent(name="Assistant", mcp_servers=[server])
        result = await Runner.run(agent, "Start a SRIFT session and tell me the join URL.")
        print(result.final_output)

asyncio.run(main())
```

Pass `cache_tools_list=True` to either constructor once you've confirmed
SRIFT's tool list is stable for your session, to skip a repeat `tools/list`
round-trip on every run.
