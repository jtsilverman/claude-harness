#!/usr/bin/env bash
# Test: coo/coo-sop.md manual split (chunk 2 of coo-doc-leanness)
#
# Behavior under test: 8 pure-reference sections (§2, §11, §12, §13, §14, §16,
# §17, §18) MOVE verbatim out of the always-injected coo/coo-sop.md into a new
# coo/reference/manual.md that the non-recursive coo/*.md session-start glob does
# NOT match. coo-sop.md keeps the operating core, gains a ## Reference manual
# pointer block, and every intra-coo-sop pointer to a moved section now names
# manual.md instead of dangling.
#
# Acceptance criteria (from the chunk spec):
#   AC1: coo/reference/manual.md exists and contains the §16.1 Perplexity template
#        AND the §18 SSH aliases.
#   AC2: the non-recursive coo/*.md glob does NOT list coo/reference/manual.md
#        (it sits in a subdir) -- proven against the SAME glob session-start.sh runs.
#   AC3: no intra-coo-sop pointer references a section number that now lives in
#        manual.md without naming manual.md (no dangling cross-ref).
#   AC4: coo-sop.md still contains §1, §5, §6, §7 (operating core retained).
#   AC5: coo-sop.md line count drops substantially (~130 lines moved out).
#
# Structural pins (intentionally green-in-RED once the move lands; they guard
# no-dangling-pointer, not feature-presence):
#   PIN: the moved-section bodies must NOT remain duplicated in coo-sop.md.

set -euo pipefail
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SOP="$REPO/coo/coo-sop.md"
MANUAL="$REPO/coo/reference/manual.md"
HOOK="$REPO/hooks/session-start.sh"
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

ok() { [ "$1" = "true" ] && echo 0 || echo 1; }

# --- AC1: manual.md exists and carries the §16.1 template + §18 aliases --------
if [ ! -f "$MANUAL" ]; then
  echo "FAIL: AC1: coo/reference/manual.md does not exist"
  FAIL=$((FAIL+1))
else
  echo "PASS: AC1a: coo/reference/manual.md exists"
  PASS=$((PASS+1))
  # §16.1 Perplexity template signature: the Deep Research spec-draft gate prompt.
  has_perplexity=$(grep -c 'Deep Research prompt: spec-draft gate' "$MANUAL" || true)
  check "AC1b: manual.md contains the §16.1 Perplexity Deep Research template" \
    "$([ "$has_perplexity" -ge 1 ] && echo 0 || echo 1)"
  # §18 SSH aliases signature: the mini alias line.
  has_ssh=$(grep -cE 'ssh mini.*admin@100\.102\.1\.27' "$MANUAL" || true)
  check "AC1c: manual.md contains the §18 SSH aliases (ssh mini)" \
    "$([ "$has_ssh" -ge 1 ] && echo 0 || echo 1)"
fi

# --- AC2: the non-recursive coo/*.md glob does NOT match manual.md ------------
# Run the EXACT glob session-start.sh uses ("$coo_dir"/*.md), not a hand-rolled
# find, so the test proves the real injection set excludes the subdir file.
matched_manual="false"
shopt -s nullglob
for f in "$REPO/coo"/*.md; do
  [ "$f" = "$MANUAL" ] && matched_manual="true"
done
shopt -u nullglob
check "AC2: non-recursive coo/*.md glob does NOT list coo/reference/manual.md" \
  "$([ "$matched_manual" = "false" ] && echo 0 || echo 1)"
# Belt-and-suspenders: confirm the glob the hook actually contains is the
# non-recursive single-star form (a recursive ** would sweep the subdir in).
hook_glob_nonrecursive=$(grep -cE '"\$coo_dir"/\*\.md' "$HOOK" || true)
check "AC2b: session-start.sh uses the non-recursive \"\$coo_dir\"/*.md glob" \
  "$([ "$hook_glob_nonrecursive" -ge 1 ] && echo 0 || echo 1)"

# --- AC3: no dangling intra-coo-sop pointer to a moved section ----------------
# Moved sections: 2, 11, 12, 13, 14, 16, 17, 18. A pointer to any of these inside
# coo-sop.md must either (a) name manual.md on the same line, or it is a dangling
# reference. We scan every line of coo-sop.md that contains a § ref to a moved
# section number and assert that line also names manual.md.
# Section-number tokens to detect (word-boundary on the trailing digit set so §1
# does not match §16, §1.1 does not match §12, etc.). We match "§ <n>" or "§<n>"
# optionally followed by a .<subsection>.
dangling=0
dangling_lines=""
while IFS= read -r line; do
  # Does this line reference a MOVED section number?
  if echo "$line" | grep -qE '§ ?(2|11|12|13|14|16|17|18)(\.[0-9]+)?([^0-9.]|$)'; then
    # It is allowed iff it names manual.md on the same line.
    if ! echo "$line" | grep -q 'manual\.md'; then
      dangling=$((dangling+1))
      dangling_lines="$dangling_lines
    -> $line"
    fi
  fi
done < "$SOP"
if [ "$dangling" -ne 0 ]; then
  echo "FAIL: AC3: $dangling intra-coo-sop pointer(s) to a moved section do not name manual.md:$dangling_lines"
  FAIL=$((FAIL+1))
else
  echo "PASS: AC3: every intra-coo-sop pointer to a moved section names manual.md (no dangling ref)"
  PASS=$((PASS+1))
fi

# --- AC4: operating core retained (§1, §5, §6, §7 still headings in coo-sop) --
core_ok="true"
for n in 1 5 6 7; do
  if ! grep -qE "^## $n\. " "$SOP"; then
    core_ok="false"
    echo "  missing core heading: ## $n."
  fi
done
check "AC4: coo-sop.md retains operating-core headings §1, §5, §6, §7" "$(ok "$core_ok")"

# --- AC5: substantial line-count drop ----------------------------------------
# Base coo-sop.md (post chunk-1) is 478 lines; ~130 lines move out. Require a
# drop to <= 360 lines (a substantial drop; end-state target ~330). The pointer
# block adds a handful of lines back, so we do not require the full 130 net.
lc=$(wc -l < "$SOP")
check "AC5: coo-sop.md line count dropped substantially (<= 360, was 478)" \
  "$([ "$lc" -le 360 ] && echo 0 || echo 1)"

# --- PIN: moved bodies are not duplicated back in coo-sop.md ------------------
# Each moved section had a distinctive body phrase; assert it is GONE from
# coo-sop.md (proves the body was deleted, not just headed-over). These are the
# anti-duplication guards: presence in both files is the slop this chunk avoids.
pin_dup=0
# §16.1 template (moved)
grep -q 'Deep Research prompt: spec-draft gate' "$SOP" && { echo "  dup: §16 Perplexity template still in coo-sop.md"; pin_dup=$((pin_dup+1)); }
# §18 SSH aliases (moved)
grep -qE 'ssh mini.*admin@100\.102\.1\.27' "$SOP" && { echo "  dup: §18 SSH aliases still in coo-sop.md"; pin_dup=$((pin_dup+1)); }
# §12 agentic primitives body (moved)
grep -q 'agentic primitives' "$SOP" 2>/dev/null && grep -q 'SUBAGENT: a separately-context-windowed worker' "$SOP" && { echo "  dup: §12 primitives body still in coo-sop.md"; pin_dup=$((pin_dup+1)); }
check "PIN: moved section bodies are not duplicated back into coo-sop.md" \
  "$([ "$pin_dup" -eq 0 ] && echo 0 || echo 1)"

echo ""
echo "Results: $PASS passed, $FAIL failed (coo-sop.md line count: $lc)"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
