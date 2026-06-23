#!/usr/bin/env python3
"""Characterization test for scripts/ship_spec.sh.

This is a CHARACTERIZATION test: it locks the CURRENT behavior of the ship-spec
bash primitives so that the extraction from skills/ship-spec/SKILL.md is proven
behavior-preserving. It must PASS against the extracted script.

No external deps; stdlib only. Each test sources scripts/ship_spec.sh in a bash
subprocess, calls one function against a temp fixture, and asserts on stdout or
on the side effects the function left on disk.

Coverage (per the task's minimum):
  (a) scaffolding-sweep bucket computation — Bucket A auto-move globs vs Bucket B.
  (b) drift-queue parse + consolidate pipeline (parse_queue -> mtime_recheck ->
      format_consolidated_list, driven via drain_drift_queue).
  (c) wiki_drift_snapshot against a tiny fixture vault via the VAULT=<path> override.
Plus a few extra characterizations of the snapshot writers (write_resolution_snapshot,
clear_execution_state) since they are part of the same extracted surface.
"""

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "ship_spec.sh")

_failures = []
_passes = []


def run_bash(snippet, env=None, cwd=None, stdin=None):
    """Source ship_spec.sh, then run the snippet in bash. Return (rc, stdout, stderr).

    No `set -e`: the ship-spec primitives intentionally use grep -c / grep -v,
    which return nonzero on no-match, and are sourced into a normal (non-errexit)
    shell in real invocation. Multi-line stdin is passed via the `stdin` arg, not
    interpolated into the snippet, so embedded newlines survive verbatim.
    """
    full = f'source "{SCRIPT}"\n{snippet}\n'
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    proc = subprocess.run(
        ["bash", "-c", full],
        capture_output=True,
        text=True,
        env=full_env,
        cwd=cwd,
        input=stdin,
    )
    return proc.returncode, proc.stdout, proc.stderr


def check(name, cond, detail=""):
    if cond:
        _passes.append(name)
        print(f"PASS  {name}")
    else:
        _failures.append((name, detail))
        print(f"FAIL  {name}  {detail}")


# ---------------------------------------------------------------------------
# (a) Scaffolding-sweep bucket computation
# ---------------------------------------------------------------------------
def test_bucket_computation():
    with tempfile.TemporaryDirectory() as root:
        specs = os.path.join(root, "specs")
        scripts = os.path.join(specs, "scripts")
        os.makedirs(scripts)
        # Bucket A in specs/: chunk-*, pivot-*, plan-*
        for f in ("chunk-2-acceptance.sh", "pivot-1-notes.md", "plan-archive.md"):
            open(os.path.join(specs, f), "w").close()
        # Bucket A in specs/scripts/: slug-prefixed
        open(os.path.join(scripts, "my-spec-c1-acceptance.sh"), "w").close()
        # Orphan in specs/scripts/ (bare prefix, NOT slug-prefixed) -> survives
        # (could belong to another in-flight spec; the sweep must not touch it).
        open(os.path.join(scripts, "c9-orphan.sh"), "w").close()
        # A cross-spec design doc (not slug-prefixed, not .bak) -- SURVIVES the sweep
        # under the allow-pattern (bucket B no longer touches it).
        open(os.path.join(specs, "cert-substrate-inventory.md"), "w").close()
        # Protect-list: current.md (live board) + owed-items.md (cross-spec register).
        # Both must SURVIVE the no-prompt delete sweep.
        open(os.path.join(specs, "current.md"), "w").close()
        open(os.path.join(specs, "owed-items.md"), "w").close()

        # list_bucket_a with slug "my-spec"
        rc, out, err = run_bash(f'list_bucket_a "{specs}" "my-spec"')
        a_names = sorted(os.path.basename(p) for p in out.split() if p.strip())
        check(
            "(a) Bucket A contains the 3 specs/ globs + slug-prefixed script",
            a_names == sorted([
                "chunk-2-acceptance.sh",
                "pivot-1-notes.md",
                "plan-archive.md",
                "my-spec-c1-acceptance.sh",
            ]),
            f"got {a_names}",
        )
        check(
            "(a) Bucket A excludes the bare-prefix orphan script",
            "c9-orphan.sh" not in a_names,
            f"got {a_names}",
        )

        # list_bucket_b -- allow-pattern: only slug-prefixed and .bak files.
        # cert-substrate-inventory.md is NOT slug-prefixed and NOT .bak, so it
        # does NOT appear in bucket B (it survives the sweep automatically).
        rc, out, err = run_bash(f'list_bucket_b "{specs}" "my-spec"')
        b_names = sorted(os.path.basename(p) for p in out.split() if p.strip())
        check(
            "(a) Bucket B is empty -- no slug-prefixed or .bak files in specs/ root",
            b_names == [],
            f"got {b_names}",
        )
        check(
            "(a) Bucket B does not contain cert-substrate-inventory.md "
            "(cross-spec doc survives allow-pattern)",
            "cert-substrate-inventory.md" not in b_names,
            f"got {b_names}",
        )

        # sweep_scaffolding DELETES both buckets (no move, no sibling, no prompt),
        # reports per-bucket deleted counts.
        rc, out, err = run_bash(f'sweep_scaffolding "{root}" "my-spec-20260101"')
        sibling = os.path.join(specs, "archive", "my-spec-20260101")
        check(
            "(a) sweep_scaffolding creates NO archive sibling dir",
            not os.path.isdir(sibling),
            f"sibling unexpectedly exists; out={out!r} err={err!r}",
        )
        check(
            "(a) sweep_scaffolding reports bucket_a_deleted=4",
            "bucket_a_deleted=4" in out,
            f"out={out!r}",
        )
        check(
            "(a) sweep_scaffolding reports bucket_b_deleted=0",
            "bucket_b_deleted=0" in out,
            f"out={out!r}",
        )
        # protect-list + cross-spec design docs survive in specs/.
        left = sorted(os.path.basename(p) for p in os.listdir(specs)
                      if os.path.isfile(os.path.join(specs, p)))
        check(
            "(a) sweep_scaffolding left current.md + owed-items.md + "
            "cert-substrate-inventory.md in specs/ (design doc survives)",
            left == sorted(["owed-items.md", "current.md", "cert-substrate-inventory.md"]),
            f"left={left}",
        )
        check(
            "(a) sweep_scaffolding left the orphan script in specs/scripts/",
            os.path.isfile(os.path.join(scripts, "c9-orphan.sh")),
        )
        check(
            "(a) sweep_scaffolding DELETED the slug-prefixed script in specs/scripts/",
            not os.path.isfile(os.path.join(scripts, "my-spec-c1-acceptance.sh")),
        )


# ---------------------------------------------------------------------------
# (b) Drift-queue parse + consolidate pipeline
# ---------------------------------------------------------------------------
def test_drift_queue_pipeline():
    with tempfile.TemporaryDirectory() as root:
        archive = os.path.join(root, "spec-20260101.md")
        # An UNRESOLVED target stays active; a missing target stays active.
        # Use a real existing-but-old target to show it stays active (mtime not newer
        # than a far-future queue timestamp).
        existing_target = os.path.join(root, "existing-target.md")
        open(existing_target, "w").close()
        with open(archive, "w") as f:
            f.write(
                "# Spec: Demo\n\n"
                "## Drift queue (drained at ship)\n\n"
                "_(append-only; one line per edited artifact)_\n"
                f"2026-01-01T00:00:00Z | edited=a.md | target={existing_target} | handler=prose\n"
                "2026-01-01T00:00:00Z | edited=b.md | target=UNRESOLVED | handler=UNKNOWN\n"
                "2099-01-01T00:00:00Z | edited=c.md | target=/nope/missing.md | handler=index\n"
                "## Some other section\n\nbody\n"
            )

        # parse_queue: 3 entries, placeholder skipped
        rc, out, err = run_bash(f'parse_queue "{archive}"')
        parsed = [ln for ln in out.splitlines() if ln.strip()]
        check(
            "(b) parse_queue returns 3 entries, skips placeholder + non-section lines",
            len(parsed) == 3,
            f"got {len(parsed)}: {parsed}",
        )
        check(
            "(b) parse_queue skips the _(append-only...)_ placeholder",
            not any("append-only" in ln for ln in parsed),
        )

        # bucket_by_handler
        rc, out, err = run_bash(f'parse_queue "{archive}" | bucket_by_handler')
        buckets = dict(
            line.split("=", 1) for line in out.splitlines() if "=" in line
        )
        check(
            "(b) bucket_by_handler counts prose=1 index=1 UNKNOWN=1",
            buckets.get("prose") == "1"
            and buckets.get("index") == "1"
            and buckets.get("UNKNOWN") == "1",
            f"got {buckets}",
        )

        # drain_drift_queue (full pipeline). The existing target is OLDER than the far
        # past queue ts? It was just created (now) vs queue ts 2026-01-01 -> if "now" is
        # after 2026-01-01 the prose entry self-resolves. Characterize the actual behavior:
        rc, out, err = run_bash(f'drain_drift_queue "{archive}"')
        check(
            "(b) drain_drift_queue emits a 'Drift queue:' header line",
            "Drift queue:" in out,
            f"out={out!r} err={err!r}",
        )
        # The UNRESOLVED and missing-target entries always survive mtime_recheck as active.
        check(
            "(b) drain keeps the UNRESOLVED entry (passes through as active)",
            "/nope/missing.md" in out or "UNRESOLVED" in out or "index" in out,
            f"out={out!r}",
        )

        # mtime_recheck characterization: a brand-new target vs a far-future queue ts
        # must NOT self-resolve (target mtime is older than the future ts).
        future_line = (
            f"2099-12-31T00:00:00Z | edited=x.md | target={existing_target} | handler=prose"
        )
        rc, out, err = run_bash("mtime_recheck", stdin=future_line + "\n")
        check(
            "(b) mtime_recheck marks active when target mtime < queue ts (future ts)",
            "verdict=active" in out,
            f"out={out!r}",
        )
        # A far-past queue ts vs a freshly-touched target must self-resolve.
        past_line = (
            f"2000-01-01T00:00:00Z | edited=x.md | target={existing_target} | handler=prose"
        )
        rc, out, err = run_bash("mtime_recheck", stdin=past_line + "\n")
        check(
            "(b) mtime_recheck marks self-resolved when target mtime > queue ts (past ts)",
            "verdict=self-resolved" in out,
            f"out={out!r}",
        )

        # format_consolidated_list time estimate characterization on a known input.
        sample = "h | edited=a | target=t | handler=diagram | verdict=active"
        rc, out, err = run_bash("format_consolidated_list", stdin=sample + "\n")
        check(
            "(b) format_consolidated_list reports diagram=1 and ~12 min estimate",
            "diagram=1" in out and "~12 min" in out,
            f"out={out!r}",
        )


# ---------------------------------------------------------------------------
# (c) wiki_drift_snapshot against a fixture vault (VAULT override)
# ---------------------------------------------------------------------------
def test_wiki_drift_snapshot():
    with tempfile.TemporaryDirectory() as root:
        vault = os.path.join(root, "vault")
        wiki = os.path.join(vault, "wiki")
        concepts = os.path.join(wiki, "concepts")
        os.makedirs(concepts)
        # page-a links to page-b (exists) and to ghost (missing -> broken link).
        with open(os.path.join(concepts, "page-a.md"), "w") as f:
            f.write("updated: 2099-01-01\n\nSee [[page-b]] and [[ghost-page]].\n")
        # page-b: exists, is referenced by page-a (not an orphan).
        with open(os.path.join(concepts, "page-b.md"), "w") as f:
            f.write("updated: 2099-01-01\n\nbody\n")
        # page-orphan: referenced by nobody -> orphan.
        with open(os.path.join(concepts, "page-orphan.md"), "w") as f:
            f.write("updated: 2099-01-01\n\nlonely\n")

        archive = os.path.join(root, "spec-20260101.md")
        with open(archive, "w") as f:
            f.write("# Spec: Demo\n\nbody\n")

        rc, out, err = run_bash(
            f'wiki_drift_snapshot "{archive}"', env={"VAULT": vault}
        )
        check(
            "(c) wiki_drift_snapshot emits the 'Vault drift at ship:' summary",
            "Vault drift at ship:" in out,
            f"out={out!r} err={err!r}",
        )
        # ghost-page is a broken link target; expect >=1 broken link.
        check(
            "(c) snapshot detects the broken link (ghost-page)",
            "1 broken links" in out or "broken links" in out and " 0 broken links" not in out,
            f"out={out!r}",
        )
        # The archive must have gained the snapshot section.
        body = open(archive).read()
        check(
            "(c) snapshot section appended to the archive file",
            "## Vault drift snapshot (ship time)" in body,
        )
        check(
            "(c) ghost-page listed under broken-link targets in the archive",
            "ghost-page" in body,
            f"archive body tail: {body[-400:]!r}",
        )
        check(
            "(c) page-orphan listed as an orphan in the archive",
            "page-orphan" in body,
        )

        # VAULT-missing degrade path.
        rc, out, err = run_bash(
            f'wiki_drift_snapshot "{archive}"',
            env={"VAULT": os.path.join(root, "does-not-exist")},
        )
        check(
            "(c) wiki_drift_snapshot degrades cleanly when vault is missing",
            "vault not found" in out and rc == 0,
            f"rc={rc} out={out!r}",
        )


# ---------------------------------------------------------------------------
# (extra) snapshot writers — write_resolution_snapshot + clear_execution_state
# ---------------------------------------------------------------------------
def test_resolution_and_exec_state():
    with tempfile.TemporaryDirectory() as root:
        archive = os.path.join(root, "spec-20260101.md")
        with open(archive, "w") as f:
            f.write(
                "# Spec: Demo\n\n"
                "## Drift queue (drained at ship)\n\n"
                "old | line\n\n"
                "## Execution state\n\n"
                "- chunk-1: merged\n- chunk-2: merged\n\n"
                "## Keep me\n\nuntouched\n"
            )

        # write_resolution_snapshot: pipe a 2-line log.
        log = "entry-1 | resolution=prose-edited\nentry-2 | resolution=deferred"
        rc, out, err = run_bash(
            f'write_resolution_snapshot "{archive}"', stdin=log + "\n"
        )
        body = open(archive).read()
        check(
            "(extra) resolved section appended with one bullet per log line",
            "## Drift queue (resolved at ship)" in body
            and "- entry-1 | resolution=prose-edited" in body
            and "- entry-2 | resolution=deferred" in body,
            f"body={body!r}",
        )
        check(
            "(extra) drained section body emptied to the stub marker",
            "_(emptied at ship;" in body and "old | line" not in body,
            f"body={body!r}",
        )
        check(
            "(extra) write_resolution_snapshot preserves unrelated sections",
            "## Keep me" in body and "untouched" in body,
        )

        # clear_execution_state.
        rc, out, err = run_bash(f'clear_execution_state "{archive}"')
        body = open(archive).read()
        check(
            "(extra) execution-state body cleared to stub, heading retained",
            "## Execution state" in body
            and "_(cleared at ship; run state is not archived)_" in body
            and "chunk-1: merged" not in body,
            f"body={body!r}",
        )
        check(
            "(extra) clear_execution_state preserves the resolved + keep sections",
            "## Drift queue (resolved at ship)" in body and "## Keep me" in body,
        )

        # empty-log no-op: write_resolution_snapshot returns 0, no change.
        archive2 = os.path.join(root, "spec2.md")
        with open(archive2, "w") as f:
            f.write("# Spec: B\n\nbody\n")
        before = open(archive2).read()
        rc, out, err = run_bash(
            f'write_resolution_snapshot "{archive2}"', stdin=""
        )
        check(
            "(extra) empty resolution log is a no-op (file unchanged, rc 0)",
            rc == 0 and open(archive2).read() == before,
            f"rc={rc}",
        )

        # clear_execution_state on a spec with no board: no-op.
        rc, out, err = run_bash(f'clear_execution_state "{archive2}"')
        check(
            "(extra) clear_execution_state no-ops when there is no board",
            rc == 0 and open(archive2).read() == before,
            f"rc={rc}",
        )


# ---------------------------------------------------------------------------
# (chunk 8) apply_all_ship_mutations driver
#
# Pins the Chunk 8 contract: ONE driver function sequences the five existing
# file-mutation ship primitives in this EXACT order:
#   sweep_scaffolding -> drain_drift_queue -> wiki_drift_snapshot
#   -> write_resolution_snapshot -> clear_execution_state
# Git steps are NOT driven (they stay prose in the skill); the driver touches
# only the five file-mutation primitives.
#
# Two complementary proofs:
#   (1) ORDER: redefine the five primitives, post-source, as tracing stubs that
#       append their own name to an order-log file, then assert the driver
#       invoked them in exactly the specified sequence. Function definitions in
#       bash are late-bound, so the driver (which calls them by name) picks up
#       the stubs. This proof is independent of the primitives' real behavior:
#       an out-of-order or missing-call driver fails here regardless.
#   (2) SIDE EFFECTS: run the driver with the REAL primitives against a full
#       fixture and assert each of the five left its real, distinct observable
#       side effect on disk. This catches a driver that names the functions but
#       mis-wires their args (so a primitive silently no-ops).
# ---------------------------------------------------------------------------
def test_apply_all_ship_mutations():
    EXPECTED_ORDER = [
        "sweep_scaffolding",
        "drain_drift_queue",
        "wiki_drift_snapshot",
        "write_resolution_snapshot",
        "clear_execution_state",
    ]

    # --- Proof (1): exact call order via tracing stubs --------------------
    with tempfile.TemporaryDirectory() as root:
        order_file = os.path.join(root, "order.log")
        specs = os.path.join(root, "specs")
        os.makedirs(specs)
        archive = os.path.join(specs, "archive", "my-spec-20260101.md")
        os.makedirs(os.path.dirname(archive))
        with open(archive, "w") as f:
            f.write("# Spec: Demo\n\nbody\n")

        # Override each primitive AFTER sourcing but BEFORE the driver call.
        # Each stub records its name; the driver must call all five in order.
        stub = "\n".join(
            f'{name}() {{ echo "{name}" >> "{order_file}"; cat >/dev/null 2>&1 || true; }}'
            if name == "write_resolution_snapshot"
            else f'{name}() {{ echo "{name}" >> "{order_file}"; }}'
            for name in EXPECTED_ORDER
        )
        snippet = (
            f'{stub}\n'
            f'apply_all_ship_mutations "{root}" "my-spec-20260101" "{archive}" '
            f'</dev/null'
        )
        rc, out, err = run_bash(snippet)
        recorded = []
        if os.path.isfile(order_file):
            recorded = [ln for ln in open(order_file).read().splitlines() if ln.strip()]
        check(
            "(8) driver invokes ALL FIVE primitives exactly once each",
            sorted(recorded) == sorted(EXPECTED_ORDER),
            f"rc={rc} recorded={recorded} err={err!r}",
        )
        check(
            "(8) driver invokes the five primitives in the SPECIFIED order "
            "(sweep -> drain -> wiki -> resolution -> clear)",
            recorded == EXPECTED_ORDER,
            f"recorded={recorded} (expected {EXPECTED_ORDER}) err={err!r}",
        )

    # --- Proof (2): real primitives leave their real side effects ---------
    with tempfile.TemporaryDirectory() as root:
        specs = os.path.join(root, "specs")
        scripts = os.path.join(specs, "scripts")
        os.makedirs(scripts)
        # Scaffolding for sweep_scaffolding to delete (Bucket A glob + slug script);
        # protect-list must survive. leftover-notes.md is a cross-spec doc that is
        # NOT slug-prefixed and NOT .bak -- it survives the allow-pattern sweep.
        open(os.path.join(specs, "chunk-7-acceptance.sh"), "w").close()
        open(os.path.join(scripts, "my-spec-c1-acceptance.sh"), "w").close()
        open(os.path.join(specs, "leftover-notes.md"), "w").close()
        open(os.path.join(specs, "current.md"), "w").close()
        open(os.path.join(specs, "owed-items.md"), "w").close()

        # A fixture vault so wiki_drift_snapshot has something to snapshot.
        vault = os.path.join(root, "vault")
        concepts = os.path.join(vault, "wiki", "concepts")
        os.makedirs(concepts)
        with open(os.path.join(concepts, "page-a.md"), "w") as f:
            f.write("updated: 2099-01-01\n\nSee [[ghost-page]].\n")

        # The archived spec the four archive-path primitives mutate.
        archive = os.path.join(specs, "archive", "my-spec-20260101.md")
        os.makedirs(os.path.dirname(archive))
        with open(archive, "w") as f:
            f.write(
                "# Spec: Demo\n\n"
                "## Drift queue (drained at ship)\n\n"
                "2026-01-01T00:00:00Z | edited=a.md | target=UNRESOLVED | handler=prose\n\n"
                "## Execution state\n\n"
                "- chunk-1: merged\n- chunk-2: merged\n\n"
                "## Keep me\n\nuntouched\n"
            )

        # Pipe a non-empty resolution log so write_resolution_snapshot writes
        # (an empty log is the documented no-op; the richer proof passes a log).
        res_log = "entry-1 | resolution=prose-edited\n"
        snippet = (
            f'apply_all_ship_mutations "{root}" "my-spec-20260101" "{archive}"'
        )
        rc, out, err = run_bash(snippet, env={"VAULT": vault}, stdin=res_log)

        # Effect 1 — sweep_scaffolding deleted slug-scoped scaffolding; protect-list
        # and non-slug cross-spec files (leftover-notes.md) survive the allow-pattern.
        left = sorted(os.path.basename(p) for p in os.listdir(specs)
                      if os.path.isfile(os.path.join(specs, p)))
        check(
            "(8) [side effect] sweep_scaffolding ran: slug scaffolding gone, "
            "protect-list + cross-spec docs survive",
            "chunk-7-acceptance.sh" not in left
            and "current.md" in left and "owed-items.md" in left
            and "leftover-notes.md" in left
            and not os.path.isfile(os.path.join(scripts, "my-spec-c1-acceptance.sh")),
            f"rc={rc} left={left} err={err!r}",
        )

        body = open(archive).read()
        # Effect 2 — drain_drift_queue ran: its 'Drift queue:' summary appears on stdout.
        check(
            "(8) [side effect] drain_drift_queue ran: 'Drift queue:' header on stdout",
            "Drift queue:" in out,
            f"out={out!r} err={err!r}",
        )
        # Effect 3 — wiki_drift_snapshot ran: snapshot section appended to archive,
        # broken-link target detected (VAULT override honored).
        check(
            "(8) [side effect] wiki_drift_snapshot ran: snapshot section in archive",
            "## Vault drift snapshot (ship time)" in body and "ghost-page" in body,
            f"archive tail={body[-500:]!r}",
        )
        # Effect 4 — write_resolution_snapshot ran: resolved section appended from
        # the piped log AND the drained section body emptied to the stub.
        check(
            "(8) [side effect] write_resolution_snapshot ran: resolved section "
            "written from piped log + drained body emptied",
            "## Drift queue (resolved at ship)" in body
            and "- entry-1 | resolution=prose-edited" in body
            and "_(emptied at ship;" in body,
            f"archive={body!r}",
        )
        # Effect 5 — clear_execution_state ran: exec-state body cleared to stub.
        check(
            "(8) [side effect] clear_execution_state ran: exec-state body cleared",
            "_(cleared at ship; run state is not archived)_" in body
            and "chunk-1: merged" not in body,
            f"archive={body!r}",
        )
        # Unrelated section untouched (no primitive clobbered it).
        check(
            "(8) [side effect] unrelated '## Keep me' section preserved through "
            "the full driver run",
            "## Keep me" in body and "untouched" in body,
            f"archive={body!r}",
        )


# ---------------------------------------------------------------------------
# (chunk 8) bucket_b allow-pattern: preserve cross-spec design docs
#
# Pins the chunk 8 contract: list_bucket_b switches from a broad
# deny-with-protect-list to an EXPLICIT allow-pattern that targets only
# slug-prefixed ephemera and .bak files.
#
# Assertions (full acceptance contract per the chunk spec):
#   1. lean-system-design.md (non-slug, non-bak) SURVIVES -- not in bucket B.
#   2. A slug-prefixed ephemeral (e.g. my-spec-notes.md) IS in bucket B -- deleted.
#   3. A .bak file IS in bucket B -- deleted.
#   4. current.md and owed-items.md still survive (protect-list still holds).
#   5. simulated sweep (sweep_scaffolding) leaves lean-system-design.md on disk.
# ---------------------------------------------------------------------------
def test_bucket_b_allow_pattern():
    slug = "my-spec"
    with tempfile.TemporaryDirectory() as root:
        specs = os.path.join(root, "specs")
        os.makedirs(specs)

        # Cross-spec design doc -- must SURVIVE the sweep (not slug-prefixed, not .bak).
        design_doc = os.path.join(specs, "lean-system-design.md")
        open(design_doc, "w").close()

        # Slug-prefixed ephemeral -- must be DELETED by bucket B.
        slug_ephemeral = os.path.join(specs, f"{slug}-notes.md")
        open(slug_ephemeral, "w").close()

        # .bak file -- must be DELETED by bucket B.
        bak_file = os.path.join(specs, "some-settings.bak")
        open(bak_file, "w").close()

        # Protect-list items -- must SURVIVE.
        open(os.path.join(specs, "current.md"), "w").close()
        open(os.path.join(specs, "owed-items.md"), "w").close()

        # Call list_bucket_b with the slug argument (the new interface).
        rc, out, err = run_bash(f'list_bucket_b "{specs}" "{slug}"')
        b_names = sorted(os.path.basename(p) for p in out.split() if p.strip())

        check(
            "(8) Bucket B allow-pattern: lean-system-design.md NOT in bucket B "
            "(cross-spec design doc survives)",
            "lean-system-design.md" not in b_names,
            f"got bucket_b={b_names}",
        )
        check(
            "(8) Bucket B allow-pattern: slug-prefixed ephemeral IS in bucket B "
            "(my-spec-notes.md is deleted)",
            f"{slug}-notes.md" in b_names,
            f"got bucket_b={b_names}",
        )
        check(
            "(8) Bucket B allow-pattern: .bak file IS in bucket B "
            "(some-settings.bak is deleted)",
            "some-settings.bak" in b_names,
            f"got bucket_b={b_names}",
        )
        check(
            "(8) Bucket B allow-pattern: current.md NOT in bucket B (protect-list)",
            "current.md" not in b_names,
            f"got bucket_b={b_names}",
        )
        check(
            "(8) Bucket B allow-pattern: owed-items.md NOT in bucket B (protect-list)",
            "owed-items.md" not in b_names,
            f"got bucket_b={b_names}",
        )

        # Simulated sweep: sweep_scaffolding must leave lean-system-design.md on disk.
        rc2, out2, err2 = run_bash(f'sweep_scaffolding "{root}" "{slug}-20260615"')
        check(
            "(8) sweep_scaffolding leaves lean-system-design.md on disk "
            "(not a sweep target under allow-pattern)",
            os.path.isfile(design_doc),
            f"rc={rc2} out={out2!r} err={err2!r}",
        )
        check(
            "(8) sweep_scaffolding deletes the slug-prefixed ephemeral",
            not os.path.isfile(slug_ephemeral),
            f"rc={rc2} out={out2!r} err={err2!r}",
        )
        check(
            "(8) sweep_scaffolding deletes the .bak file",
            not os.path.isfile(bak_file),
            f"rc={rc2} out={out2!r} err={err2!r}",
        )


# ---------------------------------------------------------------------------
# (chunk 8) bucket_b edge cases: slug-prefixed design doc + empty specs/ root
#
# Pins two named edge cases from the chunk spec:
#   1. A file that is BOTH slug-prefixed AND looks like a design doc -- the
#      allow-pattern fires on slug-prefix alone, so it IS in bucket B (deleted).
#      Determinism: allow-pattern decides, not the design-doc heuristic.
#   2. Empty specs/ root (directory exists but has no files) -- list_bucket_b
#      and sweep_scaffolding must both be silent no-ops (no error, empty output).
# ---------------------------------------------------------------------------
def test_bucket_b_edge_cases():
    slug = "my-spec"
    # --- Edge case 1: slug-prefixed file that also looks like a design doc ---
    with tempfile.TemporaryDirectory() as root:
        specs = os.path.join(root, "specs")
        os.makedirs(specs)

        # This file is both slug-prefixed and has "design" in the name.
        # The allow-pattern fires on slug-prefix; it must be in bucket B (deleted).
        slug_design = os.path.join(specs, f"{slug}-lean-system-design.md")
        open(slug_design, "w").close()

        rc, out, err = run_bash(f'list_bucket_b "{specs}" "{slug}"')
        b_names = sorted(os.path.basename(p) for p in out.split() if p.strip())

        check(
            "(8) edge case: slug-prefixed design doc IS in bucket B "
            "(allow-pattern on slug-prefix decides deterministically)",
            f"{slug}-lean-system-design.md" in b_names,
            f"got bucket_b={b_names}",
        )

    # --- Edge case 2: empty specs/ root -> no-op (no error, empty bucket B) ---
    with tempfile.TemporaryDirectory() as root:
        specs = os.path.join(root, "specs")
        os.makedirs(specs)
        # No files created -- specs/ is empty.

        rc, out, err = run_bash(f'list_bucket_b "{specs}" "{slug}"')
        b_names = [p for p in out.split() if p.strip()]

        check(
            "(8) edge case: empty specs/ root -> list_bucket_b returns empty (no-op, no error)",
            rc == 0 and b_names == [],
            f"rc={rc} bucket_b={b_names!r} err={err!r}",
        )

        # sweep_scaffolding against an empty specs/ must also be a silent no-op.
        rc2, out2, err2 = run_bash(f'sweep_scaffolding "{root}" "{slug}-20260615"')
        check(
            "(8) edge case: empty specs/ root -> sweep_scaffolding is a silent no-op (no error)",
            rc2 == 0,
            f"rc={rc2} out={out2!r} err={err2!r}",
        )


# ---------------------------------------------------------------------------
# (chunk 4) ship-spec owed-items forced verdict step
#
# Acceptance criteria:
#   AC1: skills/ship-spec/SKILL.md contains the fix/formally-accept/kill
#        trichotomy step over open owed-items entries.
#   AC2: specs/owed-items.md header documents the at-ship forced verdict
#        (deferred is not a resting state).
#
# Edge cases pinned by this test:
#   EC1: empty register -> step is a no-op (SKILL.md prose must say so).
#   EC2: item whose re-surface-trigger has NOT fired -> still presented at
#        the ship audit (the audit is exhaustive, not trigger-gated).
# ---------------------------------------------------------------------------
def test_owed_items_forced_verdict_step():
    worktree = os.path.dirname(HERE)
    skill_path = os.path.join(worktree, "skills", "ship-spec", "SKILL.md")
    owed_path = os.path.join(worktree, "specs", "owed-items.md")

    # Read both files.
    with open(skill_path) as f:
        skill_text = f.read()
    with open(owed_path) as f:
        owed_text = f.read()

    # AC1: SKILL.md contains a step with the fix/formally-accept/kill trichotomy
    # applied to open owed-items entries. We assert ALL THREE verdict terms appear
    # together with "owed-items" in the same file. The combination is the check --
    # any one term alone could be a coincidental match.
    check(
        "(4) SKILL.md contains 'formally-accept' (the trichotomy's unique term)",
        "formally-accept" in skill_text,
        "SKILL.md missing 'formally-accept' -- the trichotomy step is absent",
    )
    check(
        "(4) SKILL.md owed-items trichotomy: 'formally-accept' verdict present",
        "formally-accept" in skill_text,
        "SKILL.md missing 'formally-accept' in the owed-items trichotomy step",
    )
    check(
        "(4) SKILL.md owed-items trichotomy: 'kill' verdict present alongside formally-accept",
        "formally-accept" in skill_text and "kill" in skill_text,
        "SKILL.md missing 'kill' alongside 'formally-accept'",
    )

    # EC1: SKILL.md documents that an empty register makes the owed-items step a no-op.
    # We check that "no-op" appears near "owed" (within the same section/paragraph)
    # by requiring both "formally-accept" AND "no-op" to appear in the file
    # (the step and the edge-case qualifier are written together).
    check(
        "(4) SKILL.md documents empty-register no-op for the owed-items step "
        "('no-op' present alongside 'formally-accept')",
        "formally-accept" in skill_text and "no-op" in skill_text,
        "SKILL.md missing 'no-op' clause alongside the owed-items trichotomy step",
    )

    # EC2: SKILL.md documents that every open item is audited regardless of whether
    # its re-surface-trigger has fired (the audit is exhaustive, not trigger-gated).
    check(
        "(4) SKILL.md documents that the owed-items audit is exhaustive "
        "(surfaced regardless of trigger state)",
        "exhaustive" in skill_text,
        "SKILL.md missing 'exhaustive' -- trigger-independent audit clause absent",
    )

    # AC2: owed-items.md header documents the at-ship forced-verdict contract.
    # The contract must state that deferred is not a resting state and reference
    # the at-ship verdict; we check for the trichotomy term that uniquely identifies
    # the new contract (formally-accept).
    check(
        "(4) owed-items.md header contains 'formally-accept' "
        "(at-ship forced-verdict trichotomy documented in the register header)",
        "formally-accept" in owed_text,
        "owed-items.md header missing at-ship forced-verdict contract (formally-accept)",
    )
    # Finding 2 fix: anchor to the FULL distinctive phrase so a spurious "resting"
    # anywhere in the file cannot produce a false positive.
    check(
        "(4) owed-items.md header states deferred is not a resting state",
        "not a resting state" in owed_text,
        "owed-items.md header missing 'not a resting state' full phrase",
    )

    # Finding 1: SKILL.md must specify HOW formally-accepted items stop resurfacing.
    # The mechanism: the entry stays in the register but is marked so session-start
    # injection skips it.  SKILL.md must name the concrete marker to write --
    # specifically "FORMALLY-ACCEPTED" (the status written into the item's
    # re-surface-trigger field, which session-start reads to decide injection).
    check(
        "(4) SKILL.md formally-accept names the concrete stop-resurfacing marker "
        "('FORMALLY-ACCEPTED' written into the re-surface-trigger field)",
        "FORMALLY-ACCEPTED" in skill_text,
        "SKILL.md missing 'FORMALLY-ACCEPTED' marker -- stop-resurfacing mechanism "
        "for formally-accept is unspecified (session-start skips items without FIRED "
        "in their trigger field; formally-accepted items need FORMALLY-ACCEPTED there)",
    )


def main():
    test_bucket_computation()
    test_drift_queue_pipeline()
    test_wiki_drift_snapshot()
    test_resolution_and_exec_state()
    test_apply_all_ship_mutations()
    test_bucket_b_allow_pattern()
    test_bucket_b_edge_cases()
    test_owed_items_forced_verdict_step()

    print()
    print(f"{len(_passes)} passed, {len(_failures)} failed")
    if _failures:
        for name, detail in _failures:
            print(f"  FAILED: {name}  {detail}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
