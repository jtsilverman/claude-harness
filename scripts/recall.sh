#!/usr/bin/env bash
# recall.sh — reference implementation for the recall skill.
#
# Source: skills/recall/SKILL.md. THE SKILL.md PROSE IS THE SPEC — this file
# only carries the bash primitives the prose's per-step procedures reference. If
# behavior changes, change it here AND in the matching SKILL.md step prose; the
# prose is authoritative on what each function must do and when recall calls it.
#
# Usage: `source scripts/recall.sh` then call the function named in the step:
#   Step 4   (wiki/src grep)  : grep_wiki_sources  "<project>" "<kw1>" "<kw2>" [...]
#   Step 5.5 (codebase grep)  : grep_codebase      "<kw1>" "<kw2>" [...]
#
# Pass 1 (memory) is NO LONGER a bash primitive: it is a single hybrid index query
# (`node scripts/memory-index.mjs query ...`) judged + body-loaded by the skill, with the
# per-entry tally bumped as a serialized DB UPDATE by the sole-writer. The old Pass-1 helpers
# (bump_tally_index / bump_tally_body / grep_failures, with their recall-tally.json sidecar)
# are retired; this file now carries only the Pass-2 and Pass-3 grep primitives.
#
# The functions are side-effect-confined as the prose describes; sourcing this
# file defines them without running anything. Tests source this file directly
# (scripts/recall_test.py) to characterize behavior against temp fixtures.

MEMORY_ROOT="${MEMORY_ROOT:-/Users/you/.claude/projects/-Users-admin--claude/memory}"
WIKI_ROOT="${WIKI_ROOT:-/Users/you/Documents/brain/wiki}"
SOURCES_ROOT="${SOURCES_ROOT:-/Users/you/Documents/brain/sources}"

# ============================================================================
# Step 4 — Pass 2: wiki + sources grep
# ============================================================================

# Grep wiki concepts, coding-log, the current project's wiki dir, and all
# source subdirs for keyword hits. Prints matching filenames.
# Args: $1 = current project name (pass empty string to skip project wiki dir)
#       $@ (remaining) = keyword strings (joined with | for rg -li pattern)
# Note: uses rg for wiki/sources (available from the real CC shell); falls back
#       to grep if rg is not on PATH (e.g., in a bare subshell for tests).
grep_wiki_sources() {
  local project="$1"
  shift
  local pattern
  pattern=$(printf '%s|' "$@" | sed 's/|$//')

  local dirs=()
  dirs+=("$WIKI_ROOT/concepts/")
  dirs+=("$WIKI_ROOT/coding-log/")
  if [ -n "$project" ] && [ -d "$WIKI_ROOT/projects/$project/" ]; then
    dirs+=("$WIKI_ROOT/projects/$project/")
  fi
  dirs+=("$SOURCES_ROOT/articles/")
  dirs+=("$SOURCES_ROOT/clippings/")
  dirs+=("$SOURCES_ROOT/perplexity/")
  dirs+=("$SOURCES_ROOT/tweets/")
  dirs+=("$SOURCES_ROOT/repos/")
  dirs+=("$SOURCES_ROOT/papers/")

  # Filter to dirs that exist
  local existing_dirs=()
  for d in "${dirs[@]}"; do
    [ -d "$d" ] && existing_dirs+=("$d")
  done
  [ ${#existing_dirs[@]} -eq 0 ] && return 0

  if command -v rg &>/dev/null; then
    rg -li "$pattern" "${existing_dirs[@]}" 2>/dev/null
  else
    grep -lir "$(echo "$pattern" | sed 's/|/\\|/g')" "${existing_dirs[@]}" 2>/dev/null
  fi
}

# ============================================================================
# Step 5.5 — Pass 3: codebase git grep
# ============================================================================

# Grep the project's git-tracked code dirs for keyword hits.
# Prints up to 40 path:line:match entries.
# Args: $@ = keyword strings (joined with | for git grep -E OR pattern).
# Note: uses git grep — scans only tracked files, respects .gitignore.
# Falls back to grep -r if not in a git repo.
grep_codebase() {
  local pattern
  pattern=$(printf '%s|' "$@" | sed 's/|$//')

  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null) || root="$PWD"
  cd "$root" || return 1

  git grep -niE "$pattern" -- \
    'scripts/*' 'skills/*' 'agents/*' 'hooks/*' 'src/*' 'lib/*' \
    ':!*.md' 2>/dev/null | head -40
}
