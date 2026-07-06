# Ollama / LM Studio / vLLM / TGI / local-LLM integration

Local-LLM runtimes that support OpenAI-compatible function calling work identically.

```python
from openai import OpenAI

# Ollama:
client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")

# LM Studio:
client = OpenAI(base_url="http://localhost:1234/v1", api_key="lm-studio")

# vLLM:
client = OpenAI(base_url="http://localhost:8000/v1", api_key="vllm")

# Reuse the tool definitions and run_tool from ../openai/function_calling.py
```

**Models that support tool use well**: `llama3.1`, `llama3.3`, `qwen2.5`, `command-r`,
`mistral`, `firefunction-v2`, `hermes-2-pro`.

Local LLM + local SRIFT daemon = **fully offline, fully private** file delivery loop.
