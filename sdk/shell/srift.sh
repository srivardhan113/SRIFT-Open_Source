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
SRIFT_SDK_VERSION="4.4.0"

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
# Which transports work on this machine (direct P2P, TURN, WebSocket/HTTPS relay), with fixes. `srift_diagnose fresh` re-probes.
srift_diagnose()      { if [ "${1:-}" = fresh ]; then _srift_get "/v1/diag?fresh=1"; else _srift_get /v1/diag; fi; }
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

# srift_quick_share <file> [session-name] [--encrypt] [--password P] [--ttl-ms N] [--max-downloads N]
srift_quick_share() {
  local file="$1"; shift
  local name="AI-QuickShare"
  case "${1:-}" in --*|"") ;; *) name="$1"; shift ;; esac
  local extra=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --encrypt)       extra="$extra,\"encrypt\":true" ;;
      --password)      extra="$extra,\"password\":$(_srift_json "$2")"; shift ;;
      --ttl-ms)        extra="$extra,\"ttlMs\":$(printf '%d' "$2")"; shift ;;
      --max-downloads) extra="$extra,\"maxDownloads\":$(printf '%d' "$2")"; shift ;;
      *) echo "srift_quick_share: unknown option $1" >&2; return 2 ;;
    esac
    shift
  done
  local r; r=$(_srift_post /quick-share "{\"filePath\":$(_srift_json "$file"),\"sessionName\":$(_srift_json "$name")$extra}")
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
    diagnose)    srift_diagnose "$@" ;;
    send)        srift_send "$@" ;;
    receive)     srift_receive "$@" ;;
    chat)        srift_chat_send "$@" ;;
    history)     srift_chat_history ;;
    list)        srift_list ;;
    monitor)     srift_monitor ;;
    *)           echo "Usage: $0 {quick-share|status|state|diagnose|send|receive|chat|history|list|monitor} [args]" ; exit 1 ;;
  esac
fi
