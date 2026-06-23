#!/usr/bin/env bash
# report.sh — emit the skill-lint markdown report.
# Reads sidecar JSON + walks skill dir, computes 4 sections (Never invoked /
# Idle past N days / LRU bottom 5 / Suspicious), prints to stdout.
# Read-only: never edits any skill, never edits the sidecar.
#
# Env overrides (all optional):
#   SIDECAR_PATH         default: ~/.claude/state/skill-usage.json
#   SKILLS_DIR           default: ~/.claude/skills
#   IDLE_THRESHOLD_DAYS  default: 30
#   TODAY                default: today UTC (override for deterministic tests)
set -uo pipefail

SIDECAR="${SIDECAR_PATH:-$HOME/.claude/state/skill-usage.json}"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.claude/skills}"
IDLE_THRESHOLD_DAYS="${IDLE_THRESHOLD_DAYS:-30}"
TODAY="${TODAY:-$(date -u +%Y-%m-%d)}"

if [[ ! -f "$SIDECAR" ]]; then
  echo "# skill-lint report — $TODAY"
  echo
  echo "No sidecar at $SIDECAR. Telemetry not yet wired or never fired."
  exit 0
fi

# Enumerate the operator-authored skills from on-disk dir (each subdir is a skill).
# `find` (not glob) per lint-scan-bash-hygiene; -type d excludes
# SUPERPOWERS_MANIFEST.md and any other top-level files automatically.
ON_DISK=$(find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
          | while read -r d; do basename "$d"; done \
          | sort)

SIDECAR_PATH="$SIDECAR" \
ON_DISK_LIST="$ON_DISK" \
IDLE_THRESHOLD_DAYS="$IDLE_THRESHOLD_DAYS" \
TODAY="$TODAY" \
python3 <<'PYEOF'
import os, json
from datetime import date, datetime

sidecar_path = os.environ["SIDECAR_PATH"]
on_disk = sorted(
    s for s in os.environ["ON_DISK_LIST"].splitlines()
    if s and ":" not in s  # plugin-form skills out of scope; defensive filter
)
idle_threshold = int(os.environ["IDLE_THRESHOLD_DAYS"])
today = date.fromisoformat(os.environ["TODAY"])

with open(sidecar_path) as f:
    data = json.load(f)
skills = data.get("skills", {})

def days_since(iso):
    if not iso:
        return None
    d = datetime.fromisoformat(iso.replace("Z", "+00:00")).date()
    return (today - d).days

# Section 1: Never invoked — on disk but not in sidecar.
never = [s for s in on_disk if s not in skills]

# Section 2: Idle past N days — in sidecar with last_used older than threshold.
idle = []
for s in on_disk:
    e = skills.get(s)
    if not e:
        continue
    d = days_since(e.get("last_used"))
    if d is not None and d > idle_threshold:
        idle.append((s, d, e.get("invoked_count", 0), e.get("last_used", "")))
idle.sort(key=lambda x: -x[1])  # most idle first

# Section 3: LRU bottom 5 — 5 oldest by last_used among invoked skills.
invoked = [
    (s, days_since(skills[s].get("last_used")))
    for s in on_disk
    if s in skills and skills[s].get("last_used")
]
invoked.sort(key=lambda x: -x[1])  # oldest first
lru = invoked[:5]

# Section 4: Suspicious — first_seen age >= 30d AND invoked_count <= 3.
susp = []
for s in on_disk:
    e = skills.get(s)
    if not e:
        continue
    age = days_since(e.get("first_seen"))
    cnt = e.get("invoked_count", 0)
    if age is not None and age >= 30 and cnt <= 3:
        susp.append((s, age, cnt))
susp.sort(key=lambda x: -x[1])  # oldest first

ts = data.get("telemetry_started", "")
try:
    ts_age = (today - date.fromisoformat(ts)).days
    ts_phrase = f"Telemetry started {ts_age} days ago"
except Exception:
    ts_phrase = "Telemetry start unknown"

print(f"# skill-lint report — {today.isoformat()}")
print()
print(f"{ts_phrase}. {len(on_disk)} the operator-authored skills tracked.")
print()

print("## Never invoked since telemetry started")
if never:
    for s in never:
        print(f"- {s}")
else:
    print("(none)")
print()

print(f"## Idle past {idle_threshold} days")
if idle:
    for s, d, cnt, lu in idle:
        print(f"- {s} (last used {lu[:10]}, {d} days ago, {cnt} lifetime invocations)")
else:
    print("(none)")
print()

print("## LRU bottom 5 (by last_used)")
if lru:
    for i, (s, d) in enumerate(lru, 1):
        print(f"{i}. {s} — {d} days ago")
else:
    print("(none)")
print()

print("## Suspicious — created but rarely used")
if susp:
    for s, age, cnt in susp:
        print(f"- {s} (added {age} days ago, {cnt} invocations)")
else:
    print("(none)")
PYEOF
