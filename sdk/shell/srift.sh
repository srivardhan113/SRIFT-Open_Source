#!/usr/bin/env bash
# SRIFT shell library — POSIX-ish, works on Bash 3+, Zsh, Ksh, Dash, BusyBox sh.
#
# Source it:
#   . /path/to/srift.sh
#   srift_quick_share /abs/path/file.zip
#
# Or use as a CLI:
#   ./srift.sh quick-share /abs/path/file.zip
#
# Runtime: needs curl + jq. (Falls back to curl + grep if jq is absent.)

SRIFT_BASE="${SRIFT_BASE_URL:-http://127.0.0.1:3822}"

# SRIFT SDK version, kept in sync with the project version by scripts/sync-version.mjs.
SRIFT_SDK_VERSION="4.1.0"

_srift_have_jq() { command -v jq >/dev/null 2>&1; }

_srift_get()  { curl -sS "$SRIFT_BASE$1"; }
_srift_post() { curl -sS -X POST "$SRIFT_BASE$1" -H 'Content-Type: application/json' -d "${2:-{\}}"; }

# JSON string literal for $1: escapes backslashes (Windows paths), quotes and
# control characters, so any message or path produces valid JSON.
_srift_json() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' |
    awk 'BEGIN { ORS = ""; printf "\"" } NR > 1 { printf "\\n" } { gsub(/\r/, "\\r"); print } END { printf "\"" }'
}

# Portable: `-o /dev/null` breaks some Windows curl builds (error 43).
srift_alive()         { curl -fsS "$SRIFT_BASE/status" >/dev/null 2>&1; }
srift_status()        { _srift_get /status; }
srift_state()         { _srift_get /state; }
srift_session_start() { _srift_post /session/start  "{\"sessionName\":$(_srift_json "${1:-cli-session}")}"; }
srift_session_join()  { _srift_post /session/join   "{\"sessionId\":$(_srift_json "$1"),\"username\":$(_srift_json "${2:-cli-guest}")}"; }
srift_session_close() { _srift_post /session/close; }
srift_approve()       { _srift_post /session/approve "{\"tempUserId\":$(_srift_json "$1")}"; }
srift_reject()        { _srift_post /session/reject  "{\"tempUserId\":$(_srift_json "$1"),\"reason\":$(_srift_json "${2:-rejected}")}"; }
srift_kick()          { _srift_post /session/kick    "{\"userId\":$(_srift_json "$1")}"; }
srift_send()          { _srift_post /send            "{\"filePath\":$(_srift_json "$1")}"; }
srift_receive()       { _srift_post /receive         "{\"fileId\":$(_srift_json "$1"),\"saveDir\":$(_srift_json "${2:-$(pwd)}")}"; }
srift_chat_send()     { _srift_post /chat/send       "{\"message\":$(_srift_json "$1")}"; }
srift_chat_history()  { _srift_get  /chat/history; }
srift_list()          { _srift_get  /status | { if _srift_have_jq; then jq '.activeTransfers'; else cat; fi; }; }

srift_quick_share() {
  local file="$1"; local name="${2:-AI-QuickShare}"
  local r; r=$(_srift_post /quick-share "{\"filePath\":$(_srift_json "$file"),\"sessionName\":$(_srift_json "$name")}")
  if _srift_have_jq; then
    echo "Share URL:  $(echo "$r" | jq -r .shareUrl)"
    echo "Session ID: $(echo "$r" | jq -r .sessionId)"
    echo "File ID:    $(echo "$r" | jq -r .fileId)"
  else
    echo "$r"
  fi
}

srift_monitor() {
  curl -sN -H 'Accept: text/event-stream' "$SRIFT_BASE/api/v1/monitor/events"
}

# CLI mode
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  cmd="$1"; shift || true
  case "$cmd" in
    quick-share) srift_quick_share "$@" ;;
    status)      srift_status ;;
    state)       srift_state ;;
    send)        srift_send "$@" ;;
    receive)     srift_receive "$@" ;;
    chat)        srift_chat_send "$@" ;;
    history)     srift_chat_history ;;
    list)        srift_list ;;
    monitor)     srift_monitor ;;
    *)           echo "Usage: $0 {quick-share|status|state|send|receive|chat|history|list|monitor} [args]" ; exit 1 ;;
  esac
fi
