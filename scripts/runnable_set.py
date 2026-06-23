#!/usr/bin/env python3
"""runnable_set.py -- compute which chunks may launch in parallel right now.

Part of parallel-chunk-execution (chunk 2). The cockpit (chunk 4) holds the
spec's `## Execution state` board -- a list of chunks each carrying a status --
and shells out to this module to learn which chunks are safe to launch.

A chunk is a dict:
    {"id": str, "depends_on": [ids], "touches": [file paths], "status": str}
status vocabulary (locked in the spec's Interfaces / data model):
    pending | building | awaiting-review | approved | merged | failed | deferred

Launchable iff ALL hold:
  - status == "pending" (not already merged or in flight), AND
  - every depends_on chunk is "merged" (deps satisfied), AND
  - its touched files overlap no in-flight chunk's files AND no
    already-admitted candidate's files. Overlap is the parallel-edit hazard
    the spec forbids ("never parallelize edits to the same file").

Greedy declaration-order admission: chunks are considered in list order; when
two otherwise-launchable chunks touch the same file, the earlier one is
admitted and the later one waits (it becomes launchable on a later call once
the earlier chunk merges and frees its files). This keeps the returned set
internally conflict-free, so the cockpit can launch the whole set at once.

CLI: reads a JSON array of chunks from stdin (or a file path arg), prints the
launchable id list as JSON to stdout.
    echo "$BOARD_JSON" | python3 scripts/runnable_set.py   ->  ["2","4"]
"""
import datetime
import json
import os
import sys

MERGED = "merged"
PENDING = "pending"
BUILDING = "building"
AWAITING_REVIEW = "awaiting-review"
APPROVED = "approved"
# In-flight = a chunk that holds its touched files (no co-editing chunk may
# launch) but is not yet merged. BUILDING also consumes a concurrency slot;
# AWAITING_REVIEW / APPROVED do not (their agents are done) -- see the cockpit
# skill's slot-trim launch decision, which counts only BUILDING against the cap.
IN_FLIGHT = frozenset({BUILDING, AWAITING_REVIEW, APPROVED})
# Terminal quarantine status: a chunk whose pipeline failed. It is deliberately
# none of the categories above -- not PENDING (so it never relaunches), not
# IN_FLIGHT (so it releases its file claim and the wave proceeds around it), not
# MERGED (so a dependent never treats it as satisfied). runnable_set therefore
# ignores it: it consumes no build slot and blocks nothing. Recovery is the
# cockpit surfacing reset-or-decompose to the operator, not a scheduler transition.
FAILED = "failed"
# Terminal voluntary status: a chunk the operator's go/no-go deliberately postponed (the
# voluntary sibling of FAILED, written by chunk 7's merge gate). Same terminal
# semantics as FAILED -- not PENDING (never relaunches), not IN_FLIGHT (releases
# its file claim), not MERGED (never satisfies a dependent) -- so runnable_set
# ignores it identically. The split from FAILED is intent, not mechanism: FAILED
# is the pipeline breaking, DEFERRED is the operator choosing to set the chunk aside.
DEFERRED = "deferred"


def runnable_set(chunks):
    """Return the launchable chunk ids, in declaration order.

    chunks: iterable of chunk dicts (see module docstring). Missing keys
    default to depends_on=[], touches=[], status="pending".
    """
    chunks = list(chunks)
    status_by_id = {c["id"]: c.get("status", PENDING) for c in chunks}

    # Files held by chunks currently in flight cannot be touched by a launch.
    occupied = set()
    for c in chunks:
        if c.get("status", PENDING) in IN_FLIGHT:
            occupied |= set(c.get("touches", []))

    admitted = []
    for c in chunks:
        if c.get("status", PENDING) != PENDING:
            continue  # only pending chunks are launch candidates
        deps = c.get("depends_on", [])
        if not all(status_by_id.get(d) == MERGED for d in deps):
            continue  # an unmet (unmerged or unknown) dependency blocks launch
        files = set(c.get("touches", []))
        if files & occupied:
            continue  # would collide with an in-flight or admitted chunk
        admitted.append(c["id"])
        occupied |= files  # reserve this candidate's files for the wave
    return admitted


def _runlog(msg):
    """Append a timestamped progress line to the logfile named by
    RUNNABLE_SET_RUNLOG. No-op when the env var is unset."""
    path = os.environ.get("RUNNABLE_SET_RUNLOG")
    if not path:
        return
    ts = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    with open(path, "a") as f:
        f.write(f"{ts} {msg}\n")


def main(argv):
    _runlog("runnable_set: start")
    raw = open(argv[1]).read() if len(argv) > 1 else sys.stdin.read()
    chunks = json.loads(raw)
    result = runnable_set(chunks)
    _runlog(f"runnable_set: done, launchable={result}")
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv)
