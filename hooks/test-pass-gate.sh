#!/usr/bin/env bash
#
# PreToolUse(Bash) hook: the test-pass gate. When a `git commit` stages
# implementation code, run the project's declared test command and DENY the
# commit if it fails. The command is declared in the project CLAUDE.md as a line:
#     Test command: `<cmd>`
# No declaration -> no-op (safe by default; only opt-in projects are gated).
# RED commits (staged set is test-only, where a failing test is expected) skip.
#
# FAILS OPEN on parse/git errors -> exit 0. Verbose behind TEST_PASS_GATE_VERBOSE=1.
#
# SECURITY / TRUST BOUNDARY: the declared command is run via `eval`, so it is
# arbitrary code from the project's CLAUDE.md. This is intentional and bounded by
# trust: the harness ALREADY loads any repo's CLAUDE.md as instructions, so a repo
# you trust enough to work in is a repo whose declared test command you trust to
# run. Do NOT `git commit` inside a freshly-cloned UNTRUSTED repo before vetting its
# CLAUDE.md -- a malicious `Test command:` would execute here at commit time.

set -uo pipefail
v() { [ "${TEST_PASS_GATE_VERBOSE:-0}" = "1" ] && printf 'test-pass-gate: %s\n' "$*" >&2 || true; }

is_test() {
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
[ -n "$cwd" ] && [ -d "$cwd" ] || exit 0
git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1 || exit 0

claude_md="$cwd/CLAUDE.md"
[ -f "$claude_md" ] || { v "no project CLAUDE.md, allow"; exit 0; }
testcmd=$(grep -E '^Test command:' "$claude_md" 2>/dev/null | head -1 \
  | sed 's/^Test command:[[:space:]]*//; s/^`//; s/`[[:space:]]*$//')
[ -n "$testcmd" ] || { v "no Test command declared, allow"; exit 0; }

# Staged set. Empty -> nothing to gate. All-tests -> RED commit, skip.
staged=()
while IFS= read -r f; do staged+=("$f"); done < <(git -C "$cwd" diff --cached --name-only 2>/dev/null)
[ "${#staged[@]}" -eq 0 ] && { v "empty staged set, allow"; exit 0; }
all_tests=1
for f in "${staged[@]}"; do is_test "$f" || { all_tests=0; break; }; done
[ "$all_tests" -eq 1 ] && { v "RED commit (test-only staged), allow"; exit 0; }

v "running declared test command: $testcmd"
out=$(cd "$cwd" && eval "$testcmd" 2>&1); rc=$?
[ "$rc" -eq 0 ] && { v "tests pass, allow"; exit 0; }

tail=$(printf '%s' "$out" | tail -20)
reason="test-pass gate: \`${testcmd}\` failed (exit ${rc}) -- commit blocked. Fix the failing tests, then commit. Last output:
${tail}"
jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
