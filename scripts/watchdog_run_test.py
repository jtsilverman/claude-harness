"""
Tests for scripts/watchdog_run.py

Invocation shape: watchdog_run.py <statedir> <cmdfile>
  - reads command from <cmdfile>
  - runs it via bash -c
  - tees stdout+stderr byte-identical through to real fds
  - writes <statedir>/<taskid>.json with:
      start:  {pid, command, start_ts, last_output_ts, state:"running", exit_code:null}
      finish: {state:"exited"|"signaled", exit_code:<int>, last_output_ts:<float>}
  - re-exits with child's exact exit code

Acceptance criteria pinned here:
  AC1  echo hi -> stdout "hi", exit 0, status state=exited exit_code=0
  AC2  sh -c 'exit 7' -> process exits 7, status exit_code=7
  AC3  a command emitting output -> last_output_ts > start_ts
  AC4  stdout+stderr byte-identical to unwrapped run
  AC5  (edge) child killed by signal -> state=signaled, exit_code=128+signo
  AC6  (edge) zero-output command -> last_output_ts == start_ts
  AC7  (edge) statedir absent -> created automatically
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest

WATCHDOG = os.path.join(os.path.dirname(__file__), "watchdog_run.py")


def _run(statedir: str, cmd: str, *, capture_output=True, timeout=10):
    """Write cmd to a tempfile and invoke watchdog_run.py; return CompletedProcess."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".cmd", delete=False) as f:
        f.write(cmd)
        cmdfile = f.name
    try:
        return subprocess.run(
            [sys.executable, WATCHDOG, statedir, cmdfile],
            capture_output=capture_output,
            timeout=timeout,
        )
    finally:
        # watchdog_run.py now unlinks the cmdfile after consuming it; tolerate ENOENT.
        try:
            os.unlink(cmdfile)
        except FileNotFoundError:
            pass


def _status(statedir: str) -> dict:
    """Load the single status JSON from statedir."""
    files = [f for f in os.listdir(statedir) if f.endswith(".json")]
    assert len(files) == 1, f"expected exactly one .json in {statedir}, got {files}"
    with open(os.path.join(statedir, files[0])) as fh:
        return json.load(fh)


class TestWatchdogRun(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    # ------------------------------------------------------------------
    # AC1 -- happy path: echo hi
    # ------------------------------------------------------------------
    def test_echo_hi_stdout_exit0_and_status_exited(self):
        """AC1: echo hi prints hi, exits 0, status file state=exited exit_code=0."""
        statedir = os.path.join(self.tmpdir, "ac1")
        os.makedirs(statedir)

        result = _run(statedir, "echo hi")

        self.assertEqual(result.returncode, 0, "watchdog should re-exit 0")
        self.assertIn(b"hi", result.stdout, "stdout must contain 'hi'")

        st = _status(statedir)
        self.assertEqual(st["state"], "exited")
        self.assertEqual(st["exit_code"], 0)

    # ------------------------------------------------------------------
    # AC2 -- non-zero exit code propagated
    # ------------------------------------------------------------------
    def test_exit7_propagated_and_recorded(self):
        """AC2: sh -c 'exit 7' -> process exits 7, status exit_code=7."""
        statedir = os.path.join(self.tmpdir, "ac2")
        os.makedirs(statedir)

        result = _run(statedir, "sh -c 'exit 7'")

        self.assertEqual(result.returncode, 7, "watchdog must re-exit 7")

        st = _status(statedir)
        self.assertEqual(st["state"], "exited")
        self.assertEqual(st["exit_code"], 7)

    # ------------------------------------------------------------------
    # AC3 -- last_output_ts advances when output is produced
    # ------------------------------------------------------------------
    def test_output_advances_last_output_ts(self):
        """AC3: a command that emits output -> last_output_ts > start_ts."""
        statedir = os.path.join(self.tmpdir, "ac3")
        os.makedirs(statedir)

        _run(statedir, "echo something")

        st = _status(statedir)
        self.assertIn("start_ts", st)
        self.assertIn("last_output_ts", st)
        self.assertGreater(
            st["last_output_ts"],
            st["start_ts"],
            "last_output_ts must be strictly later than start_ts when output was produced",
        )

    # ------------------------------------------------------------------
    # AC4 -- stdout+stderr byte-identical to unwrapped run
    # ------------------------------------------------------------------
    def test_stdout_stderr_byte_identical_to_unwrapped(self):
        """AC4: wrapped stdout+stderr == direct bash -c output."""
        cmd = "echo hello_stdout; echo hello_stderr >&2"

        # unwrapped reference
        ref = subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True,
        )

        statedir = os.path.join(self.tmpdir, "ac4")
        os.makedirs(statedir)
        wrapped = _run(statedir, cmd)

        self.assertEqual(
            wrapped.stdout,
            ref.stdout,
            "stdout must be byte-identical to unwrapped run",
        )
        self.assertEqual(
            wrapped.stderr,
            ref.stderr,
            "stderr must be byte-identical to unwrapped run",
        )

    # ------------------------------------------------------------------
    # AC5 (edge) -- child killed by signal -> state=signaled, exit_code=128+signo
    # ------------------------------------------------------------------
    def test_signal_kill_sets_state_signaled(self):
        """AC5 (edge): child killed by SIGKILL -> state=signaled, exit_code=128+SIGKILL."""
        statedir = os.path.join(self.tmpdir, "ac5")
        os.makedirs(statedir)

        # 'kill -9 $$' sends SIGKILL to the shell itself
        result = _run(statedir, "kill -9 $$")

        st = _status(statedir)
        self.assertEqual(st["state"], "signaled", "state must be 'signaled' for signal death")
        expected_exit = 128 + signal.SIGKILL
        self.assertEqual(
            result.returncode,
            expected_exit,
            f"watchdog must re-exit {expected_exit}",
        )
        self.assertEqual(st["exit_code"], expected_exit)

    # ------------------------------------------------------------------
    # AC6 (edge) -- zero-output command: last_output_ts == start_ts
    # ------------------------------------------------------------------
    def test_zero_output_last_output_ts_equals_start_ts(self):
        """AC6 (edge): command with no output -> last_output_ts == start_ts."""
        statedir = os.path.join(self.tmpdir, "ac6")
        os.makedirs(statedir)

        _run(statedir, "true")

        st = _status(statedir)
        self.assertEqual(
            st["last_output_ts"],
            st["start_ts"],
            "last_output_ts must equal start_ts when command produced no output",
        )

    # ------------------------------------------------------------------
    # AC7 (edge) -- statedir absent -> created automatically
    # ------------------------------------------------------------------
    def test_statedir_created_if_absent(self):
        """AC7 (edge): if statedir does not exist, watchdog creates it."""
        statedir = os.path.join(self.tmpdir, "nonexistent", "deep", "dir")
        # must NOT exist before the run
        self.assertFalse(os.path.exists(statedir))

        result = _run(statedir, "echo creating")

        self.assertEqual(result.returncode, 0)
        self.assertTrue(os.path.isdir(statedir), "statedir must be created by watchdog")
        st = _status(statedir)
        self.assertEqual(st["state"], "exited")

    # ------------------------------------------------------------------
    # Status file start-shape assertions (pid, command, start_ts present)
    # ------------------------------------------------------------------
    def test_status_file_contains_required_start_fields(self):
        """Status file must contain pid, command, start_ts, last_output_ts, state, exit_code."""
        statedir = os.path.join(self.tmpdir, "fields")
        os.makedirs(statedir)

        _run(statedir, "echo fields_test")

        st = _status(statedir)
        for field in ("pid", "command", "start_ts", "last_output_ts", "state", "exit_code"):
            self.assertIn(field, st, f"status file must contain '{field}'")
        self.assertIsInstance(st["pid"], int)
        self.assertIsInstance(st["start_ts"], float)
        self.assertIsInstance(st["last_output_ts"], float)


    # ------------------------------------------------------------------
    # Finding-1a pin: cmdfile is unlinked after a wrapped run completes
    # ------------------------------------------------------------------
    def test_cmdfile_unlinked_after_run(self):
        """After watchdog_run.py completes, the cmdfile must no longer exist on disk."""
        statedir = os.path.join(self.tmpdir, "cmdfile_unlink")
        os.makedirs(statedir)

        # Create a cmdfile manually so we can track it after the run
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", prefix="cmd-",
                                         dir=self.tmpdir, delete=False) as f:
            f.write("echo unlink_test")
            cmdfile = f.name

        self.assertTrue(os.path.exists(cmdfile), "precondition: cmdfile must exist before run")

        result = subprocess.run(
            [sys.executable, WATCHDOG, statedir, cmdfile],
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0)
        self.assertFalse(
            os.path.exists(cmdfile),
            f"cmdfile {cmdfile!r} must be unlinked by watchdog_run.py after the run completes"
        )


if __name__ == "__main__":
    unittest.main()
