# Google Gemini integration

SRIFT works across the entire Google AI stack:

| Surface | How |
|---|---|
| **Gemini API** (Pro, Flash, Nano) | Function declarations — see `function_calling.py` |
| **Vertex AI** | Same function-calling schema. Service-account auth applies to Vertex, not to SRIFT. |
| **Google AI Studio** | Paste tool definitions or run the OpenAPI Action from `/openapi.json`. |
| **Gemini in Chrome / Workspace extensions** | Use https://srift.app web UI directly. |
| **Gemini CLI / gemini-cli** | Stdio MCP. |
| **NotebookLM** | Feed `/llms-full.txt` as a source. |

## Quick OpenAPI declaration

```python
import google.generativeai as genai
import requests

openapi = requests.get("https://srift.app/openapi.json").json()
# Convert the relevant paths into FunctionDeclaration objects, or use the auto-mode in
# google-genai SDK 1.x: genai.Client().types.openapi.from_url(...)
```
