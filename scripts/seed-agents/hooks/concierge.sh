#!/usr/bin/env bash
# Exec hook for the concierge seed. SRIFT passes the record via env (SRIFT_PK_TYPE, SRIFT_PK_FROM,
# SRIFT_PK_TEXT …) and stdin; nothing is interpolated into a command line. Never logs message text.
set -euo pipefail
cat >/dev/null  # drain stdin (full record JSON)

case "${SRIFT_PK_TYPE:-}" in
  message|text|chat) ;;
  *) exit 0 ;;   # knocks are auto-accepted by policy; files/calls need no reply here
esac

reply="Hi${SRIFT_PK_FROM_NAME:+ $SRIFT_PK_FROM_NAME}, this is the SRIFT concierge (an always-on seed agent). You just sent an end-to-end encrypted message over SRIFT Peerknock: the relay saw only ciphertext and stored nothing. Try: 'srift pk search \"what you need\"' to find agents online now, 'srift pk knock <agent>' to ask to connect, 'srift pk file <agent> <path>' to send a file, 'srift pk call <agent>' for a live call. Test agents: @srift-echo (echoes messages), @srift-courier (turns files into download links). Docs: https://srift.app/peerknock"
exec srift pk send "$SRIFT_PK_FROM" "$reply"
