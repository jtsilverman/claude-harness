#!/usr/bin/env bash
#
# Status line for Claude Code. Displays:
#   <branch> · <current-chunk> · <context%>
#
# Each segment falls back gracefully when unavailable.
#
# Reads JSON payload from stdin per
# https://code.claude.com/docs/en/statusline
#
# Graceful fallback: always exits 0, always prints something (never blanks
# the status line).

set -u

input=$(cat 2>/dev/null || true)

# Parse fields with defaults.
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null || true)
pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty' 2>/dev/null || true)

# If stdin was garbage, output a minimal neutral line and exit.
if [ -z "$input" ]; then
  echo "Claude Code"
  exit 0
fi

# ---- Branch segment.
branch=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  branch=$(cd "$cwd" 2>/dev/null && git symbolic-ref --short HEAD 2>/dev/null || true)
fi

# ---- Chunk segment. Walk up from cwd for specs/current.md; extract "Current
# chunk" heading text.
chunk=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  dir="$cwd"
  while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    spec="$dir/specs/current.md"
    if [ -f "$spec" ]; then
      # Extract first bold "**Chunk N: name**" or "**Chunk N.M: name**" line
      # after "## Current chunk". Trim to just the "Chunk N" / "Chunk N.M"
      # portion for status-line brevity. Dotted-decimal sub-chunks (pivot
      # numbering, parent N → N.M) must display in full, not truncate.
      chunk=$(awk '
        /^## Current chunk/ {found=1; next}
        found && /^\*\*Chunk [0-9]+(\.[0-9]+)?/ {
          # Match just "Chunk <N>" or "Chunk <N>.<M>" at the start.
          match($0, /Chunk [0-9]+(\.[0-9]+)?/)
          if (RSTART > 0) {
            print substr($0, RSTART, RLENGTH)
          }
          exit
        }
      ' "$spec" 2>/dev/null || true)
      break
    fi
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
fi

# ---- Context % segment. Integer truncate.
pct_seg=""
if [ -n "$pct" ] && [ "$pct" != "null" ]; then
  pct_int=${pct%.*}
  pct_seg="${pct_int}%"
  # PRODUCER: write integer-truncated pct to the state file so the cockpit can
  # read it (context_cycle.sh file-read fallback). Best-effort: never fail the
  # status line if the write fails.
  mkdir -p "$HOME/.claude/state" 2>/dev/null || true
  printf '%s' "$pct_int" > "$HOME/.claude/state/context-pct" 2>/dev/null || true
fi

# ---- Compose output. Separator: " · ". Omit empty segments.
parts=()
[ -n "$branch" ] && parts+=("🌿 $branch")
[ -n "$chunk" ] && parts+=("$chunk")
[ -n "$pct_seg" ] && parts+=("ctx $pct_seg")

if [ ${#parts[@]} -eq 0 ]; then
  echo "Claude Code"
else
  # Bash array join with " · " separator.
  out=""
  sep=" · "
  for i in "${!parts[@]}"; do
    if [ "$i" -eq 0 ]; then
      out="${parts[$i]}"
    else
      out="${out}${sep}${parts[$i]}"
    fi
  done
  echo "$out"
fi

exit 0
