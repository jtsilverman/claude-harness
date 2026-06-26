#!/usr/bin/env bash
# Test: test-pass-gate PreToolUse hook denies a `git commit` when the project's
# declared `Test command:` (in CLAUDE.md) fails -- unless the commit is RED
# (staged set is test-only). No declaration -> no-op. Non-commit -> no-op.
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-pass-gate.sh"
fail=0
chk() { if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1"; fail=1; fi; }

mkrepo() { # mkrepo <test-exit-code> -> echoes repo path with CLAUDE.md declaring the cmd
  local rc="$1" r; r=$(mktemp -d)
  git -C "$r" init -q; git -C "$r" config user.email t@t.t; git -C "$r" config user.name t
  printf 'def test_a():\n    pass\n' > "$r/test_a.py"
  printf 'x=1\n' > "$r/impl.py"
  git -C "$r" add -A; git -C "$r" commit -qm init
  printf '# Proj\nTest command: `bash run-tests.sh`\n' > "$r/CLAUDE.md"
  printf '#!/usr/bin/env bash\nexit %s\n' "$rc" > "$r/run-tests.sh"; chmod +x "$r/run-tests.sh"
  git -C "$r" add CLAUDE.md run-tests.sh; git -C "$r" commit -qm tooling
  echo "$r"
}
decision() { # decision <repo> <command>
  jq -n --arg c "$2" --arg d "$1" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' \
    | bash "$HOOK" 2>/dev/null | jq -r '.hookSpecificOutput.permissionDecision // "none"' 2>/dev/null || echo none
}

# Failing tests + impl staged -> deny
pass_repo=$(mkrepo 0); fail_repo=$(mkrepo 1)
trap 'rm -rf "$pass_repo" "$fail_repo"' EXIT
printf 'x=2\n' > "$fail_repo/impl.py"; git -C "$fail_repo" add impl.py
chk "impl commit, tests fail -> deny"   '[ "$(decision "$fail_repo" "git commit -m x")" = "deny" ]'

# RED commit (only a test staged) skips the gate even when tests fail
git -C "$fail_repo" reset -q
printf 'def test_b():\n    assert False\n' > "$fail_repo/test_b.py"; git -C "$fail_repo" add test_b.py
chk "RED test-only commit -> allow"     '[ "$(decision "$fail_repo" "git commit -m RED")" != "deny" ]'

# Passing tests + impl staged -> allow
printf 'x=2\n' > "$pass_repo/impl.py"; git -C "$pass_repo" add impl.py
chk "impl commit, tests pass -> allow"  '[ "$(decision "$pass_repo" "git commit -m x")" != "deny" ]'

# No declaration -> no-op
noproj=$(mktemp -d); git -C "$noproj" init -q
git -C "$noproj" config user.email t@t.t; git -C "$noproj" config user.name t
printf 'x=1\n' > "$noproj/impl.py"; git -C "$noproj" add impl.py
trap 'rm -rf "$pass_repo" "$fail_repo" "$noproj"' EXIT
chk "no Test command declared -> allow" '[ "$(decision "$noproj" "git commit -m x")" != "deny" ]'

# Non-commit Bash -> no-op
chk "non-commit Bash -> allow"          '[ "$(decision "$fail_repo" "git status")" != "deny" ]'

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILURES"; exit 1; }
