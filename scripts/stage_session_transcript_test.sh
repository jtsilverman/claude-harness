#!/usr/bin/env bash
# Acceptance test for chunk 2: stage_session_transcript.sh + ship-spec Step 5 update
#
# Covers:
#   C1: staging copies newest <id>.jsonl + <id>/subagents into specs/<slug>/sessions/<id>/
#   C2: re-run is idempotent (no duplicate files, exit 0)
#   C3: source files remain in place (copy, not move)
#   C4: no transcript found -> non-zero exit + non-empty stderr
#   C5: ship-spec Step 5 instructs COO to build manifest via buildSegmentManifest + pass args.manifest
#   C6: ship-spec Step 5 calls scripts/stage_session_transcript.sh + grader args are
#       { manifest, specSlug } (sessionArchiveDir is absent from the shipped contract)
#   C7: errors-only fail-open clause + large-archive scope guidance are preserved

set -uo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SCRIPT="$REPO_ROOT/scripts/stage_session_transcript.sh"
SKILL="$REPO_ROOT/skills/ship-spec/SKILL.md"

PASS=0
FAIL=0

pass() { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# ---------------------------------------------------------------------------
# C1-C4: functional tests against a synthetic fixture
# ---------------------------------------------------------------------------

TMPDIR_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# Build a minimal fixture that mirrors the real archive shape:
#   <projects_dir>/
#     <session_id>.jsonl          <- main transcript
#     <session_id>/
#       subagents/
#         sub-abc.jsonl           <- subagent transcript
#   <spec_root>/                  <- acts as the project cwd
#     specs/<slug>/               <- where staging should land

SESSION_ID="aaaabbbb-1111-2222-3333-ccccddddeeee"
SLUG="test-slug"

PROJECTS_DIR="$TMPDIR_ROOT/projects"
PROJECT_SLUG_DIR="$PROJECTS_DIR/-Users-admin-Documents-projects-myproject"  # matches cwd-slug style
mkdir -p "$PROJECT_SLUG_DIR"
mkdir -p "$PROJECT_SLUG_DIR/$SESSION_ID/subagents"

printf '{"event":"SessionStart"}\n' > "$PROJECT_SLUG_DIR/$SESSION_ID.jsonl"
printf '{"event":"SubagentMessage"}\n' > "$PROJECT_SLUG_DIR/$SESSION_ID/subagents/sub-abc.jsonl"

SPEC_ROOT="$TMPDIR_ROOT/spec_root"
mkdir -p "$SPEC_ROOT/specs"

# --- C1: first run copies both .jsonl and subagents/ ---
if [ ! -f "$SCRIPT" ]; then
  fail "C1: $SCRIPT does not exist (script not yet created)"
else
  OUT=$("$SCRIPT" "$SLUG" \
        --projects-dir "$PROJECT_SLUG_DIR" \
        --spec-root "$SPEC_ROOT" 2>&1)
  STATUS=$?

  if [ "$STATUS" -ne 0 ]; then
    fail "C1: script exited $STATUS on a valid fixture (expected 0); output: $OUT"
  else
    DEST_DIR="$SPEC_ROOT/specs/$SLUG/sessions/$SESSION_ID"
    if [ -f "$DEST_DIR/$SESSION_ID.jsonl" ]; then
      pass "C1a: .jsonl copied into specs/$SLUG/sessions/$SESSION_ID/"
    else
      fail "C1a: .jsonl NOT found at $DEST_DIR/$SESSION_ID.jsonl"
    fi

    if [ -f "$DEST_DIR/$SESSION_ID/subagents/sub-abc.jsonl" ]; then
      pass "C1b: subagents/ tree copied into specs/$SLUG/sessions/$SESSION_ID/"
    else
      fail "C1b: subagents/ tree NOT found at $DEST_DIR/$SESSION_ID/subagents/sub-abc.jsonl"
    fi
  fi
fi

# --- C2: re-run is idempotent ---
if [ -f "$SCRIPT" ]; then
  "$SCRIPT" "$SLUG" \
    --projects-dir "$PROJECT_SLUG_DIR" \
    --spec-root "$SPEC_ROOT" 2>/dev/null
  STATUS2=$?

  if [ "$STATUS2" -ne 0 ]; then
    fail "C2: second run exited $STATUS2 (expected 0, should be idempotent)"
  else
    DEST_DIR="$SPEC_ROOT/specs/$SLUG/sessions/$SESSION_ID"
    # Check exactly one .jsonl (no duplication of the .jsonl alongside the session dir copy)
    JSONL_COUNT=$(find "$DEST_DIR" -maxdepth 1 -name "$SESSION_ID.jsonl" | wc -l | tr -d ' ')
    if [ "$JSONL_COUNT" -eq 1 ]; then
      pass "C2: idempotent re-run does not duplicate .jsonl (count=$JSONL_COUNT)"
    else
      fail "C2: .jsonl count after re-run is $JSONL_COUNT (expected 1)"
    fi
  fi
fi

# --- C3: source files remain in place after staging ---
if [ -f "$SCRIPT" ]; then
  if [ -f "$PROJECT_SLUG_DIR/$SESSION_ID.jsonl" ]; then
    pass "C3: source .jsonl still present (copy, not move)"
  else
    fail "C3: source .jsonl was moved or deleted (should be a copy)"
  fi

  if [ -f "$PROJECT_SLUG_DIR/$SESSION_ID/subagents/sub-abc.jsonl" ]; then
    pass "C3b: source subagents/ still present (copy, not move)"
  else
    fail "C3b: source subagents/sub-abc.jsonl was moved or deleted"
  fi
fi

# --- C4: no transcript found -> non-zero exit + non-empty stderr ---
if [ -f "$SCRIPT" ]; then
  EMPTY_PROJECTS="$TMPDIR_ROOT/empty_projects"
  mkdir -p "$EMPTY_PROJECTS"
  SPEC_ROOT2="$TMPDIR_ROOT/spec_root2"
  mkdir -p "$SPEC_ROOT2/specs"

  # Capture stderr to a temp file; discard stdout; preserve exit status without || true
  STDERR_FILE="$TMPDIR_ROOT/c4_stderr.txt"
  set +e
  "$SCRIPT" "$SLUG" \
    --projects-dir "$EMPTY_PROJECTS" \
    --spec-root "$SPEC_ROOT2" \
    >"$TMPDIR_ROOT/c4_stdout.txt" 2>"$STDERR_FILE"
  STATUS4=$?
  set -e

  if [ "$STATUS4" -ne 0 ]; then
    pass "C4a: exits non-zero when no transcript found (exit=$STATUS4)"
  else
    fail "C4a: should exit non-zero on missing transcript, got exit 0"
  fi

  STDERR_OUT=$(cat "$STDERR_FILE")
  if [ -n "$STDERR_OUT" ]; then
    pass "C4b: produces diagnostic stderr when no transcript found"
  else
    fail "C4b: silent on missing transcript (should emit loud stderr)"
  fi
fi

# --- EC5: no subagents/ dir (no workflows ran) -> stage .jsonl alone, do not error ---
# Spec edge case: if the <session_id>/ sibling dir is absent, the script must still
# exit 0 and copy the .jsonl; it must NOT produce an error or non-zero exit.
if [ -f "$SCRIPT" ]; then
  EC5_PROJECTS="$TMPDIR_ROOT/ec5_projects"
  EC5_SPEC_ROOT="$TMPDIR_ROOT/ec5_spec_root"
  EC5_SESSION_ID="ec5sess-aaaa-bbbb-cccc-ddddeeeeeeee"
  EC5_SLUG="ec5-slug"
  mkdir -p "$EC5_PROJECTS"
  mkdir -p "$EC5_SPEC_ROOT/specs"

  # Only the .jsonl -- no session dir, no subagents/
  printf '{"event":"SessionStart"}\n' > "$EC5_PROJECTS/$EC5_SESSION_ID.jsonl"

  set +e
  EC5_OUT=$("$SCRIPT" "$EC5_SLUG" \
              --projects-dir "$EC5_PROJECTS" \
              --spec-root "$EC5_SPEC_ROOT" 2>&1)
  EC5_STATUS=$?
  set -e

  if [ "$EC5_STATUS" -eq 0 ]; then
    pass "EC5a: exits 0 when no subagents/ dir exists (jsonl-only session)"
  else
    fail "EC5a: exited $EC5_STATUS on a jsonl-only session (expected 0); output: $EC5_OUT"
  fi

  EC5_DEST="$EC5_SPEC_ROOT/specs/$EC5_SLUG/sessions/$EC5_SESSION_ID"
  if [ -f "$EC5_DEST/$EC5_SESSION_ID.jsonl" ]; then
    pass "EC5b: .jsonl copied when no subagents/ dir exists"
  else
    fail "EC5b: .jsonl NOT found at $EC5_DEST/$EC5_SESSION_ID.jsonl"
  fi

  # Confirm the session dir was NOT created (it didn't exist in source)
  if [ ! -d "$EC5_DEST/$EC5_SESSION_ID" ]; then
    pass "EC5c: no spurious session dir created when source has no subagents/"
  else
    fail "EC5c: session dir created at $EC5_DEST/$EC5_SESSION_ID (unexpected when source had none)"
  fi
fi

# --- C6-fatal: cp failure on an EXISTING subagents dir must be fatal (non-zero + loud stderr) ---
# When the sibling session dir EXISTS but the cp -R into the dest fails, the script must exit
# non-zero and emit a loud error on stderr. Silently swallowing the failure produces a partial
# grade (the exact silent-partial hazard this spec exists to close).
#
# Technique: create the dest session dir first, then chmod it 000 so cp -R cannot write into it.
# The ABSENT-dir case (EC5) must still be non-fatal -- this test only covers the PRESENT case.
if [ -f "$SCRIPT" ]; then
  C6F_PROJECTS="$TMPDIR_ROOT/c6f_projects"
  C6F_SPEC_ROOT="$TMPDIR_ROOT/c6f_spec_root"
  C6F_SESSION_ID="c6fsess-aaaa-bbbb-cccc-ddddeeeeeeee"
  C6F_SLUG="c6f-slug"
  mkdir -p "$C6F_PROJECTS"
  mkdir -p "$C6F_SPEC_ROOT/specs"

  # Source: a .jsonl + a sibling session dir with a subagent transcript
  printf '{"event":"SessionStart"}\n' > "$C6F_PROJECTS/$C6F_SESSION_ID.jsonl"
  mkdir -p "$C6F_PROJECTS/$C6F_SESSION_ID/subagents"
  printf '{"event":"SubagentMessage"}\n' > "$C6F_PROJECTS/$C6F_SESSION_ID/subagents/sub-x.jsonl"

  # Pre-create the dest session dir and make it unwritable so cp -R fails
  C6F_DEST_SESSION="$C6F_SPEC_ROOT/specs/$C6F_SLUG/sessions/$C6F_SESSION_ID/$C6F_SESSION_ID"
  mkdir -p "$C6F_DEST_SESSION"
  chmod 000 "$C6F_DEST_SESSION"

  C6F_STDERR="$TMPDIR_ROOT/c6f_stderr.txt"
  set +e
  "$SCRIPT" "$C6F_SLUG" \
    --projects-dir "$C6F_PROJECTS" \
    --spec-root "$C6F_SPEC_ROOT" \
    >"$TMPDIR_ROOT/c6f_stdout.txt" 2>"$C6F_STDERR"
  C6F_STATUS=$?
  set -e

  # Restore permissions so TMPDIR cleanup works
  chmod 755 "$C6F_DEST_SESSION"

  if [ "$C6F_STATUS" -ne 0 ]; then
    pass "C6-fatal-a: exits non-zero when cp of existing session dir fails (exit=$C6F_STATUS)"
  else
    fail "C6-fatal-a: script exited 0 on a failed cp of an existing session dir (must exit non-zero)"
  fi

  C6F_STDERR_OUT=$(cat "$C6F_STDERR")
  if [ -n "$C6F_STDERR_OUT" ]; then
    pass "C6-fatal-b: emits loud stderr when cp of existing session dir fails"
  else
    fail "C6-fatal-b: silent on failed cp of existing session dir (must emit loud stderr)"
  fi
fi

# ---------------------------------------------------------------------------
# C5: ship-spec Step 5 instructs COO to build manifest via buildSegmentManifest
#     and pass it as args.manifest to the grader workflow
# ---------------------------------------------------------------------------

# The COO IS instructed to call buildSegmentManifest as the manifest-build step.
# Chunk 4 moved manifest-building COO-side: Step 5 sub-step 2 calls buildSegmentManifest
# via Bash and passes the result as args.manifest to the Workflow tool.
BSM_INSTRUCTION_COUNT=$(grep -c 'buildSegmentManifest' "$SKILL" || true)
if [ "$BSM_INSTRUCTION_COUNT" -ge 1 ]; then
  pass "C5a: COO is instructed to build manifest via buildSegmentManifest (COO-side manifest seam)"
else
  fail "C5a: buildSegmentManifest not found in SKILL.md -- COO-side manifest seam missing"
fi

# args.manifest must appear as the grader invocation arg (COO builds manifest and passes it in)
MANIFEST_ARG_COUNT=$(grep -c 'args\.manifest\|args:.*manifest\b' "$SKILL" || true)
if [ "$MANIFEST_ARG_COUNT" -ge 1 ]; then
  pass "C5b: args.manifest present in SKILL.md (COO-side manifest seam shipped)"
else
  fail "C5b: args.manifest not found in $SKILL -- COO-side manifest seam missing"
fi

# ---------------------------------------------------------------------------
# C6: Step 5 calls scripts/stage_session_transcript.sh + grader args are
#     { sessionArchiveDir, specSlug }
# ---------------------------------------------------------------------------

STAGE_CALL_COUNT=$(grep -c 'stage_session_transcript' "$SKILL" || true)
if [ "$STAGE_CALL_COUNT" -ge 1 ]; then
  pass "C6a: stage_session_transcript.sh referenced in SKILL.md"
else
  fail "C6a: stage_session_transcript.sh not found in $SKILL"
fi

# Grader invocation must NOT carry sessionArchiveDir (chunk 4 removed it; contract is { manifest, specSlug })
ARCHIVE_DIR_COUNT=$(grep -c 'sessionArchiveDir' "$SKILL" || true)
if [ "$ARCHIVE_DIR_COUNT" -eq 0 ]; then
  pass "C6b: sessionArchiveDir absent from SKILL.md grader invocation (shipped contract is { manifest, specSlug })"
else
  fail "C6b: sessionArchiveDir still appears $ARCHIVE_DIR_COUNT time(s) in $SKILL -- old contract not removed"
fi

# Grader invocation must carry specSlug
SPEC_SLUG_COUNT=$(grep -c 'specSlug' "$SKILL" || true)
if [ "$SPEC_SLUG_COUNT" -ge 1 ]; then
  pass "C6c: specSlug present in SKILL.md grader invocation"
else
  fail "C6c: specSlug not found in $SKILL"
fi

# ---------------------------------------------------------------------------
# C7: errors-only fail-open clause + large-archive scope guidance are preserved
# ---------------------------------------------------------------------------

FAIL_OPEN_COUNT=$(grep -c 'Fail.open.*ERRORS ONLY\|ERRORS ONLY\|errors.only\|fail.open' "$SKILL" || true)
if [ "$FAIL_OPEN_COUNT" -ge 1 ]; then
  pass "C7a: errors-only fail-open clause is present in SKILL.md"
else
  fail "C7a: errors-only fail-open clause missing from $SKILL"
fi

LARGE_ARCHIVE_COUNT=$(grep -c '[Ll]arge archive\|large.archive\|Large.archive' "$SKILL" || true)
if [ "$LARGE_ARCHIVE_COUNT" -ge 1 ]; then
  pass "C7b: large-archive scope guidance is present in SKILL.md"
else
  fail "C7b: large-archive scope guidance missing from $SKILL"
fi

# C7c: the stale "pass that in-scope manifest" instruction (COO pre-filtering a manifest
# and passing it in) must NOT appear in the large-archive paragraph. The shipped end-state
# is that scoping happens INSIDE the workflow, not by the COO passing a manifest.
STALE_PASS_MANIFEST=$(grep -c 'pass that in-scope manifest' "$SKILL" || true)
if [ "$STALE_PASS_MANIFEST" -eq 0 ]; then
  pass "C7c: stale 'pass that in-scope manifest' instruction is absent from SKILL.md"
else
  fail "C7c: stale 'pass that in-scope manifest' instruction still present in $SKILL ($STALE_PASS_MANIFEST match(es))"
fi

# ---------------------------------------------------------------------------
# C8: auto-derive (no-override) path converts both '/' and '.' to '-' in slug
#
# Motivation: Claude Code's projects-dir slugs convert '.' as well as '/',
# so a cwd of /Users/you/.claude maps to -Users-admin--claude (doubled dash
# where '/.' meets), not -Users-admin-.claude (old bug).
#
# Test approach:
#   - fixture cwd: $TMPDIR_ROOT/dot.cwd  (name contains a dot)
#   - fake HOME:   $TMPDIR_ROOT/c8home   (so we never touch real ~/.claude)
#   - correct slug: echo "$DOT_CWD" | sed 's|[/.]|-|g'   (both / and . -> -)
#   - wrong slug:   echo "$DOT_CWD" | sed 's|/|-|g'      (old: only / -> -)
#   - seed the transcript at $FAKE_HOME/.claude/projects/$CORRECT_SLUG/
#   - run the script from $DOT_CWD without --projects-dir
#   - assert staged file appears at spec_root/specs/$SLUG/sessions/$SESSION_ID/
#
# This test FAILS against the old sed ('/' only) because the script computes
# the WRONG slug and finds no transcript, exiting non-zero.
# It passes after the fix (sed '[/.]') because the slug matches the seeded dir.
# ---------------------------------------------------------------------------
if [ -f "$SCRIPT" ]; then
  C8_TMPROOT="$TMPDIR_ROOT/c8"
  C8_DOT_CWD="$C8_TMPROOT/dot.cwd"      # dot in dirname -- the load-bearing case
  C8_FAKE_HOME="$C8_TMPROOT/fakehome"
  C8_SPEC_ROOT="$C8_TMPROOT/spec_root"
  C8_SESSION_ID="c8sess-aaaa-bbbb-cccc-ddddeeeeeeee"
  C8_SLUG="c8-slug"

  mkdir -p "$C8_DOT_CWD"
  mkdir -p "$C8_SPEC_ROOT/specs"

  # Compute the correct slug (both / and . -> -) from the fixture cwd's absolute path
  C8_DOT_CWD_ABS="$(cd "$C8_DOT_CWD" && pwd)"
  C8_CORRECT_SLUG=$(echo "$C8_DOT_CWD_ABS" | sed 's|[/.]|-|g')
  C8_WRONG_SLUG=$(echo "$C8_DOT_CWD_ABS" | sed 's|/|-|g')

  # Seed the transcript at the CORRECT (dot-converted) slug dir under fake HOME
  C8_PROJECTS_BASE="$C8_FAKE_HOME/.claude/projects"
  mkdir -p "$C8_PROJECTS_BASE/$C8_CORRECT_SLUG"
  printf '{"event":"SessionStart"}\n' > "$C8_PROJECTS_BASE/$C8_CORRECT_SLUG/$C8_SESSION_ID.jsonl"

  # Confirm the correct slug differs from the wrong slug (sanity: dot.cwd has a dot)
  if [ "$C8_CORRECT_SLUG" = "$C8_WRONG_SLUG" ]; then
    fail "C8-setup: correct slug == wrong slug; fixture cwd has no dot, test is vacuous ($C8_DOT_CWD_ABS)"
  else
    # Run script from the dot-cwd, overriding HOME so it never touches real ~/.claude
    C8_STDERR="$C8_TMPROOT/c8_stderr.txt"
    set +e
    (cd "$C8_DOT_CWD" && HOME="$C8_FAKE_HOME" "$SCRIPT" "$C8_SLUG" \
        --spec-root "$C8_SPEC_ROOT" \
        >"$C8_TMPROOT/c8_stdout.txt" 2>"$C8_STDERR")
    C8_STATUS=$?
    set -e

    C8_DEST="$C8_SPEC_ROOT/specs/$C8_SLUG/sessions/$C8_SESSION_ID"

    if [ "$C8_STATUS" -eq 0 ] && [ -f "$C8_DEST/$C8_SESSION_ID.jsonl" ]; then
      pass "C8: auto-derive path resolves correct slug (both / and . -> -) and stages transcript"
    else
      C8_STDERR_OUT=$(cat "$C8_STDERR")
      fail "C8: auto-derive path failed (exit=$C8_STATUS); wrong slug computed? stderr: $C8_STDERR_OUT"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# C9: multi-session -- both sessions in projects-dir are staged on one invocation
#
# Root cause pinned: stage_session_transcript.sh picked only the newest-mtime
# .jsonl (ls -t | head -n1), so a multi-session spec (built across several COO
# sessions over days) only had the ship session staged and the grader missed all
# earlier build sessions.
#
# This test seeds TWO distinct sessions in the projects-dir, runs the script
# ONCE, and asserts BOTH session directories appear under specs/<slug>/sessions/.
# It fails against the old head-n1 implementation (only newest staged) and passes
# once the script iterates all .jsonl files.
# ---------------------------------------------------------------------------
if [ -f "$SCRIPT" ]; then
  C9_TMPROOT="$TMPDIR_ROOT/c9"
  C9_PROJECTS="$C9_TMPROOT/projects"
  C9_SPEC_ROOT="$C9_TMPROOT/spec_root"
  C9_SLUG="c9-slug"
  C9_SESSION_OLD="c9sess-old-aaaa-bbbb-cccc-ddddeeeeeeee"
  C9_SESSION_NEW="c9sess-new-aaaa-bbbb-cccc-ddddeeeeeeee"

  mkdir -p "$C9_PROJECTS"
  mkdir -p "$C9_SPEC_ROOT/specs"

  # Create the OLDER session first (lower mtime), then the NEWER session.
  # The old head-n1 implementation picks only the newer one.
  printf '{"event":"SessionStart","session":"old"}\n' > "$C9_PROJECTS/$C9_SESSION_OLD.jsonl"
  # Ensure mtime ordering: sleep is cheap here; avoids a filesystem-resolution tie.
  sleep 0.05
  printf '{"event":"SessionStart","session":"new"}\n' > "$C9_PROJECTS/$C9_SESSION_NEW.jsonl"

  set +e
  C9_OUT=$("$SCRIPT" "$C9_SLUG" \
            --projects-dir "$C9_PROJECTS" \
            --spec-root "$C9_SPEC_ROOT" 2>&1)
  C9_STATUS=$?
  set -e

  if [ "$C9_STATUS" -ne 0 ]; then
    fail "C9: script exited $C9_STATUS on a two-session fixture (expected 0); output: $C9_OUT"
  fi

  C9_DEST_OLD="$C9_SPEC_ROOT/specs/$C9_SLUG/sessions/$C9_SESSION_OLD"
  C9_DEST_NEW="$C9_SPEC_ROOT/specs/$C9_SLUG/sessions/$C9_SESSION_NEW"

  if [ -f "$C9_DEST_OLD/$C9_SESSION_OLD.jsonl" ]; then
    pass "C9a: older session staged under specs/$C9_SLUG/sessions/$C9_SESSION_OLD/"
  else
    fail "C9a: older session NOT staged (only newest-mtime was picked); expected $C9_DEST_OLD/$C9_SESSION_OLD.jsonl"
  fi

  if [ -f "$C9_DEST_NEW/$C9_SESSION_NEW.jsonl" ]; then
    pass "C9b: newer session staged under specs/$C9_SLUG/sessions/$C9_SESSION_NEW/"
  else
    fail "C9b: newer session NOT staged; expected $C9_DEST_NEW/$C9_SESSION_NEW.jsonl"
  fi
fi

# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
