#!/usr/bin/env bash
#
# stage_session_transcript.sh -- copy ALL of a spec's session transcripts into
# the per-spec session store so ship-spec can grade the full multi-session arc.
#
# USAGE:
#   scripts/stage_session_transcript.sh <slug> [--projects-dir <dir>] [--spec-root <dir>]
#
# ARGS:
#   <slug>            The spec slug (e.g. "grader-same-session"). Required.
#   --projects-dir    Override: the ~/.claude/projects/<cwd-slug>/ directory to
#                     search for .jsonl files. Default: auto-derived from cwd.
#   --spec-root       Override: the project root whose specs/<slug>/sessions/ tree
#                     receives the copy. Default: cwd.
#
# WHAT IT DOES:
#   1. Finds ALL <session_id>.jsonl files in <projects-dir>.
#   2. For each session, copies the .jsonl -- and its sibling <session_id>/ dir
#      if present (subagent transcripts) -- into
#      <spec-root>/specs/<slug>/sessions/<session_id>/.
#   3. Idempotent: sessions already staged (dest dir exists) are skipped.
#      A re-run only copies sessions that are new since the last run.
#   4. Source files are NEVER moved (cp, not mv); the live writer keeps its fd.
#
# MULTI-SESSION COVERAGE:
#   A spec built across multiple COO sessions (over days or weeks) has one
#   .jsonl per session in <projects-dir>. Staging only the newest-mtime session
#   (the old head-n1 behaviour) meant the grader missed all prior build sessions.
#   This script now iterates every .jsonl so ship-grade covers the full arc.
#
# NO-SUBAGENTS EDGE CASE:
#   When no <session_id>/ sibling dir exists (no workflows ran), only the .jsonl
#   is copied; the script does NOT error. Subagents are optional.
#
# ERRORS:
#   Non-zero exit + loud stderr when no .jsonl is found in <projects-dir>.
#   All other errors (mkdir failure, cp failure) log to stderr and exit non-zero.
#   The script NEVER fails silently -- every error path has a visible stderr line.
#
# EXIT CODES:
#   0  success (staged, or already up-to-date on idempotent re-run)
#   1  no transcript found / argument error / fatal copy failure
#
# COPY-LOGIC SOURCE:
#   The copy mechanic mirrors hooks/session-archive.sh (cp -R session_dir +
#   cp .jsonl), which is the SessionEnd-hook path for multi-session specs. This
#   script is the EXPLICIT-STAGING complement: called by ship-spec Step 5 BEFORE
#   grading to ensure the current (still-running) session and all prior sessions
#   are captured without waiting for SessionEnd.

set -uo pipefail

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
SLUG=""
PROJECTS_DIR_OVERRIDE=""
SPEC_ROOT_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --projects-dir) PROJECTS_DIR_OVERRIDE="$2"; shift 2 ;;
    --spec-root)    SPEC_ROOT_OVERRIDE="$2";    shift 2 ;;
    --*)            echo "stage_session_transcript.sh: unknown flag $1" >&2; exit 1 ;;
    *)
      if [ -z "$SLUG" ]; then
        SLUG="$1"; shift
      else
        echo "stage_session_transcript.sh: unexpected positional arg: $1" >&2; exit 1
      fi
      ;;
  esac
done

if [ -z "$SLUG" ]; then
  echo "stage_session_transcript.sh: missing required <slug> argument" >&2
  echo "  usage: stage_session_transcript.sh <slug> [--projects-dir <dir>] [--spec-root <dir>]" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------

# spec-root: explicit override, else cwd
if [ -n "$SPEC_ROOT_OVERRIDE" ]; then
  spec_root="$SPEC_ROOT_OVERRIDE"
else
  spec_root="$(pwd)"
fi

# projects-dir: explicit override, else derive from ~/.claude/projects/<cwd-slug>
if [ -n "$PROJECTS_DIR_OVERRIDE" ]; then
  projects_dir="$PROJECTS_DIR_OVERRIDE"
else
  # Derive the cwd-slug: take the actual cwd, replace every '/' and '.' with '-'.
  # The leading '/' becomes a leading '-', which is the correct format Claude Code
  # uses for project slugs in ~/.claude/projects/. Claude Code also converts '.'
  # to '-', so a path component like ".claude" becomes "--claude" (the '/' before it
  # and the '.' both convert, producing a doubled dash).
  # e.g. /Users/you/.claude ->
  #      -Users-admin--claude   (note doubled dash: '/' + '.' both -> '-')
  actual_cwd="$(pwd)"
  cwd_slug=$(echo "$actual_cwd" | sed 's|[/.]|-|g')
  config_root="${HOME}/.claude"
  projects_dir="${config_root}/projects/${cwd_slug}"
fi

# ---------------------------------------------------------------------------
# Find ALL session .jsonl files in projects_dir
# ---------------------------------------------------------------------------

# Collect every .jsonl in the projects-dir (each file = one session transcript).
# A spec built over multiple COO sessions has one .jsonl per session; staging
# only the newest misses all prior build sessions, so we iterate them all.
jsonl_files=$(ls "$projects_dir"/*.jsonl 2>/dev/null || true)

if [ -z "$jsonl_files" ]; then
  echo "stage_session_transcript.sh: no .jsonl transcript found in $projects_dir" >&2
  echo "  (expected at least one <session_id>.jsonl; check that the projects-dir is correct)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Stage each session: copy .jsonl + sibling session dir into the spec store
# ---------------------------------------------------------------------------

sessions_root="$spec_root/specs/$SLUG/sessions"

for jsonl_file in $jsonl_files; do
  [ -f "$jsonl_file" ] || continue

  session_id=$(basename "$jsonl_file" .jsonl)
  session_dir="$projects_dir/$session_id"
  dest_dir="$sessions_root/$session_id"

  # Idempotent: if the dest .jsonl already exists this session was fully staged
  # on a prior run; skip it (avoids redundant I/O on large archives).
  # We check for the .jsonl specifically (not just the dir) so a partially-
  # staged dest (dir exists but no .jsonl yet) still gets completed.
  if [ -f "$dest_dir/$(basename "$jsonl_file")" ]; then
    echo "stage_session_transcript.sh: session $session_id already staged, skipping" >&2
    continue
  fi

  mkdir -p "$dest_dir" 2>/dev/null || {
    echo "stage_session_transcript.sh: cannot create dest dir $dest_dir" >&2
    exit 1
  }

  # Copy the .jsonl (the main session transcript).
  cp "$jsonl_file" "$dest_dir/" 2>/dev/null || {
    echo "stage_session_transcript.sh: failed to copy $jsonl_file -> $dest_dir/" >&2
    exit 1
  }

  # Copy the sibling session dir (subagent transcripts) when it exists.
  # No error when absent (no workflows ran -> .jsonl-only session is valid).
  if [ -d "$session_dir" ]; then
    cp -R "$session_dir" "$dest_dir/" || {
      echo "stage_session_transcript.sh: ERROR: failed to copy session dir $session_dir -> $dest_dir/ (subagent transcripts missing; cannot produce a complete grade)" >&2
      exit 1
    }
  fi

  echo "stage_session_transcript.sh: staged session $session_id -> $dest_dir" >&2
done

exit 0
