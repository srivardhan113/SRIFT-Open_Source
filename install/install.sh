#!/usr/bin/env sh
# SRIFT Universal Installer - macOS, Linux, WSL, Termux, any POSIX shell
# Usage: curl -fsSL https://srift.app/install.sh | sh
# Or:    curl -fsSL https://srift.app/install.sh | SRIFT_VERSION=2.2.2 sh
# Uninstall: curl -fsSL https://srift.app/install.sh | sh -s -- --uninstall
# Uninstall (purge all data): curl -fsSL https://srift.app/install.sh | sh -s -- --uninstall --purge
#
# What this does:
#   1. Detects OS + CPU architecture
#   2. Downloads the correct prebuilt binary from srift.app
#   3. Verifies SHA-256 checksum
#   4. Installs to ~/.srift/bin/srift
#   5. Adds ~/.srift/bin to PATH in your shell rc file
#   6. Runs srift doctor to verify the installation
#
# Environment overrides:
#   SRIFT_VERSION        - pin a specific version (default: latest)
#   SRIFT_INSTALL_DIR    - override install directory (default: ~/.srift/bin)
#   SRIFT_NO_MODIFY_PATH - set to 1 to skip PATH modification
#   SRIFT_NO_VERIFY      - set to 1 to skip checksum verification (not recommended)

set -eu

SRIFT_VERSION="${SRIFT_VERSION:-2.2.2}"
SRIFT_BASE_URL="https://srift.app/dl"
SRIFT_INSTALL_DIR="${SRIFT_INSTALL_DIR:-$HOME/.srift/bin}"
SRIFT_BIN="$SRIFT_INSTALL_DIR/srift"

# -- Colours ------------------------------------------------------------------
reset=''
bold=''
green=''
yellow=''
red=''
cyan=''
if [ -t 1 ]; then
  reset='\033[0m'
  bold='\033[1m'
  green='\033[32m'
  yellow='\033[33m'
  red='\033[31m'
  cyan='\033[36m'
fi

info()    { printf "${cyan}[srift]${reset} %s\n" "$*"; }
success() { printf "${green}[srift]${reset} ${bold}%s${reset}\n" "$*"; }
warn()    { printf "${yellow}[srift]${reset} %s\n" "$*"; }
error()   { printf "${red}[srift] ERROR:${reset} %s\n" "$*" >&2; exit 1; }

# -- Detect OS + Arch ---------------------------------------------------------
detect_target() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)

  case "$os" in
    linux)  os="linux" ;;
    darwin) os="darwin" ;;
    mingw*|msys*|cygwin*)
      error "You're on Windows under $os. Please run the PowerShell installer instead:
       irm https://srift.app/install.ps1 | iex
       (PowerShell, not Git Bash. Open Windows Terminal or PowerShell.)" ;;
    *)      error "Unsupported OS: $os. Use the manual install at https://srift.app/ai-agents#sdks" ;;
  esac

  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    armv7l) arch="arm" ;;
    *)      error "Unsupported CPU architecture: $arch" ;;
  esac

  echo "${os}-${arch}"
}

# -- Download helper - robust retry on 5xx + rustup-style security flags --
# Industry standard for Unix install scripts (verified from rustup, deno, bun):
# enforce HTTPS, require TLS >=1.2, set a meaningful UA, retry on 5xx.
download() {
  local url="$1"
  local dest="$2"
  local ua="srift-installer/${SRIFT_VERSION} ($(uname -s); $(uname -m))"
  if command -v curl >/dev/null 2>&1; then
    # --retry-all-errors retries on HTTP 5xx (curl 7.71+).
    # --proto =https + --tlsv1.2 are the rustup security recommendation.
    # Capability probe - fall back to plain --retry on ancient curl.
    if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then
      curl -fL \
           --proto '=https' --tlsv1.2 \
           -A "$ua" \
           --compressed \
           --retry 15 --retry-delay 4 --retry-all-errors \
           --connect-timeout 15 \
           -o "$dest" "$url"
    else
      # Manual retry loop for curl <7.71
      local i=0
      while [ $i -lt 15 ]; do
        if curl -fL --proto '=https' --tlsv1.2 -A "$ua" --connect-timeout 15 -o "$dest" "$url"; then return 0; fi
        i=$((i+1))
        [ $i -lt 15 ] && { echo "[srift] retry $i/15 in 4s..." >&2; sleep 4; }
      done
      return 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    wget -q -U "$ua" --tries=15 --waitretry=4 --retry-on-http-error=500,502,503,504 -O "$dest" "$url"
  else
    error "Neither curl nor wget found. Install one and retry."
  fi
}

# -- Verify SHA-256 ------------------------------------------------------------
verify_checksum() {
  local file="$1"
  local sums_file="$2"
  local basename
  basename=$(basename "$file")

  if [ "${SRIFT_NO_VERIFY:-0}" = "1" ]; then
    warn "Checksum verification skipped (SRIFT_NO_VERIFY=1). Not recommended."
    return 0
  fi

  local expected
  expected=$(grep " $basename$" "$sums_file" | cut -d' ' -f1)
  if [ -z "$expected" ]; then
    warn "No checksum found for $basename in SHA256SUMS. Skipping verification."
    return 0
  fi

  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$file" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$file" | cut -d' ' -f1)
  else
    warn "No sha256sum or shasum found. Skipping checksum verification."
    return 0
  fi

  if [ "$actual" != "$expected" ]; then
    error "Checksum mismatch for $basename!\n  Expected: $expected\n  Got:      $actual\nBinary may be corrupted. Re-run the installer."
  fi
}

# -- Add to PATH ---------------------------------------------------------------
add_to_path() {
  if [ "${SRIFT_NO_MODIFY_PATH:-0}" = "1" ]; then
    return 0
  fi

  local export_line="export PATH=\"\$HOME/.srift/bin:\$PATH\""
  local added=0

  # .bashrc
  if [ -f "$HOME/.bashrc" ]; then
    if ! grep -q '.srift/bin' "$HOME/.bashrc" 2>/dev/null; then
      printf '\n# SRIFT\n%s\n' "$export_line" >> "$HOME/.bashrc"
      added=1
    fi
  fi

  # .zshrc
  if [ -f "$HOME/.zshrc" ]; then
    if ! grep -q '.srift/bin' "$HOME/.zshrc" 2>/dev/null; then
      printf '\n# SRIFT\n%s\n' "$export_line" >> "$HOME/.zshrc"
      added=1
    fi
  fi

  # .profile (fallback)
  if [ "$added" = "0" ]; then
    if ! grep -q '.srift/bin' "$HOME/.profile" 2>/dev/null; then
      printf '\n# SRIFT\n%s\n' "$export_line" >> "$HOME/.profile"
    fi
  fi

  # Fish shell
  if [ -f "$HOME/.config/fish/config.fish" ]; then
    if ! grep -q '.srift/bin' "$HOME/.config/fish/config.fish" 2>/dev/null; then
      printf '\n# SRIFT\nfish_add_path ~/.srift/bin\n' >> "$HOME/.config/fish/config.fish"
    fi
  fi
}

# -- Uninstall -----------------------------------------------------------------
uninstall_srift() {
  local purge="${1:-0}"
  info "Uninstalling SRIFT..."

  # Stop daemon if running (best-effort)
  if command -v srift >/dev/null 2>&1 || [ -x "$SRIFT_BIN" ]; then
    local bin_cmd
    bin_cmd=$(command -v srift 2>/dev/null || echo "$SRIFT_BIN")
    if "$bin_cmd" daemon status --json 2>/dev/null | grep -q '"running":true' 2>/dev/null; then
      info "Stopping daemon..."
      "$bin_cmd" daemon stop 2>/dev/null || true
      sleep 1
    fi
  fi

  # Remove binary
  if [ -f "$SRIFT_BIN" ]; then
    rm -f "$SRIFT_BIN"
    success "Removed binary: $SRIFT_BIN"
  else
    warn "Binary not found at $SRIFT_BIN (may already be removed)."
  fi

  # Purge config/data directory
  if [ "$purge" = "1" ]; then
    local srift_dir="$HOME/.srift"
    if [ -d "$srift_dir" ]; then
      rm -rf "$srift_dir"
      success "Purged directory: $srift_dir"
    fi
  fi

  # Remove PATH entries from shell rc files
  local export_marker='.srift/bin'
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [ -f "$rc" ] && grep -q "$export_marker" "$rc" 2>/dev/null; then
      # Use a temp file to remove the SRIFT PATH block
      local tmp_rc
      tmp_rc=$(mktemp)
      grep -v "$export_marker" "$rc" | grep -v '^# SRIFT$' > "$tmp_rc" || true
      mv "$tmp_rc" "$rc"
      info "Cleaned PATH entry from: $rc"
    fi
  done

  if [ -f "$HOME/.config/fish/config.fish" ] && grep -q '.srift' "$HOME/.config/fish/config.fish" 2>/dev/null; then
    local tmp_fish
    tmp_fish=$(mktemp)
    grep -v 'srift' "$HOME/.config/fish/config.fish" > "$tmp_fish" || true
    mv "$tmp_fish" "$HOME/.config/fish/config.fish"
    info "Cleaned fish config."
  fi

  success "SRIFT uninstalled."
  if [ "$purge" != "1" ]; then
    info "Config + data at ~/.srift/ preserved. Re-run with --purge to also delete them."
  fi
  info "Reinstall: curl -fsSL https://srift.app/install.sh | sh"
}

# -- Main ----------------------------------------------------------------------
main() {
  # Handle --uninstall flag
  local do_uninstall=0
  local do_purge=0
  for arg in "$@"; do
    case "$arg" in
      --uninstall) do_uninstall=1 ;;
      --purge)     do_purge=1 ;;
    esac
  done

  if [ "$do_uninstall" = "1" ]; then
    uninstall_srift "$do_purge"
    return 0
  fi

  info "SRIFT Installer v${SRIFT_VERSION}"
  info "Detecting system..."

  local target
  target=$(detect_target)
  info "Detected: $target"

  # -- Internet connectivity check ------------------------------------------
  # Fail fast with a clear message instead of retrying download 15x into nothing.
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsS --max-time 8 --head https://srift.app/cli/version.json >/dev/null 2>&1; then
      error "Cannot reach https://srift.app - check your internet connection / proxy / firewall, then retry."
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -q --spider --timeout=8 https://srift.app/cli/version.json 2>/dev/null; then
      error "Cannot reach https://srift.app - check your internet connection / proxy / firewall, then retry."
    fi
  fi

  # -- Resolve actual latest version from the live CDN ----------------------
  # If the user pinned SRIFT_VERSION via env, honour it. Otherwise query
  # /cli/version.json so we install whatever is actually current right now
  # (handles the case where this script is older than the latest release).
  if [ -z "${SRIFT_VERSION_PINNED:-}" ] && [ -z "${_SRIFT_USER_PINNED:-}" ]; then
    local _remote_latest
    _remote_latest=$(curl -fsSL --max-time 10 https://srift.app/cli/version.json 2>/dev/null \
                     | sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
                     | head -1)
    if [ -n "$_remote_latest" ] && [ "$_remote_latest" != "$SRIFT_VERSION" ]; then
      info "Live latest is v${_remote_latest} (script baked in v${SRIFT_VERSION}). Using v${_remote_latest}."
      SRIFT_VERSION="$_remote_latest"
    fi
  fi

  # -- Idempotency: detect existing install + decide upgrade/skip/downgrade -
  local existing_version=""
  if [ -x "$SRIFT_BIN" ]; then
    existing_version=$("$SRIFT_BIN" --version 2>/dev/null \
                       | head -1 \
                       | sed -n 's/^srift[[:space:]]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')
  fi

  _version_cmp() {
    # Returns: 0=equal, 1=a<b, 2=a>b
    [ "$1" = "$2" ] && { echo 0; return; }
    local a_major=${1%%.*} a_rest=${1#*.}
    local a_minor=${a_rest%%.*} a_patch=${a_rest#*.}
    local b_major=${2%%.*} b_rest=${2#*.}
    local b_minor=${b_rest%%.*} b_patch=${b_rest#*.}
    if [ "${a_major:-0}" -lt "${b_major:-0}" ]; then echo 1; return; fi
    if [ "${a_major:-0}" -gt "${b_major:-0}" ]; then echo 2; return; fi
    if [ "${a_minor:-0}" -lt "${b_minor:-0}" ]; then echo 1; return; fi
    if [ "${a_minor:-0}" -gt "${b_minor:-0}" ]; then echo 2; return; fi
    if [ "${a_patch:-0}" -lt "${b_patch:-0}" ]; then echo 1; return; fi
    if [ "${a_patch:-0}" -gt "${b_patch:-0}" ]; then echo 2; return; fi
    echo 0
  }

  if [ -n "$existing_version" ]; then
    case "$(_version_cmp "$existing_version" "$SRIFT_VERSION")" in
      0)
        success "SRIFT v${existing_version} is already installed at $SRIFT_BIN - nothing to do."
        info "  Force re-install: rm '$SRIFT_BIN' && re-run this script"
        info "  Update later:     srift self-update"
        info "  Uninstall:        curl -fsSL https://srift.app/install.sh | sh -s -- --uninstall"
        "$SRIFT_BIN" doctor 2>/dev/null || true
        return 0
        ;;
      1)
        info "Upgrading SRIFT v${existing_version} -> v${SRIFT_VERSION} ..."
        ;;
      2)
        if [ "${SRIFT_ALLOW_DOWNGRADE:-0}" = "1" ]; then
          warn "Forcing downgrade from v${existing_version} to v${SRIFT_VERSION} (SRIFT_ALLOW_DOWNGRADE=1)."
        else
          warn "You already have v${existing_version}, which is NEWER than v${SRIFT_VERSION}."
          warn "  Not downgrading. To force, set SRIFT_ALLOW_DOWNGRADE=1 and re-run."
          info "  To go to the latest: srift self-update"
          return 0
        fi
        ;;
    esac
  else
    info "Fresh install of SRIFT v${SRIFT_VERSION} ..."
  fi

  # -- Pre-install cleanup - kill any running srift + remove stale installs --
  # Mirrors what `srift uninstall` does in 2.1.4+: kill processes, sweep PATH
  # for stale srift binaries elsewhere on the system, remove them, so the
  # new install is the ONLY srift on the box after this script finishes.
  if command -v pkill >/dev/null 2>&1; then pkill -x srift 2>/dev/null || true; fi
  if command -v killall >/dev/null 2>&1; then killall srift 2>/dev/null || true; fi
  # Scan every PATH dir for stale srift binaries (other than the install target)
  local stale_count=0
  if command -v which >/dev/null 2>&1; then
    # `which -a` lists every srift in PATH; busybox `which` may not support -a - fall back to PATH scan
    local found
    found=$(which -a srift 2>/dev/null || true)
    if [ -n "$found" ]; then
      printf '%s\n' "$found" | while IFS= read -r b; do
        # Skip the canonical install target
        case "$b" in "$SRIFT_BIN") continue ;; esac
        if [ -f "$b" ]; then
          warn "Removing stale install: $b"
          rm -f "$b" 2>/dev/null || true
          stale_count=$((stale_count + 1))
        fi
      done
    fi
  fi

  local tmp_dir
  tmp_dir=$(mktemp -d)
  local tmp_bin="$tmp_dir/srift"
  local tmp_sums="$tmp_dir/SHA256SUMS"

  # Build fallback list: requested version, then previous patches.
  # When a brand-new release like v2.1.5 is rolling out, the Cloudflare edge
  # cache in some POPs hasn't been populated yet - first request goes to
  # Cloud Run, which may cold-start 500 before the cache warms up. Falling
  # back to v2.1.4 / 2.1.3 (warm at every POP) sidesteps the race entirely.
  local _major=${SRIFT_VERSION%%.*}
  local _rest=${SRIFT_VERSION#*.}
  local _minor=${_rest%%.*}
  local _patch=${_rest#*.}
  local candidates="$SRIFT_VERSION"
  local _p=$((_patch - 1))
  while [ $_p -ge 0 ]; do
    candidates="$candidates ${_major}.${_minor}.${_p}"
    _p=$((_p - 1))
  done

  local used_version=""
  for v in $candidates; do
    local cand_url="${SRIFT_BASE_URL}/${v}/${target}/srift"
    if [ "$v" = "$SRIFT_VERSION" ]; then
      info "Downloading binary from $cand_url ..."
    else
      warn "Falling back to v${v} ($cand_url) - v${SRIFT_VERSION} is still propagating across CDN."
    fi
    if download "$cand_url" "$tmp_bin" 2>/dev/null; then
      used_version="$v"
      break
    fi
    warn "v${v} unreachable. Trying older version..."
  done
  if [ -z "$used_version" ]; then
    error "Download failed for every available version. Manual install: https://srift.app/ai-agents#sdks"
  fi
  local binary_url="${SRIFT_BASE_URL}/${used_version}/${target}/srift"
  local sums_url="${SRIFT_BASE_URL}/${used_version}/${target}/SHA256SUMS"
  if [ "$used_version" != "$SRIFT_VERSION" ]; then
    info "Installed v${used_version}. Run 'srift self-update' in 5-10 minutes to pick up v${SRIFT_VERSION} once the CDN warms up."
    SRIFT_VERSION="$used_version"
  fi

  info "Downloading checksums..."
  if download "$sums_url" "$tmp_sums" 2>/dev/null; then
    verify_checksum "$tmp_bin" "$tmp_sums"
    success "Checksum verified."
  else
    warn "Could not download SHA256SUMS. Skipping verification."
  fi

  # Install
  mkdir -p "$SRIFT_INSTALL_DIR"
  chmod +x "$tmp_bin"
  mv "$tmp_bin" "$SRIFT_BIN"
  rm -rf "$tmp_dir"

  success "Installed srift ${SRIFT_VERSION} -> $SRIFT_BIN"

  # PATH
  add_to_path

  # Verify binary runs
  if "$SRIFT_BIN" --version >/dev/null 2>&1 || "$SRIFT_BIN" version >/dev/null 2>&1; then
    local ver
    ver=$("$SRIFT_BIN" version 2>/dev/null || echo "srift ${SRIFT_VERSION}")
    success "Binary verified: $ver"
  else
    warn "Binary installed but could not execute '$SRIFT_BIN version'."
    warn "Debug info:"
    warn "  OS:   $(uname -s) / $(uname -m)"
    warn "  File: $(file "$SRIFT_BIN" 2>/dev/null || echo 'file command not found')"
    warn "  Size: $(wc -c < "$SRIFT_BIN" 2>/dev/null || echo '?') bytes"
    warn "Try running manually: $SRIFT_BIN version"
  fi

  # Run doctor to verify full installation
  info "Running post-install check (srift doctor)..."
  if "$SRIFT_BIN" doctor 2>/dev/null; then
    success "Post-install check passed."
  else
    warn "srift doctor reported issues - see above. Visit https://srift.app/ai-agents#troubleshooting"
  fi

  printf '\n'
  info "--------------------------------------------------------"
  info " SRIFT is installed! Next steps:"
  info ""
  info "  Restart your terminal (or run: source ~/.bashrc)"
  info ""
  info "  Then try:"
  info "    srift status                      # unified status view"
  info "    srift quick-share ./yourfile.zip  # share a file instantly"
  info "    srift info                        # agent integration overview"
  info "    srift install-mcp                 # MCP config for Claude/Cursor/etc."
  info ""
  info "  Update later:"
  info "    srift self-update"
  info ""
  info "  Uninstall:"
  info "    curl -fsSL https://srift.app/install.sh | sh -s -- --uninstall"
  info ""
  info "  Docs: https://srift.app/ai-agents"
  info "--------------------------------------------------------"
}

main "$@"
