#!/usr/bin/env bash
# Plugin-skip test for track-skill-usage.sh.
# Synthetic payload with tool_input.skill = "superpowers:writing-skills"
# Asserts: sidecar gets NO entry for plugin-named skills (criterion 2).
# RED until track-skill-usage.sh adds the `:`-guard.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/../scripts/track-skill-usage.sh"
PLUGIN_SKILL="superpowers:writing-skills"

TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

export SKILL_USAGE_SIDECAR="$TMPDIR_TEST/skill-usage.json"

PAYLOAD=$(jq -n --arg s "$PLUGIN_SKILL" \
  '{tool_name: "Skill", tool_input: {skill: $s}}')

printf '%s' "$PAYLOAD" | "$HOOK_SCRIPT"

if [[ ! -f "$SKILL_USAGE_SIDECAR" ]]; then
  echo "PASS: sidecar not created (acceptable — script bailed before any write)"
  exit 0
fi

# If sidecar exists, ensure plugin skill has NO entry.
has_entry=$(jq --arg s "$PLUGIN_SKILL" 'has("skills") and (.skills | has($s))' "$SKILL_USAGE_SIDECAR")
if [[ "$has_entry" == "true" ]]; then
  echo "FAIL: plugin skill '$PLUGIN_SKILL' was added to sidecar"
  jq . "$SKILL_USAGE_SIDECAR"
  exit 1
fi

echo "PASS: plugin skill not added to sidecar"
