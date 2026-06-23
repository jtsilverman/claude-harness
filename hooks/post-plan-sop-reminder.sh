#!/usr/bin/env bash
#
# PostToolUse hook (matcher: ExitPlanMode):
# Fires after the operator approves a plan. Injects a reminder into Claude's next
# turn that points at SOP Phase 2 (Specify) and the spec-collaboration
# skill, so Claude doesn't barrel from plan straight into execution
# without going through the spec / chunk-decomposition workflow.
#
# Non-blocking. Outputs JSON with hookSpecificOutput.additionalContext.
# Fail-open on any unexpected payload shape: exit 0 silently.

set -u

log() { echo "post-plan-sop-reminder.sh: $*" >&2; }

# ---- Read stdin.
input=$(cat 2>/dev/null || true)
if [ -z "$input" ]; then
  log "empty stdin, fail open"
  exit 0
fi

# ---- Parse tool_name (matcher safety check).
tool_name=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)
if [ "$tool_name" != "ExitPlanMode" ]; then
  exit 0
fi

# ---- Inject reminder into next turn.
# The additionalContext field is appended to Claude's context for the
# next assistant turn. Keep this short and concrete: pointers, not prose.
jq -n '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: (
      "PLAN ACCEPTED. Per ~/.claude/coo/coo-sop.md before execution:\n" +
      "\n" +
      "1. Phase 2 (Specify): invoke the spec-collaboration skill to convert this plan into a locked spec at <project>/specs/current.md (chunk decomposition, acceptance criteria, test strategy). The plan file at ~/.claude/plans/<slug>.md is the input; spec-collaboration consumes it.\n" +
      "2. Phase 2.5 (Branch setup): create feat/<spec-name> from main (skip if not a git repo).\n" +
      "3. Phase 3 (Scaffold): per chunk, run recall then chunk-kickoff (the operator states what the chunk will do; Claude classifies tier) before any implementation.\n" +
      "4. Phase 4 (Execute): one chunk at a time. Stop on scope drift. Two failed attempts = reset-or-decompose, no third patch.\n" +
      "5. Phase 5/6/6.5 (Verify, Commit, Capture): run the chunk-end self-check at every chunk boundary (disciplines/worker-discipline.md). capture-learning routes lessons to memory or wiki.\n" +
      "\n" +
      "EXCEPTION: skip the spec/chunk workflow only when the work is genuinely trivial (typo, comment, single-line rename, formatting). The plan you just accepted is non-trivial by definition (it justified plan mode), so the default is: invoke spec-collaboration next.\n" +
      "\n" +
      "ANTI-PATTERN: writing a stub spec yourself to clear the workflow. The spec is a contract the operator signs off on, not a checkbox. Use the skill; it forces the interrogation that a self-drafted stub skips.\n" +
      "\n" +
      "If the operator explicitly says \"skip the spec, just execute,\" honor that. Otherwise: spec-collaboration first."
    )
  }
}'

exit 0
