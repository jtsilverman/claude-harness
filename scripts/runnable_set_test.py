#!/usr/bin/env python3
"""Unit tests for runnable_set() -- the launchable-chunk computation.

Durable regression suite (lives next to the module, not in specs/scripts/),
because chunk 4's cockpit consumes runnable_set() and must stay protected.

Run: python3 scripts/runnable_set_test.py   (exit 0 = all pass, 1 = any fail)

A chunk is a dict: {id, depends_on:[ids], touches:[paths], status}.
status is the parallel-chunk-execution vocabulary:
  pending | building | awaiting-review | approved | merged | failed | deferred
A chunk is launchable iff:
  - status == pending, AND
  - every depends_on chunk is merged, AND
  - its touched files overlap no in-flight chunk (building/awaiting-review/
    approved) and no already-admitted candidate (greedy declaration order).
"""
import sys

from runnable_set import runnable_set


def chunk(cid, depends_on=None, touches=None, status="pending"):
    return {
        "id": cid,
        "depends_on": depends_on or [],
        "touches": touches or [],
        "status": status,
    }


CASES = []


def case(name, chunks, expected):
    CASES.append((name, chunks, expected))


# 1. Empty graph -> nothing launchable.
case("empty graph", [], [])

# 2. Linear chain A->B->C, nothing merged -> only A (B,C have unmet deps).
case(
    "linear chain, nothing merged",
    [
        chunk("A", touches=["a"]),
        chunk("B", depends_on=["A"], touches=["b"]),
        chunk("C", depends_on=["B"], touches=["c"]),
    ],
    ["A"],
)

# 3. Same chain after A merged -> only B unblocks (C still waits on B).
case(
    "linear chain, A merged",
    [
        chunk("A", touches=["a"], status="merged"),
        chunk("B", depends_on=["A"], touches=["b"]),
        chunk("C", depends_on=["B"], touches=["c"]),
    ],
    ["B"],
)

# 4. Two independent chunks, no file overlap -> both launch together.
case(
    "two independent, disjoint files",
    [
        chunk("A", touches=["a"]),
        chunk("B", touches=["b"]),
    ],
    ["A", "B"],
)

# 5. Two independent chunks touching the SAME file -> only the earlier one;
#    the later waits (the file-overlapping-chunks-are-rejected acceptance).
case(
    "two independent, same file -> one wins",
    [
        chunk("A", touches=["shared.md"]),
        chunk("B", touches=["shared.md"]),
    ],
    ["A"],
)

# 6. A pending chunk overlapping an IN-FLIGHT chunk's file is rejected;
#    a disjoint pending chunk still launches.
case(
    "overlap with in-flight chunk rejected",
    [
        chunk("A", touches=["shared.md"], status="building"),
        chunk("B", touches=["shared.md"]),
        chunk("C", touches=["other.md"]),
    ],
    ["C"],
)

# 7. Already merged / in-flight chunks are never in the launchable set.
case(
    "merged and in-flight excluded",
    [
        chunk("A", touches=["a"], status="merged"),
        chunk("B", touches=["b"], status="approved"),
        chunk("C", touches=["c"], status="pending"),
    ],
    ["C"],
)

# 8. Dependency on a non-existent chunk -> never runnable, no crash.
case(
    "unknown dependency id never runnable",
    [
        chunk("A", depends_on=["ghost"], touches=["a"]),
    ],
    [],
)

# 9. Dependency cycle A<->B -> neither runnable, no crash.
case(
    "dependency cycle yields empty set",
    [
        chunk("A", depends_on=["B"], touches=["a"]),
        chunk("B", depends_on=["A"], touches=["b"]),
    ],
    [],
)

# 10. Realistic toy DAG: 1 merged; 2 depends on 1 (unblocked); 3 independent
#     but shares a file with 2 (loses the greedy race); 4 independent disjoint;
#     5 in-flight. Expect [2, 4].
case(
    "toy DAG mixed state",
    [
        chunk("1", touches=["one.py"], status="merged"),
        chunk("2", depends_on=["1"], touches=["two.py"]),
        chunk("3", touches=["two.py"]),
        chunk("4", touches=["four.py"]),
        chunk("5", touches=["five.py"], status="building"),
    ],
    ["2", "4"],
)


def main():
    failures = 0
    for name, chunks, expected in CASES:
        got = runnable_set(chunks)
        ok = list(got) == list(expected)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: expected {expected}, got {list(got)}")
        if not ok:
            failures += 1
    total = len(CASES)
    print(f"\n{total - failures}/{total} passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
