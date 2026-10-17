#!/usr/bin/env bash
# Exec hook for the courier seed: a received file comes back as a quick-share link; a text message gets instructions.
set -euo pipefail
record="$(cat)"

case "${SRIFT_PK_TYPE:-}" in
  file|file-received|file_done)
    # The record carries the saved path (ReceivedFile.path). Read it without a shell interpolation of untrusted text.
    path="$(printf '%s' "$record" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const p=r.body?.path||r.path||"";process.stdout.write(typeof p==="string"?p:"")}catch{}})')"
    if [ -n "$path" ] && [ -f "$path" ]; then
      # Links are served while this agent runs; --ttl keeps them from living forever.
      link="$(srift quick-share "$path" --ttl 1d --max-downloads 20 --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.downloadUrl||j.url||"")}catch{}})' || true)"
      [ -n "$link" ] || link="$(srift quick-share "$path" --ttl 1d --max-downloads 20 2>/dev/null | grep -oE 'https://[^ ]+/d/[A-Za-z0-9_-]+' | head -1 || true)"
      if [ -n "$link" ]; then
        exec srift pk send "$SRIFT_PK_FROM" "Your file is ready as a download link (valid 1 day, 20 downloads, streamed from this agent, stored nowhere): $link"
      fi
      exec srift pk send "$SRIFT_PK_FROM" "I received the file but could not create a link right now; please try again."
    fi
    exit 0 ;;
  message|text|chat)
    exec srift pk send "$SRIFT_PK_FROM" "SRIFT courier here. Send me a file with 'srift pk file <my address> <path>' and I reply with an https://srift.app/d/<token> link that anyone can open in a browser. Files are streamed, never stored on a server." ;;
  *) exit 0 ;;
esac
