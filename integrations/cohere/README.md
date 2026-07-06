# Cohere integration

Cohere Command R/R+/A models support native tool use.

```python
import cohere
co = cohere.ClientV2()

tools = [{
    "type": "function",
    "function": {
        "name": "srift_quick_share",
        "description": "Deliver a file via E2EE P2P transfer.",
        "parameters": {"type": "object", "properties": {"filePath": {"type": "string"}}, "required": ["filePath"]},
    }
}]

resp = co.chat(model="command-r-plus", messages=[...], tools=tools)
```
