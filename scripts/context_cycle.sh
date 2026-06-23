#!/usr/bin/env bash
# context_cycle.sh -- the cockpit's auto-context-cycling self-check (chunk 11).
#
# The long-running cockpit (COO) session accumulates context across many chunks.
# Past a fraction of the window, model attention degrades (the "context rot"
# cliff). This self-check decides, at each chunk-MERGE boundary, whether the
# cockpit should cycle: finish the current chunk cleanly, clear the session, and
# auto-resume run-state from the `## Execution state` board. The cockpit must
# NEVER cycle mid-chunk -- only at a merge boundary, where no chunk is building
# and all run-state already lives durably in files.
#
# WHY a self-check, not a passive hook: a settings.json hook cannot read the live
# session context size, so the decision cannot be a hook. The cockpit calls this
# at each merge boundary with the two facts only it knows -- whether it is at a
# merge boundary, and the current context size as a percent of the window.
#
# Usage (the cockpit calls this at a merge boundary):
#   context_cycle.sh --at-merge-boundary --context-pct <N>
#   context_cycle.sh --context-pct <N>            # not at a merge boundary
#
# Threshold X is a CONFIG parameter, read from the env var
# CONTEXT_CYCLE_THRESHOLD_PCT -- NEVER hardcoded. Research recommends ~50% of the
# window, but the PRODUCTION value is Open question Q-cycle, not yet set by the operator.
# So this script ships the decision logic with X read from config and is NOT
# armed to a production threshold; with no config value set it defaults to a safe
# disabled sentinel (101) that can never trip (no context can exceed 101% of the
# window), so an un-configured cockpit never cycles by accident.
#
# Output (stdout): exactly one decision token the cockpit branches on --
#   CYCLE      -> the cockpit SHOULD cycle (finish chunk -> clear -> resume from board)
#   NO_CYCLE   -> the cockpit should NOT cycle
# Decision: CYCLE iff (at a merge boundary) AND (context-pct > threshold), a
# STRICT '>' (context exactly AT the threshold does not cycle). Anything else,
# including any context size when NOT at a merge boundary, is NO_CYCLE.
#
# SCOPE FENCE: this script is the DECISION LOGIC only. It emits a signal and has
# no side effect -- it does not itself perform the session clear and does not arm
# any production threshold. Acting on the CYCLE signal (the actual clear + the
# live resume-from-board) is the cockpit's job, proven live before the production
# threshold is armed; see coo/coo-sop.md § 9.2 and skills/cockpit/SKILL.md.

set -u

# Safe disabled sentinel for an un-configured threshold: 101% can never be
# exceeded, so an un-armed cockpit never cycles. Production X is set in config
# (Open question Q-cycle) -- this default deliberately never trips.
CONTEXT_CYCLE_DISABLED_SENTINEL=101

# --- decide_cycle: pure decision function. Reads the threshold X from the
# config env var CONTEXT_CYCLE_THRESHOLD_PCT (NOT hardcoded), takes the
# merge-boundary flag and the context percent as args, and prints exactly one
# decision token (CYCLE / NO_CYCLE) to stdout. No side effect, no session clear,
# no live-context read -- so it is unit-testable by sourcing this file and
# calling it in isolation (sourcing does not run main; see the guard below). ---
decide_cycle(){
  local at_merge_boundary=0
  local context_pct=""
  local threshold="${CONTEXT_CYCLE_THRESHOLD_PCT:-$CONTEXT_CYCLE_DISABLED_SENTINEL}"

  while [ $# -gt 0 ]; do
    case "$1" in
      --at-merge-boundary) at_merge_boundary=1 ;;
      --context-pct) shift; context_pct="${1:?context_cycle: --context-pct needs N}" ;;
      *) printf 'context_cycle: unknown arg %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done

  if [ -z "$context_pct" ]; then
    printf 'context_cycle: --context-pct is required\n' >&2; return 2
  fi

  # Cycle ONLY at a merge boundary (never mid-chunk) AND only when context is
  # strictly OVER the configured threshold. The merge-boundary gate is checked
  # first and is the load-bearing safety property: not at a boundary => NO_CYCLE
  # regardless of how full the context is. The threshold comparison uses awk for
  # a fractional-safe numeric `>` (the shell's `[ -gt ]` is integer-only and
  # errors on fractional percentages like 47.5); awk exits 0 iff pct > threshold,
  # preserving the STRICT '>' semantics (context exactly AT threshold => NO_CYCLE).
  if [ "$at_merge_boundary" -eq 1 ] \
     && awk 'BEGIN{exit !(ARGV[1] + 0 > ARGV[2] + 0)}' "$context_pct" "$threshold"; then
    printf 'CYCLE\n'
  else
    printf 'NO_CYCLE\n'
  fi
  return 0
}

# Run main only when executed directly; stay silent when sourced (so decide_cycle
# can be unit-tested in isolation without any side effect). Executing directly is
# a thin wrapper over the pure function.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  # CONSUMER: if --context-pct was NOT supplied on the CLI, fall back to reading
  # the pct from the state file written by statusline.sh. Explicit --context-pct
  # always takes precedence (guard checks the full arg list before falling back).
  _args=("$@")
  _has_pct=0
  for _a in "$@"; do
    [ "$_a" = "--context-pct" ] && _has_pct=1 && break
  done
  if [ "$_has_pct" -eq 0 ]; then
    _pct_from_file=$(cat "$HOME/.claude/state/context-pct" 2>/dev/null || true)
    if [ -n "$_pct_from_file" ]; then
      _args=("--context-pct" "$_pct_from_file" "$@")
    fi
  fi
  # bash 3.2 (macOS) errors on "${_args[@]}" when the array is EMPTY under set -u
  # (a bare no-arg call with no state file). The ${arr[@]+"${arr[@]}"} form expands
  # to nothing when empty, so decide_cycle then emits its own clean "--context-pct
  # is required" error (rc 2) instead of an unbound-variable trace (rc 1).
  decide_cycle ${_args[@]+"${_args[@]}"}
fi
