# Perplexity integration

Perplexity supports the **OpenAI-compatible** chat completions API and tool calling. SRIFT plugs
in identically to the OpenAI recipe.

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.perplexity.ai",
    api_key=os.environ["PERPLEXITY_API_KEY"],
)

# Reuse TOOLS / run_tool from ../openai/function_calling.py
```

**Perplexity Pages / Spaces**: feed `https://srift.app/llms-full.txt` as a source to teach
Perplexity the SRIFT API surface. Perplexity's web crawler is allowed by `robots.txt`.

**PPLX MCP** clients: stdio MCP `srift mcp` works directly.
