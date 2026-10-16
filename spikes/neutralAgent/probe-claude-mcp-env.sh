#!/bin/sh
# Spike probe (verdict 2, hop claude -> stdio MCP): runs the REAL claude CLI in a clean env with a throwaway
# CLAUDE_CONFIG_DIR, a non-key and an unreachable local API base URL (no account, no network), and the
# --mcp-config JSON aioncore passes. probe-mcp.cjs records which env key names it was spawned with.
# Usage: probe-claude-mcp-env.sh '<mcp-config json>' <probe-out.jsonl>
set -eu
mcp="$1"; out="$2"
cfg=$(mktemp -d); work=$(mktemp -d)
: > "$out"
cd "$work"
env -i HOME="$HOME" PATH="$PATH" CLAUDE_CONFIG_DIR="$cfg" \
  ANTHROPIC_API_KEY=spike-not-a-key ANTHROPIC_BASE_URL=http://127.0.0.1:9 \
  AIONUI_CONVERSATION_ID=spike-conv AION_ARTIFACTS_URL=http://127.0.0.1:1 AION_ARTIFACTS_TOKEN=spike-dummy \
  perl -e 'alarm 60; exec @ARGV' claude --print "hi" --mcp-config "$mcp" < /dev/null 2>&1 | tail -3 || true
rmdir "$work" 2>/dev/null || true
rm -r "$cfg"
cat "$out"
