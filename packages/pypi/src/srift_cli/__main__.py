"""Entry point for the `srift` console script.

Locates a Node.js >= 20 runtime — preferring the system `node` on PATH,
falling back to the prebuilt runtime provided by the `nodejs-wheel-binaries`
dependency — and forwards this process's argv, stdio, and exit code straight
through to the vendored SRIFT CLI bundle (``_vendor/index.js``).

Stdio must pass through byte-for-byte and unbuffered: `srift mcp` speaks
JSON-RPC over stdio, and anything this wrapper prints to stdout, or any
buffering it introduces, corrupts that protocol. Both code paths below rely
on the OS-level stdio inheritance of `os.execv` / `subprocess.run` (neither
of which touch this process's stdout/stderr buffers) rather than piping
through Python.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

_VENDOR_DIR = Path(__file__).resolve().parent / "_vendor"
_ENTRY = _VENDOR_DIR / "index.js"

# Keep in sync with `engines.node` in packages/cli/package.json.
_MIN_NODE_MAJOR = 20


def _node_major_version(node_bin: str) -> Optional[int]:
    """Return the major version of `node_bin`, or None if it can't be run."""
    try:
        result = subprocess.run(
            [node_bin, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    version = result.stdout.strip().lstrip("v")
    try:
        return int(version.split(".")[0])
    except (ValueError, IndexError):
        return None


def _find_system_node() -> Optional[str]:
    """Return a usable system `node` executable path (>= _MIN_NODE_MAJOR), or None.

    `SRIFT_NODE_BIN` forces a specific executable (or, if empty, forces the
    vendored fallback) — useful for testing and for pinning a specific
    runtime in CI/agent sandboxes.
    """
    override = os.environ.get("SRIFT_NODE_BIN")
    if override is not None:
        if not override:
            return None
        major = _node_major_version(override)
        return override if major is not None and major >= _MIN_NODE_MAJOR else None

    found = shutil.which("node")
    if not found:
        return None
    major = _node_major_version(found)
    return found if major is not None and major >= _MIN_NODE_MAJOR else None


def main() -> None:
    if not _ENTRY.exists():
        sys.stderr.write(
            f"srift: vendored CLI bundle is missing ({_ENTRY}); "
            "this wheel was built incorrectly. Reinstall `srift` from PyPI, "
            "or if you built it locally, run `python packages/pypi/build.py` first.\n"
        )
        raise SystemExit(1)

    args = sys.argv[1:]
    # Lets `srift doctor` report how it was launched ("pypi").
    os.environ.setdefault("SRIFT_RUNTIME", "pypi")
    system_node = _find_system_node()

    if system_node is not None:
        argv = [system_node, str(_ENTRY), *args]
        if os.name != "nt":
            # Replace this process outright — exact stdio/signal semantics,
            # zero Python left in the middle of the MCP stdio transport.
            os.execv(system_node, argv)
        # Windows has no execv-with-stdio-inheritance equivalent; subprocess
        # inherits stdio by default (no pipes) and we forward the exit code.
        completed = subprocess.run(argv)
        raise SystemExit(completed.returncode)

    # No suitable system Node.js — fall back to the vendored runtime. Use the
    # package's own `node()` helper (its own console-script entry point does
    # the same: `SystemExit(node(close_fds=False))`) rather than reaching into
    # its private path internals, so this wrapper stays forward-compatible
    # with how `nodejs-wheel-binaries` locates its bundled binary.
    from nodejs_wheel.executable import node as _run_vendored_node

    returncode = _run_vendored_node([str(_ENTRY), *args], close_fds=False)
    raise SystemExit(returncode)


if __name__ == "__main__":
    main()
