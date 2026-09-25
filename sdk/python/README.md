# SRIFT Python SDK

Zero-dependency Python client. `pip install srift` needs Python 3.9+; the single-file srift.py works on CPython 3.8+ (and PyPy), in every Python environment
(Lambda, Cloud Run, GKE, Colab, Jupyter, Databricks, SageMaker, RunPod, Modal, Replit, etc.).

## Install

```bash
pip install srift
```

The `srift` package on PyPI contains this SDK (`from srift import Srift`) and the `srift` command
(CLI + MCP server) — one install for both. Or drop the single file into your project; it has zero
dependencies:
```bash
curl -O https://srift.app/sdk/python/srift.py
```

> The same package gives you the `srift` command: `srift quick-share file.pdf`, or run the MCP
> server with `uvx srift mcp`. See [`srift` on PyPI](https://pypi.org/project/srift/).

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
