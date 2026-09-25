"""srift — thin Python wrapper around the Node.js SRIFT CLI.

This package does not reimplement SRIFT in Python. It vendors the same
JavaScript bundle published to npm as `srift-transfer` (see
``packages/cli/`` in the SRIFT monorepo) and runs it under a Node.js
runtime — either the system `node` (if >= 20 is on PATH) or the
prebuilt runtime pulled in via the `nodejs-wheel-binaries` dependency.

See :mod:`srift_cli.__main__` for the entry point.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "4.1.0"
