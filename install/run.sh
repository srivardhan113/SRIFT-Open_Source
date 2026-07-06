#!/usr/bin/env sh
# SRIFT ephemeral runner - run ANY srift command with ZERO install.
#
#   curl -fsSL https://srift.app/run.sh | sh -s -- <srift args...>
#
# Examples:
#   curl -fsSL https://srift.app/run.sh | sh -s -- --version
#   curl -fsSL https://srift.app/run.sh | sh -s -- quick-share ./report.pdf
#   curl -fsSL https://srift.app/run.sh | sh -s -- session start --json
#
# Unlike install.sh, this NEVER touches your PATH and never installs anything
# permanently. The binary is cached under ~/.cache/srift/<version>/<target>/ and
# reused on later runs, so only the first invocation downloads. Ideal for CI,
# ephemeral containers, sandboxes, and "just run one command" usage.
#
# Env overrides:
#   SRIFT_VERSION    pin a version (default: latest from /cli/version.json)
#   SRIFT_CACHE_DIR  override cache location (default: ~/.cache/srift)
#   SRIFT_NO_VERIFY  set to 1 to skip checksum verification (not recommended)
set -eu

DEFAULT_VERSION="2.2.2"
BASE_URL="https://srift.app/dl"
CACHE_DIR="${SRIFT_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/srift}"

err() { printf '[srift-run] ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '[srift-run] %s\n' "$*" >&2; }

# -- Detect OS + CPU ----------------------------------------------------------
os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
arch=$(uname -m 2>/dev/null)
case "$os" in
  linux)  os="linux" ;;
  darwin) os="darwin" ;;
  mingw*|msys*|cygwin*)
    err "You're on Windows. Use the PowerShell runner instead:
       irm https://srift.app/run.ps1 | iex
       (or: powershell -c \"& ([scriptblock]::Create((irm https://srift.app/run.ps1))) --version\")" ;;
  *) err "Unsupported OS: $os" ;;
esac
case "$arch" in
  x86_64|amd64)   arch="x64" ;;
  aarch64|arm64)  arch="arm64" ;;
  armv7l)         arch="arm" ;;
  *) err "Unsupported CPU architecture: $arch" ;;
esac
target="${os}-${arch}"

# -- Resolve version (latest unless pinned) -----------------------------------
version="${SRIFT_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL --max-time 10 https://srift.app/cli/version.json 2>/dev/null \
            | sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [ -z "$version" ] && version="$DEFAULT_VERSION"
fi

bindir="$CACHE_DIR/$version/$target"
bin="$bindir/srift"
url="$BASE_URL/$version/$target/srift"

# -- Download + verify (only if not already cached) ---------------------------
download() {
  mkdir -p "$bindir"
  tmp="$bin.downloading.$$"
  info "fetching srift $version ($target) ..."
  if command -v curl >/dev/null 2>&1; then
    curl -fL --proto '=https' --tlsv1.2 --compressed \
         --retry 15 --retry-delay 4 --retry-all-errors --connect-timeout 15 \
         -o "$tmp" "$url" || { rm -f "$tmp"; err "download failed from $url"; }
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=15 --waitretry=4 -O "$tmp" "$url" || { rm -f "$tmp"; err "download failed from $url"; }
  else
    err "Neither curl nor wget found."
  fi

  if [ "${SRIFT_NO_VERIFY:-0}" != "1" ]; then
    sums=$(curl -fsSL --max-time 20 "$BASE_URL/$version/$target/SHA256SUMS" 2>/dev/null || true)
    expected=$(printf '%s\n' "$sums" | awk '/ srift$/{print $1; exit}')
    if [ -n "$expected" ]; then
      if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp" | cut -d' ' -f1)
      elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$tmp" | cut -d' ' -f1)
      else actual=""; fi
      if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
        rm -f "$tmp"
        err "checksum mismatch (expected $expected, got $actual). Aborting."
      fi
    fi
  fi
  chmod +x "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$bin"
}

[ -x "$bin" ] || download

# Hand off to the real binary with whatever args were passed after `--`.
exec "$bin" "$@"
