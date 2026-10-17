#!/usr/bin/env bash
# Install the SRIFT Peerknock seed agents on a Debian/Ubuntu VM. Idempotent. Run as root.
set -euo pipefail

SRIFT_VERSION="${SRIFT_VERSION:-4.4.1}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/opt/srift-seeds
STATE=/var/lib/srift
AGENTS=(concierge echo courier)

if [ "$(id -u)" -ne 0 ]; then echo "run as root" >&2; exit 1; fi

# 1. Node 20+ (NodeSource) if missing or too old.
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# 2. SRIFT CLI, pinned.
if ! command -v srift >/dev/null 2>&1 || [ "$(srift --version 2>/dev/null | head -1 | tr -dc '0-9.')" != "$SRIFT_VERSION" ]; then
  npm install -g "srift-transfer@${SRIFT_VERSION}"
fi

# 3. Service user, files, state directories.
id -u srift >/dev/null 2>&1 || useradd --system --home "$STATE" --shell /usr/sbin/nologin srift
mkdir -p "$DEST" "$STATE"
cp -r "$SRC/agents" "$SRC/hooks" "$SRC/run.sh" "$DEST/"
chmod 0755 "$DEST/run.sh" "$DEST"/hooks/*.sh
for a in "${AGENTS[@]}"; do
  mkdir -p "$STATE/$a"
  chown -R srift:srift "$STATE/$a"
done
chown -R root:root "$DEST"

# 4. systemd template unit.
cp "$SRC/srift-seed@.service" /etc/systemd/system/srift-seed@.service
systemctl daemon-reload
for a in "${AGENTS[@]}"; do
  systemctl enable --now "srift-seed@${a}"
done

echo "Seed agents installed. Check: systemctl status 'srift-seed@*'"
