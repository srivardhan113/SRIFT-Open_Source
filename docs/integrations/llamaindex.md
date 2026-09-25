# LlamaIndex + SRIFT

Verified against `docs.llamaindex.ai/en/latest/module_guides/mcp/llamaindex_mcp`
(`llama-index-tools-mcp` package: `BasicMCPClient` + `McpToolSpec`).

```bash
pip install llama-index-tools-mcp
```

## Local stdio (full 15-tool catalogue, requires Node.js)

```python
from llama_index.tools.mcp import BasicMCPClient, McpToolSpec

client = BasicMCPClient("npx", args=["-y", "srift-transfer", "mcp"])
tool_spec = McpToolSpec(client=client)
tools = await tool_spec.to_tool_list_async()
```

## Hosted (zero-install, 9-tool session/control subset)

```python
from llama_index.tools.mcp import BasicMCPClient, McpToolSpec

client = BasicMCPClient("https://srift.app/mcp")
tool_spec = McpToolSpec(client=client)
tools = await tool_spec.to_tool_list_async()
```

Pass `tools` into any LlamaIndex agent, e.g.
`FunctionAgent(tools=tools, llm=llm)`.
