#!/usr/bin/env bash
# Stress test for track-skill-usage.sh atomic write.
# Fires N parallel invocations against a temp sidecar; asserts final count = N.
# RED until track-skill-usage.sh is implemented.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/../scripts/track-skill-usage.sh"
N=20
TEST_SKILL="stress-test-skill"

TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

export SKILL_USAGE_SIDECAR="$TMPDIR_TEST/skill-usage.json"

PAYLOAD=$(jq -n --arg s "$TEST_SKILL" \
  '{tool_name: "Skill", tool_input: {skill: $s}}')

pids=()
for i in $(seq 1 "$N"); do
  printf '%s' "$PAYLOAD" | "$HOOK_SCRIPT" &
  pids+=($!)
done

for pid in "${pids[@]}"; do
  wait "$pid" || true
done

if [[ ! -f "$SKILL_USAGE_SIDECAR" ]]; then
  echo "FAIL: sidecar not created at $SKILL_USAGE_SIDECAR"
  exit 1
fi

actual=$(jq -r --arg s "$TEST_SKILL" '.skills[$s].invoked_count // 0' "$SKILL_USAGE_SIDECAR")
if [[ "$actual" != "$N" ]]; then
  echo "FAIL: expected invoked_count=$N, got $actual"
  jq . "$SKILL_USAGE_SIDECAR" || cat "$SKILL_USAGE_SIDECAR"
  exit 1
fi

echo "PASS: invoked_count=$N after $N parallel invocations"
