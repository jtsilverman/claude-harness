#!/usr/bin/env python3
"""Unit tests for exec_state -- the ## Execution state board codec.

Durable regression suite (lives next to the module, not in specs/scripts/),
because chunk 4's cockpit round-trips the board through this codec and must
stay protected.

Run: python3 scripts/exec_state_test.py   (exit 0 = all pass, 1 = any fail)

The codec reads/writes the spec's `## Execution state` section -- a per-chunk
status board. A board entry is {"id": str, "status": str}; status is the
parallel-chunk-execution vocabulary, owned by runnable_set:
  pending | building | awaiting-review | approved | merged | failed | deferred
Contract:
  - parse_execution_state(text) -> [{"id","status"}, ...] in document order,
    reading ONLY the ## Execution state section (ignores every other section);
    [] when the section is absent or empty; raises ValueError on a status
    outside the locked vocabulary (fail-loud -- a corrupt board entry must not
    silently produce a chunk runnable_set never launches).
  - render_execution_state(board) -> the ## Execution state markdown section.
  - parse(render(board)) == board for any valid board (the round-trip).
"""
import glob
import os
import shutil
import sys
import tempfile

from exec_state import (
    parse_execution_state,
    render_execution_state,
    write_execution_state,
    STATUSES,
)
from runnable_set import DEFERRED, FAILED, IN_FLIGHT, MERGED, PENDING


CASES = []


def case(name, fn):
    CASES.append((name, fn))


def expect(cond, detail):
    if not cond:
        raise AssertionError(detail)


# 1. Round-trip a multi-chunk board: parse(render(board)) reproduces it.
#    THE acceptance property -- "the state file round-trips multi-chunk status".
def _roundtrip_multi():
    board = [
        {"id": "3", "status": "building"},
        {"id": "4", "status": "pending"},
        {"id": "5", "status": "merged"},
    ]
    got = parse_execution_state(render_execution_state(board))
    expect(got == board, f"round-trip changed the board: {got!r}")


case("round-trip multi-chunk board", _roundtrip_multi)


# 2. Round-trip every status in the locked vocabulary (no status is mangled).
def _roundtrip_all_statuses():
    board = [{"id": str(i), "status": s} for i, s in enumerate(sorted(STATUSES))]
    got = parse_execution_state(render_execution_state(board))
    expect(got == board, f"a status round-tripped wrong: {got!r}")


case("round-trip covers every locked status", _roundtrip_all_statuses)


# 3. Parse extracts ONLY the ## Execution state section out of a full spec,
#    ignoring sibling sections that also carry list items / colons.
def _parse_ignores_other_sections():
    spec = (
        "# Spec: demo\n\n"
        "## Chunk decomposition\n\n"
        "- Chunk 3: do a thing\n"
        "- depends-on: 2\n\n"
        "## Execution state\n\n"
        "- 3: building\n"
        "- 4: pending\n\n"
        "## Completed chunks\n\n"
        "- 2: merged earlier\n"
    )
    got = parse_execution_state(spec)
    expect(
        got == [{"id": "3", "status": "building"}, {"id": "4", "status": "pending"}],
        f"parse leaked a sibling section: {got!r}",
    )


case("parse reads only the Execution state section", _parse_ignores_other_sections)


# 4. Empty section body -> empty board (no entries, no crash).
def _parse_empty_section():
    spec = "## Execution state\n\n## Open questions\n\n- something\n"
    expect(parse_execution_state(spec) == [], "empty section should yield []")


case("empty section yields empty board", _parse_empty_section)


# 5. Absent section -> empty board (single-threaded specs have no such section).
def _parse_absent_section():
    spec = "# Spec: demo\n\n## Current chunk\n\n- chunk 3 pending\n"
    expect(parse_execution_state(spec) == [], "absent section should yield []")


case("absent section yields empty board", _parse_absent_section)


# 6. Round-trip the empty board (render then parse returns []).
def _roundtrip_empty():
    got = parse_execution_state(render_execution_state([]))
    expect(got == [], f"empty board did not round-trip: {got!r}")


case("empty board round-trips", _roundtrip_empty)


# 7. A status outside the locked vocabulary fails loud (corrupt board entry).
def _unknown_status_raises():
    spec = "## Execution state\n\n- 3: in-progress\n"
    try:
        parse_execution_state(spec)
    except ValueError:
        return
    raise AssertionError("unknown status 'in-progress' should raise ValueError")


case("unknown status raises ValueError", _unknown_status_raises)


# 8. The codec's vocabulary is runnable_set's, with zero duplication -- the
#    coupling that lets the cockpit feed parse() output straight to runnable_set.
def _vocab_matches_runnable_set():
    expect(
        STATUSES == frozenset({PENDING, MERGED, FAILED, DEFERRED}) | IN_FLIGHT,
        f"codec vocab drifted from runnable_set: {sorted(STATUSES)}",
    )


case("status vocabulary is runnable_set's, unduplicated", _vocab_matches_runnable_set)


# 9. Declaration order is preserved (runnable_set's greedy admission is
#    order-sensitive -- lower-index wins file-overlap ties).
def _order_preserved():
    board = [{"id": c, "status": "pending"} for c in ["7", "2", "9", "1"]]
    got = parse_execution_state(render_execution_state(board))
    expect([e["id"] for e in got] == ["7", "2", "9", "1"], f"order lost: {got!r}")


case("declaration order preserved", _order_preserved)


# 10. render is symmetric with parse: a status outside the locked vocabulary
#     fails loud, so the cockpit can never write a board the scheduler can't read.
def _render_unknown_status_raises():
    try:
        render_execution_state([{"id": "3", "status": "in-progress"}])
    except ValueError:
        return
    raise AssertionError("render of unknown status should raise ValueError")


case("render rejects unknown status", _render_unknown_status_raises)


# 11. A failed pipeline's quarantine status round-trips through the codec.
#     worker-pipeline returns status "failed" and the cockpit writes it to the
#     board to quarantine the chunk; the codec must ACCEPT it, not fail loud.
#     Regression for the chunk-4 review finding (Codex + Sonnet both caught that
#     "failed" was absent from STATUSES, so the first failed chunk would crash
#     the next parse/render tick).
def _failed_status_round_trips():
    board = [{"id": "3", "status": "failed"}]
    got = parse_execution_state(render_execution_state(board))
    expect(got == board, f"failed status did not round-trip: {got!r}")


case("failed quarantine status round-trips", _failed_status_round_trips)


# --- write_execution_state: transactional durable board writes (chunk 5) ----

_SPEC_FIXTURE = (
    "# Spec: demo\n\n"
    "## Chunk decomposition\n\n"
    "- Chunk 3: do a thing (depends-on: 2)\n\n"
    "## Execution state\n\n"
    "- 3: building\n"
    "- 4: pending\n\n"
    "## Open questions\n\n"
    "- keep me verbatim\n"
)


# 12. write replaces ONLY the ## Execution state section; sibling sections stay
#     byte-for-byte, and the new board round-trips back through parse.
def _write_replaces_only_the_section():
    d = tempfile.mkdtemp()
    try:
        spec = os.path.join(d, "current.md")
        with open(spec, "w") as f:
            f.write(_SPEC_FIXTURE)
        new_board = [{"id": "3", "status": "merged"}, {"id": "4", "status": "building"}]
        write_execution_state(spec, new_board)
        text = open(spec).read()
        expect(parse_execution_state(text) == new_board,
               f"written board did not round-trip: {parse_execution_state(text)!r}")
        expect("## Chunk decomposition\n\n- Chunk 3: do a thing (depends-on: 2)" in text,
               "sibling section before the board was mangled")
        expect("## Open questions\n\n- keep me verbatim" in text,
               "sibling section after the board was mangled")
    finally:
        shutil.rmtree(d)


case("write replaces only the Execution state section", _write_replaces_only_the_section)


# 13. write backs up the load-bearing spec to <target>.bak-YYYYMMDD-HHMMSS BEFORE
#     the rewrite (logic-error rollback, distinct from atomic-rename concurrency).
def _write_creates_timestamped_backup():
    d = tempfile.mkdtemp()
    try:
        spec = os.path.join(d, "current.md")
        with open(spec, "w") as f:
            f.write(_SPEC_FIXTURE)
        write_execution_state(spec, [{"id": "3", "status": "merged"},
                                     {"id": "4", "status": "pending"}])
        baks = glob.glob(spec + ".bak-*")
        expect(len(baks) >= 1, "write did not create a timestamped .bak")
        expect(_SPEC_FIXTURE == open(baks[0]).read(),
               "the .bak does not contain the pre-write content")
    finally:
        shutil.rmtree(d)


case("write creates a timestamped backup first", _write_creates_timestamped_backup)


# 14. write on a spec MISSING the section fails loud -- the cockpit only writes a
#     board that already exists (sole-writer of an established section), so an
#     absent section is a corrupt precondition, not an append point.
def _write_absent_section_raises():
    d = tempfile.mkdtemp()
    try:
        spec = os.path.join(d, "current.md")
        with open(spec, "w") as f:
            f.write("# Spec: demo\n\n## Current chunk\n\n- chunk 3\n")
        try:
            write_execution_state(spec, [{"id": "3", "status": "pending"}])
        except ValueError:
            return
        raise AssertionError("write on a spec without the section should raise")
    finally:
        shutil.rmtree(d)


case("write fails loud when the section is absent", _write_absent_section_raises)


# 15. write leaves no leftover tmp file (atomic tmp+rename cleaned up).
def _write_leaves_no_tmp():
    d = tempfile.mkdtemp()
    try:
        spec = os.path.join(d, "current.md")
        with open(spec, "w") as f:
            f.write(_SPEC_FIXTURE)
        write_execution_state(spec, [{"id": "3", "status": "approved"},
                                     {"id": "4", "status": "pending"}])
        leftovers = glob.glob(spec + ".tmp*")
        expect(leftovers == [], f"atomic write left a tmp file: {leftovers!r}")
    finally:
        shutil.rmtree(d)


case("write leaves no leftover tmp file", _write_leaves_no_tmp)


# 16. Two writes in quick succession produce TWO distinct backups -- the
#     sole-writer cockpit can write the board twice within one second, and a
#     second-precision .bak stamp would clobber the first write's rollback copy.
def _two_writes_keep_distinct_backups():
    d = tempfile.mkdtemp()
    try:
        spec = os.path.join(d, "current.md")
        with open(spec, "w") as f:
            f.write(_SPEC_FIXTURE)
        write_execution_state(spec, [{"id": "3", "status": "building"},
                                     {"id": "4", "status": "pending"}])
        write_execution_state(spec, [{"id": "3", "status": "merged"},
                                     {"id": "4", "status": "pending"}])
        baks = glob.glob(spec + ".bak-*")
        expect(len(baks) == 2, f"two rapid writes should keep 2 distinct backups, got {len(baks)}")
    finally:
        shutil.rmtree(d)


case("two rapid writes keep distinct backups", _two_writes_keep_distinct_backups)


# 17. Writing an EMPTY board preserves every following section + round-trips to
#     [] (regression lock for Codex's empty-board concern; the only artifact is a
#     cosmetic blank line, and this path is unreachable in the real flow -- the
#     cockpit never writes an empty board -- but lock the no-data-loss invariant).
def _write_empty_board_preserves_siblings():
    d = tempfile.mkdtemp()
    try:
        spec = os.path.join(d, "current.md")
        with open(spec, "w") as f:
            f.write(_SPEC_FIXTURE)
        write_execution_state(spec, [])
        text = open(spec).read()
        expect("## Open questions\n\n- keep me verbatim" in text,
               "empty-board write dropped a following section")
        expect("## Chunk decomposition" in text,
               "empty-board write dropped a preceding section")
        expect(parse_execution_state(text) == [], "empty-board write did not round-trip to []")
    finally:
        shutil.rmtree(d)


case("write of an empty board preserves sibling sections", _write_empty_board_preserves_siblings)


# 18. write_execution_state fsyncs the tmp BEFORE os.replace (chunk 11: crash
#     durability for the durable board). The fsync is a kernel syscall, invisible
#     from output, so we observe it by recording the call order of os.fsync vs
#     os.replace: fsync must precede replace (fsyncing AFTER the rename is too
#     late -- the tmp is already the live board). The .bak (logic-error rollback)
#     is a separate guarantee and is asserted in case 13; this locks the
#     crash-durability one, and that the fsync targets the TMP, not the bak.
def _write_fsyncs_before_replace():
    import exec_state
    d = tempfile.mkdtemp()
    try:
        spec = os.path.join(d, "current.md")
        with open(spec, "w") as f:
            f.write(_SPEC_FIXTURE)
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
            write_execution_state(spec, [{"id": "3", "status": "merged"},
                                         {"id": "4", "status": "pending"}])
        finally:
            os.fsync, os.replace = real_fsync, real_replace
        expect("fsync" in order, f"write_execution_state never fsynced: {order!r}")
        expect("replace" in order, f"write_execution_state never replaced: {order!r}")
        expect(order.index("fsync") < order.index("replace"),
               f"fsync must precede os.replace, got {order!r}")
    finally:
        shutil.rmtree(d)


case("write_execution_state fsyncs before os.replace", _write_fsyncs_before_replace)


# 19. The .bak rollback copy is itself fsynced to disk BEFORE os.replace makes
#     the new board live (chunk 11 follow-up, Codex P2). The .bak is the rollback
#     SUBSTRATE for a bad splice; current.md is a load-bearing config file. If the
#     OS crashes after os.replace makes a bad board live but before the .bak's
#     bytes leave the page cache, the rollback copy is itself torn/empty and the
#     guarantee it exists to provide is gone. So the .bak must be durable before
#     the forward rename, not merely written. shutil.copy2 does not fsync, so the
#     writer must fsync the .bak explicitly. We observe: the copy happens, then a
#     fsync of the .bak's fd, all before os.replace. (Two fsyncs total now -- the
#     tmp's from case 18 and the .bak's from here -- both ahead of the replace.)
def _write_fsyncs_bak_before_replace():
    import fcntl
    d = tempfile.mkdtemp()
    try:
        spec = os.path.join(d, "current.md")
        with open(spec, "w") as f:
            f.write(_SPEC_FIXTURE)
        order = []
        fsynced_paths = []
        real_copy2, real_fsync, real_replace = shutil.copy2, os.fsync, os.replace

        # Map every live fd to its path at fsync time, so we can tell the .bak's
        # fsync apart from the tmp's. /dev/fd readlink raises EINVAL on macOS, so
        # use fcntl F_GETPATH (macOS-native fd->path) with a Linux /proc fallback.
        F_GETPATH = getattr(fcntl, "F_GETPATH", 50)

        def _fd_path(fd):
            try:
                return fcntl.fcntl(fd, F_GETPATH, b"\x00" * 1024).split(b"\x00", 1)[0].decode()
            except OSError:
                try:
                    return os.readlink(f"/proc/self/fd/{fd}")
                except OSError:
                    return None

        def spy_fsync(fd):
            fsynced_paths.append(_fd_path(fd))
            order.append("fsync")
            return real_fsync(fd)

        def spy_copy2(src, dst):
            order.append("copy2")
            return real_copy2(src, dst)

        def spy_replace(src, dst):
            order.append("replace")
            return real_replace(src, dst)

        shutil.copy2, os.fsync, os.replace = spy_copy2, spy_fsync, spy_replace
        try:
            write_execution_state(spec, [{"id": "3", "status": "merged"},
                                         {"id": "4", "status": "pending"}])
        finally:
            shutil.copy2, os.fsync, os.replace = real_copy2, real_fsync, real_replace

        expect("replace" in order, f"write never replaced: {order!r}")
        expect("copy2" in order, f"write never copied the .bak: {order!r}")
        # A .bak path was fsynced (not just the tmp).
        bak_fsyncs = [p for p in fsynced_paths if p and ".bak-" in p]
        expect(bak_fsyncs, f"the .bak rollback copy was never fsynced: {fsynced_paths!r}")
        # Every fsync (tmp AND bak) precedes the rename -- nothing is synced too late.
        last_fsync = max(i for i, ev in enumerate(order) if ev == "fsync")
        expect(last_fsync < order.index("replace"),
               f"a fsync followed os.replace (synced too late): {order!r}")
    finally:
        shutil.rmtree(d)


case("write fsyncs the .bak rollback copy before os.replace", _write_fsyncs_bak_before_replace)


def main():
    failures = 0
    for name, fn in CASES:
        try:
            fn()
            print(f"[PASS] {name}")
        except AssertionError as e:
            print(f"[FAIL] {name}: {e}")
            failures += 1
        except Exception as e:  # a crashing test body reports + continues, never silently aborts the suite
            print(f"[ERROR] {name}: {type(e).__name__}: {e}")
            failures += 1
    total = len(CASES)
    print(f"\n{total - failures}/{total} passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
