# LangChain + SRIFT

Verified against `docs.langchain.com/oss/python/langchain/mcp` and the
`langchain-mcp-adapters` reference (`reference.langchain.com/python/langchain-mcp-adapters/client/MultiServerMCPClient`).
Note: the exact config-dict code sample lives on that reference site's
"Connections" sub-page, which this check could not fetch directly — the
shape below (`transport`/`command`/`args` keys) is corroborated by the
reference docs and `langchain-mcp-adapters`' README, but re-diff it against
`langchain-ai/langchain-mcp-adapters` if `MultiServerMCPClient` rejects it.

```bash
pip install langchain-mcp-adapters
```

## Local stdio (full 15-tool catalogue, requires Node.js)

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "srift": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "srift-transfer", "mcp"],
    }
})
tools = await client.get_tools()
```

## Hosted (zero-install, 9-tool session/control subset)

```python
client = MultiServerMCPClient({
    "srift": {
        "transport": "streamable_http",
        "url": "https://srift.app/mcp",
    }
})
tools = await client.get_tools()
```

Pass `tools` into any LangChain/LangGraph agent, e.g.
`create_react_agent(model, tools)`.
