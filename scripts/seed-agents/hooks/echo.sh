#!/usr/bin/env bash
# Exec hook for the echo seed: sends every text message back to its sender.
set -euo pipefail
cat >/dev/null

case "${SRIFT_PK_TYPE:-}" in
  message|text|chat) ;;
  *) exit 0 ;;
esac

text="${SRIFT_PK_TEXT:-}"
[ -n "$text" ] || exit 0
# shellcheck source=_guard.sh
source "$(dirname "${BASH_SOURCE[0]}")/_guard.sh"
reply_allowed || exit 0
exec srift pk send "$SRIFT_PK_FROM" "echo: ${text:0:4000}"
