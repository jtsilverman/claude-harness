#!/usr/bin/env bash
# Acceptance test for chunk 8: tdd-red skill must instruct RED to cover edgeCases field
# alongside acceptanceCriteria, framed as context (not a new numbered procedure step).
#
# Criteria:
#   A) The skill's step 1 reading instruction mentions edgeCases (or "edge cases") field
#   B) The mention is framed as context about what to test, NOT a new numbered TDD step

set -euo pipefail

SKILL="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)/skills/tdd-red/SKILL.md"

if [[ ! -f "$SKILL" ]]; then
  echo "FAIL: skills/tdd-red/SKILL.md not found at $SKILL"
  exit 1
fi

fail=0

# --- Criterion A: edgeCases mentioned in the reading/coverage instruction ---
# The chunk's requirement is that RED is told to read edgeCases field and let it
# shape what scenarios the test covers. We check for the phrase in the skill body.
if grep -qi "edgecase\|edge.case\|edge_case" "$SKILL"; then
  echo "PASS A: edgeCases / edge cases mentioned in skill"
else
  echo "FAIL A: no mention of edgeCases or edge cases in skill -- RED agent has no instruction to cover them"
  fail=1
fi

# --- Criterion B: framing is context, not a new numbered procedure step ---
# A new numbered step would look like "3." or "4." appearing before any edge-case
# mention in the Your lane section. We verify the edge-case text does NOT appear
# as a new standalone numbered bullet (i.e. not "^[0-9]+\." on the same or preceding line).
# Positive signal: the phrase appears adjacent to the existing step-1 read instruction,
# or introduced with context words like "include", "also read", "named", "cover".
# Negative signal: a new numbered step "N. Cover edge cases" is added.

# Count lines that look like new numbered steps mentioning edge cases
new_step_count=$(grep -c "^[0-9][0-9]*\.\s.*[Ee]dge.case" "$SKILL" || true)
if [[ "$new_step_count" -gt 0 ]]; then
  echo "FAIL B: edge cases introduced as a new numbered TDD step (count=$new_step_count) -- must be context, not procedure"
  fail=1
else
  echo "PASS B: edge cases not introduced as a new numbered step (context framing, not procedure)"
fi

if [[ "$fail" -eq 0 ]]; then
  echo "ALL PASS"
  exit 0
else
  exit 1
fi
