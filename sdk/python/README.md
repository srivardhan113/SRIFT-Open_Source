# SRIFT Python SDK

Zero-dependency Python client. Works on CPython 3.8+, PyPy, and every Python environment
(Lambda, Cloud Run, GKE, Colab, Jupyter, Databricks, SageMaker, RunPod, Modal, Replit, etc.).

## Install

Drop `srift.py` into your project, or:
```bash
# coming soon: pip install srift
curl -O https://srift.app/sdk/python/srift.py
```

## Use

```python
from srift import Srift

s = Srift()                                              # auto-targets http://127.0.0.1:3822
result = s.quick_share("/abs/path/file.zip")
print(result["shareUrl"])                                # → https://srift.app/join-session?id=ABC1234
```

## Async

```python
import asyncio
from srift import AsyncSrift

async def main():
    async with AsyncSrift() as s:
        r = await s.quick_share("/path/file.bin")
        print(r["shareUrl"])

asyncio.run(main())
```

## MCP HTTP transport

```python
from srift import SriftMCP

mcp = SriftMCP()
mcp.initialize()
print(mcp.tools())                                        # list of 14 tools
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
