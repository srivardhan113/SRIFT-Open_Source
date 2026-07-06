# OpenAI integration

SRIFT works with every OpenAI surface:

| OpenAI surface | How to wire SRIFT |
|---|---|
| **Function calling** (Chat Completions / Responses API) | Declare `srift_quick_share` as a tool; route the call to the local daemon. See `function_calling.py`. |
| **Custom GPTs (ChatGPT)** | Add an Action with the schema at `https://srift.app/openapi.json`. Auth: None. |
| **OpenAI Apps / GPT-4o tool use** | Same OpenAPI schema. Auth: None. |
| **Assistants API v2** | Pass tool definitions via `tools=[{"type":"function","function":...}]`. |
| **Realtime API** (voice/text) | Same function-calling pattern. Stream `transfer_progress` SSE back as voice updates. |
| **Codex CLI** | Add SRIFT via MCP stdio. See top-level `AGENTS.md`. |
| **OpenAI Python/Node SDKs** | Use the recipes here verbatim. |

See `function_calling.py` for a complete runnable example.
