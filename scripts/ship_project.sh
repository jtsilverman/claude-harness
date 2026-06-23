#!/usr/bin/env bash
# ship_project.sh — reference implementation for the ship-project skill.
#
# Source: skills/ship-project/SKILL.md. THE SKILL.md PROSE IS THE SPEC — this
# file only carries the bash primitives the prose's per-step procedures
# reference. If behavior changes, change it here AND in the matching SKILL.md step
# prose; the prose is authoritative on what each function must do and when the
# COO calls it.
#
# Usage: `source scripts/ship_project.sh` then call the function named in the step:
#   Step 7c (collage round-trip) : collage_round_trip <implement-url> <slug>   (VAULT=<path> override)
#
# The collage_round_trip orchestrator composes the lower-level primitives:
#   fetch_implement_tarball <url> <out>      — curl the gzipped Claude Design tar
#   extract_design <tarball> <work_dir>      — untar; accept README at root or one level deep
#   find_canonical_html <work_dir>           — largest *.html in the extracted tree
#   persist_html <src> <target>              — atomic copy via tmp-derived-from-target; refuses overwrite
#   render_collage_png <html>                — rasterize via render-design-png.sh
#
# The functions are side-effect-confined as the prose describes; sourcing this
# file defines them without running anything. Tests source this file directly
# (scripts/ship_project_test.py) to characterize behavior against temp fixtures.

# ============================================================================
# Step 7c — Collage round-trip (was fenced block `# step-7-impl`)
# ============================================================================

# Fetch the gzipped Claude Design tarball from an implement URL.
# Per `claude-design-implement-handoff`: claude.ai/design/<id> serves gzipped tar.
fetch_implement_tarball() {
  local url="$1" out="$2"
  curl -fsSL -o "$out" "$url" || return 1
  [ -s "$out" ] || return 1
}

# Extract a Claude Design tarball into work_dir.
# Per `claude-design-implement-handoff`: README + chats/ + project/ are bundled
# either at the root of the tarball (legacy format) OR inside a single
# `claude-<project-slug>/` wrapper directory (current format as of 2026-05-07
# dogfood; the slug derives from the Claude Design project title).
extract_design() {
  local tarball="$1" work_dir="$2"
  mkdir -p "$work_dir"
  tar -xzf "$tarball" -C "$work_dir" || return 1
  # Accept README at root OR one level deep inside a wrapper dir.
  find "$work_dir" -maxdepth 2 -name 'README.md' -type f | head -1 | grep -q .
}

# Locate the canonical HTML render inside an extracted Claude Design directory.
# Heuristic: the largest *.html under the dir tree (Claude Design embeds the
# whole render in one HTML file; chat exports are .md, not .html).
find_canonical_html() {
  local work_dir="$1"
  find "$work_dir" -name '*.html' -type f -print0 \
    | xargs -0 -I{} stat -f '%z %N' {} 2>/dev/null \
    | sort -rn | head -1 | awk '{$1=""; sub(/^ /, ""); print}'
}

# Copy HTML to target via tmp-derived-from-target, per
# `atomic-rename-tmp-derived-from-target`. Refuses to overwrite an existing
# target so a prior collage is never silently clobbered.
persist_html() {
  local src="$1" target="$2"
  if [ -e "$target" ]; then
    echo "persist_html: $target exists; refusing to overwrite. Move or remove the prior collage first." >&2
    return 1
  fi
  local tmp="${target}.tmp.$$"
  cp "$src" "$tmp" && mv "$tmp" "$target"
}

# Render the collage HTML to PNG via render-design-png.sh.
# Per `claude-design-png-export-for-obsidian`: HTML is canonical, PNG is the
# Obsidian preview sibling; re-export after every HTML edit.
render_collage_png() {
  local html="$1"
  ~/.claude/scripts/render-design-png.sh "$html"
}

# Top-level orchestrator. Fetches the tarball, extracts, persists HTML, renders
# PNG. Emits the HTML and PNG target paths to stdout (one per line) for the
# caller to consume in prose Step 7d. VAULT env override for tests.
collage_round_trip() {
  local url="$1" slug="$2"
  local vault="${VAULT:-$HOME/Documents/brain}"
  local proj_dir="$vault/wiki/projects/$slug"
  [ -d "$proj_dir" ] || { echo "collage_round_trip: project dir missing: $proj_dir" >&2; return 1; }

  local work_dir tarball html_target png_target src_html
  work_dir=$(mktemp -d -t "collage-${slug}-XXXXXX")
  tarball="$work_dir/design.tar.gz"
  html_target="$proj_dir/L0-collage.html"
  png_target="$proj_dir/L0-collage.png"

  fetch_implement_tarball "$url" "$tarball" \
    || { echo "collage_round_trip: fetch failed for $url" >&2; return 1; }
  extract_design "$tarball" "$work_dir/extract" \
    || { echo "collage_round_trip: extract failed (no README.md at root?)" >&2; return 1; }
  src_html=$(find_canonical_html "$work_dir/extract")
  [ -n "$src_html" ] && [ -f "$src_html" ] \
    || { echo "collage_round_trip: no .html found in tarball" >&2; return 1; }

  persist_html "$src_html" "$html_target" || return 1
  render_collage_png "$html_target" \
    || { echo "collage_round_trip: PNG render failed" >&2; return 1; }

  echo "$html_target"
  echo "$png_target"
}
