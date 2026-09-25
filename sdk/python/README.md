# SRIFT Python SDK

Zero-dependency Python client. Works on CPython 3.8+, PyPy, and every Python environment
(Lambda, Cloud Run, GKE, Colab, Jupyter, Databricks, SageMaker, RunPod, Modal, Replit, etc.).

## Install

```bash
pip install srift-sdk
```

Or drop `srift.py` into your project directly — it has zero dependencies:
```bash
curl -O https://srift.app/sdk/python/srift.py
```

> Looking for the `srift` CLI / MCP server itself (not this HTTP client
> library)? See [`srift` on PyPI](https://pypi.org/project/srift/) —
> `uvx srift mcp` or `pipx install srift`.

## Use

```python
from srift import Srift

s = Srift()                                              # auto-targets http://127.0.0.1:3822
result = s.quick_share("/abs/path/file.zip")
print(result["downloadUrl"])                             # → https://srift.app/d/<token>
# The file streams from this machine on demand (nothing is stored on a server),
# so the link works while the daemon runs.
```

## Async

```python
import asyncio
from srift import AsyncSrift

async def main():
    async with AsyncSrift() as s:
        r = await s.quick_share("/path/file.bin")
        print(r["downloadUrl"])

asyncio.run(main())
```

## MCP HTTP transport

```python
from srift import SriftMCP

mcp = SriftMCP()
mcp.initialize()
print(mcp.tools())                                        # list of 15 tools
result = mcp.tool("srift_quick_share", filePath="/path/file.bin")
```

## SSE events

```python
for evt in Srift().stream_events():
    if evt["event"] == "transfer_progress":
        print(f"{evt['data']['fileName']}: {evt['data']['progress']:.1f}%")
```

## Environment variable

`SRIFT_BASE_URL` overrides the daemon URL (default `http://127.0.0.1:3822`).
