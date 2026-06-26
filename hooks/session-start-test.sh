#!/usr/bin/env bash
# Test: session-start.sh injects only status:active top-level specs, by name.
# RED-first for the spec-convention change (current.md -> named status:active specs).
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/session-start.sh"
fail=0
chk() { if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1"; fail=1; fi; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/specs/archive"
printf -- '---\nstatus: active\n---\n# Active One\nbody-active-one\n' > "$tmp/specs/active-one.md"
printf -- '---\nstatus: active\n---\n# Active Two\nbody-active-two\n' > "$tmp/specs/active-two.md"
printf -- '# Stale Spec\nbody-stale (no status)\n'                     > "$tmp/specs/stale.md"
printf -- '---\nstatus: shipped\n---\n# Done\nbody-shipped\n'          > "$tmp/specs/done.md"
printf -- 'old board\n'                                                > "$tmp/specs/current.md"

out=$(printf '{"cwd":"%s","source":"startup"}' "$tmp" | bash "$HOOK" 2>/dev/null)

chk "injects active-one body"        '[ -n "$out" ] && printf "%s" "$out" | grep -q "body-active-one"'
chk "injects active-two body"        'printf "%s" "$out" | grep -q "body-active-two"'
chk "names active-one path"          'printf "%s" "$out" | grep -q "active-one.md"'
chk "skips stale (no status)"        '! printf "%s" "$out" | grep -q "body-stale"'
chk "skips shipped"                  '! printf "%s" "$out" | grep -q "body-shipped"'
chk "ignores current.md board"       '! printf "%s" "$out" | grep -q "old board"'
chk "output is valid JSON"           'printf "%s" "$out" | jq -e . >/dev/null'

# No specs dir -> silent, valid (empty) exit, no crash.
empty=$(mktemp -d); trap 'rm -rf "$tmp" "$empty"' EXIT
out2=$(printf '{"cwd":"%s","source":"startup"}' "$empty" | bash "$HOOK" 2>/dev/null; echo "EXIT:$?")
chk "no-specs dir exits 0"           'printf "%s" "$out2" | grep -q "EXIT:0"'

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILURES"; exit 1; }
