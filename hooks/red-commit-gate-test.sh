#!/usr/bin/env bash
# Test: red-commit-gate PreToolUse hook escalates (ask) a `git commit` whose
# staged diff DELETES a committed test file -- the "agents delete their own
# tests" guard. Adding tests, deleting non-tests, and non-commit Bash pass.
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/red-commit-gate.sh"
fail=0
chk() { if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1"; fail=1; fi; }

repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT
git -C "$repo" init -q
git -C "$repo" config user.email t@t.t; git -C "$repo" config user.name t
printf 'def test_x():\n    assert True\n' > "$repo/test_x.py"
printf 'print("impl")\n'                  > "$repo/impl.py"
printf 'notes\n'                          > "$repo/README.md"
git -C "$repo" add test_x.py impl.py README.md
git -C "$repo" commit -qm init

decision() { # decision <repo> <command>
  jq -n --arg c "$2" --arg d "$1" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' \
    | bash "$HOOK" 2>/dev/null | jq -r '.hookSpecificOutput.permissionDecision // "none"' 2>/dev/null || echo none
}

# Stage a deletion of the committed test -> ask
git -C "$repo" rm -q test_x.py
chk "deleting committed test -> ask"  '[ "$(decision "$repo" "git commit -m wip")" = "ask" ]'
chk "non-commit Bash passes"          '[ "$(decision "$repo" "git status")" != "ask" ]'
git -C "$repo" reset -q --hard

# Stage a deletion of a NON-test file -> pass
git -C "$repo" rm -q README.md
chk "deleting non-test -> pass"       '[ "$(decision "$repo" "git commit -m doc")" != "ask" ]'
git -C "$repo" reset -q --hard

# Rename a committed test away (R*) -> ask
git -C "$repo" mv test_x.py renamed_x.py
chk "renaming a test away -> ask"     '[ "$(decision "$repo" "git commit -m mv")" = "ask" ]'
git -C "$repo" reset -q --hard

# Stage an ADD of a new test (the RED commit) -> pass
printf 'def test_y():\n    assert False\n' > "$repo/test_y.py"
git -C "$repo" add test_y.py
chk "adding a failing test -> pass"   '[ "$(decision "$repo" "git commit -m RED")" != "ask" ]'
git -C "$repo" reset -q --hard; rm -f "$repo/test_y.py"

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILURES"; exit 1; }
