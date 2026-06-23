#!/usr/bin/env python3
"""cockpit_sidecar.py -- the cockpit's EPHEMERAL run-state + resume plan.

Part of parallel-chunk-execution (chunk 5: durable state + clean resume).

Two kinds of cockpit run-state, split by durability:
  - DURABLE: the ## Execution state board in current.md (per-chunk status),
    written transactionally by exec_state.write_execution_state. It survives a
    /clear and is the SOURCE OF TRUTH for what is done.
  - EPHEMERAL: this sidecar -- a JSON object keyed by chunk id holding what the
    board can't carry and what must NOT land in the archived spec:
        { "<id>": {"runId", "branch", "worktree", "bundle"} }
    in-flight Workflow runIds (for resumeFromRunId reconnection) + collected
    review bundles. Kept OUT of current.md (Interfaces / data model) so a shipped
    spec carries no stale run state. It is a dotfile sibling of the spec
    (gitignored): ephemeral and reconstructible, so -- unlike current.md -- it
    needs no timestamped .bak, only the atomic tmp+rename for crash safety.

resume_plan(board, sidecar) is the clean-resume core: after a /clear the cockpit
re-reads the durable board + this sidecar and classifies EVERY chunk. The
contract is enumerated up front (not happy-path-first -- the chunk-4 lesson that
cost 4 Codex rounds):

  status          sidecar           -> bucket     meaning
  pending         (any)             -> tick       normal scheduler launch
  building        bundle (failed)   -> done       finished+failed; terminal board-write lost; quarantine, do NOT rebuild
  building        bundle (green)    -> reload     finished+green; completion board-write lost; do NOT rebuild
  building        runId, no bundle  -> resume     Workflow({scriptPath, resumeFromRunId})
  building        neither           -> relaunch   safe restart (in-flight work is provisional)
  awaiting-review has bundle        -> reload     bundle recovered; do NOT rebuild
  awaiting-review no bundle         -> reload     bundle=None + warning; still don't rebuild
  approved        (any)             -> merge      past the go/no-go; resume the merge (chunk 7), not re-review
  merged          (any)             -> done       in git history
  failed          (any)             -> done       quarantined; the scheduler ignores it
  deferred        (any)             -> done       set aside by the operator's go/no-go (chunk 7)

THE invariant resume_plan guarantees: no chunk with a completed status
(merged/approved/awaiting-review/failed) is ever placed in `relaunch` or `tick`,
so a /clear+resume never redoes or loses completed work. resumeFromRunId itself
is best-effort across a /clear (its run journal is session-scoped -- verified
live in chunk 5: an in-session resume cache-hits at 0 tokens, but the journal
lives under the session id, so a wipe is not guaranteed to find it). The durable
board is what makes the no-redo guarantee unconditional; "prefer wave/chunk-
boundary resets" (no building chunk at /clear) keeps resume a pure board
re-read + re-tick, sidestepping journal survival entirely.

A status outside the locked vocabulary fails loud -- the forced-articulation
that made chunk 7 route `deferred` (the operator's voluntary postpone) to `done` rather
than let it be silently dropped from the resume.

CLI (the acceptance check's call shape):
    python3 scripts/cockpit_sidecar.py resume-plan <sidecar.json> < board.json
"""
import datetime
import json
import os
import sys


def _runlog(msg):
    """Append a timestamped progress line to COCKPIT_SIDECAR_RUNLOG. No-op if unset."""
    path = os.environ.get("COCKPIT_SIDECAR_RUNLOG")
    if not path:
        return
    ts = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    with open(path, "a") as f:
        f.write(f"{ts} {msg}\n")

from runnable_set import (
    APPROVED,
    AWAITING_REVIEW,
    BUILDING,
    DEFERRED,
    FAILED,
    MERGED,
    PENDING,
)

SIDECAR_NAME = ".cockpit-sidecar.json"
# awaiting-review: the pipeline finished, the bundle is collected, the chunk
# waits on the operator's go/no-go -- resume reloads the bundle for review, never
# rebuilds. (approved is NOT here: chunk 7 made it a written, pre-merge state, so
# it is past the go/no-go and resumes into the merge path, not back into review.)
_RELOAD_STATUSES = frozenset({AWAITING_REVIEW})


def default_sidecar_path(spec_path):
    """The sidecar path for a spec: a dotfile sibling, OUT of the spec itself."""
    return os.path.join(os.path.dirname(os.path.abspath(spec_path)), SIDECAR_NAME)


def read_sidecar(path):
    """Read the sidecar dict; {} when the file is absent (a fresh spec).

    Corruption-tolerant (chunk 11): a torn / 0-byte / malformed-JSON sidecar
    degrades to a board-only resume -- it returns {} (so the durable board is
    still re-read) after a LOUD stderr warning, instead of raising and aborting
    ALL resume. The sidecar is ephemeral/reconstructible; only the in-flight
    runIds + collected bundles are lost (the board carries every chunk's status),
    so this is recoverable-but-lossier -- prefer wave-boundary resets.
    """
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        try:
            return json.load(f)
        except (json.JSONDecodeError, ValueError) as e:
            sys.stderr.write(
                f"WARNING: cockpit sidecar at {path} is corrupt ({e}); "
                f"degrading to a board-only resume (in-flight runIds + collected "
                f"bundles are lost, but the durable board still re-reads)\n"
            )
            return {}


def _atomic_write(path, obj):
    """Write obj as JSON atomically: tmp DERIVED FROM TARGET, then os.replace."""
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        # Durability before the rename (chunk 11): flush Python's buffer to the
        # OS, then fsync the OS buffer to the disk, so a crash between the write
        # and os.replace can't leave a torn tmp that the rename then makes live.
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def record_launch(path, chunk_id, run_id, branch, worktree):
    """Persist a launched pipeline's reconnection fields, at/before launch."""
    sc = read_sidecar(path)
    entry = sc.get(chunk_id, {})
    entry.update({"runId": run_id, "branch": branch, "worktree": worktree})
    sc[chunk_id] = entry
    _atomic_write(path, sc)


def record_bundle(path, chunk_id, bundle):
    """Store a collected review bundle on the chunk's entry, preserving runId."""
    sc = read_sidecar(path)
    entry = sc.get(chunk_id, {})
    entry["bundle"] = bundle
    sc[chunk_id] = entry
    _atomic_write(path, sc)


def resume_plan(board, sidecar):
    """Classify every board chunk for a post-/clear resume. See module docstring
    for the full status contract. Returns:
        {done, reload, resume, relaunch, tick: [...],
         repair: [{id, status}], warnings: [str]}
    `repair` lists chunks whose board status is stale (a building-window recovery
    where the terminal board-write was lost): the cockpit (sole writer) must
    write each {id -> status} to the board on resume so the scheduler's
    BUILDING-slot count reflects reality. Pure: this function never writes.
    """
    plan = {"done": [], "reload": [], "merge": [], "resume": [],
            "relaunch": [], "tick": [], "repair": [], "warnings": []}
    for c in board:
        cid, status = c["id"], c["status"]
        entry = sidecar.get(cid, {})
        if status in (MERGED, FAILED, DEFERRED):
            # Terminal: in git history (merged), quarantined (failed), or set
            # aside by the operator's go/no-go (deferred). Resume never relaunches,
            # reloads, or re-ticks any of them.
            plan["done"].append(cid)
        elif status == APPROVED:
            # Past the operator's go/no-go (chunk 7 writes `approved` before the merge).
            # A /clear in the approved->merged window resumes into the merge path
            # (re-run mergeable_set + merge_chunk_branch), NOT back into review --
            # re-presenting an already-approved chunk would redo a completed
            # approval (the "no redone completed work" invariant, Req 7).
            plan["merge"].append(cid)
        elif status == PENDING:
            plan["tick"].append(cid)
        elif status == BUILDING:
            bundle = entry.get("bundle")
            if bundle is not None:
                # The pipeline finished and its bundle was persisted, but the
                # board write marking the terminal status did not land before the
                # wipe (the cockpit persists the bundle BEFORE the board update).
                # The bundle's OWN status is authoritative: a failed bundle
                # quarantines (done), a green one reloads for review. Either way
                # never rebuild -- the work already ran; rebuilding is exactly the
                # redo-completed-work failure resume exists to prevent, and
                # reloading a failed bundle would relay/merge it as a success.
                # The board still says `building`, so emit a `repair` so the
                # cockpit (sole writer) reconciles it -- otherwise the scheduler
                # keeps counting the freed build slot as occupied (BUILDING).
                if bundle.get("status") == FAILED:
                    plan["done"].append(cid)
                    plan["repair"].append({"id": cid, "status": FAILED})
                    plan["warnings"].append(
                        f"chunk {cid} board says building but a FAILED bundle is "
                        f"persisted; quarantining (the failed board-write was lost)"
                    )
                else:
                    plan["reload"].append({"id": cid, "bundle": bundle})
                    plan["repair"].append({"id": cid, "status": AWAITING_REVIEW})
                    plan["warnings"].append(
                        f"chunk {cid} board says building but a bundle is persisted; "
                        f"the completion board-write was lost -- reloading, not rebuilding"
                    )
            elif entry.get("runId"):
                plan["resume"].append({
                    "id": cid,
                    "runId": entry["runId"],
                    "branch": entry.get("branch"),
                    "worktree": entry.get("worktree"),
                })
            else:
                plan["relaunch"].append(cid)
                plan["warnings"].append(
                    f"chunk {cid} was building but has no sidecar runId; "
                    f"safe to relaunch (in-flight work is provisional)"
                )
        elif status in _RELOAD_STATUSES:
            bundle = entry.get("bundle")
            plan["reload"].append({"id": cid, "bundle": bundle})
            if bundle is None:
                plan["warnings"].append(
                    f"chunk {cid} is {status} but no bundle in the sidecar; "
                    f"will not rebuild, but the bundle must be re-derived"
                )
        else:
            raise ValueError(f"chunk {cid} has unknown status {status!r}")
    return plan


def main(argv):
    if len(argv) >= 3 and argv[1] == "resume-plan":
        _runlog(f"cockpit_sidecar: start op=resume-plan sidecar={argv[2]}")
        sidecar = read_sidecar(argv[2])
        board = json.loads(sys.stdin.read())
        plan = resume_plan(board, sidecar)
        _runlog(f"cockpit_sidecar: done resume-plan tick={plan.get('tick')} merge={plan.get('merge')}")
        json.dump(plan, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    sys.stderr.write(
        "usage: cockpit_sidecar.py resume-plan <sidecar.json> < board.json\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
