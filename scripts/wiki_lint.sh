#!/usr/bin/env bash
# wiki_lint.sh — reference implementation for the wiki-lint skill.
#
# Source: skills/wiki-lint/SKILL.md. THE SKILL.md PROSE IS THE SPEC — this file
# only carries the bash primitives the prose's per-check procedures reference. If
# behavior changes, change it here AND in the matching SKILL.md check prose; the
# prose is authoritative on what each function must do and when it is called.
#
# Usage: `source scripts/wiki_lint.sh` then call the function named in the check:
#   Check 1  (broken links — spec slug namespace) : build_spec_slug_namespace
#   Check 8  (supersede-orphans)                  : check_supersede_orphans [vault]
#   Check 9  (empty hot buckets)                  : check_empty_buckets [vault]
#   Check 10 (stale project pages)                : check_stale_projects [vault]
#
# The functions are side-effect-free (stdout only) unless noted; sourcing this
# file defines them without running anything. Tests source this file directly
# (scripts/wiki_lint_test.py) to characterize behavior against a tiny temp
# fixture vault via the VAULT=<path> env override.

WIKI_LINT_VAULT="${VAULT:-$HOME/Documents/brain}"

# ============================================================================
# Check 1 — Broken wiki-links: build spec slug namespace
# (was fenced block `# Build spec slug namespace` inside the skip filter list)
# ============================================================================

# Build the set of cross-substrate spec slugs so the broken-links checker can
# categorize matching refs as cross-substrate rather than broken. Emits one slug
# per line to stdout. Reads:
#   - ~/.claude/specs/current.md (the active spec, if any): slug = value after "# Spec: "
#   - ~/.claude/specs/archive/*.md (archived specs): slug = filename minus -YYYYMMDD.md suffix
build_spec_slug_namespace() {
  {
    if [ -f ~/.claude/specs/current.md ]; then
      sed -n '1s/^# Spec: //p' ~/.claude/specs/current.md
    fi
    find ~/.claude/specs/archive -maxdepth 1 -name "*.md" 2>/dev/null \
      | sed -E 's|.*/||; s|-[0-9]{8}\.md$||'
  } | sort -u
}

# ============================================================================
# Check 8 — Supersede-orphans
# (was fenced block inside Check 8 prose)
# ============================================================================

# Find files in wiki/superseded/ that are not referenced by any active wiki
# page via "^supersedes: <slug>". Uses rg when available; falls back to grep.
# Emits one "ORPHAN: <path> (slug: <slug>)" line per orphaned archive.
# Vault root defaults to $VAULT env var or ~/Documents/brain; overridable for tests.
check_supersede_orphans() {
  local vault="${VAULT:-$HOME/Documents/brain}"
  find "${vault}/wiki/superseded" -type f -name "*.md" 2>/dev/null | while read f; do
    local slug
    slug=$(basename "$f" | sed -E 's/-[0-9]{8}\.md$//')
    local found=0
    if command -v rg >/dev/null 2>&1; then
      rg -l "^supersedes: ${slug}$" "${vault}/wiki" --glob '!superseded/*' >/dev/null 2>&1 && found=1
    else
      grep -rl "^supersedes: ${slug}$" "${vault}/wiki" --exclude-dir=superseded >/dev/null 2>&1 && found=1
    fi
    [ "$found" -eq 0 ] && echo "ORPHAN: $f (slug: $slug)"
  done
}

# ============================================================================
# Check 9 — Empty hot buckets
# (was fenced block inside Check 9 prose)
# ============================================================================

# For each hot bucket, count .md files (excluding index.md). Emit one
# "EMPTY: <bucket-relpath>" line per bucket with zero non-index files.
# Vault root defaults to $VAULT env var or ~/Documents/brain.
check_empty_buckets() {
  local vault="${VAULT:-$HOME/Documents/brain}"
  for d in wiki/daily wiki/domains wiki/entities sources/inbox sources/clippings sources/tweets sources/repos; do
    local full="$vault/$d"
    [ -d "$full" ] || continue
    local n
    n=$(find "$full" -maxdepth 1 -type f -name "*.md" -not -name "index.md" | wc -l | tr -d ' ')
    [ "$n" -eq 0 ] && echo "EMPTY: $d"
  done
}

# ============================================================================
# Check 10 — Stale project pages
# (was fenced block inside Check 10 prose)
# ============================================================================

# Find wiki/projects/<project>/index.md pages with mtime > 30 days. Emits one
# path per line. Vault root defaults to $VAULT env var or ~/Documents/brain.
check_stale_projects() {
  local vault="${VAULT:-$HOME/Documents/brain}"
  find "${vault}/wiki/projects" -maxdepth 2 -name index.md -mtime +30 2>/dev/null
}
