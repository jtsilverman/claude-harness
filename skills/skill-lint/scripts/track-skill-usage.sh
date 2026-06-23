#!/usr/bin/env bash
# track-skill-usage.sh — PostToolUse hook for the Skill tool.
# Reads a JSON payload from stdin, increments invoked_count and refreshes
# last_used (UTC) for the named skill in the sidecar JSON.
# Concurrent writers serialize via mkdir-lock; final write is atomic-rename.

set -uo pipefail

SIDECAR="${SKILL_USAGE_SIDECAR:-$HOME/.claude/state/skill-usage.json}"
SIDECAR_DIR="$(dirname "$SIDECAR")"
mkdir -p "$SIDECAR_DIR"

payload=$(cat)
skill=$(printf '%s' "$payload" | jq -r '.tool_input.skill // empty')
[[ -z "$skill" ]] && exit 0
[[ "$skill" == *":"* ]] && exit 0  # plugin skills (e.g., superpowers:writing-skills) — out of scope

now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

LOCKDIR="$SIDECAR.lockdir"
attempts=0
while ! mkdir "$LOCKDIR" 2>/dev/null; do
  attempts=$((attempts + 1))
  if (( attempts > 500 )); then
    echo "track-skill-usage: lock acquisition timeout for $LOCKDIR" >&2
    exit 1
  fi
  sleep 0.01
done
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT INT TERM

if [[ -s "$SIDECAR" ]]; then
  current=$(cat "$SIDECAR")
else
  current=$(jq -n --arg t "$(date -u +%Y-%m-%d)" \
    '{version: 1, telemetry_started: $t, skills: {}}')
fi

updated=$(printf '%s' "$current" | jq \
  --arg s "$skill" \
  --arg now "$now" \
  '.skills[$s] = ((.skills[$s] // {invoked_count: 0, first_seen: $now}) | .invoked_count += 1 | .last_used = $now)')

tmp="$SIDECAR.tmp.$$"
printf '%s\n' "$updated" >"$tmp"
mv "$tmp" "$SIDECAR"
