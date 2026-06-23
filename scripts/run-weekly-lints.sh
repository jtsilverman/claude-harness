#!/usr/bin/env bash
# run-weekly-lints.sh -- the weekly off-hours lint sweep (Req 1 of coo-cockpit-upgrades).
#
# Run by the launchd agent `com.user.claude-weekly-lints` (Sun 21:07 ET). It invokes
# the wiki-lint + skill-lint skills HEADLESSLY via `claude -p` and appends both reports
# to a logfile you can `tail -f`. This is the LOCAL standing-schedule mechanism: a
# `/schedule` routine runs in the cloud and can't see the local ~/Documents/brain vault,
# and a CronCreate job needs a live REPL + expires after 7 days -- only an OS-level
# launchd agent gives a true unattended weekly sweep.
#
# launchd runs with a minimal PATH, so `claude` is resolved by absolute path with a
# PATH fallback. Read-only lints; safe to run unattended.
set -u

LOG="${LINT_CRON_LOG:-$HOME/.claude/state/lint-cron.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

CLAUDE_BIN="/opt/homebrew/bin/claude"
[ -x "$CLAUDE_BIN" ] || CLAUDE_BIN="$(command -v claude 2>/dev/null || echo claude)"

{
  printf '\n===== weekly lint sweep %s =====\n' "$(/bin/date -Iseconds 2>/dev/null || /bin/date)"
  "$CLAUDE_BIN" -p \
    "Run the wiki-lint skill, then the skill-lint skill, on this machine, and output both full reports verbatim." 2>&1
  printf '\n===== end weekly lint sweep (exit %s) =====\n' "$?"
} >> "$LOG" 2>&1
