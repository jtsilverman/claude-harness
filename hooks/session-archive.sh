#!/usr/bin/env bash
#
# SessionEnd hook: ARCHIVES the session transcript on teardown + restores the
# mock-the operator corpus capture.
#
# This REPLACES the old per-/clear GRADE trigger (hooks/session-grader-launcher.sh,
# now disarmed): instead of firing a slow, paid headless grader run on EVERY
# /clear, this hook does the cheap, deterministic half -- it COPIES the session's
# transcript into a per-spec store so a single ship-time grade can read the whole
# arc later -- and re-invokes user_corpus_extract so the mock-the operator corpus keeps
# accumulating one message-capture per qualifying clear.
#
# Reads the SessionEnd JSON payload from stdin
#   {session_id, transcript_path, cwd, hook_event_name, reason}
# and, when the session is SPEC-RELATED, recursive-COPIES the session DIR (the
# sibling ${transcript_path%.jsonl}) plus the .jsonl itself into the per-spec
# store under the payload cwd:
#   specs/<slug>/sessions/<session-id>/        (locked / shipped spec)
#   specs/_pending-sessions/<session-id>/      (pre-lock drafting, no slug yet)
# The store is a COPY (an independent snapshot, not a reference) and ACCUMULATES
# (each session lands in its own <session-id>/ subdir; nothing is overwritten).
#
# SPEC-DETECTION (an OR of three signals, evaluated against the payload cwd):
#   A  $cwd/specs/current.md exists AND carries a "**Status:** Locked" line
#      -> spec-related; key = the `slug:` frontmatter value. (build/ship sessions)
#   B  current.md is ABSENT but a $cwd/specs/archive/<slug>-<today>.md was just
#      written -> spec-related; key = that filename's stem MINUS the trailing
#      -YYYYMMDD. Required because ship-spec DELETES current.md before the ship
#      session ends, so A alone would miss the ship session itself.
#   C  a NON-locked current.md exists, OR (no current.md and no signal-B archive
#      but) a $config_root/plans/*.md was modified within the last 30 min -- i.e.
#      a plan was just consumed this session -> spec-related but no slug yet ->
#      stage by session-id in specs/_pending-sessions/<id>/, re-keyed to the slug
#      at lock (a later chunk).
#   None match -> not spec-related: the per-spec archive is SKIPPED, but the
#      corpus capture STILL fires (below).
#
# CORPUS CAPTURE fires on EVERY qualifying clear, INDEPENDENT of spec-detection:
# capturing the operator's own messages is cheap + deterministic and the corpus must
# never lose a message, so it runs even in the None case. Best-effort: it never
# blocks or fails the hook. Runs from $config_root so the corpus lands at
# <config_root>/coo/voice-corpus-raw/<id>.md (the extractor writes relative to
# cwd; dedup-by-session makes a repeat run a no-op).
#
# NOT REGISTERED YET (the operator-gated go-live): this hook ships BUILT-BUT-UNREGISTERED.
# Arming the live SessionEnd registration (the settings.json edit) is a separate
# the operator-gated GO-LIVE step; this chunk does NOT touch settings.json.
#
# FAILS OPEN: any error logs to stderr and exits 0 with no output. A broken
# teardown hook must NEVER block a session from ending. There is nothing to emit
# to the harness on SessionEnd, so success is also a silent exit 0.

set -uo pipefail

# --- read + parse the SessionEnd payload -------------------------------------
# Capture stdin FIRST (never pipe it to a downstream heredoc/parser, which would
# consume it). On any read failure, fail open.
input=$(cat 2>/dev/null || true)

if [ -z "$input" ]; then
  echo "session-archive.sh: empty stdin, skipping" >&2
  exit 0
fi

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)
transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)

# Without a session id we cannot name the store / corpus output; fail open.
if [ -z "$session_id" ]; then
  echo "session-archive.sh: no session_id in payload, skipping" >&2
  exit 0
fi

# Bridge transcript_path (<projects>/<id>.jsonl) to the session DIR
# (<projects>/<id>/): the dir is the transcript path with the .jsonl suffix
# stripped (they are siblings). The .jsonl is the main log; the DIR holds nested
# workflow-subagent transcripts under <id>/subagents/, which a recursive copy of
# the DIR picks up automatically.
session_dir=""
if [ -n "$transcript_path" ]; then
  session_dir="${transcript_path%.jsonl}"
fi

# --- self-locate the config root (for the corpus extractor path) -------------
# This file lives at <config_root>/hooks/session-archive.sh, so ../ from the
# script dir is the config root (~/.claude live, or the worktree root in-tree).
# Hermetic and independent of $cwd. The corpus output anchors here; the per-spec
# archive (below) anchors at the payload $cwd instead -- the corpus is a global
# COO resource, the per-spec store belongs to the graded workspace.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)
config_root=$(cd "${script_dir:-.}/.." 2>/dev/null && pwd || true)

# --- JAKE-MESSAGE CAPTURE (mock-the operator corpus, RAW tier) -----------------------
# Runs on EVERY qualifying SessionEnd, BEFORE (and independent of) the spec-
# detection / archive below, so a None-case clear still captures the corpus.
# Best-effort -- never blocks or fails the hook. Passes $session_dir as ARGV (the
# extractor derives the sibling .jsonl from it); does NOT pipe $input to it.
corpus_script="$config_root/scripts/user_corpus_extract.py"
if [ -n "$session_dir" ] && [ -f "$corpus_script" ]; then
  ( cd "$config_root" && python3 "$corpus_script" "$session_dir" >/dev/null 2>&1 ) || true
fi

# --- SPEC-DETECTION: resolve the per-spec store key (OR of signals A/B/C) -----
# Without a cwd we have nowhere to anchor the per-spec store; corpus already
# fired, so exit 0.
if [ -z "$cwd" ]; then
  exit 0
fi

current_md="$cwd/specs/current.md"
today=$(date +%Y%m%d)

# store_dir is the destination <session-id>/ directory once a signal matches;
# empty means "no spec signal" (None -> skip the archive).
store_dir=""
# slug is the spec's canonical slug, set only on Signal A; empty otherwise.
slug=""

if [ -f "$current_md" ] && grep -q '^\*\*Status:\*\* Locked' "$current_md" 2>/dev/null; then
  # Signal A: a LOCKED current.md -> key = its slug: frontmatter value.
  # Production current.md carries the slug as a BOLD markdown line
  # (`**slug:** <x>`), so parse robustly: take the first line containing
  # `slug:`, strip the bold `**` markers, drop the `slug:` prefix, and trim
  # surrounding whitespace. This matches BOTH `**slug:** <x>` and bare
  # `slug: <x>` (a bare-grep on '^slug:' silently missed the bold line and
  # skipped the archive).
  slug=$(grep -m1 'slug:' "$current_md" 2>/dev/null \
    | sed -e 's/\*\*//g' -e 's/.*slug:[[:space:]]*//' -e 's/[[:space:]]*$//')
  if [ -n "$slug" ]; then
    store_dir="$cwd/specs/$slug/sessions/$session_id"
  fi
elif [ ! -f "$current_md" ]; then
  # Signal B: current.md ABSENT but a just-written specs/archive/<stem>-<today>.md
  # names the slug (ship-spec deleted current.md before this session ended).
  # Key = the archive filename stem MINUS the trailing -<today>.
  # Tie-break by most-recently-modified (`ls -t`): with >1 same-day archive,
  # `find ... | head -n1` returns an UNSPECIFIED directory-traversal order and
  # can surface a stale file, mis-keying the store; `ls -t` deterministically
  # selects the just-written newest archive.
  archive_file=$(ls -t "$cwd/specs/archive"/*-"${today}".md 2>/dev/null | head -n1)
  # Signal C (plans arm) detection, hoisted ABOVE the archive branch so a RECENT plan
  # can outrank a STALE same-day archive. A plan "just consumed" this session means
  # pre-lock drafting whose cwd has no current.md yet (e.g. spec-collaboration consumed
  # a ~/.claude/plans/*.md but has not written current.md). Heuristic: any plans file
  # modified within the last 30 minutes. The plans dir resolves to $config_root/plans/
  # (the self-located root), not the live ~/.claude/plans, so the arm is hermetic/testable.
  recent_plan=$(find "$config_root/plans" -maxdepth 1 -type f -name '*.md' -mmin -30 2>/dev/null \
    | head -n1)
  if [ -n "$archive_file" ]; then
    # PRECEDENCE: with BOTH a same-day archive AND a just-consumed plan present, a NEWER
    # plan means a fresh creation session started after an earlier same-day ship -- the
    # session belongs to the NEW (not-yet-locked) spec, not the OLD shipped one. Let the
    # recent plan outrank the stale archive: take Signal C (pending), not Signal B. If the
    # archive is newer-or-equal (or there is no recent plan), Signal B still wins as before.
    if [ -n "$recent_plan" ] && [ "$recent_plan" -nt "$archive_file" ]; then
      store_dir="$cwd/specs/_pending-sessions/$session_id"
    else
      stem=$(basename "$archive_file" .md)
      archive_slug="${stem%-${today}}"
      if [ -n "$archive_slug" ]; then
        store_dir="$cwd/specs/$archive_slug/sessions/$session_id"
      fi
    fi
  elif [ -n "$recent_plan" ]; then
    # Signal C (plans arm), no archive at all: a plan was just consumed this session but
    # the cwd has no current.md yet. Stage by session-id in the pending bucket (no slug
    # yet), re-keyed to the slug at lock.
    store_dir="$cwd/specs/_pending-sessions/$session_id"
  fi
else
  # Signal C: current.md exists but is NOT Locked -> pre-lock drafting, no slug
  # yet -> stage by session-id in the pending bucket (re-keyed to the slug at lock).
  store_dir="$cwd/specs/_pending-sessions/$session_id"
fi

# None matched -> not spec-related: corpus already fired, no archive. Exit 0.
if [ -z "$store_dir" ]; then
  exit 0
fi

# --- RE-KEY: move any pending sessions into the now-known slug store ----------
# Fires only on Signal A (slug is known). Scans specs/_pending-sessions/ and
# mv-s every <id>/ subdir into specs/<slug>/sessions/<id>/. The store
# ACCUMULATES (each session lands in its own <id>/ subdir; mv is safe because
# two sessions with distinct ids never share a destination). Sources that have
# already been moved are gone after the mv; this is a true re-key (not a copy).
# Best-effort: errors are logged but do NOT fail the hook.
if [ -n "$slug" ]; then
  pending_root="$cwd/specs/_pending-sessions"
  slug_sessions_root="$cwd/specs/$slug/sessions"
  if [ -d "$pending_root" ]; then
    for pending_dir in "$pending_root"/*/; do
      # Guard: only process entries that are actual directories.
      [ -d "$pending_dir" ] || continue
      pending_id=$(basename "$pending_dir")
      dest="$slug_sessions_root/$pending_id"
      mkdir -p "$slug_sessions_root" 2>/dev/null || true
      mv "$pending_dir" "$dest" 2>/dev/null || true
    done
  fi
fi

# --- ARCHIVE: recursive COPY of the session DIR + the sibling .jsonl ----------
# The store ACCUMULATES (each session in its own <session-id>/ subdir) and is an
# independent COPY (cp duplicates bytes; later edits to the source do not touch
# the stored copy). The session DIR may be absent (orphan case): copy the lone
# .jsonl and DO NOT crash. Best-effort throughout -- fail open on any cp error.
mkdir -p "$store_dir" 2>/dev/null || true

# Copy the recursive session DIR when it exists (carries nested subagent
# transcripts under subagents/). Orphan sessions have no dir -> skip silently.
if [ -n "$session_dir" ] && [ -d "$session_dir" ]; then
  cp -R "$session_dir" "$store_dir/" 2>/dev/null || true
fi

# Copy the main .jsonl alongside the dir copy (always present when we got here).
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  cp "$transcript_path" "$store_dir/" 2>/dev/null || true
fi

exit 0
