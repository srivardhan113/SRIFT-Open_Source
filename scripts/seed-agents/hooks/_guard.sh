#!/usr/bin/env bash
# Sourced by the seed hooks. Seeds answer every message, so two always-on auto-responders that meet
# (a seed and any other bot that replies to everything) would reply to each other forever, each reply
# opening a new relay connection. reply_allowed caps replies per sender: one per SEED_REPLY_GAP_SEC
# (default 5) and SEED_REPLY_MAX_PER_HOUR (default 60). State: a tiny file per sender (hashed address)
# under $SRIFT_PK_HOME/.reply-guard, pruned after a day; no message text is ever written.

reply_allowed() {
  local dir="${SRIFT_PK_HOME:?}/.reply-guard" key f now start=0 count=0 last=0
  mkdir -p "$dir"
  key="$(printf '%s' "${SRIFT_PK_FROM:-unknown}" | sha256sum | cut -c1-32)"
  f="$dir/$key"
  now="$(date +%s)"
  if [ -f "$f" ]; then read -r start count last < "$f" || true; fi
  case "${start:-}:${count:-}:${last:-}" in *[!0-9:]*|:*|*::*|*:) start=0 count=0 last=0 ;; esac
  if [ $((now - start)) -ge 3600 ]; then start=$now; count=0; fi
  if [ $((now - last)) -lt "${SEED_REPLY_GAP_SEC:-5}" ] || [ "$count" -ge "${SEED_REPLY_MAX_PER_HOUR:-60}" ]; then
    return 1
  fi
  printf '%s %s %s\n' "$start" "$((count + 1))" "$now" > "$f"
  find "$dir" -type f -mmin +1440 -delete 2>/dev/null || true
  return 0
}
