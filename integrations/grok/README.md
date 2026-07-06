# xAI Grok integration

Grok exposes an OpenAI-compatible API. SRIFT plugs in via the same function-calling pattern.

```python
from openai import OpenAI
client = OpenAI(base_url="https://api.x.ai/v1", api_key=os.environ["XAI_API_KEY"])
# Reuse TOOLS / run_tool from ../openai/function_calling.py — model name: "grok-2-latest" / "grok-3"
```

**Grok in X (Twitter)** consumer surface: paste the share URL returned by `srift_quick_share`
directly into chat. No further integration needed.
