#!/usr/bin/env python3
"""RED-stage acceptance test for scripts/schedule-lints.sh (chunk 7).

Chunk 7 contract: a new scripts/schedule-lints.sh that, when run with --print
(a headless dry-run), emits the EXACT schedule command + cadence the cockpit
would hand to the CC-native `schedule` skill (CronCreate) to register a weekly
off-hours routine running BOTH wiki-lint and skill-lint, surfacing both reports.
The dry-run prints the command WITHOUT registering a real cron (registration is
a global side effect the cockpit performs live, never the worker).

This test pins the FULL acceptance contract; an implementation that only nails
"it prints something" or only one lint cannot pass:

  AC1  --print describes the correct WEEKLY Sunday-9pm-ET routine that runs
       wiki-lint AND skill-lint:
         (1a) cron cadence == Sun 21:00 ET   (0 21 * * 0  or  0 21 * * SUN)
         (1b) timezone is Eastern            (ET / America/New_York)
         (1c) a human-readable weekly Sunday 9pm cadence appears
         (1d) wiki-lint is invoked
         (1e) skill-lint is invoked
  AC2  --print emits the schedule command + both lint invocations with NO side
       effects, exit 0:
         (2a) exit code 0
         (2b) output names the `schedule` mechanism / cron command to register
         (2c) output marks itself a dry-run (not registered)
         (2d) running --print in an empty temp cwd creates NO files (no side
              effect) and does not shell out to a CronCreate executable
  AC3  the script is shellcheck-clean (run if shellcheck is on PATH; otherwise
       the assertion is recorded as a SKIPPED gap, never silently dropped).

stdlib only. Run: python3 scripts/schedule_lints_test.py
(exit 0 = all pass, nonzero = any fail).
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "schedule-lints.sh")

_failures = []
_passes = []
_skips = []


def check(name, cond, detail=""):
    if cond:
        _passes.append(name)
        print(f"PASS  {name}")
    else:
        _failures.append((name, detail))
        print(f"FAIL  {name}  {detail}")


def skip(name, detail=""):
    _skips.append((name, detail))
    print(f"SKIP  {name}  {detail}")


def run_print(cwd=None):
    """Invoke `bash scripts/schedule-lints.sh --print` and capture result."""
    proc = subprocess.run(
        ["bash", SCRIPT, "--print"],
        capture_output=True,
        text=True,
        cwd=cwd,
    )
    return proc.returncode, proc.stdout, proc.stderr


# ---------------------------------------------------------------------------
# AC1 — correct weekly Sunday-9pm-ET routine running BOTH lints
# ---------------------------------------------------------------------------
def test_cadence_and_both_lints():
    rc, out, err = run_print()
    low = out.lower()

    # (1a) cron expression for Sunday 21:00: minute=0 hour=21 dom=* mon=* dow=0|SUN.
    cron_re = re.compile(r"\b0\s+21\s+\*\s+\*\s+(?:0|7|sun|SUN)\b")
    check(
        "AC1a --print emits cron cadence for Sunday 21:00 (0 21 * * 0 / SUN)",
        bool(cron_re.search(out)),
        f"no 'Sun 21:00' cron expr in output; got:\n{out!r}\nstderr={err!r}",
    )

    # (1b) Eastern timezone explicit (ET label or IANA America/New_York).
    check(
        "AC1b --print declares Eastern timezone (ET / America/New_York)",
        ("america/new_york" in low) or re.search(r"\bet\b", low) is not None
        or "eastern" in low,
        f"no ET/America-New_York timezone marker; got:\n{out!r}",
    )

    # (1c) human-readable weekly Sunday 9pm cadence.
    check(
        "AC1c --print states a weekly Sunday 9pm cadence in words",
        ("weekly" in low) and ("sunday" in low or "sun" in low)
        and ("9pm" in low or "9 pm" in low or "21:00" in out or "9:00 pm" in low),
        f"no human-readable 'weekly Sunday 9pm' cadence; got:\n{out!r}",
    )

    # (1d) wiki-lint invoked.
    check(
        "AC1d --print includes a wiki-lint invocation",
        "wiki-lint" in low or "wiki_lint" in low,
        f"no wiki-lint invocation; got:\n{out!r}",
    )

    # (1e) skill-lint invoked.
    check(
        "AC1e --print includes a skill-lint invocation",
        "skill-lint" in low or "skill_lint" in low,
        f"no skill-lint invocation; got:\n{out!r}",
    )

    # (1f) BOTH lints run UNCONDITIONALLY. The routine's contract is that both
    # lints run and both reports surface regardless of either's exit. `&&` would
    # short-circuit (skip /skill-lint if /wiki-lint exits non-zero); a sequential
    # separator (`;`) runs both regardless. Assert no `&&` joins the two lints AND
    # a `;` separator is present.
    check(
        "AC1f --print joins the two lints unconditionally (no && short-circuit)",
        ("wiki-lint && /skill-lint" not in out)
        and ("wiki-lint && skill-lint" not in out)
        and (";" in out),
        f"lints not joined unconditionally (found && short-circuit or no ; "
        f"separator); got:\n{out!r}",
    )


# ---------------------------------------------------------------------------
# AC2 — dry-run emits the schedule command, exit 0, no side effects
# ---------------------------------------------------------------------------
def test_dryrun_exit0_and_names_schedule_command():
    rc, out, err = run_print()
    low = out.lower()

    # (2a) exit 0.
    check(
        "AC2a --print exits 0",
        rc == 0,
        f"rc={rc} stderr={err!r}",
    )

    # (2b) the schedule mechanism / command the cockpit registers is named, so the
    # printed text is an actionable registration command, not just a description.
    check(
        "AC2b --print names the schedule mechanism / cron command to register",
        "schedule" in low or "cron" in low,
        f"output does not name the schedule/cron registration mechanism; got:\n{out!r}",
    )

    # (2c) dry-run is marked as not-registered (no live CronCreate happened).
    check(
        "AC2c --print marks itself a dry-run / not-registered",
        ("dry-run" in low) or ("dry run" in low) or ("not registered" in low)
        or ("would register" in low) or ("print" in low and "no side" in low),
        f"output does not flag itself as a non-registering dry-run; got:\n{out!r}",
    )


def test_dryrun_has_no_side_effects():
    """--print must not write files or shell out to a real CronCreate executable.

    Run in an empty temp cwd; assert the directory is still empty afterward and
    the run succeeded. A live-registration attempt would either error (no such
    executable) or, worse, mutate global cron state — neither is acceptable for
    the worker-side dry-run.
    """
    with tempfile.TemporaryDirectory() as tmp:
        before = set(os.listdir(tmp))
        rc, out, err = run_print(cwd=tmp)
        after = set(os.listdir(tmp))

        check(
            "AC2d-i --print creates no files in cwd (no side effect)",
            before == after,
            f"cwd changed: new entries {after - before}; stderr={err!r}",
        )
        check(
            "AC2d-ii --print does not error out attempting live registration",
            rc == 0,
            f"rc={rc} stderr={err!r}",
        )


# ---------------------------------------------------------------------------
# AC3 — shellcheck-clean (run if shellcheck present; else recorded SKIP gap)
# ---------------------------------------------------------------------------
def test_shellcheck_clean():
    sc = shutil.which("shellcheck")
    if not sc:
        skip(
            "AC3 shellcheck-clean",
            "shellcheck not on PATH in this worktree; cockpit/implementer must "
            "run `shellcheck scripts/schedule-lints.sh` -> clean. Gap recorded, "
            "not silently dropped.",
        )
        return
    proc = subprocess.run([sc, SCRIPT], capture_output=True, text=True)
    check(
        "AC3 scripts/schedule-lints.sh is shellcheck-clean",
        proc.returncode == 0,
        f"shellcheck findings:\n{proc.stdout}\n{proc.stderr}",
    )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def main():
    print("=" * 64)
    print(f"schedule-lints acceptance test  (script: {SCRIPT})")
    print("=" * 64)

    if not os.path.exists(SCRIPT):
        print(f"\nNOTE: {SCRIPT} does not exist yet (expected at RED stage).")

    test_cadence_and_both_lints()
    test_dryrun_exit0_and_names_schedule_command()
    test_dryrun_has_no_side_effects()
    test_shellcheck_clean()

    print()
    print(
        f"{len(_passes)} passed, {len(_failures)} failed, "
        f"{len(_skips)} skipped "
        f"({len(_passes) + len(_failures) + len(_skips)} total)"
    )
    if _failures:
        print("\nFailed:")
        for name, detail in _failures:
            print(f"  FAIL  {name}  {detail}")
    sys.exit(1 if _failures else 0)


if __name__ == "__main__":
    main()
