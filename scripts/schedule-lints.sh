#!/usr/bin/env bash
#
# schedule-lints.sh - registers a weekly off-hours lint sweep via the `schedule`
# skill (CronCreate). Runs wiki-lint + skill-lint every Sunday at 9pm ET and
# surfaces both reports.
#
# The COCKPIT performs the live registration; the worker NEVER calls CronCreate
# directly. Use --print (dry-run mode) to emit the exact schedule command + both
# lint invocations without registering, so the acceptance test can assert against
# the emitted text headlessly.
#
# Usage:
#   scripts/schedule-lints.sh --print   # dry-run: print and exit 0, no side effects
#   scripts/schedule-lints.sh           # print usage (live registration is cockpit's job)
#
# Cron cadence:  0 21 * * 0  (weekly Sunday 21:00 ET / America/New_York)

set -euo pipefail

CADENCE_CRON="0 21 * * 0"
TIMEZONE="America/New_York"
HUMAN_CADENCE="weekly Sunday 9pm ET"

print_schedule() {
    cat <<EOF
# schedule-lints dry-run (not registered - cockpit performs live CronCreate)
#
# Schedule command the cockpit would register via the \`schedule\` skill:
#
#   /schedule weekly Sunday 9pm ET (cron: ${CADENCE_CRON}) timezone: ${TIMEZONE}
#   command: /wiki-lint ; /skill-lint
#
# Cadence : ${HUMAN_CADENCE}
# Cron    : ${CADENCE_CRON}
# Timezone: ${TIMEZONE}
#
# Lint invocations:
#   wiki-lint  - invokes the wiki-lint skill; surfaces broken links, stale pages,
#                orphaned supersedes, empty hot buckets
#   skill-lint - invokes the skill-lint skill; surfaces malformed skill files,
#                missing required sections, broken internal references
#
# To register: the cockpit runs \`/schedule\` with the above cadence and command.
# This script is a dry-run reference only; it creates no cron entries.
EOF
}

if [[ "${1:-}" == "--print" ]]; then
    print_schedule
    exit 0
fi

echo "Usage: $0 --print" >&2
echo "  --print  Emit the schedule command + lint invocations (dry-run, no side effects)" >&2
echo "" >&2
echo "Live registration is performed by the cockpit via the \`schedule\` skill." >&2
exit 1
