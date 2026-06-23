#!/usr/bin/env python3
"""Unit tests for cockpit_sidecar -- the ephemeral run-state sidecar + resume_plan.

Durable regression suite (lives next to the module). Part of
parallel-chunk-execution chunk 5 (durable state + clean resume).

Run: python3 scripts/cockpit_sidecar_test.py   (exit 0 = all pass, 1 = any fail)

The sidecar is the cockpit's EPHEMERAL run-state, kept OUT of current.md (so the
archived spec carries no stale run state): a JSON object keyed by chunk id ->
{runId, branch, worktree, bundle}. The durable run-state is the board in
current.md; the sidecar holds only what the board can't (in-flight Workflow
runIds for resumeFromRunId reconnection + collected review bundles).

resume_plan(board, sidecar) is the heart: after a /clear the cockpit re-reads the
durable board + the sidecar and classifies EVERY chunk so completed work is never
relaunched and in-flight chunks route to runId-reconnect. Full status contract
(enumerated up front, not happy-path-first -- the chunk-4 lesson):

  status          sidecar              -> classification
  pending         (any)                -> tick      (normal scheduler launch)
  building        has runId            -> resume    (Workflow resumeFromRunId)
  building        no runId             -> relaunch  (safe: in-flight work is provisional)
  awaiting-review has bundle           -> reload    (bundle recovered)
  awaiting-review no bundle            -> reload    (bundle=None) + warning
  approved        has bundle           -> reload    (bundle recovered)
  approved        no bundle            -> reload    (bundle=None) + warning
  merged          (any)                -> done      (in git history)
  failed          (any)                -> done      (quarantined; scheduler ignores)
  deferred        (any)                -> done      (set aside by the operator's go/no-go)

THE invariant: no chunk with a completed status (merged/approved/awaiting-review/
failed) ever appears in `relaunch` or `tick` -- "no redone completed work".
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile

from cockpit_sidecar import (
    default_sidecar_path,
    read_sidecar,
    record_bundle,
    record_launch,
    resume_plan,
)
from runnable_set import (
    APPROVED,
    AWAITING_REVIEW,
    BUILDING,
    DEFERRED,
    FAILED,
    MERGED,
    PENDING,
)

CASES = []


def case(name, fn):
    CASES.append((name, fn))


def expect(cond, detail):
    if not cond:
        raise AssertionError(detail)


def _ids(entries):
    """resume_plan buckets hold either bare ids or dicts with an 'id' key."""
    return [e["id"] if isinstance(e, dict) else e for e in entries]


# --- resume_plan: the full status contract ---------------------------------

# 1. Mixed board: every status routes to the right bucket.
def _resume_plan_full_contract():
    board = [
        {"id": "1", "status": MERGED},
        {"id": "2", "status": AWAITING_REVIEW},
        {"id": "3", "status": BUILDING},
        {"id": "4", "status": PENDING},
        {"id": "5", "status": BUILDING},
        {"id": "6", "status": FAILED},
        {"id": "7", "status": APPROVED},
    ]
    sidecar = {
        "3": {"runId": "wf_aaa", "branch": "b3", "worktree": "/wt/3"},
        "2": {"runId": "wf_bbb", "branch": "b2", "worktree": "/wt/2",
              "bundle": {"chunkId": "2", "status": AWAITING_REVIEW}},
        "7": {"runId": "wf_ddd", "branch": "b7", "worktree": "/wt/7",
              "bundle": {"chunkId": "7", "status": "approved"}},
        # chunk 5 (building) has NO sidecar entry -> relaunch.
    }
    plan = resume_plan(board, sidecar)
    expect(_ids(plan["done"]) == ["1", "6"], f"done wrong: {plan['done']!r}")
    # awaiting-review reloads for the go/no-go; approved is PAST the go/no-go and
    # resumes into the merge path (chunk 7), not back into re-review.
    expect(_ids(plan["reload"]) == ["2"], f"reload wrong: {plan['reload']!r}")
    expect(_ids(plan["merge"]) == ["7"], f"merge wrong: {plan['merge']!r}")
    expect(_ids(plan["resume"]) == ["3"], f"resume wrong: {plan['resume']!r}")
    expect(_ids(plan["relaunch"]) == ["5"], f"relaunch wrong: {plan['relaunch']!r}")
    expect(_ids(plan["tick"]) == ["4"], f"tick wrong: {plan['tick']!r}")


case("resume_plan routes every status correctly", _resume_plan_full_contract)


# 2. THE invariant: no completed-status chunk is ever relaunched or re-ticked.
def _no_completed_work_redone():
    completed = {MERGED, AWAITING_REVIEW, APPROVED, FAILED}
    board = [
        {"id": "1", "status": MERGED},
        {"id": "2", "status": AWAITING_REVIEW},
        {"id": "3", "status": APPROVED},
        {"id": "4", "status": FAILED},
        {"id": "5", "status": BUILDING},   # no sidecar -> relaunch (allowed: in-flight)
        {"id": "6", "status": PENDING},    # tick (allowed: never started)
    ]
    plan = resume_plan(board, {})
    relaunch_or_tick = set(_ids(plan["relaunch"])) | set(_ids(plan["tick"]))
    completed_ids = {c["id"] for c in board if c["status"] in completed}
    leaked = relaunch_or_tick & completed_ids
    expect(not leaked, f"completed work routed to a launch path: {sorted(leaked)}")


case("no completed-status chunk is relaunched or re-ticked", _no_completed_work_redone)


# 3. building WITH runId -> resume carries the reconnection fields.
def _building_with_runid_resumes():
    board = [{"id": "3", "status": BUILDING}]
    sidecar = {"3": {"runId": "wf_xyz", "branch": "b3", "worktree": "/wt/3"}}
    plan = resume_plan(board, sidecar)
    expect(plan["relaunch"] == [], "building w/ runId must not relaunch")
    entry = plan["resume"][0]
    expect(entry["runId"] == "wf_xyz" and entry["branch"] == "b3"
           and entry["worktree"] == "/wt/3",
           f"resume entry lost reconnection fields: {entry!r}")


case("building chunk with runId routes to resume", _building_with_runid_resumes)


# 3b. building + a PERSISTED BUNDLE -> reload, never resume/relaunch. The cockpit
#     persists the bundle BEFORE it marks the board awaiting-review; a /clear in
#     that window leaves status=building with the completed bundle safe on disk.
#     Rebuilding it would redo completed work -- the exact failure resume exists
#     to prevent. (The contract row missed in the first pass; Codex P1.)
def _building_with_bundle_reloads():
    board = [{"id": "3", "status": BUILDING}]
    sidecar = {"3": {"runId": "wf_x", "branch": "b3", "worktree": "/wt/3",
                     "bundle": {"chunkId": "3", "status": AWAITING_REVIEW}}}
    plan = resume_plan(board, sidecar)
    expect(_ids(plan["resume"]) == [], "building+bundle must not resume (it finished)")
    expect(_ids(plan["relaunch"]) == [], "building+bundle must not relaunch")
    by_id = {e["id"]: e for e in plan["reload"]}
    expect(by_id.get("3", {}).get("bundle"),
           f"building+bundle should reload the persisted bundle: {plan['reload']!r}")
    # the board still says building though the work finished -> resume must
    # surface a board repair so the scheduler stops counting a freed slot.
    rep = {e["id"]: e["status"] for e in plan["repair"]}
    expect(rep.get("3") == AWAITING_REVIEW,
           f"building+green-bundle should repair board to awaiting-review: {plan['repair']!r}")


case("building chunk with a persisted bundle reloads, not rebuilds",
     _building_with_bundle_reloads)


# 3c. building + a persisted FAILED bundle -> done (quarantine), not reload. The
#     cockpit persists the bundle before writing the terminal status; if the wipe
#     lost a `failed` board-write, the bundle's own status is authoritative. A
#     failed bundle routed to reload would be relayed/merged (chunk 6/7) as a
#     reviewable success. Never rebuild either way. (Codex P2, round 3.)
def _building_with_failed_bundle_quarantines():
    board = [{"id": "3", "status": BUILDING}]
    sidecar = {"3": {"runId": "wf_x", "branch": "b3", "worktree": "/wt/3",
                     "bundle": {"chunkId": "3", "status": FAILED}}}
    plan = resume_plan(board, sidecar)
    expect("3" in plan["done"], f"failed bundle should quarantine to done: {plan!r}")
    expect(_ids(plan["reload"]) == [], "a failed bundle must not reload as reviewable")
    expect(_ids(plan["resume"]) == [] and _ids(plan["relaunch"]) == [],
           "a failed bundle must not resume or relaunch")
    rep = {e["id"]: e["status"] for e in plan["repair"]}
    expect(rep.get("3") == FAILED,
           f"building+failed-bundle should repair board to failed: {plan['repair']!r}")


case("building chunk with a failed bundle quarantines to done",
     _building_with_failed_bundle_quarantines)


# 4. building WITHOUT a sidecar entry -> relaunch + a warning (can't reconnect).
def _building_without_runid_relaunches_with_warning():
    board = [{"id": "5", "status": BUILDING}]
    plan = resume_plan(board, {})
    expect(_ids(plan["relaunch"]) == ["5"], "building w/o runId must relaunch")
    expect(any("5" in w for w in plan["warnings"]),
           f"missing-runId relaunch should warn: {plan['warnings']!r}")


case("building chunk without runId relaunches with a warning",
     _building_without_runid_relaunches_with_warning)


# 5. awaiting-review WITH bundle -> reload carries the bundle; WITHOUT -> warn.
def _reload_carries_bundle_or_warns():
    board = [{"id": "2", "status": AWAITING_REVIEW},
             {"id": "8", "status": AWAITING_REVIEW}]
    sidecar = {"2": {"bundle": {"chunkId": "2"}}}  # chunk 8 has no bundle
    plan = resume_plan(board, sidecar)
    by_id = {e["id"]: e for e in plan["reload"]}
    expect(by_id["2"]["bundle"] == {"chunkId": "2"}, "reload dropped the bundle")
    expect(by_id["8"]["bundle"] is None, "missing bundle should reload as None")
    expect(any("8" in w for w in plan["warnings"]),
           f"built-but-no-bundle should warn: {plan['warnings']!r}")


case("reload recovers the bundle or warns when absent", _reload_carries_bundle_or_warns)


# 6. Empty board -> every bucket empty (no crash).
def _empty_board():
    plan = resume_plan([], {})
    for k in ("done", "reload", "merge", "resume", "relaunch", "tick", "repair"):
        expect(plan[k] == [], f"empty board left {k} non-empty: {plan[k]!r}")


case("empty board yields an all-empty plan", _empty_board)


# 7. Stale sidecar entry (chunk absent from the board) is ignored -- the board
#    is the source of truth, not the sidecar.
def _stale_sidecar_entry_ignored():
    board = [{"id": "4", "status": PENDING}]
    sidecar = {"99": {"runId": "wf_ghost", "branch": "bX", "worktree": "/wt/X"}}
    plan = resume_plan(board, sidecar)
    everywhere = (_ids(plan["done"]) + _ids(plan["reload"]) + _ids(plan["resume"])
                  + _ids(plan["relaunch"]) + _ids(plan["tick"]))
    expect("99" not in everywhere, f"stale sidecar entry leaked into plan: {plan!r}")


case("stale sidecar entry is ignored", _stale_sidecar_entry_ignored)


# --- sidecar persistence: record_launch / record_bundle / read -------------

# 8. record_launch persists the reconnection fields; read_sidecar reads them.
def _record_launch_round_trips():
    d = tempfile.mkdtemp()
    try:
        p = os.path.join(d, ".cockpit-sidecar.json")
        record_launch(p, "3", "wf_aaa", "feat-chunk-3", "/wt/3")
        sc = read_sidecar(p)
        e = sc["3"]
        expect(e["runId"] == "wf_aaa" and e["branch"] == "feat-chunk-3"
               and e["worktree"] == "/wt/3",
               f"record_launch lost fields: {e!r}")
        # the file is valid JSON on disk
        with open(p) as f:
            json.load(f)
    finally:
        shutil.rmtree(d)


case("record_launch persists and reads back", _record_launch_round_trips)


# 9. record_bundle merges into the existing launch entry without dropping runId.
def _record_bundle_merges():
    d = tempfile.mkdtemp()
    try:
        p = os.path.join(d, ".cockpit-sidecar.json")
        record_launch(p, "3", "wf_aaa", "b3", "/wt/3")
        record_bundle(p, "3", {"chunkId": "3", "status": AWAITING_REVIEW})
        e = read_sidecar(p)["3"]
        expect(e["runId"] == "wf_aaa", "record_bundle clobbered the runId")
        expect(e["bundle"]["status"] == AWAITING_REVIEW,
               f"record_bundle did not store the bundle: {e!r}")
    finally:
        shutil.rmtree(d)


case("record_bundle merges, preserving the launch entry", _record_bundle_merges)


# 10. Two launches coexist; a second write doesn't corrupt the first.
def _two_launches_coexist():
    d = tempfile.mkdtemp()
    try:
        p = os.path.join(d, ".cockpit-sidecar.json")
        record_launch(p, "3", "wf_a", "b3", "/wt/3")
        record_launch(p, "4", "wf_b", "b4", "/wt/4")
        sc = read_sidecar(p)
        expect(sc["3"]["runId"] == "wf_a" and sc["4"]["runId"] == "wf_b",
               f"second launch corrupted the sidecar: {sc!r}")
    finally:
        shutil.rmtree(d)


case("two launches coexist in the sidecar", _two_launches_coexist)


# 11. read_sidecar on an absent file -> {} (a fresh spec has no sidecar yet).
def _read_absent_sidecar():
    d = tempfile.mkdtemp()
    try:
        p = os.path.join(d, ".cockpit-sidecar.json")
        expect(read_sidecar(p) == {}, "absent sidecar should read as {}")
    finally:
        shutil.rmtree(d)


case("absent sidecar reads as empty dict", _read_absent_sidecar)


# 11b. A CORRUPT sidecar (torn / 0-byte / malformed JSON) must NOT raise and abort
#     ALL resume. read_sidecar degrades to a board-only resume: it returns {} (so
#     the durable board is still re-read) AND emits a LOUD warning to stderr, so
#     the lost ephemeral run-state is visible. Today json.load raises
#     JSONDecodeError, killing the whole resume; the fallback is the chunk's
#     headline. (chunk 11: durable-state crash/corruption safety.)
def _corrupt_sidecar_degrades_to_empty_with_warning():
    d = tempfile.mkdtemp()
    try:
        p = os.path.join(d, ".cockpit-sidecar.json")
        with open(p, "w") as f:
            f.write("{")  # malformed / partially-written JSON
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            result = read_sidecar(p)  # must NOT raise
        expect(result == {},
               f"corrupt sidecar must degrade to {{}} (board-only resume), got {result!r}")
        expect(err.getvalue().strip() != "",
               "corrupt sidecar must emit a LOUD warning to stderr, got nothing")
    finally:
        shutil.rmtree(d)


case("corrupt sidecar degrades to board-only resume with a warning",
     _corrupt_sidecar_degrades_to_empty_with_warning)


# 11c. _atomic_write fsyncs the tmp BEFORE os.replace (chunk 11: crash
#     durability). The fsync is a kernel syscall, invisible from output, so we
#     observe it by recording the call order of os.fsync vs os.replace: fsync
#     must precede replace -- fsyncing AFTER the rename is too late (the tmp is
#     already the live file). record_launch drives a real write through
#     _atomic_write end to end.
def _atomic_write_fsyncs_before_replace():
    import cockpit_sidecar as cs
    d = tempfile.mkdtemp()
    try:
        p = os.path.join(d, ".cockpit-sidecar.json")
        order = []
        real_fsync, real_replace = os.fsync, os.replace

        def spy_fsync(fd):
            order.append("fsync")
            return real_fsync(fd)

        def spy_replace(src, dst):
            order.append("replace")
            return real_replace(src, dst)

        os.fsync, os.replace = spy_fsync, spy_replace
        try:
            cs.record_launch(p, "3", "wf_aaa", "b3", "/wt/3")
        finally:
            os.fsync, os.replace = real_fsync, real_replace
        expect("fsync" in order, f"_atomic_write never fsynced: {order!r}")
        expect("replace" in order, f"_atomic_write never replaced: {order!r}")
        expect(order.index("fsync") < order.index("replace"),
               f"fsync must precede os.replace, got {order!r}")
    finally:
        shutil.rmtree(d)


case("_atomic_write fsyncs before os.replace", _atomic_write_fsyncs_before_replace)


# 12. default_sidecar_path derives a sibling of the spec, OUT of current.md
#     (a dotfile so it stays out of the way), and is not the spec itself.
def _default_path_is_sibling_dotfile():
    spec = "/proj/specs/current.md"
    p = default_sidecar_path(spec)
    expect(p != spec, "sidecar path must not be the spec file")
    expect(os.path.dirname(p) == os.path.dirname(spec),
           f"sidecar should sit beside the spec: {p}")
    expect(os.path.basename(p).startswith("."),
           f"sidecar should be a dotfile: {p}")


case("default_sidecar_path is a sibling dotfile", _default_path_is_sibling_dotfile)


# 13. An unknown status fails loud -- a status outside the locked vocabulary
#     must not be silently dropped from the resume. (Chunk 7 added `deferred` to
#     the vocabulary; the fail-loud guard now fires on a genuinely-unknown one.)
def _unknown_status_raises():
    try:
        resume_plan([{"id": "3", "status": "frobnicated"}], {})
    except ValueError:
        return
    raise AssertionError("unknown status should raise ValueError")


case("unknown status fails loud", _unknown_status_raises)


# 13b. `deferred` (chunk 7) is terminal -- the operator's go/no-go set the chunk aside.
#      Resume routes it to `done` alongside merged/failed: never relaunched,
#      never reloaded, never re-ticked.
def _deferred_routes_to_done():
    plan = resume_plan([{"id": "3", "status": DEFERRED}], {})
    expect("3" in plan["done"], f"deferred should route to done: {plan!r}")
    elsewhere = (_ids(plan["reload"]) + _ids(plan["resume"])
                 + plan["relaunch"] + plan["tick"])
    expect("3" not in elsewhere, f"deferred must be done-only: {plan!r}")


case("deferred routes to done (terminal)", _deferred_routes_to_done)


# 13c. `approved` (chunk 7 made it a written, pre-merge state) resumes into the
#      MERGE path -- it is past the operator's go/no-go, so it must not re-present for
#      review (reload) or rebuild (relaunch); it just needs merging.
def _approved_routes_to_merge():
    plan = resume_plan([{"id": "7", "status": APPROVED}], {})
    expect(_ids(plan["merge"]) == ["7"], f"approved should route to merge: {plan!r}")
    not_here = (_ids(plan["reload"]) + _ids(plan["resume"])
                + plan["relaunch"] + plan["tick"] + _ids(plan["done"]))
    expect("7" not in not_here, f"approved must be merge-only: {plan!r}")


case("approved resumes into the merge path", _approved_routes_to_merge)


def main():
    failures = 0
    for name, fn in CASES:
        try:
            fn()
            print(f"[PASS] {name}")
        except AssertionError as e:
            print(f"[FAIL] {name}: {e}")
            failures += 1
        except Exception as e:  # import/attr errors surface here during RED
            print(f"[ERROR] {name}: {type(e).__name__}: {e}")
            failures += 1
    total = len(CASES)
    print(f"\n{total - failures}/{total} passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
