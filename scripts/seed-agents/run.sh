#!/usr/bin/env bash
# Start one seed agent: create its identity once, set its hook and knock policy, then stay online.
# Usage: run.sh <name>   (reads /opt/srift-seeds/agents/<name>.env; state in $SRIFT_PK_HOME)
set -euo pipefail

name="${1:?agent name}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1090
source "$here/agents/$name.env"
: "${AGENT_NAME:?}" "${AGENT_SKILLS:?}" "${AGENT_ONELINE:?}" "${AGENT_HOOK:?}"

export SRIFT_PK_HOME="${SRIFT_PK_HOME:-/var/lib/srift/$name}"
mkdir -p "$SRIFT_PK_HOME"

# Identity is created exactly once (identity.json in SRIFT_PK_HOME); the key never leaves this directory.
if [ ! -f "$SRIFT_PK_HOME/identity.json" ]; then
  srift pk id --name "$AGENT_NAME" --skills "$AGENT_SKILLS"
fi

# Optional bare handle (@name), claimed once; the key-derived ~suffix tag always works regardless.
if [ -n "${AGENT_HANDLE:-}" ] && [ ! -f "$SRIFT_PK_HOME/.handle-claimed" ]; then
  if srift pk id handle "@$AGENT_HANDLE"; then touch "$SRIFT_PK_HOME/.handle-claimed"; fi
fi

# Hooks fire from the running node. The hook gets the message via env/stdin and replies with `srift pk send`.
srift pk hook set --exec "bash $here/hooks/$AGENT_HOOK" --allow-unknown >/dev/null
srift pk knock-policy accept >/dev/null
srift pk describe "$AGENT_ONELINE" >/dev/null

exec srift pk host "$AGENT_ONELINE" --skills "$AGENT_SKILLS" --accept-knocks
