# SRIFT integrations — every major AI provider, framework, and platform

Drop-in recipes. Every example is real, runnable code.

## AI providers

| Provider | Path | Surfaces covered |
|---|---|---|
| **OpenAI** | [`openai/`](openai/) | Function calling, Custom GPTs, Assistants v2, Apps, Realtime, Codex CLI |
| **Anthropic / Claude** | [`anthropic/`](anthropic/) | Claude Desktop (MCP), Tool Use API, Claude Code, Agent SDK |
| **Google Gemini** | [`gemini/`](gemini/) | Gemini API, Vertex AI, AI Studio, NotebookLM, Gemini CLI |
| **Perplexity** | [`perplexity/`](perplexity/) | OpenAI-compatible chat, Pages, MCP |
| **xAI Grok** | [`grok/`](grok/) | OpenAI-compatible chat |
| **Mistral** | [`mistral/`](mistral/) | Native tool use, Le Chat, Codestral |
| **Cohere** | [`cohere/`](cohere/) | Tool use (Command R/R+/A) |
| **Ollama / LM Studio / vLLM / TGI** | [`ollama/`](ollama/) | Any local LLM with OpenAI-compatible function calling |

## Agent frameworks

| Framework | Path |
|---|---|
| **LangChain** (Python + JS) | [`langchain/`](langchain/) |
| **LlamaIndex** | [`llamaindex/`](llamaindex/) |
| **AutoGen** (Microsoft) | [`autogen/`](autogen/) |
| **CrewAI** | [`crewai/`](crewai/) |
| **DSPy** | [`dspy/`](dspy/) |
| **Vercel AI SDK** | [`vercel-ai-sdk/`](vercel-ai-sdk/) |
| **Mastra** | [`mastra/`](mastra/) |

## Automation / no-code

| Platform | Path |
|---|---|
| **n8n** | [`n8n/`](n8n/) |
| **Zapier** | [`zapier/`](zapier/) |
| **Make.com** | [`make/`](make/) |

## Environments

| Where | Path |
|---|---|
| **Docker** (sidecar pattern + compose) | [`docker/`](docker/) |
| **Kubernetes** | [`kubernetes/`](kubernetes/) |
| **GitHub Actions** | [`github-actions/`](github-actions/) |
| **Cloudflare Workers** | [`cloudflare-workers/`](cloudflare-workers/) |
| **AWS Lambda** | [`aws-lambda/`](aws-lambda/) |
| **GCP Cloud Run** | [`gcp-cloud-run/`](gcp-cloud-run/) |
| **Replit** | [`replit/`](replit/) |
| **VS Code extension** | [`vscode-extension/`](vscode-extension/) |

## Don't see your stack?

Every integration above ultimately calls `http://127.0.0.1:3822/quick-share` (or another daemon
endpoint). **Any** runtime with HTTP can use SRIFT — even ones not listed here. See
[`/openapi.json`](https://srift.app/openapi.json) for the full schema and
[`../sdk/`](../sdk/) for thin clients in 10+ languages.
