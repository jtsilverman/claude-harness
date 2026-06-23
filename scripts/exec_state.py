#!/usr/bin/env python3
"""exec_state.py -- read/write the spec's `## Execution state` board.

Part of parallel-chunk-execution (chunk 3). `## Execution state` is the
per-chunk status board that supersedes the singular `## Current chunk` for
specs run in parallel: one line per chunk, `- <id>: <status>`, where status is
the locked vocabulary owned by runnable_set:
    pending | building | awaiting-review | approved | merged | failed | deferred

This module is the codec the cockpit uses to read the board into structured
data and render it back. The cockpit (chunk 4) parses the board to learn each
chunk's status, joins it with the static depends-on/touches Scheduling fields,
and feeds runnable_set; on each merge it renders the board back. (One section
op lives outside this codec on purpose: ship-spec's at-archive clear just
blanks the section body -- a one-way erase, no parse/render -- and stays
self-contained so ship-spec keeps working on any project's spec without
importing this claude-code-setup-only module.)

SOLE-WRITER INVARIANT (Req 2): `## Execution state` is written by the cockpit
ONLY, only at merge, serially -- exactly one writer at a time, so the
spec-state race never exists. This codec documents and serves that invariant;
it does not enforce it. Enforcement is structural and lands in chunks 4 (the
cockpit is the only caller of the write path), 7 (serial merge), and 8 (the
worker bundle carries zero shared-state writes). Workers never touch this
section; they return their board delta to the cockpit as structured data.

A board entry is a dict {"id": str, "status": str}, kept in document order
(runnable_set's greedy admission is order-sensitive). The status vocabulary is
imported from runnable_set, not re-declared, so the two cannot drift.

CLI (the cockpit's call shapes):
    python3 scripts/exec_state.py parse   < spec.md     ->  board JSON on stdout
    python3 scripts/exec_state.py render  < board.json  ->  the ## Execution
                                                            state section
"""
import datetime
import json
import os
import re
import shutil
import sys


def _runlog(msg):
    """Append a timestamped progress line to EXEC_STATE_RUNLOG. No-op if unset."""
    path = os.environ.get("EXEC_STATE_RUNLOG")
    if not path:
        return
    ts = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    with open(path, "a") as f:
        f.write(f"{ts} {msg}\n")

from runnable_set import DEFERRED, FAILED, IN_FLIGHT, MERGED, PENDING

# The locked status vocabulary, sourced from runnable_set (zero duplication).
# FAILED / DEFERRED are the two terminal statuses the cockpit writes -- FAILED
# when a worker pipeline fails, DEFERRED when the operator's go/no-go postpones a chunk
# (chunk 7). The codec must accept both so the next tick can re-read the board
# (runnable_set ignores both; see runnable_set.FAILED / runnable_set.DEFERRED).
STATUSES = frozenset({PENDING, MERGED, FAILED, DEFERRED}) | IN_FLIGHT

HEADING = "## Execution state"

# Body of the ## Execution state section: everything between its heading and
# the next `## ` heading (or end of file). Same section-capture shape ship-spec
# uses to drain the drift queue.
_SECTION = re.compile(r"^## Execution state[ \t]*\n(.*?)(?=\n## |\Z)", re.M | re.S)
# A board line: `- <id>: <status>`. id is everything up to the first colon.
_ENTRY = re.compile(r"^- (?P<id>[^:]+):\s*(?P<status>\S+)\s*$")


def parse_execution_state(text):
    """Return the board [{"id","status"}, ...] from text's ## Execution state
    section, in document order. Returns [] when the section is absent or empty.
    Raises ValueError on a status outside the locked vocabulary -- a corrupt
    board entry must fail loud, not silently produce a never-launching chunk.
    """
    m = _SECTION.search(text)
    if not m:
        return []
    board = []
    for line in m.group(1).splitlines():
        em = _ENTRY.match(line.strip())
        if not em:
            continue
        status = em.group("status").strip()
        if status not in STATUSES:
            raise ValueError(
                f"unknown status {status!r} in ## Execution state "
                f"(expected one of {sorted(STATUSES)})"
            )
        board.append({"id": em.group("id").strip(), "status": status})
    return board


def render_execution_state(board):
    """Render a board [{"id","status"}, ...] as the ## Execution state section.
    Raises ValueError on a status outside the locked vocabulary (symmetric with
    parse -- never write a board the scheduler can't read).
    """
    lines = [HEADING, ""]
    for entry in board:
        status = entry["status"]
        if status not in STATUSES:
            raise ValueError(
                f"unknown status {status!r} for chunk {entry['id']!r} "
                f"(expected one of {sorted(STATUSES)})"
            )
        lines.append(f"- {entry['id']}: {status}")
    return "\n".join(lines) + "\n"


def write_execution_state(spec_path, board):
    """Transactionally replace the ## Execution state section of spec_path.

    The cockpit's durable run-state write (Req 7). Two failure modes, two
    defenses:
      - concurrent-writer visibility: render the new section, splice it in, write
        to a tmp DERIVED FROM THE TARGET, then os.replace (atomic on the same
        filesystem). No reader ever sees a half-written spec; deriving tmp from
        spec_path (not a shared TMP_DIR) keeps two cockpits writing different
        specs in one dir from colliding on the tmp path.
      - logic-error rollback: copy the spec to <spec_path>.bak-YYYYMMDD-HHMMSS
        BEFORE the rewrite. current.md is a load-bearing config file; atomic
        rename guarantees nothing about whether the NEW content is correct, so a
        bad splice would otherwise destroy the spec with no rollback substrate.

    Replaces ONLY the ## Execution state section (heading + body) via the same
    section regex parse uses; every sibling section is preserved byte-for-byte.
    Raises ValueError when the section is absent: the cockpit is the sole writer
    of an already-established board (chunk 3 seeds the section), so an absent
    section is a corrupt precondition, not an append point.
    """
    with open(spec_path) as f:
        text = f.read()
    if not _SECTION.search(text):
        raise ValueError(
            f"{spec_path}: no '## Execution state' section to write "
            f"(write_execution_state replaces an existing board, never appends)"
        )
    rendered = render_execution_state(board)  # validates the status vocabulary
    # Replace the full matched span (heading + body) with the rendered section.
    # A function replacement avoids re's backslash/group interpolation on the
    # rendered text. count=1: there is exactly one such section.
    new_text = _SECTION.sub(lambda m: rendered, text, count=1)

    # Microsecond precision (not just seconds): the sole-writer cockpit can write
    # the board twice within one second (e.g. mark building, then a re-tick), and
    # a second-precision stamp would clobber the earlier write's rollback copy.
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    bak = f"{spec_path}.bak-{stamp}"
    shutil.copy2(spec_path, bak)
    # Durability for the rollback SUBSTRATE (chunk 11 follow-up): shutil.copy2
    # writes the .bak but does not fsync it, so its bytes can sit in the OS page
    # cache. If a crash lands after the os.replace below makes a bad board live
    # but before those bytes reach disk, the .bak is itself torn/empty and the
    # rollback it exists to provide is gone. fsync the .bak so it is durable
    # before the forward rename. (The forward path is the only os.replace
    # durable writer and is fsynced separately at the tmp below; the .bak is not
    # os.replace'd live, but as a load-bearing rollback copy it must be durable
    # all the same.)
    bak_fd = os.open(bak, os.O_RDONLY)
    try:
        os.fsync(bak_fd)
    finally:
        os.close(bak_fd)

    tmp = f"{spec_path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(new_text)
        # Durability before the rename (chunk 11): flush Python's buffer to the
        # OS, then fsync the OS buffer to disk, so a crash between the write and
        # os.replace can't leave a torn tmp that the rename then makes the live
        # board. The .bak above is the logic-error rollback; this is the
        # crash-durability guarantee -- distinct defenses.
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, spec_path)


def main(argv):
    if len(argv) < 2 or argv[1] not in ("parse", "render"):
        sys.stderr.write("usage: exec_state.py {parse|render} < input\n")
        return 2
    _runlog(f"exec_state: start op={argv[1]}")
    if argv[1] == "parse":
        result = parse_execution_state(sys.stdin.read())
        _runlog(f"exec_state: parse done, entries={len(result)}")
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
    else:  # render
        sys.stdout.write(render_execution_state(json.load(sys.stdin)))
        _runlog("exec_state: render done")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
