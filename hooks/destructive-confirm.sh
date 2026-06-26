#!/usr/bin/env bash
#
# PreToolUse(Bash) hook: escalate hard-to-reverse commands to a user confirmation
# prompt (permissionDecision "ask"). Mirrors the destructive-ops list in
# rules/git-discipline.md. This is the irreversible-op gate: it does not hard-deny
# (legitimate destructive ops exist) -- it forces a deliberate confirm.
#
# FAILS OPEN: any parse error -> exit 0 with no output (normal permission flow).
# Verbose trace to stderr behind DESTRUCTIVE_CONFIRM_VERBOSE=1.

set -uo pipefail
v() { [ "${DESTRUCTIVE_CONFIRM_VERBOSE:-0}" = "1" ] && printf 'destructive-confirm: %s\n' "$*" >&2 || true; }

input=$(cat 2>/dev/null || true)
[ -z "$input" ] && { v "empty stdin, allow"; exit 0; }

tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)
[ "$tool" = "Bash" ] || { v "non-Bash tool ($tool), allow"; exit 0; }

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -z "$cmd" ] && { v "no command, allow"; exit 0; }

# Destructive patterns (extended regex, matched against the whole command).
patterns=(
  'git[[:space:]]+reset[[:space:]]+(.*[[:space:]])?--hard'
  'git[[:space:]]+push[[:space:]]+(.*[[:space:]])?(--force([[:space:]]|=|$)|--force-with-lease|-f([[:space:]]|$))'
  'git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f'
  'git[[:space:]]+branch[[:space:]]+(.*[[:space:]])?-D'
  'git[[:space:]]+filter-branch'
  'git[[:space:]]+filter-repo'
  'git[[:space:]]+rebase[[:space:]]+(.*[[:space:]])?-i([[:space:]]|$)'
  'git[[:space:]]+worktree[[:space:]]+remove[[:space:]]+(.*[[:space:]])?(--force|-f)([[:space:]]|$)'
  'git[[:space:]]+checkout[[:space:]]+(--[[:space:]]+)?\.([[:space:]]|$)'
  'git[[:space:]]+restore[[:space:]]+(--[[:space:]]+)?\.([[:space:]]|$)'
  'git[[:space:]]+restore[[:space:]]+(.*[[:space:]])?(--worktree|-[a-zA-Z]*W)([[:space:]].*)?[[:space:]]\.([[:space:]]|$)'
  '(^|[^[:alnum:]_])rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*r[a-zA-Z]*f'
  '(^|[^[:alnum:]_])rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*f[a-zA-Z]*r'
  '(^|[^[:alnum:]_])rm[[:space:]]+(.*[[:space:]])?-r([[:space:]].*)?[[:space:]]-f'
  '(^|[^[:alnum:]_])rm[[:space:]]+(.*[[:space:]])?-f([[:space:]].*)?[[:space:]]-r'
)

matched=""
for p in "${patterns[@]}"; do
  if printf '%s' "$cmd" | grep -Eq "$p"; then matched="$p"; break; fi
done
[ -z "$matched" ] && { v "no destructive pattern, allow"; exit 0; }

v "matched: $matched"
reason="Destructive / hard-to-reverse command (matches rules/git-discipline.md destructive-ops). Confirm the target and that the loss is intended before running."
jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: $r
  }
}'
exit 0
