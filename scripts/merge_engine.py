#!/usr/bin/env python3
"""merge_engine.py -- chunk 7's serial merge engine (the mechanical half).

Part of parallel-chunk-execution. After the chunk's disposition authorizes it (the
auto-merge-on-clean default writes `approved` with no go/no-go; a vision/scope
carve-out gets the operator's explicit verdict), the cockpit folds each approved worktree
branch into the feature branch. The merge is
SERIALIZED (sole-writer, one at a time), ORDER-FREE among independents (a chunk
merges only after the chunks it depends on; among independents any order is
correct -- file-non-overlap makes them conflict-free), and HISTORY-CLEAN
(rebase-and-merge, one commit per chunk, no merge commit).

Two halves, split the sigil-split way (mechanical in code, judgment in prose):

  - mergeable_set(chunks) -- THIS module. Pure, deterministic. Which APPROVED
    chunks may merge right now: every depends_on is MERGED. The dependency gate
    that makes "a dependent refuses to merge before its dependency" hold. It is
    the merge-side sibling of runnable_set's launch gate (greedy admission over a
    DAG); the difference is the predicate (approved+deps-merged vs
    pending+deps-merged+no-file-overlap) -- merges don't need file-overlap
    rejection because they run one at a time, never in parallel.

  - merge_chunk_branch(repo, feature_branch, chunk_branch) -- THIS module. The
    git rebase-and-ff-merge executor. Deterministic side effect, tested against a
    real git fixture. Replays the chunk branch onto the current feature tip then
    fast-forwards; on a rebase conflict it aborts cleanly and reports, so the
    cockpit can escalate to the operator.

  - the go/no-go gate + the serial loop + conflict escalation -- cockpit
    SKILL.md prose (## Merge). LLM judgment / interactive git, NOT in this module.

PRECONDITION (operational, enforced by the cockpit prose, not this module): the
chunk's worktree is pruned before merge so its branch is not checked out
elsewhere. git refuses to operate on a branch that is live in a worktree; the
worker's commit is durable in .git, so `git worktree remove` keeps the branch
and its commits while freeing it for the rebase. See cockpit SKILL.md ## Merge.

CLI (the acceptance check's call shape for the pure gate):
    python3 scripts/merge_engine.py mergeable < board.json  ->  ["1","2"]
"""
import datetime
import json
import os
import subprocess
import sys

from runnable_set import APPROVED, MERGED, PENDING


def _runlog(msg):
    """Append a timestamped progress line to MERGE_ENGINE_RUNLOG. No-op if unset."""
    path = os.environ.get("MERGE_ENGINE_RUNLOG")
    if not path:
        return
    ts = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    with open(path, "a") as f:
        f.write(f"{ts} {msg}\n")


def mergeable_set(chunks):
    """Return the APPROVED chunk ids whose every depends_on is MERGED, in
    declaration order.

    chunks: iterable of chunk dicts {"id","status","depends_on"}. A non-APPROVED
    chunk's status defaults to "pending" and it is skipped before any dependency
    check. An APPROVED candidate MUST carry an explicit `depends_on` key (a chunk
    with no deps encodes it as []): the merge is irreversible, so a missing key is
    a malformed board, not "no dependencies", and the gate FAILS LOUD rather than
    fail-open to mergeable (which could merge a dependent before its dep). This is
    stricter than runnable_set's launch gate (which defaults the key) on purpose:
    a wrong launch is provisional and discardable, a wrong merge corrupts history.
    See policy-map-fail-loud-on-unknown-keys.

    Order-free among independents: the full eligible set comes back; the cockpit
    merges them one at a time in any order (each is independently correct -- no
    file overlap means no conflict regardless of order). A dependent chunk is
    absent from the set until its dependency reaches MERGED -- the "refuses to
    merge before its dependency" gate. Non-APPROVED statuses (pending, building,
    awaiting-review, merged, failed, deferred) are never returned: only a chunk
    whose disposition wrote APPROVED is a merge candidate, and a deferred/failed
    dep never counts as satisfied (only MERGED does).
    """
    chunks = list(chunks)
    status_by_id = {c["id"]: c.get("status", PENDING) for c in chunks}
    out = []
    for c in chunks:
        if c.get("status", PENDING) != APPROVED:
            continue
        if "depends_on" not in c:
            raise ValueError(
                f"chunk {c['id']!r} is approved but carries no depends_on field; "
                f"the merge gate refuses to guess (a no-dep chunk must encode "
                f"depends_on=[]). A missing key is a malformed board, not no-deps."
            )
        if all(status_by_id.get(d) == MERGED for d in c["depends_on"]):
            out.append(c["id"])
    return out


def _git(repo, *args, check=True):
    """Run a git command in repo; return the CompletedProcess. check=True raises
    CalledProcessError on a nonzero exit (used for steps that must succeed)."""
    return subprocess.run(
        ["git", "-C", repo, *args],
        check=check, capture_output=True, text=True,
    )


def merge_chunk_branch(repo, feature_branch, chunk_branch):
    """Rebase-and-ff-merge chunk_branch into feature_branch in repo.

    Sequence (linear history, one commit per chunk, no merge commit):
      1. checkout chunk_branch, rebase it onto feature_branch -- replays the
         chunk's commits onto the current feature tip. Clean when the chunk
         touched non-overlapping files (the runnable-set invariant guarantees
         it for parallel chunks); a conflict here is the adjacent-region case
         the spec escalates.
      2. checkout feature_branch, merge --ff-only chunk_branch -- a pure
         fast-forward (feature is now an ancestor of the rebased chunk_branch),
         so no merge commit is created and history stays linear.

    Returns one of four structured outcomes (a non-merged outcome is ALWAYS a
    returned envelope, never a raised exception, and merged=False on every one --
    fail-closed). The three failure shapes are discriminated, not collapsed:

      merged:       {"merged": True,  "sha": <new feature HEAD>, "conflict": False, "branch": ...}
      true conflict:{"merged": False, "sha": None, "conflict": True,  "branch": ...}
      untracked:    {"merged": False, "sha": None, "conflict": False, "untracked_collision": True, "branch": ...}
      dirty tree:   {"merged": False, "sha": None, "conflict": False, "dirty_tree": True, "branch": ...}

    A true conflict (adjacent-region overlap) fires at the rebase; an
    untracked-collision (an untracked feature-worktree file the checkout would
    clobber) fires at the checkout; a dirty-disjoint tree (NON-board uncommitted
    changes the chunk does not own) fires at the rebase but is a tree-state
    failure, NOT a content conflict -- so it is NOT escalated as conflict=True.
    (The cockpit commits its board write before every merge, so a tracked-dirty
    CHECKOUT from the board can no longer arise -- dirty_tree now fires only from
    the rebase path.) On every failure
    path the rebase is aborted, the repo is restored to feature_branch, and
    feature_branch is left exactly where it was -- the failed merge has zero effect
    on shared history. The cockpit reads conflict=True and escalates to the operator
    (reset-or-decompose), never a silent retry.

    ALWAYS leaves the repo checked out on feature_branch (the sole-writer
    cockpit's home), on every exit path.
    """
    _runlog(f"merge_chunk_branch: start repo={repo} feature={feature_branch} chunk={chunk_branch}")
    # Step 1: rebase the chunk branch onto the current feature tip.
    # The checkout can fail with an UNTRACKED-collision: an untracked
    # feature-worktree file the switch would clobber ("The following untracked
    # working tree files would be overwritten ..."). git leaves the repo on
    # feature_branch untouched (no rebase started), so it is a structured
    # non-merged outcome, NOT a crash and NOT a conflict.
    #
    # The cockpit commits its board write (specs/current.md) as its own board-only
    # commit BEFORE every merge (cockpit SKILL.md ## Merge), so the tree the
    # checkout sees is clean: a TRACKED-dirty checkout from the board write can no
    # longer arise, and that branch is deleted. The remaining tree-state failure --
    # NON-board dirtiness (uncommitted changes the chunk does not own) -- surfaces
    # at the REBASE below, NOT the checkout, and is handled there as dirty_tree.
    # Any OTHER checkout failure is unexpected; it raises (fail-loud).
    checkout = _git(repo, "checkout", chunk_branch, check=False)
    if checkout.returncode != 0:
        if "untracked working tree files would be overwritten" in checkout.stderr:
            # git refused the switch and left us on feature_branch untouched.
            return {
                "merged": False, "sha": None, "conflict": False,
                "untracked_collision": True, "branch": chunk_branch,
            }
        raise subprocess.CalledProcessError(
            checkout.returncode, checkout.args,
            output=checkout.stdout, stderr=checkout.stderr,
        )
    rebase = _git(repo, "rebase", feature_branch, check=False)
    if rebase.returncode != 0:
        # Abort any in-progress rebase, restore feature, leave feature_branch
        # untouched on every path. Then discriminate the failure:
        #   - a dirty-but-DISJOINT worktree (uncommitted changes to files the chunk
        #     does not own) makes rebase refuse with "unstaged"/"uncommitted
        #     changes" -- a tree-state failure, NOT a content conflict. Reporting it
        #     as conflict=True would FALSELY escalate it; flag dirty_tree instead.
        #   - anything else (adjacent-region CONFLICT, "could not apply") is a true
        #     conflict the cockpit escalates to the operator.
        # Both are fail-closed (merged=False); only the conflict FLAG differs.
        _git(repo, "rebase", "--abort", check=False)
        _git(repo, "checkout", feature_branch, check=False)
        if "unstaged changes" in rebase.stderr or "uncommitted changes" in rebase.stderr:
            return {
                "merged": False, "sha": None, "conflict": False,
                "dirty_tree": True, "branch": chunk_branch,
            }
        return {"merged": False, "sha": None, "conflict": True, "branch": chunk_branch}

    # Step 2: fast-forward feature to the rebased chunk branch (no merge commit).
    _git(repo, "checkout", feature_branch)
    _git(repo, "merge", "--ff-only", chunk_branch)
    sha = _git(repo, "rev-parse", feature_branch).stdout.strip()
    _runlog(f"merge_chunk_branch: done merged=True sha={sha} chunk={chunk_branch}")
    return {"merged": True, "sha": sha, "conflict": False, "branch": chunk_branch}


def main(argv):
    if len(argv) >= 2 and argv[1] == "mergeable":
        _runlog("merge_engine: start op=mergeable")
        chunks = json.loads(sys.stdin.read())
        result = mergeable_set(chunks)
        _runlog(f"merge_engine: done mergeable={result}")
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
        return 0
    if len(argv) >= 2 and argv[1] == "merge":
        # Parse --repo, --feature, --chunk from argv.
        # Usage: merge_engine.py merge --repo <path> --feature <branch> --chunk <branch>
        args = argv[2:]
        params = {}
        i = 0
        while i < len(args):
            if args[i] in ("--repo", "--feature", "--chunk") and i + 1 < len(args):
                params[args[i].lstrip("-")] = args[i + 1]
                i += 2
            else:
                i += 1
        if not all(k in params for k in ("repo", "feature", "chunk")):
            sys.stderr.write(
                "usage: merge_engine.py merge --repo <path> --feature <branch> --chunk <branch>\n"
            )
            return 2
        _runlog(
            f"merge_engine: start op=merge repo={params['repo']} "
            f"feature={params['feature']} chunk={params['chunk']}"
        )
        result = merge_chunk_branch(params["repo"], params["feature"], params["chunk"])
        _runlog(f"merge_engine: done merge merged={result.get('merged')} sha={result.get('sha')}")
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
        # Exit non-zero when the merge did not land (conflict, dirty tree, etc.).
        return 0 if result.get("merged") else 1
    sys.stderr.write(
        "usage: merge_engine.py mergeable < board.json\n"
        "       merge_engine.py merge --repo <path> --feature <branch> --chunk <branch>\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
