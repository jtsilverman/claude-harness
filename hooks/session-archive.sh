#!/usr/bin/env bash
#
# SessionEnd hook: record a POINTER to the session just ended, for /learn.
#
# The lean archive does NOT copy transcripts (Claude Code already keeps them at
# their native transcript_path) and does NOT build a per-spec store. It writes
# one deterministic pointer file, <config_root>/state/last-session.json, that the
# SessionStart hook reads to offer /learn on the previous session.
#
# Reads the SessionEnd payload {session_id, transcript_path, cwd, ...} from stdin.
# Writes { transcript_path, cwd, session_id, lines } where `lines` is the .jsonl
# line count (the deterministic qualify signal: >= 100 lines -> substantial).
#
# FAILS OPEN: any error logs to stderr and exits 0. A teardown hook must never
# block a session from ending.

set -uo pipefail

input=$(cat 2>/dev/null || true)
[ -z "$input" ] && { echo "session-archive.sh: empty stdin, skipping" >&2; exit 0; }

transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)

# Self-locate config root: this file is <config_root>/hooks/session-archive.sh.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)
config_root=$(cd "${script_dir:-.}/.." 2>/dev/null && pwd || true)
[ -z "$config_root" ] && exit 0

# Deterministic qualify signal: line count of the native .jsonl (0 if unreadable).
lines=0
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  lines=$(wc -l < "$transcript_path" 2>/dev/null | tr -d ' ' || echo 0)
fi

state_dir="$config_root/state"
mkdir -p "$state_dir" 2>/dev/null || true

# Atomic write: tmp + mv, so a concurrent SessionStart never reads a half file.
tmp="$state_dir/.last-session.json.tmp.$$"
if jq -n \
    --arg tp "$transcript_path" \
    --arg cwd "$cwd" \
    --arg sid "$session_id" \
    --argjson lines "${lines:-0}" \
    '{transcript_path:$tp, cwd:$cwd, session_id:$sid, lines:$lines}' \
    > "$tmp" 2>/dev/null; then
  mv "$tmp" "$state_dir/last-session.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
else
  rm -f "$tmp" 2>/dev/null || true
fi

exit 0
