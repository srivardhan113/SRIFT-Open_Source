#!/usr/bin/env python3
"""Generate packages/pypi/README.md from the npm README (packages/cli/README.md).

The PyPI page and the npm page describe the same CLI, so the PyPI README is the
npm README with the Python-specific parts swapped in: title and badges, the
install section (uvx / pipx / pip), the CI example, the listings table, and a
short "how the Python package works" section. build.py runs this before every
build; `python packages/pypi/readme.py --check` exits 1 if README.md is stale.

Every substitution asserts its anchor exists, so a restructured npm README fails
loudly here instead of silently shipping a half-converted PyPI page.
"""

from __future__ import annotations

import sys
from pathlib import Path

PYPI_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PYPI_ROOT.parent.parent
NPM_README = REPO_ROOT / "packages" / "cli" / "README.md"
PYPI_README = PYPI_ROOT / "README.md"

HEADER = """# srift

[![PyPI version](https://img.shields.io/pypi/v/srift.svg?color=blue)](https://pypi.org/project/srift/)
[![npm version](https://img.shields.io/npm/v/srift-transfer.svg?color=blue)](https://www.npmjs.com/package/srift-transfer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python](https://img.shields.io/badge/python-%3E%3D3.9-brightgreen.svg)](https://www.python.org/)
"""

PYTHON_NOTE = """> **Python package.** `pip install srift` gives you the same `srift` command as the npm package
> [`srift-transfer`](https://www.npmjs.com/package/srift-transfer), with no separate Node.js install:
> it runs the official CLI bundle with your system `node` (20+) or a bundled Node.js runtime.
> Details in "How the Python package works" below.
"""

INSTALL = """## 🚀 Installation

### From PyPI (Python 3.9+, no Node.js required)
```bash
# Run once with no persistent install (recommended for MCP hosts):
uvx srift mcp

# Or install the `srift` command:
pipx install srift
pip install srift
```

### From npm (Node.js 20+)
```bash
npm install -g srift-transfer
```

### Standalone Binary (no Python or Node.js)
- **macOS / Linux / WSL / Termux (POSIX sh):**
  ```bash
  curl -fsSL https://srift.app/install.sh | sh
  ```
- **Windows PowerShell:**
  ```powershell
  irm https://srift.app/install.ps1 | iex
  ```

### MCP config without a persistent install
```json
{ "mcpServers": { "srift": { "command": "uvx", "args": ["srift", "mcp"] } } }
```
No `uv`? Use `"command": "pipx", "args": ["run", "srift", "mcp"]`. For AgentNet: `"args": ["srift", "agentnet", "mcp"]`.

---

"""

HOW_IT_WORKS = """## 🐍 How the Python package works

- It is a thin wrapper, not a Python reimplementation: it ships the same JavaScript bundle as the npm package
  (built from the same `cli/index.ts` + `cli/daemon.ts` sources, dependencies inlined) and runs it with your
  system `node` if it is 20 or newer, otherwise with the Node.js runtime from
  [`nodejs-wheel-binaries`](https://pypi.org/project/nodejs-wheel-binaries/).
- argv, stdin, stdout, stderr and the exit code are passed straight through, including the byte-exact
  JSON-RPC stdio stream of `srift mcp` and `srift agentnet mcp`.
- `webtorrent` (an optional large-file accelerator) is not bundled because of its native addons; SRIFT falls
  back to WebSocket-chunked transfer, so behaviour is otherwise identical to npm.
- The same package includes the Python **SDK** (a zero-dependency client for the local daemon's HTTP API):
  `from srift import Srift` — see [`sdk/python`](https://github.com/srivardhan113/SRIFT-Open_Source/tree/main/sdk/python).

---

"""


def _replace(text: str, old: str, new: str) -> str:
    if old not in text:
        raise SystemExit(f"[readme.py] anchor not found in packages/cli/README.md: {old[:70]!r}")
    return text.replace(old, new, 1)


def _replace_section(text: str, start: str, end: str, new: str) -> str:
    i = text.find(start)
    j = text.find(end, i + len(start)) if i >= 0 else -1
    if i < 0 or j < 0:
        raise SystemExit(f"[readme.py] section not found in packages/cli/README.md: {start!r} .. {end!r}")
    return text[:i] + new + text[j:]


def generate() -> str:
    src = NPM_README.read_text("utf-8").replace("\r\n", "\n")

    # Title + badges: everything before the tagline.
    tagline = src.index("> **Zero-config")
    out = HEADER + "\n" + src[tagline:]
    out = _replace(out, "🌐 **Web Platform:**", PYTHON_NOTE + "\n🌐 **Web Platform:**")

    out = _replace(out, "### 🖥️ Headless Server & Cloud Container File Delivery via npm / npx",
                   "### 🖥️ Headless Server & Cloud Container File Delivery via pip / uvx")
    out = _replace(out, "npx srift-transfer quick-share ./build/app-release.tar.gz --once --ttl 1h --wait",
                   "uvx srift quick-share ./build/app-release.tar.gz --once --ttl 1h --wait")
    out = _replace(out, "Install via npm (`npm install -g srift-transfer` or `npx`)",
                   "Install via PyPI (`pip install srift` or `uvx srift`), npm (`npm install -g srift-transfer`)")

    out = _replace_section(out, "## 🚀 Installation", "## 🛠 Model Context Protocol (MCP) Setup", INSTALL)
    out = _replace(out, "## 🔗 Links & Resources", HOW_IT_WORKS + "## 🔗 Links & Resources")

    out = _replace(out, "| npm | [`srift-transfer`](https://www.npmjs.com/package/srift-transfer) |",
                   "| PyPI | [`srift`](https://pypi.org/project/srift/) |\n"
                   "| npm | [`srift-transfer`](https://www.npmjs.com/package/srift-transfer) |")
    out = _replace(out, "All resolve to the same product. Install `srift-transfer`; the command is `srift`.",
                   "All resolve to the same product. `pip install srift` (or `npm i -g srift-transfer`); the command is `srift`.")
    # Ownership marker the MCP registry looks for before listing the PyPI package (server.json).
    return out.rstrip("\n") + "\n\n<!-- mcp-name: app.srift/srift -->\n"


def main() -> None:
    content = generate()
    current = PYPI_README.read_text("utf-8").replace("\r\n", "\n") if PYPI_README.exists() else ""
    if "--check" in sys.argv:
        if current != content:
            print("[readme.py] packages/pypi/README.md is stale; run: python packages/pypi/readme.py", file=sys.stderr)
            raise SystemExit(1)
        print("[readme.py] packages/pypi/README.md is up to date")
        return
    if current != content:
        PYPI_README.write_text(content, "utf-8", newline="\n")
        print("[readme.py] wrote packages/pypi/README.md from packages/cli/README.md")
    else:
        print("[readme.py] packages/pypi/README.md already up to date")


if __name__ == "__main__":
    main()
