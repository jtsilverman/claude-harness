#!/usr/bin/env python3
"""Unit tests for merge_engine -- chunk 7's serial merge engine.

Durable regression suite (lives next to the module, not in specs/scripts/),
because the cockpit merges every approved chunk through this engine and a
mis-merge corrupts the feature branch's history (Tier A).

Run: python3 scripts/merge_engine_test.py   (exit 0 = all pass, 1 = any fail)

The merge engine has two halves (sigil-split: mechanical in code, judgment in
prose). This module tests the mechanical half:

  - mergeable_set(chunks) -- pure. Which APPROVED chunks may merge now: every
    depends_on is MERGED. Order-free among independents (returns the full
    eligible set in declaration order; the cockpit merges them one at a time in
    any order, each independently correct). A dependent is absent until its
    dependency merges -- the "refuses to merge before its dependency" gate.

  - merge_chunk_branch(repo, feature_branch, chunk_branch) -- the git
    rebase-and-ff-merge executor. Replays the chunk branch's commits onto the
    current feature tip, then fast-forwards: linear history, one commit per
    chunk, no merge commit. On a rebase conflict it aborts cleanly (feature
    branch untouched, repo back on feature_branch) and reports conflict so the
    cockpit can escalate to the operator.

  - DEFERRED -- the voluntary sibling of FAILED added to the vocabulary: a chunk
    the operator's go/no-go postponed. Terminal and non-merged, so runnable_set ignores
    it (never relaunches, releases its file claim, never satisfies a dependent)
    exactly like FAILED, and mergeable_set never returns it (not APPROVED).

The translation gate / serial loop / conflict-escalation prose is cockpit
SKILL.md judgment, NOT unit-tested here.
"""
import json
import os
import subprocess
import sys
import tempfile

from merge_engine import mergeable_set, merge_chunk_branch
from runnable_set import (
    APPROVED,
    AWAITING_REVIEW,
    BUILDING,
    DEFERRED,
    FAILED,
    IN_FLIGHT,
    MERGED,
    PENDING,
    runnable_set,
)
from exec_state import (
    STATUSES,
    parse_execution_state,
    render_execution_state,
)


CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def chunk(cid, status, depends_on=None, touches=None):
    # Always carries an explicit depends_on (default []), mirroring the board the
    # cockpit's tick builds. The merge gate fails loud on an APPROVED chunk that
    # lacks the key; that case is built from a raw dict in its own test.
    c = {"id": cid, "status": status, "depends_on": depends_on or []}
    if touches is not None:
        c["touches"] = touches
    return c


# ---------------------------------------------------------------------------
# mergeable_set -- the dependency-respecting merge gate (pure)
# ---------------------------------------------------------------------------

@case
def test_approved_no_deps_is_mergeable():
    board = [chunk("1", APPROVED)]
    assert mergeable_set(board) == ["1"], mergeable_set(board)


@case
def test_approved_with_merged_dep_is_mergeable():
    board = [chunk("1", MERGED), chunk("2", APPROVED, depends_on=["1"])]
    assert mergeable_set(board) == ["2"], mergeable_set(board)


@case
def test_approved_with_unmerged_dep_refuses():
    # The load-bearing acceptance half: a dependent refuses to merge before its
    # dependency. The dep is itself only approved (not yet merged).
    board = [chunk("1", APPROVED), chunk("2", APPROVED, depends_on=["1"])]
    # 1 is mergeable (no deps); 2 is NOT (dep 1 not merged yet).
    assert mergeable_set(board) == ["1"], mergeable_set(board)


@case
def test_two_independents_both_mergeable_order_free():
    # Order-free among independents: both come back, declaration order. The
    # cockpit merges them one at a time in either order -- both correct.
    board = [chunk("1", APPROVED), chunk("2", APPROVED)]
    assert mergeable_set(board) == ["1", "2"], mergeable_set(board)


@case
def test_non_approved_statuses_never_mergeable():
    for s in (PENDING, BUILDING, AWAITING_REVIEW, MERGED, FAILED, DEFERRED):
        board = [chunk("1", s)]
        assert mergeable_set(board) == [], f"{s!r} -> {mergeable_set(board)}"


@case
def test_deferred_dep_does_not_satisfy_dependent():
    # DEFERRED is non-merged: a chunk depending on a deferred chunk cannot merge
    # (only MERGED satisfies a dependency), same as a failed dep.
    board = [chunk("1", DEFERRED), chunk("2", APPROVED, depends_on=["1"])]
    assert mergeable_set(board) == [], mergeable_set(board)


@case
def test_declaration_order_preserved():
    board = [chunk("3", APPROVED), chunk("1", APPROVED), chunk("2", APPROVED)]
    assert mergeable_set(board) == ["3", "1", "2"], mergeable_set(board)


@case
def test_approved_chunk_missing_depends_on_fails_loud():
    # The merge is irreversible: an approved candidate with NO depends_on key is
    # a malformed board (the cockpit's tick always populates it, even as []), not
    # "no deps". Fail loud rather than fail-open to mergeable. Non-approved chunks
    # are skipped before the check, so a bare {"id","status":"pending"} is fine.
    bad = [{"id": "1", "status": APPROVED}]  # no depends_on key
    try:
        mergeable_set(bad)
    except ValueError:
        pass
    else:
        raise AssertionError("approved chunk missing depends_on should raise")
    # an explicit empty list is the legitimate no-deps encoding -> mergeable
    assert mergeable_set([chunk("1", APPROVED, depends_on=[])]) == ["1"]


# ---------------------------------------------------------------------------
# DEFERRED vocabulary -- terminal sibling of FAILED
# ---------------------------------------------------------------------------

@case
def test_deferred_in_exec_state_vocabulary():
    assert DEFERRED in STATUSES, sorted(STATUSES)
    # Round-trips through the board codec like any other status.
    text = "## Execution state\n\n- 1: deferred\n- 2: merged\n"
    board = parse_execution_state(text)
    assert board == [{"id": "1", "status": DEFERRED}, {"id": "2", "status": MERGED}], board
    assert "- 1: deferred" in render_execution_state(board)


@case
def test_deferred_not_in_flight():
    # Releases its file claim: a pending chunk touching the same files as a
    # deferred chunk IS runnable (deferred is not IN_FLIGHT, like failed).
    assert DEFERRED not in IN_FLIGHT, IN_FLIGHT
    board = [
        chunk("1", DEFERRED, touches=["a.py"]),
        chunk("2", PENDING, touches=["a.py"]),
    ]
    assert runnable_set(board) == ["2"], runnable_set(board)


@case
def test_deferred_never_relaunched_and_blocks_dependent():
    # Terminal: a deferred chunk is never itself runnable (not pending), and a
    # pending dependent of it stays blocked (dep not merged).
    board = [
        chunk("1", DEFERRED),
        chunk("2", PENDING, depends_on=["1"]),
    ]
    assert runnable_set(board) == [], runnable_set(board)


# ---------------------------------------------------------------------------
# merge_chunk_branch -- the git rebase-and-ff-merge executor (real fixture)
# ---------------------------------------------------------------------------

def _git(repo, *args):
    return subprocess.run(
        ["git", "-C", repo, *args],
        check=True, capture_output=True, text=True,
    ).stdout


def _make_repo():
    """A temp git repo with a feature branch and two chunk branches off it.
    chunk-1 adds a.txt, chunk-2 adds b.txt (no file overlap -> clean rebase)."""
    repo = tempfile.mkdtemp(prefix="mergeeng.")
    _git(repo, "init", "-q", "-b", "feature")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    with open(os.path.join(repo, "base.txt"), "w") as f:
        f.write("base\n")
    _git(repo, "add", "base.txt")
    _git(repo, "commit", "-q", "-m", "base")

    for cid, fname in (("1", "a.txt"), ("2", "b.txt")):
        _git(repo, "checkout", "-q", "-b", f"feature-chunk-{cid}", "feature")
        with open(os.path.join(repo, fname), "w") as f:
            f.write(f"chunk {cid}\n")
        _git(repo, "add", fname)
        _git(repo, "commit", "-q", "-m", f"chunk {cid}")
    _git(repo, "checkout", "-q", "feature")
    return repo


def _log_shas(repo, ref="feature"):
    return _git(repo, "log", "--format=%H", ref).split()


@case
def test_merge_two_independents_in_order():
    repo = _make_repo()
    r1 = merge_chunk_branch(repo, "feature", "feature-chunk-1")
    r2 = merge_chunk_branch(repo, "feature", "feature-chunk-2")
    assert r1["merged"] and r2["merged"], (r1, r2)
    # both files landed on feature
    assert os.path.exists(os.path.join(repo, "a.txt")), "a.txt missing"
    assert os.path.exists(os.path.join(repo, "b.txt")), "b.txt missing"
    # linear history: no merge commits anywhere
    assert _git(repo, "log", "--merges", "--format=%H", "feature").strip() == "", "merge commit present"
    # both chunk commit subjects intact on feature
    subjects = _git(repo, "log", "--format=%s", "feature")
    assert "chunk 1" in subjects and "chunk 2" in subjects, subjects
    # repo left on feature
    assert _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == "feature"


@case
def test_merge_two_independents_reverse_order_same_result():
    repo = _make_repo()
    r2 = merge_chunk_branch(repo, "feature", "feature-chunk-2")
    r1 = merge_chunk_branch(repo, "feature", "feature-chunk-1")
    assert r1["merged"] and r2["merged"], (r1, r2)
    assert os.path.exists(os.path.join(repo, "a.txt"))
    assert os.path.exists(os.path.join(repo, "b.txt"))
    assert _git(repo, "log", "--merges", "--format=%H", "feature").strip() == ""
    subjects = _git(repo, "log", "--format=%s", "feature")
    assert "chunk 1" in subjects and "chunk 2" in subjects, subjects


# --- the non-merged outcomes of merge_chunk_branch, enumerated up front ---
# A rebase/ff merge of an APPROVED chunk has three non-merged ENVELOPE shapes
# (conflict / untracked_collision / dirty_tree), each a STRUCTURED outcome
# (returned envelope, never a raised exception, never silently merged). All are
# fail-closed: merged is False on every one.
#
# The cockpit commits its board write (specs/current.md) as its own board-only
# commit BEFORE every merge (cockpit SKILL.md ## Merge), so the tree the checkout
# sees is clean -- a TRACKED-dirty CHECKOUT from the board write can no longer
# arise, and that branch is deleted. dirty_tree now fires from a SINGLE git
# failure: a dirty-disjoint REBASE (NON-board uncommitted changes the chunk does
# not own).
#
#   outcome           fires at   discriminator (git phrase)                       envelope flag
#   ----------------  ---------  -----------------------------------------------  ----------------------
#   true conflict     rebase     "CONFLICT" / "could not apply"                   conflict=True
#   untracked         checkout   "untracked working tree files would be over..."  untracked_collision=True
#   dirty-disjoint    rebase     "unstaged"/"uncommitted changes"                 dirty_tree=True
#
# true conflict is pinned by test_conflict_aborts_cleanly_and_reports; untracked by
# test_untracked_collision_handled_not_raised; dirty-disjoint by
# test_dirty_disjoint_tree_not_escalated_as_conflict. The shared invariant: a
# non-merged outcome NEVER reports merged=True (fail-closed preserved) and the
# tree-state failure is NOT escalated as conflict=True.


@case
def test_untracked_collision_handled_not_raised():
    # The chunk branch ADDS a tracked file a.txt; the feature worktree already has
    # an UNTRACKED a.txt. git checkout of the chunk branch refuses ("would be
    # overwritten by checkout") and exits nonzero -- the current engine calls
    # checkout with check=True, so it RAISES CalledProcessError before returning
    # any envelope. The chunk must instead surface a structured non-merged outcome:
    # caught, not raised; flagged untracked_collision; NOT a conflict; repo left on
    # feature; feature history untouched.
    repo = tempfile.mkdtemp(prefix="mergeeng.")
    _git(repo, "init", "-q", "-b", "feature")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    with open(os.path.join(repo, "base.txt"), "w") as f:
        f.write("base\n")
    _git(repo, "add", "base.txt")
    _git(repo, "commit", "-q", "-m", "base")
    _git(repo, "checkout", "-q", "-b", "feature-chunk-1", "feature")
    with open(os.path.join(repo, "a.txt"), "w") as f:
        f.write("chunk 1\n")
    _git(repo, "add", "a.txt")
    _git(repo, "commit", "-q", "-m", "chunk 1")
    _git(repo, "checkout", "-q", "feature")
    feature_before = _git(repo, "rev-parse", "feature").strip()
    # an untracked a.txt on feature that the chunk-branch checkout would clobber
    with open(os.path.join(repo, "a.txt"), "w") as f:
        f.write("untracked local\n")

    # Must NOT raise -- a structured outcome, not a crash.
    try:
        r = merge_chunk_branch(repo, "feature", "feature-chunk-1")
    except Exception as e:
        raise AssertionError(
            f"untracked collision must be handled as a structured outcome, "
            f"not raised: {type(e).__name__}: {e}"
        )

    assert r["merged"] is False, r            # fail-closed: not silently merged
    assert r.get("untracked_collision") is True, r
    assert r.get("conflict") is False, r      # NOT falsely escalated as a conflict
    assert r.get("sha") is None, r
    assert r.get("branch") == "feature-chunk-1", r
    # feature history untouched by the failed merge
    assert _git(repo, "rev-parse", "feature").strip() == feature_before, "feature moved"
    # repo left on feature (sole-writer home), no rebase in progress
    assert _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == "feature", "not on feature"
    assert not os.path.exists(os.path.join(repo, ".git", "rebase-merge")), "rebase left in progress"
    assert not os.path.exists(os.path.join(repo, ".git", "rebase-apply")), "rebase left in progress"


@case
def test_dirty_disjoint_tree_not_escalated_as_conflict():
    # A dirty-but-DISJOINT worktree: an uncommitted edit to a tracked file
    # (base.txt) that the chunk branch does NOT own. git checkout carries the dirty
    # file forward (succeeds), but the subsequent rebase refuses with "You have
    # unstaged changes" (exit 1). The current engine treats ANY nonzero rebase as
    # conflict=True -- a FALSE escalation, because the failure is a dirty tree, not
    # a content conflict. The chunk must distinguish them: structured outcome
    # flagged dirty_tree, conflict False, fail-closed (not merged).
    repo = tempfile.mkdtemp(prefix="mergeeng.")
    _git(repo, "init", "-q", "-b", "feature")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    with open(os.path.join(repo, "base.txt"), "w") as f:
        f.write("base\n")
    _git(repo, "add", "base.txt")
    _git(repo, "commit", "-q", "-m", "base")
    # chunk-1 adds a.txt (disjoint from base.txt)
    _git(repo, "checkout", "-q", "-b", "feature-chunk-1", "feature")
    with open(os.path.join(repo, "a.txt"), "w") as f:
        f.write("chunk 1\n")
    _git(repo, "add", "a.txt")
    _git(repo, "commit", "-q", "-m", "chunk 1")
    _git(repo, "checkout", "-q", "feature")
    # advance feature so the rebase actually has a commit to replay onto
    with open(os.path.join(repo, "c.txt"), "w") as f:
        f.write("feature moved\n")
    _git(repo, "add", "c.txt")
    _git(repo, "commit", "-q", "-m", "feature advance")
    feature_before = _git(repo, "rev-parse", "feature").strip()
    # dirty, DISJOINT uncommitted edit to a tracked file the chunk does not own
    with open(os.path.join(repo, "base.txt"), "w") as f:
        f.write("base\nlocal dirty edit\n")

    try:
        r = merge_chunk_branch(repo, "feature", "feature-chunk-1")
    except Exception as e:
        raise AssertionError(
            f"dirty-disjoint tree must be a structured outcome, not raised: "
            f"{type(e).__name__}: {e}"
        )

    assert r["merged"] is False, r            # fail-closed: not silently merged
    assert r.get("dirty_tree") is True, r
    assert r.get("conflict") is False, r      # the load-bearing assertion: NOT escalated
    assert r.get("sha") is None, r
    assert r.get("branch") == "feature-chunk-1", r
    # feature history untouched by the refused merge
    assert _git(repo, "rev-parse", "feature").strip() == feature_before, "feature moved"
    # repo left on feature, no rebase in progress
    assert _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == "feature", "not on feature"
    assert not os.path.exists(os.path.join(repo, ".git", "rebase-merge")), "rebase left in progress"
    assert not os.path.exists(os.path.join(repo, ".git", "rebase-apply")), "rebase left in progress"


@case
def test_conflict_aborts_cleanly_and_reports():
    # Two branches editing the SAME line of the SAME file -> the second rebase
    # conflicts. The engine must abort, leave feature exactly where the first
    # merge left it, end on feature_branch with no rebase in progress.
    repo = tempfile.mkdtemp(prefix="mergeeng.")
    _git(repo, "init", "-q", "-b", "feature")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    with open(os.path.join(repo, "shared.txt"), "w") as f:
        f.write("original\n")
    _git(repo, "add", "shared.txt")
    _git(repo, "commit", "-q", "-m", "base")
    for cid in ("1", "2"):
        _git(repo, "checkout", "-q", "-b", f"feature-chunk-{cid}", "feature")
        with open(os.path.join(repo, "shared.txt"), "w") as f:
            f.write(f"edit by {cid}\n")
        _git(repo, "add", "shared.txt")
        _git(repo, "commit", "-q", "-m", f"chunk {cid}")
        _git(repo, "checkout", "-q", "feature")

    r1 = merge_chunk_branch(repo, "feature", "feature-chunk-1")
    assert r1["merged"], r1
    feature_after_1 = _git(repo, "rev-parse", "feature").strip()

    r2 = merge_chunk_branch(repo, "feature", "feature-chunk-2")
    assert not r2["merged"] and r2.get("conflict"), r2
    # feature untouched by the failed merge
    assert _git(repo, "rev-parse", "feature").strip() == feature_after_1, "feature moved on conflict"
    # repo back on feature, no rebase in progress
    assert _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == "feature"
    assert not os.path.exists(os.path.join(repo, ".git", "rebase-merge")), "rebase left in progress"
    assert not os.path.exists(os.path.join(repo, ".git", "rebase-apply")), "rebase left in progress"


# ---------------------------------------------------------------------------
# merge subcommand -- CLI envelope (chunk 6)
# These tests call merge_engine.py as a subprocess (the CLI surface), not
# the import-only merge_chunk_branch() function. The acceptance criteria
# require: clean ff prints JSON {merged:true,sha:...,conflict:false} exit 0;
# conflict prints {merged:false,conflict:true} exit non-zero with no partial
# merge left; dirty tree returns {dirty_tree:true} envelope; missing args
# exit 2. The cockpit SKILL.md grep is tested by test_cockpit_skill_names_merge_primitive.
# ---------------------------------------------------------------------------

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
MERGE_ENGINE = os.path.join(SCRIPTS_DIR, "merge_engine.py")


def _run_merge_cli(repo, feature, chunk, extra_args=None):
    """Run merge_engine.py merge and return (returncode, parsed_json_or_None, stderr)."""
    cmd = [
        sys.executable, MERGE_ENGINE, "merge",
        "--repo", repo,
        "--feature", feature,
        "--chunk", chunk,
    ]
    if extra_args:
        cmd += extra_args
    proc = subprocess.run(cmd, capture_output=True, text=True)
    try:
        result = json.loads(proc.stdout.strip())
    except (json.JSONDecodeError, ValueError):
        result = None
    return proc.returncode, result, proc.stderr


@case
def test_merge_subcommand_clean_ff_prints_json_merged_true():
    """clean ff: merge subcommand exits 0 and prints {merged:true, sha:..., conflict:false}."""
    repo = _make_repo()
    rc, result, stderr = _run_merge_cli(repo, "feature", "feature-chunk-1")
    assert rc == 0, f"expected exit 0 on clean ff, got {rc}; stderr={stderr!r}"
    assert result is not None, f"stdout was not valid JSON: {result!r}"
    assert result.get("merged") is True, f"merged should be True: {result}"
    assert result.get("conflict") is False, f"conflict should be False: {result}"
    sha = result.get("sha")
    assert sha and len(sha) >= 7, f"sha should be a non-empty commit hash: {result}"


@case
def test_merge_subcommand_conflict_prints_json_conflict_true_exits_nonzero():
    """conflict: merge subcommand exits non-zero and prints {merged:false, conflict:true}; no partial merge."""
    repo = tempfile.mkdtemp(prefix="mergeeng.")
    _git(repo, "init", "-q", "-b", "feature")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    with open(os.path.join(repo, "shared.txt"), "w") as f:
        f.write("original\n")
    _git(repo, "add", "shared.txt")
    _git(repo, "commit", "-q", "-m", "base")
    for cid in ("1", "2"):
        _git(repo, "checkout", "-q", "-b", f"feature-chunk-{cid}", "feature")
        with open(os.path.join(repo, "shared.txt"), "w") as f:
            f.write(f"edit by {cid}\n")
        _git(repo, "add", "shared.txt")
        _git(repo, "commit", "-q", "-m", f"chunk {cid}")
        _git(repo, "checkout", "-q", "feature")

    # Merge chunk-1 cleanly first.
    rc1, r1, _ = _run_merge_cli(repo, "feature", "feature-chunk-1")
    assert rc1 == 0 and r1 and r1.get("merged"), f"first merge should succeed: {r1}"
    feature_sha_after_first = _git(repo, "rev-parse", "feature").strip()

    # Merge chunk-2 conflicts.
    rc2, result, stderr = _run_merge_cli(repo, "feature", "feature-chunk-2")
    assert rc2 != 0, f"conflict merge must exit non-zero, got {rc2}"
    assert result is not None, f"stdout must be valid JSON even on conflict: {result!r}"
    assert result.get("merged") is False, f"merged should be False: {result}"
    assert result.get("conflict") is True, f"conflict should be True: {result}"

    # Feature branch untouched.
    assert _git(repo, "rev-parse", "feature").strip() == feature_sha_after_first, \
        "feature moved after conflict"
    # No rebase in progress.
    assert not os.path.exists(os.path.join(repo, ".git", "rebase-merge")), "rebase left"
    assert not os.path.exists(os.path.join(repo, ".git", "rebase-apply")), "rebase left"


@case
def test_merge_subcommand_dirty_tree_returns_dirty_tree_envelope():
    """dirty tree: merge subcommand returns {dirty_tree:true, merged:false} (no merge attempted)."""
    repo = _make_repo()
    # dirty an unrelated tracked file in the feature worktree
    with open(os.path.join(repo, "base.txt"), "w") as f:
        f.write("dirty local edit\n")
    rc, result, stderr = _run_merge_cli(repo, "feature", "feature-chunk-1")
    assert result is not None, f"stdout must be valid JSON: {result!r}"
    assert result.get("merged") is False, f"merged should be False on dirty tree: {result}"
    assert result.get("dirty_tree") is True, f"dirty_tree should be True: {result}"


@case
def test_merge_subcommand_missing_args_exits_2():
    """missing required args: merge subcommand exits 2 (usage error)."""
    proc = subprocess.run(
        [sys.executable, MERGE_ENGINE, "merge"],
        capture_output=True, text=True,
    )
    assert proc.returncode == 2, f"expected exit 2 on missing args, got {proc.returncode}"


@case
def test_cockpit_skill_names_merge_primitive():
    """cockpit SKILL.md step 3a must reference 'merge_engine.py merge' (grep check)."""
    skill_path = os.path.join(
        os.path.dirname(SCRIPTS_DIR), "skills", "cockpit", "SKILL.md"
    )
    assert os.path.exists(skill_path), f"SKILL.md not found at {skill_path}"
    with open(skill_path) as f:
        content = f.read()
    assert "merge_engine.py merge" in content, (
        f"cockpit SKILL.md step 3a does not reference 'merge_engine.py merge'; "
        f"found no such substring in {skill_path}"
    )


@case
def test_merge_subcommand_already_merged_branch_is_safe_noop():
    """already-merged branch: second merge invocation returns {merged:true, conflict:false} exit 0 (safe no-op)."""
    repo = _make_repo()
    # First merge succeeds.
    rc1, r1, stderr1 = _run_merge_cli(repo, "feature", "feature-chunk-1")
    assert rc1 == 0 and r1 and r1.get("merged"), f"first merge must succeed: {r1}; stderr={stderr1!r}"
    sha_after_first = r1.get("sha")

    # Second invocation with the same already-merged branch must be a safe no-op.
    rc2, r2, stderr2 = _run_merge_cli(repo, "feature", "feature-chunk-1")
    assert rc2 == 0, f"already-merged branch must exit 0, got {rc2}; stderr={stderr2!r}"
    assert r2 is not None, f"stdout must be valid JSON: {r2!r}"
    assert r2.get("merged") is True, f"merged should be True for no-op: {r2}"
    assert r2.get("conflict") is False, f"conflict should be False for no-op: {r2}"
    # Feature branch sha unchanged (no new commit for an empty rebase).
    sha_after_noop = _git(repo, "rev-parse", "feature").strip()
    assert sha_after_noop == sha_after_first, (
        f"feature sha changed on already-merged no-op: {sha_after_first!r} -> {sha_after_noop!r}"
    )


# ---------------------------------------------------------------------------
# coo-simplification chunk 2 -- board-committed clean-tree merge.
#
# The new invariant: the cockpit commits the board write (specs/current.md) as
# its OWN board-only commit right after write_execution_state, BEFORE the merge.
# So merge_chunk_branch always sees a CLEAN tree -- no stash/pop dance. This pair
# pins that:
#   - a board-committed clean tree merges green with NO stash step (AC1 positive);
#   - the anti-tautology twin: leave the board edit UNCOMMITTED (dirty) and the
#     same merge refuses with dirty_tree (AC4 -- reverting the board-commit flips
#     the clean-tree-merge assertion to fail).
# Plus: the dead CHECKOUT-path tracked-dirty dirty_tree branch is GONE from the
# source (AC1: "the CHECKOUT-path dirty_tree branch is gone"), while the
# REBASE-path dirty_tree guard STILL fires on non-board dirtiness (kept --
# pinned by test_dirty_disjoint_tree_not_escalated_as_conflict above).
# ---------------------------------------------------------------------------

MERGE_ENGINE_SRC = os.path.join(SCRIPTS_DIR, "merge_engine.py")


def _make_repo_with_board():
    """A temp repo whose feature branch tracks specs/current.md (the board), with
    two chunk branches that touch ONLY their own disjoint files (never the board).
    Mirrors the live shape: the cockpit commits the board on feature; a worker
    chunk branch never touches specs/current.md (write-nothing-shared)."""
    repo = tempfile.mkdtemp(prefix="mergeeng.")
    _git(repo, "init", "-q", "-b", "feature")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    os.makedirs(os.path.join(repo, "specs"))
    with open(os.path.join(repo, "specs", "current.md"), "w") as f:
        f.write("## Execution state\n\n- 1: building\n")
    _git(repo, "add", "specs/current.md")
    _git(repo, "commit", "-q", "-m", "base board")
    for cid, fname in (("1", "a.txt"), ("2", "b.txt")):
        _git(repo, "checkout", "-q", "-b", f"feature-chunk-{cid}", "feature")
        with open(os.path.join(repo, fname), "w") as f:
            f.write(f"chunk {cid}\n")
        _git(repo, "add", fname)
        _git(repo, "commit", "-q", "-m", f"chunk {cid}")
    _git(repo, "checkout", "-q", "feature")
    return repo


@case
def test_board_committed_clean_tree_merges_green_no_stash():
    """AC1: with the board write COMMITTED (clean tree), a merge runs green with
    NO stash step. The cockpit committed specs/current.md as its own commit, so
    the tree the rebase sees is clean -- merge succeeds, no dirty_tree, no stash."""
    repo = _make_repo_with_board()
    # The cockpit's new step: mark the board and COMMIT it as a board-only commit
    # (this is what removes the need for any stash). Tree is clean afterward.
    with open(os.path.join(repo, "specs", "current.md"), "w") as f:
        f.write("## Execution state\n\n- 1: awaiting-review\n")
    _git(repo, "add", "specs/current.md")
    _git(repo, "commit", "-q", "-m", "board: mark chunk 1 awaiting-review")
    # Tree is clean (the board write is committed, not dirty in the worktree).
    status = _git(repo, "status", "--porcelain")
    assert status.strip() == "", f"tree must be clean after the board commit, got {status!r}"
    # Merge runs green directly -- NO stash needed.
    r = merge_chunk_branch(repo, "feature", "feature-chunk-1")
    assert r["merged"] is True, f"clean-tree merge must succeed: {r}"
    assert r.get("dirty_tree") is not True, f"clean tree must NOT report dirty_tree: {r}"
    assert os.path.exists(os.path.join(repo, "a.txt")), "chunk file must land on feature"


@case
def test_uncommitted_board_edit_refuses_dirty_tree_anti_tautology():
    """AC4 anti-tautology twin of the clean-tree test: leave the board edit
    UNCOMMITTED (the OLD dirty-board state the board-commit invariant removed) and
    the SAME merge refuses with dirty_tree. This proves the clean-tree-merge test
    above passes BECAUSE the board was committed -- revert that commit (leave it
    dirty) and the merge no longer lands clean."""
    repo = _make_repo_with_board()
    # The OLD failure mode: the board write is left DIRTY in the worktree (not
    # committed). This is a dirty-disjoint tree (the chunk branch never touches
    # specs/current.md) -> the REBASE-path dirty_tree guard fires.
    with open(os.path.join(repo, "specs", "current.md"), "w") as f:
        f.write("## Execution state\n\n- 1: awaiting-review\n")
    # advance feature so the rebase has a commit to replay onto
    with open(os.path.join(repo, "c.txt"), "w") as f:
        f.write("feature moved\n")
    # NOTE: do NOT commit the board edit -- leave specs/current.md dirty.
    feature_before = _git(repo, "rev-parse", "feature").strip()
    r = merge_chunk_branch(repo, "feature", "feature-chunk-1")
    assert r["merged"] is False, f"a dirty board tree must NOT merge: {r}"
    assert r.get("dirty_tree") is True, f"a dirty board tree must report dirty_tree: {r}"
    assert r.get("conflict") is False, f"a dirty tree is NOT a conflict: {r}"
    # feature untouched by the refused merge
    assert _git(repo, "rev-parse", "feature").strip() == feature_before, "feature moved"


@case
def test_checkout_path_tracked_dirty_branch_is_gone():
    """AC1: the dead CHECKOUT-path tracked-dirty dirty_tree branch is DELETED.
    Under the board-commit invariant a tracked-dirty CHECKOUT can no longer arise
    from the board write, so that branch is dead code. It is removed from the
    source: the 'Your local changes to the following files would be overwritten'
    checkout discriminator no longer appears in merge_engine.py. (The REBASE-path
    dirty_tree guard -- 'unstaged'/'uncommitted changes' -- stays.)"""
    with open(MERGE_ENGINE_SRC) as f:
        src = f.read()
    assert "Your local changes to the following files would be overwritten" not in src, (
        "the CHECKOUT-path tracked-dirty dirty_tree branch must be deleted from "
        "merge_engine.py (dead under the board-commit invariant)"
    )
    # The REBASE-path guard's discriminator MUST remain (it is NOT dead -- it
    # guards non-board dirtiness from a false conflict escalation).
    assert "unstaged changes" in src or "uncommitted changes" in src, (
        "the REBASE-path dirty_tree guard must be KEPT (board-commit does not "
        "clean non-board dirtiness)"
    )


def main():
    failed = 0
    for fn in CASES:
        try:
            fn()
            print(f"PASS: {fn.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL: {fn.__name__}: {e}")
    print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
