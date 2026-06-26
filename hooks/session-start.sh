#!/usr/bin/env bash
#
# SessionStart hook: offer /learn on the previous session + inject the active spec.
#
# Reads <config_root>/state/last-session.json (written by session-archive.sh on
# the previous SessionEnd). If that session was for THIS workspace (cwd match)
# and substantial (>= 100 .jsonl lines), it injects an instruction to run /learn
# on that transcript (the deterministic qualify gate; the agent decides nothing,
# the hook does). Below threshold, it injects a softer "ask whether to run /learn"
# note. Also injects each active per-project spec (named specs/*.md whose
# frontmatter has `status: active`) when present.
#
# Fires on source: startup | resume | clear (not compact). FAILS OPEN: errors
# log to stderr, exit 0 with no output. A broken hook must never block startup.

set -uo pipefail

input=$(cat 2>/dev/null || true)
[ -z "$input" ] && { echo "session-start.sh: empty stdin, skipping" >&2; exit 0; }

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
[ -z "$cwd" ] && { echo "session-start.sh: no cwd, skipping" >&2; exit 0; }

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)
config_root=$(cd "${script_dir:-.}/.." 2>/dev/null && pwd || true)

learn_part=""
state_file="$config_root/state/last-session.json"
if [ -n "$config_root" ] && [ -f "$state_file" ]; then
  # Read pointer fields. jq failures leave vars empty -> the block is skipped.
  prev_cwd=$(jq -r '.cwd // empty' "$state_file" 2>/dev/null || true)
  prev_tp=$(jq -r '.transcript_path // empty' "$state_file" 2>/dev/null || true)
  prev_lines=$(jq -r '.lines // 0' "$state_file" 2>/dev/null || echo 0)
  # Only offer /learn for the SAME workspace (sessions are siloed per project).
  if [ -n "$prev_tp" ] && [ "$prev_cwd" = "$cwd" ]; then
    if [ "${prev_lines:-0}" -ge 100 ] 2>/dev/null; then
      learn_part="PREVIOUS SESSION qualifies for /learn (${prev_lines} transcript lines). Run the \`learn\` skill on the previous transcript at: ${prev_tp} -- it returns a state summary (orient yourself from it) plus durable lessons. Do this before new work."
    else
      learn_part="PREVIOUS SESSION transcript at ${prev_tp} (${prev_lines} lines, below the auto-/learn threshold). Ask the user whether to run /learn on it; otherwise skim it for continuity."
    fi
  fi
fi

# Active per-project specs (cwd-relative, optional). Convention: a live spec is a
# named file in specs/ with `status: active` in its frontmatter; multiple may be
# active at once (two-at-a-time work). Archived/shipped specs are skipped.
spec_part=""
if [ -d "$cwd/specs" ]; then
  while IFS= read -r sp; do
    [ -f "$sp" ] || continue
    head -n 15 "$sp" 2>/dev/null | grep -qiE '^status:[[:space:]]*active[[:space:]]*$' || continue
    spec_part="${spec_part:+$spec_part

}ACTIVE SPEC ($sp):

$(cat "$sp" 2>/dev/null)"
  done < <(find "$cwd/specs" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort)
fi

# Emit. Nothing to say -> silent exit 0 (never malformed JSON).
ctx=""
[ -n "$learn_part" ] && ctx="$learn_part"
[ -n "$spec_part" ] && ctx="${ctx:+$ctx

}$spec_part"
[ -z "$ctx" ] && exit 0

jq -n --arg ctx "$ctx" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
exit 0
