# Mistral integration

Mistral exposes native function calling and is OpenAI-compatible.

```python
from mistralai import Mistral
client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])

tools = [{
    "type": "function",
    "function": {
        "name": "srift_quick_share",
        "description": "Deliver a file via E2EE P2P transfer.",
        "parameters": {"type": "object", "properties": {"filePath": {"type": "string"}}, "required": ["filePath"]},
    }
}]

resp = client.chat.complete(model="mistral-large-latest", messages=[...], tools=tools)
```

Also works with **Le Chat**, **Mistral Codestral**, and **Mistral Inference SDK**.
