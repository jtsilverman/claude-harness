#!/usr/bin/env bash
# ship_spec.sh — reference implementation for the ship-spec skill.
#
# Source: skills/ship-spec/SKILL.md. THE SKILL.md PROSE IS THE SPEC — this file
# only carries the bash primitives the prose's per-step procedures reference. If
# behavior changes, change it here AND in the matching SKILL.md step prose; the
# prose is authoritative on what each function must do and when the COO calls it.
#
# Usage: `source scripts/ship_spec.sh` then call the function named in the step:
#   Step 6  (scaffolding sweep) : sweep_scaffolding "<project-root>" "<slug>-YYYYMMDD"
#   Step 8  (drift-queue drain) : drain_drift_queue "<archived-spec-path>"
#   Step 9  (vault-sweep snap.) : wiki_drift_snapshot "<archived-spec-path>"   (VAULT=<path> override)
#   Step 10 (resolution snap.)  : <log-via-stdin> | write_resolution_snapshot "<archived-spec>"
#   Step 10.5 (clear exec state): clear_execution_state "<archived-spec>"
#   Step 10.55 (ship-time grade): COO-hosted IN-SESSION Workflow (no shell primitive),
#                                  via workflows/grader-workflow.js; see skills/ship-spec/SKILL.md.
#
# The functions are side-effect-confined as the prose describes; sourcing this
# file defines them without running anything. Tests source this file directly
# (scripts/ship_spec_test.py) to characterize behavior against temp fixtures.

# ============================================================================
# Step 6 — Scaffolding sweep (was fenced block `# step-6-impl`)
# ============================================================================

# List Bucket A (auto-move) candidates. Emits one path per line.
# Searches:
#   - specs/ (maxdepth 1): files matching chunk-*, pivot-*, plan-* globs.
#   - specs/scripts/ (maxdepth 1): files starting with ${slug}- (spec-scoped
#     scaffolding). Skipped if slug is empty or scripts/ doesn't exist.
list_bucket_a() {
  local specs_dir="$1"
  local slug="$2"
  [ -d "$specs_dir" ] || return 0
  {
    find "$specs_dir" -maxdepth 1 -type f \( \
         -name 'chunk-*' -o \
         -name 'pivot-*' -o \
         -name 'plan-*' \
       \) 2>/dev/null
    if [ -n "$slug" ] && [ -d "$specs_dir/scripts" ]; then
      find "$specs_dir/scripts" -maxdepth 1 -type f \
           -name "${slug}-*" \
           2>/dev/null
    fi
  } | sort
}

# List Bucket B (delete) candidates. Uses an EXPLICIT allow-pattern: only
# slug-prefixed ship ephemera (<slug>-*) and .bak / .bak-* files are targeted.
# .bak-* covers timestamped backups (e.g. current.md.bak-20260621-143000).
# This is intentionally narrower than the old deny-with-protect-list: arbitrary
# loose files in specs/ root (cross-spec design docs, standing registers, etc.)
# survive automatically because they don't match the allow-pattern.
# Protect-list (current.md, owed-items.md) survive as before since they don't
# match either pattern.
list_bucket_b() {
  local specs_dir="$1" slug="$2"
  [ -d "$specs_dir" ] || return 0
  [ -z "$slug" ] && return 0
  find "$specs_dir" -maxdepth 1 -type f \( \
       -name "${slug}-*" -o \
       -name '*.bak' -o \
       -name '*.bak-*' \
       \) 2>/dev/null | sort
}

# Delete a list of paths (one per line on stdin). Echoes the count deleted.
# rm is irreversible by design: a shipped spec's acceptance scaffolding is
# throwaway (the operator's call 2026-06-03), so the sweep deletes rather than archives.
delete_paths() {
  local deleted=0
  while IFS= read -r src; do
    [ -z "$src" ] && continue
    [ -f "$src" ] || continue
    rm -f "$src" && deleted=$((deleted + 1))
  done
  echo "$deleted"
}

# Top-level orchestrator. DELETES both buckets unconditionally (no archive
# sibling, no AskUserQuestion prompt) and reports per-bucket deleted counts.
# Protect-list (current.md, owed-items.md) and specs/scripts/ orphans are
# excluded upstream by list_bucket_b / list_bucket_a, so this never needs a
# guard of its own.
sweep_scaffolding() {
  local project_root="$1" slug_dated="$2"
  local specs_dir="$project_root/specs"
  # Extract slug from slug_dated by stripping trailing -YYYYMMDD (8 digits).
  # If the input doesn't match, slug stays equal to slug_dated and scripts/
  # matching falls back to a literal prefix.
  local slug="${slug_dated%-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]}"

  local bucket_a bucket_b a_deleted b_deleted
  bucket_a=$(list_bucket_a "$specs_dir" "$slug")
  bucket_b=$(list_bucket_b "$specs_dir" "$slug")
  a_deleted=0
  b_deleted=0
  [ -n "$bucket_a" ] && a_deleted=$(printf '%s\n' "$bucket_a" | delete_paths)
  [ -n "$bucket_b" ] && b_deleted=$(printf '%s\n' "$bucket_b" | delete_paths)

  echo "bucket_a_deleted=$a_deleted"
  echo "bucket_b_deleted=$b_deleted"
}

# ============================================================================
# Step 8 — Drift-queue drain (was fenced block `# step-8-impl`)
# ============================================================================

# Read the § Drift queue section from a spec file. Emit one pipe-delimited line per entry.
# Skips the placeholder `_(append-only; ...)_` line if present.
parse_queue() {
  local spec="$1"
  [ -f "$spec" ] || return 0
  awk '
    /^## Drift queue \(drained at ship\)/ { in_section = 1; next }
    /^## / && in_section { in_section = 0 }
    in_section && /\|/ && !/^_\(/ { print }
  ' "$spec"
}

# Read pipe-lines from stdin. Emit "handler=count" lines to stdout, one per handler bucket.
bucket_by_handler() {
  awk -F' \\| ' '
    {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^handler=/) {
          h = substr($i, 9)
          counts[h]++
        }
      }
    }
    END {
      for (h in counts) print h "=" counts[h]
    }
  '
}

# Read pipe-lines from stdin. For each line, compare the target file mtime to the queue ISO
# timestamp. Emit the original line plus " | verdict=active" or " | verdict=self-resolved".
# Lines whose target is UNRESOLVED or missing pass through as active.
mtime_recheck() {
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local ts target queue_epoch target_mtime
    ts=$(printf '%s' "$line" | awk -F' \\| ' '{print $1}')
    target=$(printf '%s' "$line" | awk -F' \\| ' '{
      for (i = 1; i <= NF; i++) if ($i ~ /^target=/) print substr($i, 8)
    }')
    if [ -z "$target" ] || [ "$target" = "UNRESOLVED" ] || [ ! -e "$target" ]; then
      printf '%s | verdict=active\n' "$line"
      continue
    fi
    queue_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null \
                  || date -u -d "$ts" +%s 2>/dev/null)
    target_mtime=$(stat -f %m "$target" 2>/dev/null || stat -c %Y "$target" 2>/dev/null)
    if [ -n "$queue_epoch" ] && [ -n "$target_mtime" ] && [ "$target_mtime" -gt "$queue_epoch" ]; then
      printf '%s | verdict=self-resolved\n' "$line"
    else
      printf '%s | verdict=active\n' "$line"
    fi
  done
}

# Read pipe-lines from stdin. Emit a human-readable consolidated list:
# total count, per-handler breakdown, time estimate, and per-entry summary.
format_consolidated_list() {
  local lines total diagram prose index unknown est_min
  lines=$(cat)
  total=$(printf '%s\n' "$lines" | grep -c '|')
  diagram=$(printf '%s\n' "$lines" | grep -c 'handler=diagram')
  prose=$(printf '%s\n' "$lines" | grep -c 'handler=prose')
  index=$(printf '%s\n' "$lines" | grep -c 'handler=index')
  unknown=$(printf '%s\n' "$lines" | grep -c 'handler=UNKNOWN')
  est_min=$(( diagram * 12 + (prose + index) / 2 + unknown * 2 ))
  echo "Drift queue: $total entries (diagram=$diagram, prose=$prose, index=$index, UNKNOWN=$unknown)"
  echo "Estimated review time: ~${est_min} min (diagram entries refreshed in parallel by diagram-refresher agents)"
  if [ "$total" -gt 0 ]; then
    echo ""
    echo "Entries:"
    printf '%s\n' "$lines" | awk -F' \\| ' '
      /\|/ {
        edited = ""; target = ""; handler = ""
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^edited=/)  edited  = substr($i, 8)
          if ($i ~ /^target=/)  target  = substr($i, 8)
          if ($i ~ /^handler=/) handler = substr($i, 9)
        }
        printf "  - %s | %s -> %s\n", handler, edited, target
      }
    '
  fi
}

# Emit first 3 lines of source artifact for the diff preview shown in handler outputs.
# Surfaces "(source missing: <path>)" if absent so callers always get a single-line surrogate
# rather than empty stdout (which would silently shrink the structured surface).
source_diff_3line() {
  local source="$1"
  if [ ! -f "$source" ]; then
    echo "(source missing: $source)"
    return 0
  fi
  head -n 3 "$source"
}

# Shared worker for prose + index handlers. Side-effect-free: emits a structured surface
# Claude reads to draft the wiki Edit. On target-missing, emits the deferred verdict (no
# preview block) so the orchestrator marks deferred and continues without further work.
_diff_draft_handler() {
  local handler="$1" line="$2"
  local edited target preview
  edited=$(printf '%s\n' "$line" | awk -F' \\| ' '{for(i=1;i<=NF;i++) if($i~/^edited=/) print substr($i,8)}')
  target=$(printf '%s\n' "$line" | awk -F' \\| ' '{for(i=1;i<=NF;i++) if($i~/^target=/) print substr($i,8)}')
  if [ ! -f "$target" ]; then
    printf 'verdict=deferred-target-missing handler=%s target=%s\n' "$handler" "$target"
    return 0
  fi
  preview=$(source_diff_3line "$edited")
  printf 'verdict=draft handler=%s source=%s target=%s\n' "$handler" "$edited" "$target"
  printf -- '--- source preview (first 3 lines) ---\n%s\n--- end preview ---\n' "$preview"
}

prose_handler() { _diff_draft_handler prose "$1"; }
index_handler() { _diff_draft_handler index "$1"; }

# UNKNOWN handler: emit the 3-line source preview + the route-prompt text. Side-effect-free.
# Claude reads the output and runs AskUserQuestion to capture the routing answer + new-pair
# flag (see workflow step 7 prose).
unknown_handler() {
  local line="$1"
  local edited preview
  edited=$(printf '%s\n' "$line" | awk -F' \\| ' '{for(i=1;i<=NF;i++) if($i~/^edited=/) print substr($i,8)}')
  preview=$(source_diff_3line "$edited")
  printf 'verdict=route-prompt handler=UNKNOWN source=%s\n' "$edited"
  printf -- '--- source preview (first 3 lines) ---\n%s\n--- end preview ---\n' "$preview"
  echo "Prompt: route this edit to which wiki page? (path) Optionally add a pair-table row."
}

# Top-level orchestrator. Emits the consolidated list (with self-resolved diagram entries
# already dropped) to stdout. Does NOT fire any agent or AskUserQuestion — those require
# the COO + the operator synchronous loop that the SKILL.md prose teaches. Test scripts call this
# function to verify the list-formation pipeline end-to-end.
drain_drift_queue() {
  local archive_path="$1"
  local active
  active=$(parse_queue "$archive_path" | mtime_recheck | grep -v 'verdict=self-resolved')
  printf '%s\n' "$active" | format_consolidated_list
}

# ============================================================================
# Step 9 — Vault-sweep snapshot (was fenced block `# step-9-impl`).
# Retained as the COO's degrade/manual fallback when the vault-sweeper agent
# (Step 4 fan-out) is unavailable or ship-spec is run outside the fan-out path.
# ============================================================================

wiki_drift_snapshot() {
  local archive_path="$1"
  local vault="${VAULT:-$HOME/Documents/brain}"

  if [ ! -d "$vault" ]; then
    echo "wiki-lint skipped: vault not found at $vault. Ship continuing without snapshot."
    return 0
  fi

  local threshold
  threshold=$(date -j -v-30d +%Y-%m-%d 2>/dev/null || date -d "30 days ago" +%Y-%m-%d)

  # Check 1: broken links (unique targets)
  local broken_targets existing broken n_broken
  broken_targets=$(grep -rohE '\[\[[^]|]+(\|[^]]+)?\]\]' "$vault/wiki" 2>/dev/null \
    | sed -E 's/^\[\[([^|\]]+).*\]\]$/\1/' | sort -u)
  existing=$(find "$vault" -name '*.md' -exec basename {} .md \; 2>/dev/null | sort -u)
  broken=$(comm -23 <(echo "$broken_targets") <(echo "$existing") 2>/dev/null)
  n_broken=$(printf '%s' "$broken" | grep -c . 2>/dev/null)

  # Check 2: orphans
  local referenced all_pages orphans n_orphans
  referenced=$(grep -rohE '\[\[[^]|]+' "$vault/wiki" 2>/dev/null \
    | sed -E 's/^\[\[//' | sort -u)
  all_pages=$(find "$vault/wiki" -name '*.md' -exec basename {} .md \; 2>/dev/null | sort -u)
  orphans=$(comm -23 <(echo "$all_pages") <(echo "$referenced") \
    | grep -vE '^(index|SCHEMA|log|conventions|diagram-conventions)$' 2>/dev/null)
  n_orphans=$(printf '%s' "$orphans" | grep -c . 2>/dev/null)

  # Check 3: stale frontmatter
  local n_stale
  n_stale=$(grep -rH '^updated:' "$vault/wiki" 2>/dev/null \
    | awk -F'updated: *' -v thr="$threshold" 'NF>1 && $2 < thr {n++} END {print n+0}')

  # Check 4: supersede-orphans
  local supersede_orphans n_supersede
  supersede_orphans=""
  if [ -d "$vault/wiki/superseded" ]; then
    supersede_orphans=$(find "$vault/wiki/superseded" -type f -name "*.md" 2>/dev/null | while read f; do
      slug=$(basename "$f" | sed -E 's/-[0-9]{8}\.md$//')
      if ! grep -rl "^supersedes: ${slug}$" "$vault/wiki" --exclude-dir=superseded 2>/dev/null | head -1 >/dev/null 2>&1; then
        echo "$f"
      fi
    done)
  fi
  n_supersede=$(printf '%s' "$supersede_orphans" | grep -c . 2>/dev/null)

  # Check 5: empty hot buckets
  local empty_buckets="" n_empty=0
  for d in wiki/daily wiki/domains wiki/entities wiki/concepts sources/inbox sources/clippings sources/tweets sources/repos; do
    local full="$vault/$d"
    [ ! -d "$full" ] && continue
    local n
    n=$(find "$full" -maxdepth 1 -type f -name "*.md" -not -name "index.md" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$n" -eq 0 ]; then
      empty_buckets="${empty_buckets}${d}"$'\n'
      n_empty=$((n_empty+1))
    fi
  done

  # One-line summary to stdout
  echo "Vault drift at ship: $n_broken broken links, $n_orphans orphans, $n_stale stale frontmatter, $n_supersede supersede-orphans, $n_empty empty buckets."

  # Append snapshot section to archived spec
  {
    echo ""
    echo "## Vault drift snapshot (ship time)"
    echo ""
    echo "Generated $(date +%Y-%m-%d) by ship-spec Step 9 (vault-sweeper agent). Counts only; for narrative inspection (contradictions, concept-suggestions) run \`/wiki-lint\` manually."
    echo ""
    echo "### Counts"
    echo ""
    echo "- $n_broken broken links (unique targets)"
    echo "- $n_orphans orphans"
    echo "- $n_stale stale frontmatter"
    echo "- $n_supersede supersede-orphans"
    echo "- $n_empty empty buckets"
    echo ""
    if [ "$n_broken" -gt 0 ]; then
      echo "### Broken-link targets"
      echo ""
      echo "$broken" | sed 's/^/- /'
      echo ""
    fi
    if [ "$n_orphans" -gt 0 ]; then
      echo "### Orphan pages"
      echo ""
      echo "$orphans" | sed 's/^/- /'
      echo ""
    fi
    if [ "$n_supersede" -gt 0 ]; then
      echo "### Supersede-orphans"
      echo ""
      echo "$supersede_orphans" | sed 's/^/- /'
      echo ""
    fi
    if [ "$n_empty" -gt 0 ]; then
      echo "### Empty hot buckets"
      echo ""
      printf '%s' "$empty_buckets" | sed 's/^/- /'
      echo ""
    fi
  } >> "$archive_path"
}

# ============================================================================
# Step 10 — Drift-queue resolution snapshot (was fenced block `# step-10-impl`)
# ============================================================================

write_resolution_snapshot() {
  local archive="$1"
  [ -f "$archive" ] || { echo "write_resolution_snapshot: archive not found: $archive" >&2; return 0; }

  local log
  log=$(cat)
  if [ -z "$log" ]; then
    return 0
  fi

  local tmp="${archive}.tmp.$$"
  LOG="$log" python3 - "$archive" "$tmp" <<'PY'
import sys, os, re
archive_path, tmp_path = sys.argv[1], sys.argv[2]
log = os.environ.get('LOG', '').strip()
with open(archive_path) as f:
    text = f.read()

# Empty the drained section body (heading retained as marker; body replaced with a stub line).
text = re.sub(
    r'(## Drift queue \(drained at ship\)\n)(.*?)(?=\n## |\Z)',
    r'\1\n_(emptied at ship; resolutions recorded in `## Drift queue (resolved at ship)` below)_\n',
    text,
    count=1,
    flags=re.S,
)

# Append the resolved section. One bullet per log line.
section_lines = ["", "## Drift queue (resolved at ship)", ""]
for line in log.splitlines():
    line = line.strip()
    if line:
        section_lines.append("- " + line)
section_lines.append("")
section = "\n".join(section_lines)

if not text.endswith("\n"):
    text += "\n"
text += section

with open(tmp_path, 'w') as f:
    f.write(text)
PY
  mv "$tmp" "$archive"
}

# ============================================================================
# Step 10.5 — Clear `## Execution state` (was fenced block `# clear-exec-state-impl`)
# ============================================================================

clear_execution_state() {
  local archive="$1"
  [ -f "$archive" ] || { echo "clear_execution_state: archive not found: $archive" >&2; return 0; }
  grep -q '^## Execution state' "$archive" || return 0  # single-threaded spec: no board to clear

  local tmp="${archive}.tmp.$$"
  python3 - "$archive" "$tmp" <<'PY'
import sys, re
archive_path, tmp_path = sys.argv[1], sys.argv[2]
with open(archive_path) as f:
    text = f.read()

# Empty the ## Execution state body (heading retained as a marker; body
# replaced with a stub). Run-state is scratch; the archived spec carries none.
text = re.sub(
    r'(## Execution state\n)(.*?)(?=\n## |\Z)',
    r'\1\n_(cleared at ship; run state is not archived)_\n',
    text,
    count=1,
    flags=re.S,
)

with open(tmp_path, 'w') as f:
    f.write(text)
PY
  mv "$tmp" "$archive"
}

# ============================================================================
# Step 10.55 — Read-only ship-time grade over the per-spec session archive.
# NO SHELL FUNCTION: the grade runs as an IN-SESSION Workflow the COO hosts
# directly via workflows/grader-workflow.js (segment -> flaggers -> judge ->
# routed findings); ship_spec.sh keeps NO grade primitive. See skills/ship-spec/SKILL.md.
# ============================================================================

# ============================================================================
# Driver — sequences the five file-mutation ship primitives in one call.
# Git steps are NOT included here; they stay prose in the ship-spec skill.
# Args: $1 = project_root, $2 = slug_dated, $3 = archive_path
# Stdin: passed through to write_resolution_snapshot (empty = no-op per that fn)
# ============================================================================

apply_all_ship_mutations() {
  local project_root="$1" slug_dated="$2" archive="$3"
  sweep_scaffolding "$project_root" "$slug_dated"
  drain_drift_queue "$archive"
  wiki_drift_snapshot "$archive"
  write_resolution_snapshot "$archive"
  clear_execution_state "$archive"
  # Delete the cockpit sidecar (ephemeral run-state: in-flight runIds, bundles,
  # fired demo ids). It lives at specs/.cockpit-sidecar.json (sibling of current.md,
  # per cockpit_sidecar.py default_sidecar_path). Use $project_root, not dirname($archive)
  # -- the archive path is specs/archive/<slug>-YYYYMMDD.md so dirname resolves to
  # specs/archive/, not specs/.
  local sidecar
  sidecar="$project_root/specs/.cockpit-sidecar.json"
  [ -f "$sidecar" ] && rm -f "$sidecar"
}
