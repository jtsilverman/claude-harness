#!/usr/bin/env bash
# Test: destructive-confirm PreToolUse hook escalates destructive Bash commands
# to a confirmation prompt (permissionDecision "ask"); leaves everything else alone.
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/destructive-confirm.sh"
fail=0

# decision <command> -> prints the permissionDecision (or "none" if no JSON / allow)
decision() {
  local cmd="$1"
  local out
  out=$(jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c},cwd:"/tmp"}' | bash "$HOOK" 2>/dev/null)
  printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // "none"' 2>/dev/null || echo "none"
}
asks()  { if [ "$(decision "$1")" = "ask" ]; then echo "ok ask:  $1"; else echo "FAIL (want ask):  $1"; fail=1; fi; }
allows(){ if [ "$(decision "$1")" != "ask" ]; then echo "ok pass: $1"; else echo "FAIL (want pass): $1"; fail=1; fi; }

# Destructive -> ask
asks "git reset --hard HEAD~1"
asks "git push --force origin main"
asks "git push --force-with-lease"
asks "git push -f"
asks "git clean -fd"
asks "git branch -D feat/old"
asks "git filter-branch --tree-filter x"
asks "git rebase -i HEAD~3"
asks "git worktree remove --force .worktrees/x"
asks "rm -rf build/"
asks "rm -fr /tmp/x"
asks "git checkout -- ."
asks "git restore ."
asks "git restore --worktree ."
asks "git restore --staged --worktree ."

# Safe -> pass
allows "git status"
allows "git commit -m 'x'"
allows "git push origin feat/x"
allows "git reset HEAD file.txt"
allows "git branch -d merged"
allows "rm file.txt"
allows "rm -f single.txt"
allows "ls -la"
allows "git rebase main"
allows "git restore --staged ."
allows "git restore --staged file.txt"

# Non-Bash tool -> pass (no JSON)
non_bash=$(jq -n '{tool_name:"Edit",tool_input:{file_path:"/x"},cwd:"/tmp"}' | bash "$HOOK" 2>/dev/null)
if [ -z "$non_bash" ]; then echo "ok pass: non-Bash tool silent"; else echo "FAIL: non-Bash emitted output"; fail=1; fi

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILURES"; exit 1; }
