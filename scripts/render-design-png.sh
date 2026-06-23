#!/usr/bin/env bash
# render-design-png.sh — rasterize a Claude Design HTML render to PNG for Obsidian preview.
#
# Usage:
#   render-design-png.sh <input.html> [output.png] [WIDTHxHEIGHT]
#
# Default output: same directory, same basename, .png extension.
# Default size:   parsed from the SVG viewBox in the HTML; falls back to 2400x1620.
# Output is 2x retina (chrome scales the screenshot to physical pixels), so a
# 2400x1620 logical canvas yields a 4800x3240 PNG.
#
# Why this exists: Claude Design renders are HTML+SVG (text-diffable, canonical).
# Obsidian doesn't render arbitrary HTML inline in preview, so we export a PNG
# alongside and embed it via ![[<name>.png]] in the seed .md. The HTML is still
# the source of truth — the PNG is stale-prone and must be re-exported after
# every HTML edit.

set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ $# -lt 1 ]]; then
  echo "usage: $(basename "$0") <input.html> [output.png] [WIDTHxHEIGHT]" >&2
  exit 1
fi

input="$1"
if [[ ! -f "$input" ]]; then
  echo "error: input file not found: $input" >&2
  exit 1
fi

# Resolve to absolute path so Chrome's file:// URL is unambiguous.
input_abs="$(cd "$(dirname "$input")" && pwd)/$(basename "$input")"

output="${2:-${input_abs%.html}.png}"

# Extract viewBox dimensions if not supplied (e.g. "0 0 2400 1620" -> "2400x1620").
if [[ $# -ge 3 ]]; then
  size="$3"
else
  vb=$(grep -oE 'viewBox="[^"]+"' "$input_abs" | head -1 | sed -E 's/viewBox="([^"]+)"/\1/' || true)
  if [[ -n "$vb" ]]; then
    w=$(echo "$vb" | awk '{print $3}')
    h=$(echo "$vb" | awk '{print $4}')
    size="${w%.*}x${h%.*}"
  else
    size="2400x1620"
  fi
fi

if [[ ! -x "$CHROME" ]]; then
  echo "error: Chrome not found at $CHROME" >&2
  exit 1
fi

echo "rendering: $input_abs"
echo "          → $output  (window: $size)"

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --hide-scrollbars \
  --no-sandbox \
  --window-size="$size" \
  --default-background-color=00000000 \
  --screenshot="$output" \
  "file://$input_abs" 2>&1 | grep -v -E "^\[" || true

if [[ ! -f "$output" ]]; then
  echo "error: screenshot was not created" >&2
  exit 1
fi

ls -lh "$output"
file "$output"
