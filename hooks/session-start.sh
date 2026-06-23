#!/usr/bin/env bash
#
# SessionStart hook: injects the COO governance superset (the relocated coo/*.md
# docs, from the CONFIG ROOT) into the MAIN session on every start, and ALSO
# injects the per-project spec (specs/current.md from $cwd) when one is present.
#
# Fires on source: startup | resume | clear (not compact — compact is
# deliberate narrowing, don't override).
#
# Fails open: errors log to stderr, exit 0 with empty output. A broken
# hook must never block a Claude Code session from starting.

set -euo pipefail

# Read stdin JSON. On any read failure, log and exit 0 with no output.
input=$(cat 2>/dev/null || true)

if [ -z "$input" ]; then
  echo "session-start.sh: empty stdin, skipping" >&2
  exit 0
fi

# Parse cwd from stdin. If jq fails (malformed JSON), exit silently.
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null || true)

if [ -z "$cwd" ]; then
  echo "session-start.sh: no cwd in stdin, skipping" >&2
  exit 0
fi

# --- coo/ governance superset (config-root sourced, spec-INDEPENDENT) ----------
# The coo/*.md docs are GLOBAL governance, not per-project: chunk 10 moved them
# out of the rules/ autoload path (so worker subagents stay blind), and this hook
# is the COO's only path back to the superset. They live at the CONFIG ROOT
# alongside rules/ (the live install: ~/.claude), so they must be sourced from
# there — NOT from the session's $cwd, or the COO would lose its governance in
# every project except the config dir itself.
#
# Self-locate the config root from the hook's own path: this file lives at
# <config_root>/hooks/session-start.sh, so ../ from the script dir IS the config
# root (resolves to ~/.claude live, or the worktree root in-tree). Hermetic and
# robust — independent of $cwd, the caller's PWD, and symlinks-free.
#
# Built ALWAYS (spec-present or not): the governance superset is not gated on a
# spec existing. Concatenate every coo/*.md as RAW text, each prefixed with its
# path as a header so the COO can tell the docs apart in one blob, then append to
# additionalContext via --arg (raw string), NOT --argjson — plain text, not JSON.
#
# Fail-open / graceful-degradation: if coo/ is absent or a file can't be read,
# coo_blob stays empty and the hook still emits whatever spec content exists
# (and vice-versa) — never a total failure.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)
coo_blob=""
if [ -n "$script_dir" ]; then
  config_root=$(cd "$script_dir/.." 2>/dev/null && pwd || true)
  coo_dir="$config_root/coo"
  if [ -n "$config_root" ] && [ -d "$coo_dir" ]; then
    for coo_file in "$coo_dir"/*.md; do
      # Guard the literal glob (no matches) and unreadable files.
      [ -f "$coo_file" ] || continue
      if coo_body=$(cat "$coo_file" 2>/dev/null); then
        coo_blob="$coo_blob

=== COO DOC: ${coo_file#$config_root/} ===

$coo_body"
      fi
    done
  fi
fi

# --- per-project spec (cwd-sourced, optional) ---------------------------------
# specs/current.md is correctly per-project, so it stays $cwd-relative. Build the
# spec part independently of coo/: empty when no spec exists; otherwise the raw
# spec body, plus a cockpit-routing pointer when the spec carries a
# '## Execution state' board (which marks a PARALLEL multi-chunk spec).
spec_path="$cwd/specs/current.md"
spec_part=""
if [ -f "$spec_path" ]; then
  # Readability gate: bail open (leaving spec_part empty) if the spec can't be
  # read, BEFORE the `cat` below would exit non-zero under `set -e`. The jq value
  # is intentionally discarded — this only proves the file is readable text.
  if jq -Rs . < "$spec_path" >/dev/null 2>&1; then
    spec_part=$(cat "$spec_path")
    # Parallel-spec detection: a '## Execution state' board marks a parallel
    # multi-chunk spec the COO drives via the cockpit skill. Single-threaded
    # specs use '## Current chunk' and get NO pointer. grep -q failing (no board)
    # is the normal single-threaded path, not an error.
    if grep -q '^## Execution state' "$spec_path" 2>/dev/null; then
      spec_part="$spec_part

---
COCKPIT ROUTING: this spec carries a '## Execution state' board, so it is a PARALLEL multi-chunk spec. Drive it with the cockpit skill: read the '## Execution state' board, compute the runnable set (chunks whose deps are merged, file-disjoint, within free build slots), and launch one worker pipeline per launchable chunk. Do not build chunks inline."
    fi
  else
    echo "session-start.sh: failed to read $spec_path, skipping spec" >&2
  fi
fi

# --- emit ---------------------------------------------------------------------
# additionalContext = (spec part, possibly empty) + coo/ superset.
# owed-items is a ship-only register (read at ship-spec Step 2.5); it is not
# injected here. If both are empty, emit nothing and exit 0 -- never malformed
# JSON, never an empty-context object.
if [ -z "$spec_part" ] && [ -z "$coo_blob" ]; then
  exit 0
fi

jq -n --arg ctx "$spec_part$coo_blob" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'

exit 0
