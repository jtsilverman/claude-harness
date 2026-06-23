#!/usr/bin/env bash
# Test: cross-ref repair for coo-doc-leanness chunk 3
#
# Behavior under test: After chunk 2, §2,11,12,13,14,16,17,18 live in
# coo/reference/manual.md. External files still referenced those sections at
# their old coo-sop.md locations. This chunk repoints every external dangling
# pointer so no file under ~/.claude/ cites a moved section as coming from
# coo-sop.md.
#
# Acceptance criteria:
#   AC1: No external file (outside the two authoritative sources and history dirs)
#        contains 'coo-sop.md § 16' — the Perplexity template ref moved to manual.md.
#   AC2: skills/spec-collaboration/SKILL.md Perplexity section now cites
#        coo/reference/manual.md (not coo-sop.md) for the template.
#   AC3: CLAUDE.md does NOT claim 'infrastructure' is a coo-sop topic without
#        acknowledging it moved to manual.md on the same line.
#   AC4: Full sweep — no active file contains 'coo-sop.md § N' where N is a
#        moved section number (2, 11, 12, 13, 14, 16, 17, 18).
#
# Edge cases:
#   - A reference to §6, §7, §8, §9, §15 (core sections that STAYED) must NOT
#     be rewritten — these are correct pointers. The test must not false-flag them.
#   - manual.md may reference its own sibling sections — exclude it from the sweep.
#   - coo-sop.md itself may reference manual.md by its moved section numbers
#     (the intra-doc pointer block) — exclude it from the sweep.
#   - specs/, ledgers/, session-reviews/, and archive/ contain historical prose
#     that describes the old state; they are read-only history, not active code.
#     Exclude them from AC4.
#   - This test lives in a worktree path that contains ".worktrees/"; exclusion
#     patterns must match on the file's relative path, not the absolute path, to
#     avoid filtering out every result.

set -euo pipefail
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SOP="$REPO/coo/coo-sop.md"
MANUAL="$REPO/coo/reference/manual.md"
SKILL="$REPO/skills/spec-collaboration/SKILL.md"
CLAUDE_MD="$REPO/CLAUDE.md"
PASS=0
FAIL=0

check() {
  local label="$1" result="$2"
  if [ "$result" = "0" ]; then
    echo "PASS: $label"
    PASS=$((PASS+1))
  else
    echo "FAIL: $label"
    FAIL=$((FAIL+1))
  fi
}

# Helper: is a path excluded from the active-code sweep?
# Excluded: the two authoritative sources, and history/log directories.
is_excluded() {
  local fp="$1"
  # Strip REPO prefix to get repo-relative path for pattern matching
  local rel="${fp#$REPO/}"
  [ "$fp" = "$SOP" ] && return 0
  [ "$fp" = "$MANUAL" ] && return 0
  # History and log directories (read-only narrative)
  echo "$rel" | grep -qE "^(specs|ledgers|session-reviews)/" && return 0
  # Archived specs
  echo "$rel" | grep -qE "/archive/" && return 0
  # The test script itself
  echo "$rel" | grep -qE "^scripts/coo_sop" && return 0
  return 1
}

# --- AC1: No external active file references §16 via coo-sop.md --------------
hits_ac1=0
hits_ac1_lines=""
while IFS= read -r filepath; do
  is_excluded "$filepath" && continue
  while IFS= read -r line; do
    if echo "$line" | grep -qE "coo-sop\.md\s*§\s*16"; then
      hits_ac1=$((hits_ac1+1))
      hits_ac1_lines="$hits_ac1_lines
    $filepath: $line"
    fi
  done < "$filepath"
done < <(find "$REPO" -type f \( -name "*.md" -o -name "*.sh" -o -name "*.py" -o -name "*.js" \) 2>/dev/null)

if [ "$hits_ac1" -ne 0 ]; then
  echo "FAIL: AC1: $hits_ac1 external file(s) still cite 'coo-sop.md § 16' (moved to manual.md):$hits_ac1_lines"
  FAIL=$((FAIL+1))
else
  echo "PASS: AC1: no external file cites 'coo-sop.md § 16' (Perplexity template moved to manual.md)"
  PASS=$((PASS+1))
fi

# --- AC2: spec-collaboration SKILL.md cites manual.md for the template --------
cites_manual=$(grep -c "coo/reference/manual\.md" "$SKILL" || true)
check "AC2: spec-collaboration SKILL.md cites coo/reference/manual.md" \
  "$([ "$cites_manual" -ge 1 ] && echo 0 || echo 1)"

# Also confirm the OLD coo-sop.md §16 reference is gone from the SKILL
old_ref=$(grep -cE "coo-sop\.md\s*§\s*16" "$SKILL" || true)
check "AC2b: spec-collaboration SKILL.md no longer cites coo-sop.md §16" \
  "$([ "$old_ref" -eq 0 ] && echo 0 || echo 1)"

# --- AC3: CLAUDE.md coo-sop.md pointer does not list 'infrastructure' alone --
# The line is a topic-descriptor, not a §-pointer. After the fix, the line must
# either (a) not mention 'infrastructure', or (b) also name manual.md so the
# reader knows where infra content now lives.
# Concrete check: find lines in CLAUDE.md that mention 'coo-sop.md' AND
# 'infrastructure'; each such line must also mention 'manual.md'.
bad_claude=0
bad_claude_lines=""
while IFS= read -r line; do
  if echo "$line" | grep -q "coo-sop\.md" && echo "$line" | grep -qi "infrastructure"; then
    if ! echo "$line" | grep -q "manual\.md"; then
      bad_claude=$((bad_claude+1))
      bad_claude_lines="$bad_claude_lines
    -> $line"
    fi
  fi
done < "$CLAUDE_MD"
if [ "$bad_claude" -ne 0 ]; then
  echo "FAIL: AC3: CLAUDE.md mentions coo-sop.md + infrastructure without naming manual.md:$bad_claude_lines"
  FAIL=$((FAIL+1))
else
  echo "PASS: AC3: CLAUDE.md coo-sop.md descriptor does not claim infrastructure without naming manual.md"
  PASS=$((PASS+1))
fi

# --- AC4: Full moved-section sweep -------------------------------------------
# No active file contains 'coo-sop.md § N' where N is a moved section:
# 2, 11, 12, 13, 14, 16, 17, 18.
# Core sections that stayed (1,3,4,5,6,7,8,9,10,15,19,20) must NOT be flagged.
dangling_total=0
dangling_report=""

while IFS= read -r filepath; do
  is_excluded "$filepath" && continue

  # Scan for moved-section § refs in coo-sop.md context
  while IFS= read -r line; do
    # Match: coo-sop.md § N where N is a moved section (word-boundary after N
    # so §1 does not match §11, §16 does not match §1)
    if echo "$line" | grep -qE "coo-sop\.md\s*§\s*(2|11|12|13|14|16|17|18)([^0-9.]|\.[0-9]|$)"; then
      dangling_total=$((dangling_total+1))
      dangling_report="$dangling_report
    ${filepath#$REPO/}: $line"
    fi
  done < "$filepath"

done < <(find "$REPO" -type f \( -name "*.md" -o -name "*.sh" -o -name "*.py" -o -name "*.js" \) 2>/dev/null)

if [ "$dangling_total" -ne 0 ]; then
  echo "FAIL: AC4: $dangling_total external dangling pointer(s) to moved sections:$dangling_report"
  FAIL=$((FAIL+1))
else
  echo "PASS: AC4: full sweep — no external file points at a moved section via coo-sop.md"
  PASS=$((PASS+1))
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
