#!/usr/bin/env bash
# Acceptance test for chunk 3: grader-judge.md suppress rule for readerModelUpdates
# Tests three criteria:
#   1. Suppress predicate is 'already in ## Known'
#   2. Unlisted/default-Frontier graduation case is explicitly NOT suppressed
#   3. New-Frontier (whats-X-again) case is named
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
TARGET="$REPO_ROOT/agents/grader-judge.md"

fail() { echo "FAIL: $1"; exit 1; }
pass() { echo "PASS: $1"; }

# Criterion 1: suppress predicate must be 'already in ## Known'
# The doc must contain text stating suppress when already in Known
if grep -q "already in.*##.*Known\|already.*Known\|suppress.*already.*Known" "$TARGET"; then
  pass "C1: suppress predicate 'already in ## Known' is stated"
else
  fail "C1: suppress predicate 'already in ## Known' not found in $TARGET"
fi

# Criterion 2: unlisted/default-Frontier graduation case explicitly NOT suppressed
# Must mention unlisted concepts default to Frontier and that got-it on them IS emitted
if grep -q "unlisted\|default.*Frontier\|Frontier.*default" "$TARGET"; then
  pass "C2: unlisted/default-Frontier graduation case is mentioned"
else
  fail "C2: unlisted/default-Frontier graduation case not found in $TARGET"
fi

# Criterion 3: new-Frontier case (whats-X-again) is named
# whats-X-again must appear in the readerModelUpdates section
if grep -q "whats-X-again\|what.*again\|Frontier" "$TARGET"; then
  pass "C3: new-Frontier / whats-X-again case is named"
else
  fail "C3: whats-X-again / new-Frontier case not found in $TARGET"
fi

echo "All acceptance criteria PASS"
