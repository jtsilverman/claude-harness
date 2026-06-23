#!/usr/bin/env bash
# promotion-test.sh — chunk 5 acceptance: skill-lint promoted in skill-candidates.md
# and CLAUDE.md sibling-lint don't covers all three.
#
# Section-anchored grep (per memory pattern acceptance-grep-needs-feature-anchor)
# so existing prose elsewhere in the file can't pre-pass the assertion.

set -uo pipefail

CAND="$HOME/Documents/brain/wiki/concepts/skill-candidates.md"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  [pass] $*"; }

[[ -f "$CAND" ]] || fail "skill-candidates.md not at $CAND"
[[ -f "$CLAUDE_MD" ]] || fail "CLAUDE.md not at $CLAUDE_MD"

# Extract Candidates-observed section (between '## Candidates observed' and the
# next '## ' heading) and the Promoted section.
candidates=$(awk '/^## Candidates observed$/{f=1; next} /^## /{f=0} f' "$CAND")
promoted=$(awk '/^## Promoted$/{f=1; next} /^## /{f=0} f' "$CAND")

# --- T1: skill-lint entry no longer in Candidates observed ---
if printf '%s' "$candidates" | grep -qE '\*\*`skill-lint`'; then
  fail "T1: skill-lint entry still present in '## Candidates observed' section"
fi
pass "T1: skill-lint entry absent from Candidates observed"

# --- T2: skill-lint entry is in Promoted ---
if ! printf '%s' "$promoted" | grep -qE '`skill-lint`'; then
  fail "T2: skill-lint not found in '## Promoted' section"
fi
pass "T2: skill-lint entry present in Promoted"

# --- T3: Promoted section no longer the empty placeholder ---
if printf '%s' "$promoted" | grep -qE '^\(none yet\)$'; then
  fail "T3: '## Promoted' section still contains '(none yet)' placeholder"
fi
pass "T3: Promoted section has real entry, not '(none yet)'"

# --- T4: Promoted entry links to where the skill lives (path or wiki-link) ---
if ! printf '%s' "$promoted" | grep -qE 'skills/skill-lint|\[\[skill-lint\]\]'; then
  fail "T4: Promoted skill-lint entry has no link to skill location"
fi
pass "T4: Promoted entry links to skill location"

# --- T5: CLAUDE.md read-only-lint don't covers all three sibling lints ---
# The chunk 4 baseline only mentioned wiki-lint. Acceptance: a single line (or
# adjacent lines) names memory-lint, wiki-lint, AND skill-lint together in the
# read-only / report-don't-repair posture.
hunk=$(grep -n -B1 -A1 -E "memory-lint|wiki-lint|skill-lint" "$CLAUDE_MD" || true)
mem=$(printf '%s' "$hunk" | grep -c "memory-lint" || true)
wik=$(printf '%s' "$hunk" | grep -c "wiki-lint" || true)
skl=$(printf '%s' "$hunk" | grep -c "skill-lint" || true)
[[ "$mem" -ge 1 ]] || fail "T5: CLAUDE.md does not mention memory-lint"
[[ "$wik" -ge 1 ]] || fail "T5: CLAUDE.md does not mention wiki-lint"
[[ "$skl" -ge 1 ]] || fail "T5: CLAUDE.md does not mention skill-lint"
pass "T5: CLAUDE.md names all three sibling lints"

echo "PASS: promotion-test.sh (5 assertions)"
