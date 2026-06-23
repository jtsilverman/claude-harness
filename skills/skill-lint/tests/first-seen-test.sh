#!/usr/bin/env bash
# first-seen-test.sh — chunk 4 acceptance: first-invocation auto-registration
# bakes first_seen == last_used; subsequent invocations leave first_seen
# untouched while last_used and invoked_count advance.
#
# Pure unit test: drives track-skill-usage.sh against an isolated sidecar via
# the SKILL_USAGE_SIDECAR env var; no harness wiring needed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../scripts/track-skill-usage.sh"

TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT
export SKILL_USAGE_SIDECAR="$TMPDIR_TEST/skill-usage.json"

fail() { echo "FAIL: $*" >&2; exit 1; }

fire() {
  printf '{"tool_input":{"skill":"%s"}}' "$1" | "$HOOK"
}

# --- T1: first invocation auto-registers with first_seen ---
fire "fresh-skill"
[[ -s "$SKILL_USAGE_SIDECAR" ]] || fail "T1: sidecar not created"

count=$(jq -r '.skills["fresh-skill"].invoked_count' "$SKILL_USAGE_SIDECAR")
[[ "$count" == "1" ]] || fail "T1: invoked_count expected 1, got $count"

first_seen=$(jq -r '.skills["fresh-skill"].first_seen // "MISSING"' "$SKILL_USAGE_SIDECAR")
last_used=$(jq -r '.skills["fresh-skill"].last_used // "MISSING"' "$SKILL_USAGE_SIDECAR")
[[ "$first_seen" != "MISSING" ]] || fail "T1: first_seen field is missing on auto-registration"
[[ "$first_seen" == "$last_used" ]] || fail "T1: first_seen ($first_seen) != last_used ($last_used) on first invocation"

# --- T2: subsequent invocation preserves first_seen, advances last_used ---
sleep 1  # ensure timestamps differ
fire "fresh-skill"

count2=$(jq -r '.skills["fresh-skill"].invoked_count' "$SKILL_USAGE_SIDECAR")
[[ "$count2" == "2" ]] || fail "T2: invoked_count expected 2, got $count2"

first_seen2=$(jq -r '.skills["fresh-skill"].first_seen' "$SKILL_USAGE_SIDECAR")
last_used2=$(jq -r '.skills["fresh-skill"].last_used' "$SKILL_USAGE_SIDECAR")
[[ "$first_seen2" == "$first_seen" ]] || fail "T2: first_seen mutated ($first_seen -> $first_seen2)"
[[ "$last_used2" != "$last_used" ]] || fail "T2: last_used did not advance ($last_used == $last_used2)"

# --- T3: telemetry_started is set at sidecar creation (verify chunk 1 wiring) ---
ts=$(jq -r '.telemetry_started // "MISSING"' "$SKILL_USAGE_SIDECAR")
[[ "$ts" != "MISSING" ]] || fail "T3: telemetry_started missing from sidecar"
[[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail "T3: telemetry_started not YYYY-MM-DD ($ts)"

echo "PASS: first-seen-test.sh (3 assertions)"
