#!/usr/bin/env bash
# codex-review.sh -- run the external `codex review` CLI over a chunk's changes
# and emit a structured, parseable bug/security findings report.
#
# Part of the review-mode-workflow verification net: a fresh, different model
# (OpenAI Codex) reviews changes the context-rich coder (Opus) produced, so a
# human is not the only safety net. Consumed by the chunk-end review gate (the fresh-context review net).
#
# Usage:
#   codex-review.sh [--uncommitted | --base <branch> | --commit <sha>] [--tier S|A|B|C]
# Scope defaults to --uncommitted (the chunk-end pre-commit case);
# --base reviews the branch against a base, --commit reviews one commit.
# --tier scales the review model + reasoning effort to the chunk's risk tier
# (S = strongest + xhigh, A = strongest + high, B/absent = default + medium,
# C = lightest + low). It is optional and may appear in any position; absent
# reproduces the pre-tier default.
#
# Output (stdout): one parsed finding per line, then a machine-readable result:
#   RESULT: CLEAN            no `[P<n>]` findings
#   RESULT: FINDINGS=<n>     n>=1 `[P<n>]` findings
# Header, the self-fetched diff, and sandbox noise are stripped; only findings
# and the RESULT line reach stdout.
#
# Exit: 0 on a successful review (clean OR with findings); >=2 only on error.
#
# Why parse the text, not the exit code: `codex review` exits 0 even when it
# reports a P1 issue, so clean-vs-findings MUST be derived from the output.
#
# Why key strictly on the `[P<n>]` severity tag (chunk-10 evidence): live runs
# 2026-06-01 confirmed `codex review` reliably tags every finding with `[P<n>]`
# (a seeded SQL injection surfaced as `[P1]`), and emits open-ended REASONING
# prose when a change is clean (e.g. "does not alter runtime behavior, so it
# should not break existing code"). Clean prose carries no canned all-clear
# token, so trying to require one -- or to keyword-detect "concern" prose --
# false-alarms every clean review (clean-prose and problem-prose share the same
# risk vocabulary; one affirms absence, one asserts presence). The `[P<n>]` tag
# is the only reliable signal: no tag => CLEAN. The chunk-1 "prose-only review
# reads CLEAN" caveat was a theoretical gap that does not occur in practice; the
# real risk it implied is handled by codex's structured-findings contract.

set -u

# --- parse_review: stdin = raw `codex review` output; stdout = findings + RESULT.
# Pure (no codex call, no globals) so it is unit-testable in isolation by sourcing
# this file and piping a fixture, with no live network call. ---
parse_review(){
  local raw findings n

  # Findings are lines shaped:  - [P<n>] <title> -- <file>:<lines>
  # Keying on the [P<n>] severity tag (not the dash) means diff lines, which begin
  # with a bare '-' or '+', are never mistaken for findings. Codex streams its
  # final message twice, so dedupe identical lines.
  raw="$(cat)"
  findings="$(printf '%s\n' "$raw" \
    | grep -E '^[[:space:]]*-[[:space:]]+\[P[0-9]+\]' \
    | sed 's/^[[:space:]]*//' \
    | awk '!seen[$0]++')"

  if [ -z "$findings" ]; then
    printf 'RESULT: CLEAN\n'
    return 0
  fi

  n="$(printf '%s\n' "$findings" | grep -c '.')"
  printf '%s\n' "$findings"
  printf 'RESULT: FINDINGS=%s\n' "$n"
  return 0
}

# --- tier_config: TIER (S|A|B|C, or empty) -> the `codex review` config args for
# that tier, one token per line (so a bash-3.2 reader can split them into an
# array via a here-string without word-splitting hazards). Pure (no codex call,
# no globals) so it is unit-testable by sourcing this file -- same contract as
# parse_review.
#
# Tier scales the review to the chunk's intrinsic risk (chunk 9). Model ids +
# effort levels verified against ~/.codex/models_cache.json (2026-06-03):
#   S    -> gpt-5.5 (strongest) + xhigh: catastrophic-risk chunks; xhigh is the
#           ceiling reasoning level for gpt-5.5/5.4/mini ("max" is NOT valid for
#           these models; verified against models_cache.json 2026-06-03)
#   A    -> gpt-5.5 (strongest) + high : the highest-risk chunks get the deepest review
#   B    -> gpt-5.4-mini (lightest)+medium: B is the highest-VOLUME tier, so it fires
#           Codex on the CHEAP cross-model lens (chunk 9 flip) -- a cheap second model
#           on the common path, not a skip. Reversible via this one-line branch.
#   ''   -> medium, NO model override  : the absent/no-tier path stays byte-identical
#           to the pre-tier default, so the existing no-tier callers (the chunk-end review
#           gate) are unaffected. B and '' now DIVERGE: B carries the model, '' does not.
#   C    -> gpt-5.4-mini (lightest)+low: boilerplate gets the cheapest pass
# `codex review` takes the model only via `-c model=...` (it has no -m/--model
# flag, unlike `codex` / `codex exec`), so both knobs go through -c. Unknown tier
# fails loud (return 2) rather than silently picking a default -- a mis-typed tier
# must surface, not quietly downgrade the net. ---
tier_config(){
  case "${1:-}" in
    S)    printf -- '-c\nmodel=gpt-5.5\n-c\nmodel_reasoning_effort=xhigh\n' ;;
    A)    printf -- '-c\nmodel=gpt-5.5\n-c\nmodel_reasoning_effort=high\n' ;;
    B)    printf -- '-c\nmodel=gpt-5.4-mini\n-c\nmodel_reasoning_effort=medium\n' ;;
    "")   printf -- '-c\nmodel_reasoning_effort=medium\n' ;;
    C)    printf -- '-c\nmodel=gpt-5.4-mini\n-c\nmodel_reasoning_effort=low\n' ;;
    *)    printf 'codex-review: unknown tier %s (expected S|A|B|C)\n' "$1" >&2; return 2 ;;
  esac
}

main(){
  # --- scope + tier selection. --tier is OPTIONAL and may appear in any
  # position; absent -> the pre-tier default (medium effort, no model override),
  # byte-identical to before tiers existed, so the existing no-tier caller
  # (the chunk-end review gate) is unchanged. NOTE (chunk 9): the absent path no
  # longer equals Tier B -- B now carries the gpt-5.4-mini model (cheap-lens flip);
  # absent stays bare. ---
  local TIER TIER_RAW RAW RC line
  local -a SCOPE_ARGS TIER_ARGS

  # Log startup before any early-exit path (including the codex-not-found check
  # below). Honors CODEX_REVIEW_RUNLOG env var; no-op if unset.
  # Use /bin/date directly so the log works even when PATH is restricted.
  if [ -n "${CODEX_REVIEW_RUNLOG:-}" ]; then
    local _ts
    _ts="$(/bin/date -Iseconds 2>/dev/null || /bin/date '+%Y-%m-%dT%H:%M:%S')"
    printf '%s codex-review: start args=%s\n' "$_ts" "$*" >> "$CODEX_REVIEW_RUNLOG"
  fi

  SCOPE_ARGS=(--uncommitted)   # default scope when no scope flag is given
  TIER=""                      # default tier = pre-tier default (NOT Tier B; see tier_config)
  while [ $# -gt 0 ]; do
    case "$1" in
      --uncommitted) SCOPE_ARGS=(--uncommitted) ;;
      --base)   shift; SCOPE_ARGS=(--base   "${1:?codex-review: --base needs a branch}") ;;
      --commit) shift; SCOPE_ARGS=(--commit "${1:?codex-review: --commit needs a sha}") ;;
      --tier)   shift; TIER="${1:?codex-review: --tier needs S|A|B|C}" ;;
      *) printf 'codex-review: unknown arg %s\n' "$1" >&2; exit 2 ;;
    esac
    shift
  done

  if ! command -v codex >/dev/null 2>&1; then
    printf 'codex-review: codex CLI not found on PATH\n' >&2; exit 3
  fi

  # Resolve the tier -> codex config args. Fail loud on an unknown tier (a
  # mis-typed tier must surface, not silently review at the wrong depth).
  if ! TIER_RAW="$(tier_config "$TIER")"; then
    printf '%s\n' "$TIER_RAW" >&2; exit 2
  fi
  TIER_ARGS=()
  # here-string (not a pipe) so the loop runs in the current shell and the array
  # survives -- bash 3.2 has no mapfile/readarray.
  while IFS= read -r line; do
    [ -n "$line" ] && TIER_ARGS+=("$line")
  done <<< "$TIER_RAW"

  # Review at the tier-scaled model + reasoning effort. Verified 2026-06-01 that
  # `-c model_reasoning_effort=` is accepted and bumps the header; model ids
  # verified against models_cache.json 2026-06-03 (see tier_config).
  RAW="$(codex review "${SCOPE_ARGS[@]}" "${TIER_ARGS[@]}" < /dev/null 2>&1)"
  RC=$?
  if [ "$RC" -ne 0 ]; then
    printf 'codex-review: codex exited %s\n' "$RC" >&2
    printf '%s\n' "$RAW" >&2
    exit 4
  fi

  printf '%s\n' "$RAW" | parse_review
}

# Run main only when executed directly; stay silent when sourced (so parse_review
# can be unit-tested without triggering a codex call).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
