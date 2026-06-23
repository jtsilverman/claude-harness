#!/usr/bin/env python3
"""RED test for chunk 8 -- scripts/runlog.sh + progress-logging wiring.

This is the FAILING test the implementer drives GREEN. It pins the FULL chunk-8
contract (all three acceptance criteria), not just the first:

  Criterion 1 -- runlog unit behavior:
      scripts/runlog.sh exists and defines a `runlog <logfile> <message>` shell
      function that (a) writes a line carrying an ISO8601 timestamp prefix
      (^YYYY-MM-DDTHH:MM:SS, timezone-suffix-agnostic so BSD `date -Iseconds`
      and GNU `date` both match) and the message body, and (b) APPENDS -- a
      second call leaves the first line intact (2 lines, not 1 overwritten).

  Criterion 2 -- each wired script logs on a REAL run:
      every pipeline-critical script, invoked via its real entry point with its
      logfile redirected to a temp path via a per-script env var, appends at
      least one timestamped progress line to that logfile. Covered for both
      script classes: the python helpers (demo_detect.py, runnable_set.py,
      exec_state.py, merge_engine.py, cockpit_sidecar.py) and the bash script
      (codex-review.sh).

  Criterion 3 -- ZERO behavior change:
      the six named helper functions (parse_execution_state, runnable_set,
      mergeable_set, merge_chunk_branch, resume_plan, due_milestones) return
      IDENTICAL results with logging wired in as a clean script would have
      returned -- the log is a pure side channel. Asserted by computing each
      function's result against a known fixture and checking it equals the
      independently hand-derived expected value (NOT a round-trip through the
      function under test), while a logfile env var is set so logging is active.

No external deps; stdlib only (same shape as recall_test.py). Each python helper
is exercised in a fresh subprocess so its module-import-time logging (if any)
and per-call logging are both observed; the bash function is sourced and run in
a bash subprocess. The logfile path is injected per script via an env var named
`<SCRIPT>_RUNLOG` (e.g. RUNNABLE_SET_RUNLOG) -- the documented monitor seam the
`tail -f` path watches. If the implementer chooses different env var names the
contract is the same (a per-script redirectable logfile); update the NAMES map
below to match, but the asserted BEHAVIOR (a timestamped append on a real run,
zero return-value change) is the spec and must not move.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RUNLOG_SH = os.path.join(HERE, "runlog.sh")

# ISO8601 prefix: YYYY-MM-DDTHH:MM:SS , timezone suffix (offset or Z) NOT
# asserted -- BSD `date -Iseconds` emits ...-04:00, GNU emits ...+0000.
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")

# Per-script logfile env var the wired script honors (the redirectable monitor
# seam). One per wired script; the documented `tail -f` target.
RUNLOG_ENV = {
    "runnable_set": "RUNNABLE_SET_RUNLOG",
    "exec_state": "EXEC_STATE_RUNLOG",
    "merge_engine": "MERGE_ENGINE_RUNLOG",
    "cockpit_sidecar": "COCKPIT_SIDECAR_RUNLOG",
    "demo_detect": "DEMO_DETECT_RUNLOG",
    "codex_review": "CODEX_REVIEW_RUNLOG",
}

_failures = []
_passes = []


def check(name, cond, detail=""):
    if cond:
        _passes.append(name)
        print(f"PASS  {name}")
    else:
        _failures.append((name, detail))
        print(f"FAIL  {name}  {detail}")


def run_bash(snippet, env=None, cwd=None):
    """Source runlog.sh, then run the snippet in bash. Return (rc, stdout, stderr)."""
    full = f'source "{RUNLOG_SH}"\n{snippet}\n'
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    proc = subprocess.run(
        ["bash", "-c", full],
        capture_output=True, text=True, env=full_env, cwd=cwd,
    )
    return proc.returncode, proc.stdout, proc.stderr


def run_py(script, args, stdin_text="", env=None, cwd=None):
    """Run a scripts/<script>.py via its CLI in a subprocess.
    Return (rc, stdout, stderr)."""
    full_env = dict(os.environ)
    # Make `from runnable_set import ...` etc. resolve regardless of cwd.
    full_env["PYTHONPATH"] = HERE + os.pathsep + full_env.get("PYTHONPATH", "")
    if env:
        full_env.update(env)
    proc = subprocess.run(
        [sys.executable, os.path.join(HERE, f"{script}.py"), *args],
        input=stdin_text, capture_output=True, text=True,
        env=full_env, cwd=cwd,
    )
    return proc.returncode, proc.stdout, proc.stderr


def logfile_lines(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [ln for ln in f.read().splitlines() if ln.strip()]


def assert_timestamped_append(prefix, path):
    """A wired-script logfile assertion: file exists, has >=1 line, and every
    non-empty line carries an ISO8601 timestamp prefix."""
    lines = logfile_lines(path)
    check(
        f"{prefix}: logfile got >=1 progress line on a real run",
        len(lines) >= 1,
        f"path={path} lines={lines!r}",
    )
    if lines:
        check(
            f"{prefix}: every logfile line carries an ISO8601 timestamp prefix",
            all(TS_RE.match(ln) for ln in lines),
            f"lines={lines!r}",
        )


# ---------------------------------------------------------------------------
# Criterion 1 -- runlog unit: timestamp format + APPEND (not overwrite)
# ---------------------------------------------------------------------------
def test_runlog_unit():
    check("(1) runlog.sh exists", os.path.exists(RUNLOG_SH), f"missing {RUNLOG_SH}")

    with tempfile.TemporaryDirectory() as d:
        log = os.path.join(d, "test.log")

        rc, out, err = run_bash(f'runlog "{log}" "first message"')
        check("(1) runlog exits 0 on first call", rc == 0, f"rc={rc} err={err!r}")

        lines = logfile_lines(log)
        check(
            "(1) runlog wrote exactly one line on first call",
            len(lines) == 1,
            f"lines={lines!r}",
        )
        if lines:
            check(
                "(1) the line carries an ISO8601 timestamp prefix",
                bool(TS_RE.match(lines[0])),
                f"line={lines[0]!r}",
            )
            check(
                "(1) the line contains the message body",
                "first message" in lines[0],
                f"line={lines[0]!r}",
            )

        # Second call: APPEND, not overwrite -- the first line must survive.
        rc, out, err = run_bash(f'runlog "{log}" "second message"')
        check("(1) runlog exits 0 on second call", rc == 0, f"rc={rc} err={err!r}")
        lines = logfile_lines(log)
        check(
            "(1) runlog APPENDS (two lines after two calls, not one overwritten)",
            len(lines) == 2,
            f"lines={lines!r}",
        )
        if len(lines) == 2:
            check(
                "(1) the first message is still present after the second call",
                "first message" in lines[0],
                f"lines={lines!r}",
            )
            check(
                "(1) the second message is present and timestamped",
                "second message" in lines[1] and bool(TS_RE.match(lines[1])),
                f"lines={lines!r}",
            )


# ---------------------------------------------------------------------------
# Criterion 1 (cont.) -- runlog creates the parent dir when absent.
# The header documents "Creates the file (and parent dirs) if absent", but a bare
# `printf >> logfile` FAILS when the parent directory does not exist. runlog must
# be best-effort robust: create the parent dir, then append -- so a logfile under
# a not-yet-existing directory still gets its line and the call exits 0.
# ---------------------------------------------------------------------------
def test_runlog_creates_missing_parent_dir():
    with tempfile.TemporaryDirectory() as d:
        # A logfile two levels deep under dirs that do NOT exist yet.
        log = os.path.join(d, "nested", "deeper", "test.log")
        check(
            "(1) parent dir does not exist before the runlog call",
            not os.path.exists(os.path.dirname(log)),
            f"unexpected pre-existing dir {os.path.dirname(log)!r}",
        )

        rc, out, err = run_bash(f'runlog "{log}" "into a missing dir"')
        check(
            "(1) runlog exits 0 even when the parent dir is absent",
            rc == 0,
            f"rc={rc} err={err!r}",
        )

        lines = logfile_lines(log)
        check(
            "(1) runlog created the missing parent dir and wrote the line",
            len(lines) == 1,
            f"path={log} lines={lines!r}",
        )
        if lines:
            check(
                "(1) the line written into the new dir is timestamped and carries the message",
                bool(TS_RE.match(lines[0])) and "into a missing dir" in lines[0],
                f"line={lines[0]!r}",
            )


# ---------------------------------------------------------------------------
# Criterion 2 -- each wired script appends a timestamped progress line on a real
# run, AND Criterion 3 -- the helper returns the SAME result with logging active.
# Each helper has an independently hand-derived expected value (not a round-trip).
# ---------------------------------------------------------------------------
def test_runnable_set_logs_and_unchanged():
    # Board: chunk "2" pending no deps -> launchable; "3" depends on unmerged "1"
    # -> blocked; "1" already merged. Hand-derived launchable set = ["2"].
    board = [
        {"id": "1", "depends_on": [], "touches": ["a.py"], "status": "merged"},
        {"id": "2", "depends_on": [], "touches": ["b.py"], "status": "pending"},
        {"id": "3", "depends_on": ["9"], "touches": ["c.py"], "status": "pending"},
    ]
    with tempfile.TemporaryDirectory() as d:
        log = os.path.join(d, "runnable.log")
        rc, out, err = run_py(
            "runnable_set", [], stdin_text=json.dumps(board),
            env={RUNLOG_ENV["runnable_set"]: log},
        )
        check("(3) runnable_set exits 0", rc == 0, f"rc={rc} err={err!r}")
        check(
            "(3) runnable_set returns the SAME launchable set with logging active",
            out.strip() == json.dumps(["2"]),
            f"out={out!r} expected={json.dumps(['2'])!r}",
        )
        assert_timestamped_append("(2) runnable_set", log)


def test_exec_state_parse_logs_and_unchanged():
    spec = (
        "# Spec\n\n## Execution state\n\n"
        "- 1: merged\n- 2: building\n- 3: pending\n\n"
        "## Next section\n\nbody\n"
    )
    # Hand-derived board (document order, statuses verbatim).
    expected = [
        {"id": "1", "status": "merged"},
        {"id": "2", "status": "building"},
        {"id": "3", "status": "pending"},
    ]
    with tempfile.TemporaryDirectory() as d:
        log = os.path.join(d, "exec_state.log")
        rc, out, err = run_py(
            "exec_state", ["parse"], stdin_text=spec,
            env={RUNLOG_ENV["exec_state"]: log},
        )
        check("(3) exec_state parse exits 0", rc == 0, f"rc={rc} err={err!r}")
        check(
            "(3) parse_execution_state returns the SAME board with logging active",
            json.loads(out) == expected,
            f"out={out!r} expected={expected!r}",
        )
        assert_timestamped_append("(2) exec_state", log)


def test_merge_engine_mergeable_logs_and_unchanged():
    # Approved chunk "2" with its dep "1" merged -> mergeable; approved "3" whose
    # dep "9" is not merged -> not mergeable. Hand-derived mergeable set = ["2"].
    board = [
        {"id": "1", "depends_on": [], "status": "merged"},
        {"id": "2", "depends_on": ["1"], "status": "approved"},
        {"id": "3", "depends_on": ["9"], "status": "approved"},
    ]
    with tempfile.TemporaryDirectory() as d:
        log = os.path.join(d, "merge_engine.log")
        rc, out, err = run_py(
            "merge_engine", ["mergeable"], stdin_text=json.dumps(board),
            env={RUNLOG_ENV["merge_engine"]: log},
        )
        check("(3) merge_engine mergeable exits 0", rc == 0, f"rc={rc} err={err!r}")
        check(
            "(3) mergeable_set returns the SAME set with logging active",
            out.strip() == json.dumps(["2"]),
            f"out={out!r} expected={json.dumps(['2'])!r}",
        )
        assert_timestamped_append("(2) merge_engine", log)


def test_merge_engine_merge_chunk_branch_logs_and_unchanged():
    """The irreversible merge core: a real git fixture, a clean ff-merge. The
    return envelope must be unchanged (merged True/conflict False, sha = new
    feature HEAD) AND merge_chunk_branch must append a timestamped log line --
    log lines only, zero control-flow change (the chunk's CRITICAL caveat)."""
    with tempfile.TemporaryDirectory() as repo:
        def git(*args):
            return subprocess.run(
                ["git", "-C", repo, *args], capture_output=True, text=True
            )
        git("init", "-b", "main")
        git("config", "user.email", "t@t.com")
        git("config", "user.name", "T")
        with open(os.path.join(repo, "base.txt"), "w") as f:
            f.write("base\n")
        git("add", "."); git("commit", "-m", "base")
        git("checkout", "-b", "feature")
        # A disjoint chunk branch off feature.
        git("checkout", "-b", "chunk")
        with open(os.path.join(repo, "chunk.txt"), "w") as f:
            f.write("chunk work\n")
        git("add", "."); git("commit", "-m", "chunk commit")
        git("checkout", "feature")

        log = os.path.join(repo, "merge_engine_call.log")
        # Drive merge_chunk_branch via an inline runner so we get the real return
        # envelope; logging redirected via the env var.
        runner = (
            "import json, sys; "
            "import merge_engine as m; "
            "print(json.dumps(m.merge_chunk_branch(sys.argv[1], 'feature', 'chunk')))"
        )
        env = dict(os.environ)
        env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
        env[RUNLOG_ENV["merge_engine"]] = log
        proc = subprocess.run(
            [sys.executable, "-c", runner, repo],
            capture_output=True, text=True, env=env,
        )
        check(
            "(3) merge_chunk_branch ran without raising",
            proc.returncode == 0,
            f"rc={proc.returncode} err={proc.stderr!r}",
        )
        result = None
        try:
            result = json.loads(proc.stdout.strip())
        except Exception as e:
            check("(3) merge_chunk_branch returned parseable JSON envelope",
                  False, f"stdout={proc.stdout!r} err={e}")
        if result is not None:
            # Independently verify the merge actually fast-forwarded.
            head = git("rev-parse", "feature").stdout.strip()
            check(
                "(3) merge_chunk_branch envelope is unchanged: merged True, "
                "conflict False, sha == new feature HEAD",
                result.get("merged") is True
                and result.get("conflict") is False
                and result.get("sha") == head
                and result.get("branch") == "chunk",
                f"result={result!r} head={head!r}",
            )
            # The merge really happened: chunk.txt is now on feature.
            check(
                "(3) merge_chunk_branch actually merged (chunk.txt present on feature)",
                os.path.exists(os.path.join(repo, "chunk.txt")),
                f"repo contents={os.listdir(repo)!r}",
            )
        assert_timestamped_append("(2) merge_engine.merge_chunk_branch", log)


def test_cockpit_sidecar_resume_plan_logs_and_unchanged():
    board = [
        {"id": "1", "status": "merged"},
        {"id": "2", "status": "pending"},
        {"id": "3", "status": "approved"},
    ]
    sidecar = {}
    with tempfile.TemporaryDirectory() as d:
        sc_path = os.path.join(d, "sidecar.json")
        with open(sc_path, "w") as f:
            json.dump(sidecar, f)
        log = os.path.join(d, "cockpit_sidecar.log")
        rc, out, err = run_py(
            "cockpit_sidecar", ["resume-plan", sc_path],
            stdin_text=json.dumps(board),
            env={RUNLOG_ENV["cockpit_sidecar"]: log},
        )
        check("(3) cockpit_sidecar resume-plan exits 0", rc == 0, f"rc={rc} err={err!r}")
        plan = json.loads(out)
        # Hand-derived: merged->done, pending->tick, approved->merge.
        check(
            "(3) resume_plan buckets are unchanged with logging active",
            plan.get("done") == ["1"]
            and plan.get("tick") == ["2"]
            and plan.get("merge") == ["3"],
            f"plan={plan!r}",
        )
        assert_timestamped_append("(2) cockpit_sidecar", log)


def test_demo_detect_due_milestones_logs_and_unchanged():
    # Bullet-form demo plan: M1 trigger 1,2 ; both merged -> due. M2 trigger 3 ;
    # 3 not merged -> not due. Hand-derived due = [M1].
    spec = (
        "# Spec\n\n## Execution state\n\n"
        "- 1: merged\n- 2: merged\n- 3: pending\n\n"
        "## CEO demo plan\n\n"
        "- **M1** | trigger: 1, 2 | what+how: x | shows: y | show-and-tell\n"
        "- **M2** | trigger: 3 | what+how: x | shows: y | show-and-tell\n\n"
        "## End\n\nbody\n"
    )
    expected = [{"id": "M1", "triggers": ["1", "2"], "fork": "show-and-tell"}]
    with tempfile.TemporaryDirectory() as d:
        log = os.path.join(d, "demo_detect.log")
        # demo_detect.py has no documented CLI in the file read; drive the pure
        # function via an inline runner so the assertion targets the real
        # due_milestones return value. fired_ids = [] (nothing fired yet).
        runner = (
            "import json, sys; import demo_detect as dd; "
            "print(json.dumps(dd.due_milestones(sys.stdin.read(), set())))"
        )
        env = dict(os.environ)
        env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
        env[RUNLOG_ENV["demo_detect"]] = log
        proc = subprocess.run(
            [sys.executable, "-c", runner],
            input=spec, capture_output=True, text=True, env=env,
        )
        check("(3) demo_detect due_milestones ran", proc.returncode == 0,
              f"rc={proc.returncode} err={proc.stderr!r}")
        if proc.returncode == 0:
            check(
                "(3) due_milestones returns the SAME due list with logging active",
                json.loads(proc.stdout) == expected,
                f"out={proc.stdout!r} expected={expected!r}",
            )
        assert_timestamped_append("(2) demo_detect", log)


def test_codex_review_bash_logs_on_real_run():
    """The bash script class. codex-review.sh, invoked directly with no `codex`
    CLI on PATH, still appends a startup progress line to its logfile before it
    bails -- the wiring is log lines only and fires on a real invocation.
    parse_review's pure output is unchanged (CLEAN on empty findings)."""
    script = os.path.join(HERE, "codex-review.sh")
    bash_bin = "/bin/bash"
    with tempfile.TemporaryDirectory() as d:
        log = os.path.join(d, "codex_review.log")
        # Build an isolated bin/ that has the interpreters the script needs
        # (bash, sh, git, the tools in its body) but DELIBERATELY no `codex`, so
        # the script's `command -v codex` fails and it exits early (rc 3) WITHOUT
        # firing a real -- networked, costly -- codex review, but AFTER it has
        # logged its startup line. This is how we exercise the bash class on a
        # real run without invoking codex.
        fake_bin = os.path.join(d, "bin")
        os.makedirs(fake_bin)
        for tool in ("bash", "sh", "git", "grep", "sed", "awk", "cat",
                     "printf", "env", "dirname", "basename"):
            real = subprocess.run(
                ["/usr/bin/which", tool], capture_output=True, text=True
            ).stdout.strip()
            if real:
                os.symlink(real, os.path.join(fake_bin, tool))
        env = dict(os.environ)
        env[RUNLOG_ENV["codex_review"]] = log
        env["PATH"] = fake_bin  # no `codex` here -> early exit after logging
        proc = subprocess.run(
            [bash_bin, script, "--uncommitted", "--tier", "B"],
            capture_output=True, text=True, env=env,
        )
        # The exact exit code is the script's existing contract (3 = codex not
        # found); we don't pin it here, only that a progress line was logged.
        assert_timestamped_append("(2) codex-review.sh", log)

        # Criterion 3 for the bash unit: parse_review (defined in codex-review.sh,
        # NOT runlog.sh) still emits CLEAN on input with no [P<n>] findings --
        # logging must not alter its parse output. Source codex-review.sh directly.
        full = (
            f'source "{script}"\n'
            'printf "%s\\n" "some prose, no findings" | parse_review\n'
        )
        cr_env = dict(os.environ)
        cr_env[RUNLOG_ENV["codex_review"]] = log
        cr = subprocess.run(
            [bash_bin, "-c", full], capture_output=True, text=True, env=cr_env
        )
        check(
            "(3) parse_review still returns CLEAN on no-findings input",
            cr.stdout.strip() == "RESULT: CLEAN",
            f"out={cr.stdout!r} err={cr.stderr!r}",
        )


def main():
    test_runlog_unit()
    test_runlog_creates_missing_parent_dir()
    test_runnable_set_logs_and_unchanged()
    test_exec_state_parse_logs_and_unchanged()
    test_merge_engine_mergeable_logs_and_unchanged()
    test_merge_engine_merge_chunk_branch_logs_and_unchanged()
    test_cockpit_sidecar_resume_plan_logs_and_unchanged()
    test_demo_detect_due_milestones_logs_and_unchanged()
    test_codex_review_bash_logs_on_real_run()

    print()
    print(f"{len(_passes)} passed, {len(_failures)} failed")
    if _failures:
        for name, detail in _failures:
            print(f"  FAILED: {name}  {detail}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
