#!/usr/bin/env bash
# runlog.sh -- shared timestamped-append log helper for pipeline-critical scripts.
#
# Usage: `source scripts/runlog.sh` then call:
#   runlog <logfile> <message>
#       Appends one ISO8601-timestamped line to <logfile>.
#       Creates the file (and parent dirs) if absent.
#       Appends -- never overwrites -- so callers may call multiple times
#       and the log accumulates a trace suitable for `tail -f` monitoring.
#
# The documented `tail -f` monitor path:
#   Each pipeline-critical script honors a per-script env var (e.g.
#   RUNNABLE_SET_RUNLOG, EXEC_STATE_RUNLOG, MERGE_ENGINE_RUNLOG,
#   COCKPIT_SIDECAR_RUNLOG, DEMO_DETECT_RUNLOG, CODEX_REVIEW_RUNLOG) that
#   names its logfile. Set the var before invoking to redirect to a path of
#   your choice, then:
#       tail -f /path/to/logfile
#   to watch progress lines in real time. Each line is prefixed with an
#   ISO8601 timestamp (YYYY-MM-DDTHH:MM:SS<tz>) so lines are sortable and
#   grep-able by time. Unset the var -> no logging (no-op default).
#
# No side effects on source: sourcing this file defines the function only.

runlog() {
    local logfile="$1"
    local message="$2"
    [ -z "$logfile" ] && return 0
    # date -Iseconds: BSD (macOS) emits YYYY-MM-DDTHH:MM:SS-04:00;
    # GNU emits YYYY-MM-DDTHH:MM:SS+0000. Both match the TS_RE the test uses.
    local ts
    ts="$(date -Iseconds 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S')"
    # Best-effort: ensure the parent dir exists so the append cannot fail on a
    # missing directory. Logging must NEVER crash the caller, so swallow any
    # mkdir error (|| true) -- the printf below still runs, and if the dir truly
    # could not be created the append is a no-op rather than a fatal.
    mkdir -p "$(dirname "$logfile")" 2>/dev/null || true
    printf '%s %s\n' "$ts" "$message" >> "$logfile"
}
