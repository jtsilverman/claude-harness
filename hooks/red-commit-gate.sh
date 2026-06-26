#!/usr/bin/env bash
#
# PreToolUse(Bash) hook: the RED gate as a git-state check. When a `git commit`
# stages a DELETION of a committed test file, escalate to a confirm prompt
# (permissionDecision "ask"). Tests live in git so they cannot be silently
# removed/gutted; legitimate obsolete-test removal still passes on confirm.
# Adding tests (the RED commit) and deleting non-tests are untouched.
#
# FAILS OPEN: any parse/git error -> exit 0, no output. Verbose behind
# RED_COMMIT_GATE_VERBOSE=1.

set -uo pipefail
v() { [ "${RED_COMMIT_GATE_VERBOSE:-0}" = "1" ] && printf 'red-commit-gate: %s\n' "$*" >&2 || true; }

is_test() { # path -> 0 if it looks like a test file
  printf '%s' "$1" | grep -Eq '(^|/)(tests?|__tests__)/' && return 0
  printf '%s' "$1" | grep -Eq '(^|/)test_[^/]+\.(py|sh)$' && return 0
  printf '%s' "$1" | grep -Eq '[._-]test\.(py|sh|mjs|js|ts|tsx)$' && return 0
  printf '%s' "$1" | grep -Eq '[A-Za-z0-9]Test\.(java|kt|cs)$' && return 0
  return 1
}

input=$(cat 2>/dev/null || true)
[ -z "$input" ] && exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)
[ "$tool" = "Bash" ] || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
printf '%s' "$cmd" | grep -Eq '\bgit[[:space:]]+commit\b' || { v "not a git commit, allow"; exit 0; }

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
[ -n "$cwd" ] && [ -d "$cwd" ] || { v "no cwd, allow"; exit 0; }
git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1 || { v "not a git repo, allow"; exit 0; }

# Staged deletions (D) and rename-sources (R...) of test files.
deleted_tests=()
while IFS=$'\t' read -r status path rest; do
  case "$status" in
    D) is_test "$path" && deleted_tests+=("$path") ;;
    R*) is_test "$path" && deleted_tests+=("$path (renamed away)") ;;
  esac
done < <(git -C "$cwd" diff --cached --name-status 2>/dev/null)

[ "${#deleted_tests[@]}" -eq 0 ] && { v "no staged test deletions, allow"; exit 0; }

list=$(printf '%s; ' "${deleted_tests[@]}")
v "staged test deletions: $list"
reason="RED gate: this commit removes committed test(s): ${list}. Confirm the test is genuinely obsolete (delete-what-you-obsolete), not a silent test gutting."
jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: $r
  }
}'
exit 0
