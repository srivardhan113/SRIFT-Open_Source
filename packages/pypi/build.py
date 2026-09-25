#!/usr/bin/env python3
"""Build the `srift` PyPI wheel + sdist.

Steps:
  1. Bundle cli/{index,daemon}.ts (esbuild, deps inlined) into
     src/srift_cli/_vendor/{index,daemon}.js — see scripts/bundle.mjs.
  2. Assert this package's version matches packages/cli/package.json (the
     source of truth for the CLI's version across every published surface).
  3. Regenerate README.md from the npm README (see readme.py), so the PyPI and
     npm pages always match, and copy the Python SDK (sdk/python/srift.py) to
     src/srift.py so `pip install srift` also provides `from srift import Srift`.
  4. Run `python -m build` to produce dist/*.whl and dist/*.tar.gz.

Usage:
    python packages/pypi/build.py [--skip-bundle] [--skip-build]

Requires: Node.js + this repo's node_modules (for step 1), and the `build`
package (`pip install build`) for step 3.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

PYPI_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PYPI_ROOT.parent.parent


def run(cmd: list[str], **kwargs) -> None:
    print(f"[build.py] $ {' '.join(cmd)}")
    subprocess.run(cmd, check=True, cwd=str(REPO_ROOT), **kwargs)


def bundle() -> None:
    run(["node", str(PYPI_ROOT / "scripts" / "bundle.mjs")])


def check_version_sync() -> str:
    cli_pkg = json.loads((REPO_ROOT / "packages" / "cli" / "package.json").read_text("utf-8"))
    cli_version = cli_pkg["version"]

    pyproject_src = (PYPI_ROOT / "pyproject.toml").read_text("utf-8")
    match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', pyproject_src)
    if not match:
        print("[build.py] could not find version= in packages/pypi/pyproject.toml", file=sys.stderr)
        raise SystemExit(1)
    pypi_version = match.group(1)

    # A PyPI-only post-release (e.g. 4.0.0.post1, used to fix packaging or the
    # PyPI page without a new CLI release) still ships the same CLI version.
    if pypi_version != cli_version and not re.fullmatch(re.escape(cli_version) + r"\.post\d+", pypi_version):
        print(
            f"[build.py] version drift: packages/pypi/pyproject.toml version="
            f"'{pypi_version}' but packages/cli/package.json version='{cli_version}'. "
            "Sync them before building/publishing.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    return cli_version


def sync_sdk() -> None:
    """Copy the Python SDK (sdk/python/srift.py) into the wheel as `srift.py`."""
    src = REPO_ROOT / "sdk" / "python" / "srift.py"
    dst = PYPI_ROOT / "src" / "srift.py"
    data = src.read_bytes()
    if not dst.exists() or dst.read_bytes() != data:
        dst.write_bytes(data)
        print(f"[build.py] copied {src.relative_to(REPO_ROOT)} -> {dst.relative_to(REPO_ROOT)}")


def build_dist() -> None:
    run([sys.executable, "-m", "build", str(PYPI_ROOT)])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-bundle", action="store_true", help="reuse an existing _vendor/ bundle")
    parser.add_argument("--skip-build", action="store_true", help="bundle + verify only, skip `python -m build`")
    args = parser.parse_args()

    version = check_version_sync()
    print(f"[build.py] CLI version {version} (matches packages/cli/package.json)")

    import readme
    readme.main()
    sync_sdk()

    if not args.skip_bundle:
        bundle()
    else:
        print("[build.py] --skip-bundle: reusing existing src/srift_cli/_vendor/")

    if not args.skip_build:
        build_dist()
        print(f"[build.py] done -> {PYPI_ROOT / 'dist'}")
    else:
        print("[build.py] --skip-build: skipped `python -m build`")


if __name__ == "__main__":
    main()
