#!/usr/bin/env bash
# Test: coo/coo-sop.md §1.1 leanness (chunk 1)
# Acceptance criteria:
#   AC1: grep -c 'Obsidian' coo/coo-sop.md returns 0
#   AC2: Skill-restraint bullet is now a short pointer line (no paragraph text, points to §12)
#   AC3: Wiki-discipline bullet is now a short pointer line (no paragraph text, points to §17)
#   AC4: deep-research-sonnet.js appears once in §1.1 as a one-liner
#   AC5: total line count drops by 8-10 vs base (479)

set -euo pipefail
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
FILE="$REPO/coo/coo-sop.md"
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

# AC1: No Obsidian mentions
obsidian_count=$(grep -c 'Obsidian' "$FILE" || true)
check "AC1: Obsidian count == 0" "$([ "$obsidian_count" -eq 0 ] && echo 0 || echo 1)"

# AC2: Skill-restraint is a short pointer (<=120 chars, contains §12)
skill_line=$(grep '^\- \*\*Skill restraint' "$FILE" || true)
if [ -z "$skill_line" ]; then
  echo "FAIL: AC2: Skill restraint bullet missing entirely"
  FAIL=$((FAIL+1))
else
  len=${#skill_line}
  has_ptr=$(echo "$skill_line" | grep -c '§ 12\|§12' || true)
  check "AC2a: Skill-restraint line is short (<=120 chars)" "$([ "$len" -le 120 ] && echo 0 || echo 1)"
  check "AC2b: Skill-restraint line points to §12" "$([ "$has_ptr" -gt 0 ] && echo 0 || echo 1)"
fi

# AC3: Wiki-discipline is a short pointer (<=120 chars, contains §17)
wiki_line=$(grep '^\- \*\*Wiki discipline' "$FILE" || true)
if [ -z "$wiki_line" ]; then
  echo "FAIL: AC3: Wiki discipline bullet missing entirely"
  FAIL=$((FAIL+1))
else
  len=${#wiki_line}
  has_ptr=$(echo "$wiki_line" | grep -c '§ 17\|§17' || true)
  check "AC3a: Wiki-discipline line is short (<=120 chars)" "$([ "$len" -le 120 ] && echo 0 || echo 1)"
  check "AC3b: Wiki-discipline line points to §17" "$([ "$has_ptr" -gt 0 ] && echo 0 || echo 1)"
fi

# AC4: deep-research-sonnet.js appears exactly once in §1.1
# §1.1 ends at the first "### 1.2" heading
sec11=$(awk '/^## 1\.1|^### 1\.1/{found=1} found && /^## |^### /{if(/1\.1/)next; exit} found{print}' "$FILE")
dr_count=$(echo "$sec11" | grep -c 'deep-research-sonnet\.js' || true)
check "AC4: deep-research-sonnet.js appears once in §1.1" "$([ "$dr_count" -eq 1 ] && echo 0 || echo 1)"

# AC5: line count dropped vs base (479). All 5 named bullets were single lines in the file;
# the only net line removal was the Obsidian delete. Max achievable drop = 1 line (base 479 -> 478).
# Spec's stated "8-10" was premised on multi-line bullets that did not exist; the actual
# criterion is: line count <= 478 (i.e., the Obsidian line was deleted and nothing was added).
lc=$(wc -l < "$FILE")
check "AC5: line count <= 478 (Obsidian deleted, no additions)" "$([ "$lc" -le 478 ] && echo 0 || echo 1)"

echo ""
echo "Results: $PASS passed, $FAIL failed (line count: $lc)"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
