#!/usr/bin/env bash
# Acceptance test for chunk 3: scripts/report.sh produces a 4-section markdown
# report from a hand-crafted sidecar fixture + a controlled fixture skills dir.
# Maps to spec acceptance criterion 6.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPORT_SH="$SCRIPT_DIR/../scripts/report.sh"

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

FIXTURE_SKILLS="$TMPDIR/skills"
mkdir -p "$FIXTURE_SKILLS"
for s in alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo; do
  mkdir -p "$FIXTURE_SKILLS/$s"
  touch "$FIXTURE_SKILLS/$s/SKILL.md"
done

SIDECAR="$TMPDIR/skill-usage.json"
cat > "$SIDECAR" <<'EOF'
{
  "version": 1,
  "telemetry_started": "2025-09-01",
  "skills": {
    "charlie": { "invoked_count": 25, "last_used": "2026-04-01T12:00:00Z", "first_seen": "2025-12-01T12:00:00Z" },
    "delta":   { "invoked_count": 8,  "last_used": "2026-04-15T12:00:00Z", "first_seen": "2025-11-01T12:00:00Z" },
    "echo":    { "invoked_count": 4,  "last_used": "2026-04-20T12:00:00Z", "first_seen": "2025-12-15T12:00:00Z" },
    "foxtrot": { "invoked_count": 12, "last_used": "2026-04-25T12:00:00Z", "first_seen": "2025-10-01T12:00:00Z" },
    "golf":    { "invoked_count": 6,  "last_used": "2026-04-28T12:00:00Z", "first_seen": "2026-01-01T12:00:00Z" },
    "hotel":   { "invoked_count": 20, "last_used": "2026-05-01T12:00:00Z", "first_seen": "2025-09-01T12:00:00Z" },
    "india":   { "invoked_count": 15, "last_used": "2026-05-06T12:00:00Z", "first_seen": "2026-02-01T12:00:00Z" },
    "juliet":  { "invoked_count": 30, "last_used": "2026-05-08T12:00:00Z", "first_seen": "2026-03-01T12:00:00Z" },
    "kilo":    { "invoked_count": 2,  "last_used": "2026-05-02T12:00:00Z", "first_seen": "2026-03-08T12:00:00Z" }
  }
}
EOF

if [[ ! -x "$REPORT_SH" ]] && [[ ! -f "$REPORT_SH" ]]; then
  echo "FAIL: $REPORT_SH does not exist"
  exit 1
fi

OUTPUT=$(SIDECAR_PATH="$SIDECAR" SKILLS_DIR="$FIXTURE_SKILLS" TODAY="2026-05-08" bash "$REPORT_SH" 2>&1)

PASS=0
FAIL=0
note() {
  local name="$1" ok="$2"
  if [[ "$ok" == "yes" ]]; then
    echo "  [pass] $name"
    PASS=$((PASS+1))
  else
    echo "  [FAIL] $name"
    FAIL=$((FAIL+1))
  fi
}

section() {
  # Extract lines under '## <header>' up to the next '## ' or end-of-output.
  local header="$1"
  printf '%s\n' "$OUTPUT" | awk -v h="## $header" '
    $0 == h || index($0, h) == 1 { flag=1; next }
    /^## / { flag=0 }
    flag { print }
  '
}

# Anchor: each section's bullet line must contain the slug as a whole word.
contains_slug() {
  local block="$1" slug="$2"
  printf '%s\n' "$block" | grep -qE "(^|[[:space:]])${slug}([[:space:]]|$|[^a-z])"
}

# All four headers must be present.
echo "$OUTPUT" | grep -q '^## Never invoked since telemetry started' && note "header: Never invoked" yes || note "header: Never invoked" no
echo "$OUTPUT" | grep -q '^## Idle past 30 days' && note "header: Idle past 30 days" yes || note "header: Idle past 30 days" no
echo "$OUTPUT" | grep -q '^## LRU bottom 5' && note "header: LRU bottom 5" yes || note "header: LRU bottom 5" no
echo "$OUTPUT" | grep -q '^## Suspicious' && note "header: Suspicious" yes || note "header: Suspicious" no

# Section 1: Never invoked → alpha, bravo
NI=$(section "Never invoked since telemetry started")
contains_slug "$NI" alpha && note "Never-invoked includes alpha" yes || note "Never-invoked includes alpha" no
contains_slug "$NI" bravo && note "Never-invoked includes bravo" yes || note "Never-invoked includes bravo" no
contains_slug "$NI" charlie && note "Never-invoked excludes charlie" no || note "Never-invoked excludes charlie" yes

# Section 2: Idle past 30 days → charlie only (37d ago)
IDLE=$(section "Idle past 30 days")
contains_slug "$IDLE" charlie && note "Idle includes charlie" yes || note "Idle includes charlie" no
contains_slug "$IDLE" delta && note "Idle excludes delta (23d)" no || note "Idle excludes delta (23d)" yes
contains_slug "$IDLE" alpha && note "Idle excludes alpha (never invoked)" no || note "Idle excludes alpha (never invoked)" yes

# Section 3: LRU bottom 5 → charlie, delta, echo, foxtrot, golf
LRU=$(section "LRU bottom 5")
for s in charlie delta echo foxtrot golf; do
  contains_slug "$LRU" "$s" && note "LRU includes $s" yes || note "LRU includes $s" no
done
contains_slug "$LRU" hotel && note "LRU excludes hotel" no || note "LRU excludes hotel" yes
contains_slug "$LRU" alpha && note "LRU excludes alpha (never invoked)" no || note "LRU excludes alpha (never invoked)" yes

# Section 4: Suspicious → kilo
SUSP=$(section "Suspicious")
contains_slug "$SUSP" kilo && note "Suspicious includes kilo" yes || note "Suspicious includes kilo" no
contains_slug "$SUSP" charlie && note "Suspicious excludes charlie (high count)" no || note "Suspicious excludes charlie (high count)" yes
contains_slug "$SUSP" alpha && note "Suspicious excludes alpha (never invoked)" no || note "Suspicious excludes alpha (never invoked)" yes

echo "---"
echo "Passed: $PASS  Failed: $FAIL"
[[ $FAIL -eq 0 ]] || exit 1
