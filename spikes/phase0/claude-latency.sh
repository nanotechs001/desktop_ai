#!/usr/bin/env bash
# Phase 0 spike (throwaway): p50 latency of 5 one-shot `claude -p` calls vs 5 messages through one long-lived stream-json process.
# Stops (exit 2) without retrying if the first call fails (e.g. not signed in). Never attempts a login.
set -u
CLAUDE=${CLAUDE:-claude}  # optional: CLAUDE_EXTRA="--strict-mcp-config ..." appended to both modes
PROMPT='Reply with {"ok":true}'
ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
p50() { sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}'; }
tmp=$(mktemp -d)
trap 'kill $pid 2>/dev/null; rm -rf "$tmp"' EXIT
pid=

oneshot=()
for i in 1 2 3 4 5; do
  s=$(ms)
  out=$($CLAUDE -p --model haiku --output-format json --no-session-persistence ${CLAUDE_EXTRA:-} "$PROMPT" 2>&1); rc=$?
  e=$(ms)
  if [ $rc -ne 0 ] || echo "$out" | grep -q '"is_error":true'; then
    echo "one-shot call $i failed (rc=$rc): $(echo "$out" | head -c 300)"; echo "NOT_SIGNED_IN_OR_FAILED: run pending"; exit 2
  fi
  oneshot+=($((e - s))); echo "one-shot $i: $((e - s)) ms"
done
echo "one-shot p50: $(printf '%s\n' "${oneshot[@]}" | p50) ms"

mkfifo "$tmp/in"
$CLAUDE -p --model haiku --input-format stream-json --output-format stream-json --verbose --no-session-persistence ${CLAUDE_EXTRA:-} < "$tmp/in" > "$tmp/out" 2>"$tmp/err" &
pid=$!
exec 3> "$tmp/in"
long=()
for i in 1 2 3 4 5; do
  s=$(ms)
  printf '{"type":"user","message":{"role":"user","content":"%s"}}\n' "Reply with {\\\"ok\\\":true}" >&3
  until [ "$(grep -c '"type":"result"' "$tmp/out")" -ge $i ]; do
    sleep 0.02
    [ $(($(ms) - s)) -gt 60000 ] && { echo "long-lived message $i timed out; stderr: $(head -c 300 "$tmp/err")"; exit 2; }
  done
  e=$(ms); long+=($((e - s))); echo "long-lived $i: $((e - s)) ms"
done
exec 3>&-
echo "long-lived p50: $(printf '%s\n' "${long[@]}" | p50) ms (message 1 includes process start)"
