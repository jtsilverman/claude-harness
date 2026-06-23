"""
Tests for scripts/watchdog_read.py

watchdog_read.py is a PostToolUse hook that:
  - reads hook stdin JSON (contains agent_id or session_id)
  - derives key = agent_id || session_id
  - globs /tmp/claude-watchdog/<key>/*.json for task status files
  - for each task: computes elapsed, idle=now-last_output_ts,
    and for state=running snapshots `ps -o %cpu= -p <pid>`
  - emits hookSpecificOutput.additionalContext with one compact line per
    live or just-finished task
  - SUPPRESSES output entirely when no task files exist or all are stale-finished

Acceptance criteria (all must pass):

  AC1  running task with last_output_ts~now -> additionalContext contains
       "running" + elapsed (e.g. "1s") + cpu value
  AC2  exited task with exit_code=3 -> line contains "EXITED 3"
  AC3  running task with idle>300s and cpu~0 -> line contains "possibly wedged"
  AC4  empty/absent status dir -> NO additionalContext in output (suppressed entirely)
  AC5  running task with cpu>0 -> does NOT contain "possibly wedged"

Invocation: the hook reads JSON from stdin and writes JSON to stdout.
The JSON stdin shape is a PostToolUse event: {tool_name, agent_id?, session_id?, ...}
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HOOK = os.path.join(os.path.dirname(__file__), "watchdog_read.py")
STATEDIR_BASE = "/tmp/claude-watchdog"


def _run_hook(stdin_payload: dict, *, timeout=10) -> subprocess.CompletedProcess:
    """Invoke watchdog_read.py with stdin_payload as JSON on stdin."""
    return subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps(stdin_payload).encode(),
        capture_output=True,
        timeout=timeout,
    )


def _parse_output(result: subprocess.CompletedProcess):
    """Parse stdout JSON; return None if stdout is empty (suppressed)."""
    if not result.stdout.strip():
        return None
    return json.loads(result.stdout)


def _write_status(statedir: str, taskid: str, data: dict) -> None:
    """Write a status JSON file for a fake task."""
    os.makedirs(statedir, exist_ok=True)
    path = os.path.join(statedir, f"{taskid}.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


class TestWatchdogRead(unittest.TestCase):

    def setUp(self):
        """Use a unique key per test to avoid cross-contamination."""
        self.key = f"test-wr-{os.getpid()}-{int(time.time()*1000)}"
        self.statedir = os.path.join(STATEDIR_BASE, self.key)
        self.stdin_base = {"tool_name": "Bash", "session_id": self.key}

    def tearDown(self):
        """Clean up status files written during the test."""
        import shutil
        if os.path.isdir(self.statedir):
            shutil.rmtree(self.statedir, ignore_errors=True)

    # ------------------------------------------------------------------
    # AC1 -- running task with recent output -> emits "running" + elapsed + cpu
    # ------------------------------------------------------------------
    def test_running_task_emits_running_elapsed_cpu(self):
        """AC1: running task (last_output_ts=now) -> additionalContext has 'running' + elapsed + cpu."""
        now = time.time()
        # Use pid=1 (init/launchd) which always exists on macOS/Linux
        _write_status(self.statedir, "task-ac1", {
            "pid": 1,
            "command": "sleep 9999",
            "start_ts": now - 5.0,
            "last_output_ts": now - 1.0,
            "state": "running",
            "exit_code": None,
        })

        result = _run_hook(self.stdin_base)
        self.assertEqual(result.returncode, 0, f"hook must exit 0; stderr={result.stderr!r}")

        parsed = _parse_output(result)
        self.assertIsNotNone(parsed, "stdout must be non-empty JSON for a running task")

        ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn("running", ctx.lower(),
                      f"additionalContext must contain 'running'; got: {ctx!r}")
        # elapsed should be a small number followed by 's' (e.g. "5s" or "5.0s")
        self.assertRegex(ctx, r"\d+",
                         f"additionalContext must contain elapsed digits; got: {ctx!r}")

    # ------------------------------------------------------------------
    # AC2 -- exited task with exit_code=3 -> line contains "EXITED 3"
    # ------------------------------------------------------------------
    def test_exited_nonzero_emits_EXITED_code(self):
        """AC2: task with state=exited exit_code=3 -> line contains 'EXITED 3'."""
        now = time.time()
        _write_status(self.statedir, "task-ac2", {
            "pid": 99999,
            "command": "false",
            "start_ts": now - 10.0,
            "last_output_ts": now - 9.0,
            "state": "exited",
            "exit_code": 3,
        })

        result = _run_hook(self.stdin_base)
        self.assertEqual(result.returncode, 0)

        parsed = _parse_output(result)
        self.assertIsNotNone(parsed, "stdout must be non-empty JSON for an exited task")

        ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn("EXITED 3", ctx,
                      f"additionalContext must contain 'EXITED 3'; got: {ctx!r}")

    # ------------------------------------------------------------------
    # AC3 -- running task idle>300s + cpu~0 -> "possibly wedged"
    # ------------------------------------------------------------------
    def test_idle_running_zero_cpu_emits_possibly_wedged(self):
        """AC3: running task with idle>300s and cpu~0 -> line contains 'possibly wedged'."""
        now = time.time()
        # pid=99999 almost certainly does not exist -> ps will fail or show 0 cpu
        # idle = now - last_output_ts = 400s > 300s WEDGE_SECS threshold
        _write_status(self.statedir, "task-ac3", {
            "pid": 99999,
            "command": "sleep 9999",
            "start_ts": now - 420.0,
            "last_output_ts": now - 400.0,
            "state": "running",
            "exit_code": None,
        })

        result = _run_hook(self.stdin_base)
        self.assertEqual(result.returncode, 0)

        parsed = _parse_output(result)
        self.assertIsNotNone(parsed, "stdout must be non-empty JSON for a wedge-suspect task")

        ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn("possibly wedged", ctx,
                      f"additionalContext must contain 'possibly wedged'; got: {ctx!r}")

    # ------------------------------------------------------------------
    # AC4 -- empty/absent status dir -> NO additionalContext (suppressed)
    # ------------------------------------------------------------------
    def test_empty_statedir_suppresses_output(self):
        """AC4: no status files -> hook emits nothing (no additionalContext)."""
        # Ensure statedir does NOT exist
        import shutil
        if os.path.isdir(self.statedir):
            shutil.rmtree(self.statedir)

        result = _run_hook(self.stdin_base)
        self.assertEqual(result.returncode, 0)

        # Either stdout is empty, or the parsed JSON has no additionalContext
        parsed = _parse_output(result)
        if parsed is not None:
            # If there IS output, it must not carry additionalContext
            ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext")
            self.assertIsNone(ctx,
                              f"empty statedir must NOT emit additionalContext; got: {ctx!r}")

    # ------------------------------------------------------------------
    # AC5 -- running task with cpu>0 -> does NOT get "possibly wedged"
    # ------------------------------------------------------------------
    def test_running_task_with_active_cpu_not_labelled_wedged(self):
        """AC5: running task idle>300s but cpu>0 -> NO 'possibly wedged' label."""
        now = time.time()
        # Use pid=1 (always running, will have non-zero cpu or at minimum ps succeeds).
        # But we need cpu > 0 specifically. We mock the scenario by making the hook
        # see cpu > 0: the real ps on pid=1 on macOS returns a small cpu % (often 0.0).
        # Instead, write a task whose idle is BELOW 300s, so it cannot be wedged
        # even if cpu is 0. However AC5 says "running+cpu>0 does NOT get wedged".
        # We write a separate test for the "cpu>0 even with long idle" case by
        # spawning an actual long-running process with some cpu to ensure ps sees it.
        #
        # Pragmatic approach: spawn a real cpu-using process, write its pid as running
        # with idle>300s, and assert no "possibly wedged" in output.
        # We use python3 -c "while True: pass" for a guaranteed cpu-burning process.
        import subprocess as sp
        burner = sp.Popen([sys.executable, "-c", "while True: pass"])
        try:
            # Give the process a moment to register cpu
            time.sleep(0.3)
            _write_status(self.statedir, "task-ac5", {
                "pid": burner.pid,
                "command": "python3 -c 'while True: pass'",
                "start_ts": now - 420.0,
                "last_output_ts": now - 400.0,  # idle=400s > WEDGE_SECS=300
                "state": "running",
                "exit_code": None,
            })

            result = _run_hook(self.stdin_base)
            self.assertEqual(result.returncode, 0)

            parsed = _parse_output(result)
            # There IS a running task -> output should be present
            # (or suppressed if ps fails; either way, 'possibly wedged' must be absent)
            if parsed is not None:
                ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
                self.assertNotIn("possibly wedged", ctx,
                                 f"cpu>0 task must NOT be labelled 'possibly wedged'; got: {ctx!r}")
        finally:
            burner.kill()
            burner.wait()

    # ------------------------------------------------------------------
    # Finding 1/9: AC1 must assert that 'cpu=' appears in the running line.
    # A regression stripping cpu from the line should fail this test.
    # ------------------------------------------------------------------
    def test_running_task_emits_cpu_field(self):
        """AC1 cpu= pin: running task with a real pid must include 'cpu=' in the line."""
        now = time.time()
        # pid=1 (launchd/init) always exists and ps succeeds -> cpu= should appear
        _write_status(self.statedir, "task-cpu-pin", {
            "pid": 1,
            "command": "sleep 9999",
            "start_ts": now - 5.0,
            "last_output_ts": now - 1.0,
            "state": "running",
            "exit_code": None,
        })

        result = _run_hook(self.stdin_base)
        self.assertEqual(result.returncode, 0, f"hook must exit 0; stderr={result.stderr!r}")

        parsed = _parse_output(result)
        self.assertIsNotNone(parsed, "stdout must be non-empty JSON for a running task")

        ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn("cpu=", ctx,
                      f"additionalContext must contain 'cpu='; got: {ctx!r}")

    # ------------------------------------------------------------------
    # Finding 2: multiple live tasks -> one line each (newline separated)
    # ------------------------------------------------------------------
    def test_multiple_running_tasks_emit_one_line_each(self):
        """Edge case: two running tasks -> two lines in additionalContext."""
        now = time.time()
        # pid=1 always exists; use two distinct task files
        _write_status(self.statedir, "task-multi-1", {
            "pid": 1,
            "command": "sleep 1111",
            "start_ts": now - 10.0,
            "last_output_ts": now - 2.0,
            "state": "running",
            "exit_code": None,
        })
        _write_status(self.statedir, "task-multi-2", {
            "pid": 1,
            "command": "sleep 2222",
            "start_ts": now - 20.0,
            "last_output_ts": now - 3.0,
            "state": "running",
            "exit_code": None,
        })

        result = _run_hook(self.stdin_base)
        self.assertEqual(result.returncode, 0, f"hook must exit 0; stderr={result.stderr!r}")

        parsed = _parse_output(result)
        self.assertIsNotNone(parsed, "stdout must be non-empty JSON for multiple running tasks")

        ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
        lines = [l for l in ctx.split("\n") if l.strip()]
        self.assertEqual(len(lines), 2,
                         f"two tasks must produce exactly two lines; got {len(lines)} lines in: {ctx!r}")
        # Both lines should mention 'running'
        for line in lines:
            self.assertIn("running", line.lower(),
                          f"each line must mention 'running'; line={line!r}")

    # ------------------------------------------------------------------
    # Finding 3: subagent context reads its own agent_id-keyed dir,
    # not the session_id-keyed dir.
    # ------------------------------------------------------------------
    def test_agent_id_takes_priority_over_session_id(self):
        """Edge case: agent_id in stdin -> hook reads agent_id-keyed statedir, not session_id."""
        now = time.time()
        agent_id = f"agent-{os.getpid()}-{int(now * 1000)}"
        agent_statedir = os.path.join(STATEDIR_BASE, agent_id)

        # Write a task file under the agent_id-keyed dir
        _write_status(agent_statedir, "task-agent", {
            "pid": 1,
            "command": "agent job",
            "start_ts": now - 8.0,
            "last_output_ts": now - 1.0,
            "state": "running",
            "exit_code": None,
        })

        try:
            # stdin has BOTH agent_id and session_id; only agent_id dir has a file
            stdin_payload = {
                "tool_name": "Bash",
                "agent_id": agent_id,
                "session_id": self.key,  # self.statedir is empty (no files written)
            }
            result = _run_hook(stdin_payload)
            self.assertEqual(result.returncode, 0, f"hook must exit 0; stderr={result.stderr!r}")

            parsed = _parse_output(result)
            # Hook should see the task in agent_id dir -> emit non-empty output
            self.assertIsNotNone(parsed,
                                 "hook must emit output when agent_id-keyed dir has tasks")

            ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
            self.assertIn("running", ctx.lower(),
                          f"agent_id-keyed task must appear in output; got: {ctx!r}")
        finally:
            import shutil
            shutil.rmtree(agent_statedir, ignore_errors=True)

    # ------------------------------------------------------------------
    # Finding 4: dead pid with idle < WEDGE_SECS -> emits running line
    # (no cpu, no "possibly wedged" -- just running with elapsed)
    # ------------------------------------------------------------------
    def test_dead_pid_short_idle_emits_running_line(self):
        """Edge case: pid gone but state=running, idle<WEDGE_SECS -> still emits 'running', no wedge label."""
        now = time.time()
        # pid=99999 almost certainly does not exist; idle=10s < 300s WEDGE_SECS
        _write_status(self.statedir, "task-dead-short", {
            "pid": 99999,
            "command": "died quickly",
            "start_ts": now - 15.0,
            "last_output_ts": now - 10.0,  # idle=10s < 300s threshold
            "state": "running",
            "exit_code": None,
        })

        result = _run_hook(self.stdin_base)
        self.assertEqual(result.returncode, 0, f"hook must exit 0; stderr={result.stderr!r}")

        parsed = _parse_output(result)
        self.assertIsNotNone(parsed,
                             "dead-pid running task (idle<WEDGE_SECS) must still emit output")

        ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn("running", ctx.lower(),
                      f"line must contain 'running' even when pid is gone; got: {ctx!r}")
        self.assertNotIn("possibly wedged", ctx,
                         f"idle<WEDGE_SECS must NOT produce 'possibly wedged'; got: {ctx!r}")

    # ------------------------------------------------------------------
    # Finding 7 (SECURITY): path-traversal guard on the key parameter.
    # A crafted key like '../../etc' must NOT resolve outside STATEDIR_BASE.
    # ------------------------------------------------------------------
    def test_traversal_key_does_not_escape_statedir_base(self):
        """SECURITY: key='../../etc' -> hook resolves to STATEDIR_BASE/etc (basename), not /etc."""
        # Write a status file under STATEDIR_BASE/etc (the safe path after basename)
        traversal_key = "../../etc"
        # basename('../../etc') == 'etc'
        safe_statedir = os.path.join(STATEDIR_BASE, "etc")
        now = time.time()
        _write_status(safe_statedir, "task-traversal", {
            "pid": 1,
            "command": "traversal-test",
            "start_ts": now - 5.0,
            "last_output_ts": now - 1.0,
            "state": "running",
            "exit_code": None,
        })
        try:
            stdin_payload = {"tool_name": "Bash", "session_id": traversal_key}
            result = _run_hook(stdin_payload)
            self.assertEqual(result.returncode, 0, f"hook must exit 0; stderr={result.stderr!r}")
            # The hook resolves to STATEDIR_BASE/etc (not /etc), so it sees the file we wrote
            # and emits output (proving basename was applied).
            parsed = _parse_output(result)
            self.assertIsNotNone(parsed,
                                 "traversal key must resolve to safe dir and emit output")
            ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
            self.assertIn("running", ctx.lower(),
                          f"traversal-resolved task must appear in output; got: {ctx!r}")
        finally:
            import shutil
            shutil.rmtree(safe_statedir, ignore_errors=True)

    # ------------------------------------------------------------------
    # Finding 5: ps fails (dead pid), idle < WEDGE_SECS -> line emitted
    # without cpu field, no "possibly wedged"
    # ------------------------------------------------------------------
    def test_ps_fail_short_idle_still_emits_line_without_cpu(self):
        """Edge case: ps fails for dead pid, idle<WEDGE_SECS -> emit 'running' line (no cpu=, no wedge)."""
        now = time.time()
        # pid=99999 -> ps will fail; idle=5s << 300s -> no wedge label
        _write_status(self.statedir, "task-ps-fail", {
            "pid": 99999,
            "command": "ps-fail-cmd",
            "start_ts": now - 12.0,
            "last_output_ts": now - 5.0,  # idle=5s, well below WEDGE_SECS
            "state": "running",
            "exit_code": None,
        })

        result = _run_hook(self.stdin_base)
        self.assertEqual(result.returncode, 0, f"hook must exit 0; stderr={result.stderr!r}")

        parsed = _parse_output(result)
        self.assertIsNotNone(parsed,
                             "ps-fail running task (idle<WEDGE_SECS) must still emit output")

        ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn("running", ctx.lower(),
                      f"line must contain 'running' even when ps fails; got: {ctx!r}")
        self.assertNotIn("cpu=", ctx,
                         f"ps-fail must NOT emit cpu= field; got: {ctx!r}")
        self.assertNotIn("possibly wedged", ctx,
                         f"idle<WEDGE_SECS must NOT produce 'possibly wedged'; got: {ctx!r}")


class TestWedgeWatch(unittest.TestCase):
    """
    Tests for watchdog_read.py --wedge-watch mode.

    Acceptance criteria:
      WW1  --wedge-watch on a fixture with state=running, idle>300s, cpu~0
           exits 2 and stderr contains the 'possibly wedged' telemetry line.
      WW2  --wedge-watch on a healthy task (idle<300s) exits 0 and emits nothing.
      WW3  --wedge-watch when status dir is absent exits 0 and emits nothing.
      WW4  --wedge-watch with no files in statedir exits 0 and emits nothing.
      WW5  pid gone (ps fails) + idle>300s -> treated as wedged, exits 2.
      WW6  worktree settings.json has PostToolUse hook for --wedge-watch
           with asyncRewake:true.
      WW7  live ~/.claude/settings.json is NOT modified (no wedge-watch hook
           registered there), and no /tmp spike scripts are left.
    """

    # WW8 added by fixer: pins that wedge telemetry goes to stderr (primary
    # asyncRewake channel), not stdout -- per spec edgeCase and in-repo
    # documentation (security_reminder_hook.py:240-244 confirms CC reads
    # 'stderr || stdout'; stderr is the specified primary channel).

    WORKTREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    WORKTREE_SETTINGS = os.path.join(WORKTREE_ROOT, "settings.json")
    def setUp(self):
        self.key = f"test-ww-{os.getpid()}-{int(time.time()*1000)}"
        self.statedir = os.path.join(STATEDIR_BASE, self.key)

    def tearDown(self):
        import shutil
        if os.path.isdir(self.statedir):
            shutil.rmtree(self.statedir, ignore_errors=True)

    def _run_wedge_watch(self, key=None, *, timeout=10):
        """Invoke watchdog_read.py --wedge-watch with a session key via env var or key arg."""
        # --wedge-watch does NOT read stdin; it needs the key from somewhere.
        # The implementation should derive the key from a CLI arg or env override.
        # We pass the key as the session-id via a minimal stdin payload, OR
        # the implementation uses an env var. We support both by passing key via
        # stdin payload (same shape as regular mode) alongside --wedge-watch.
        k = key if key is not None else self.key
        stdin_payload = {"tool_name": "Bash", "session_id": k}
        return subprocess.run(
            [sys.executable, HOOK, "--wedge-watch"],
            input=json.dumps(stdin_payload).encode(),
            capture_output=True,
            timeout=timeout,
        )

    # ------------------------------------------------------------------
    # WW1: wedge fixture -> exits 2, stderr contains 'possibly wedged'
    #      (telemetry is on stderr -- the primary asyncRewake body channel)
    # ------------------------------------------------------------------
    def test_wedge_fixture_exits_2_with_wedged_line(self):
        """WW1: state=running + idle>300s + cpu~0 -> exits 2, stderr contains 'possibly wedged'."""
        now = time.time()
        # pid=99999 almost certainly absent -> ps fails -> cpu treated as ~0
        _write_status(self.statedir, "task-wedge", {
            "pid": 99999,
            "command": "long running job",
            "start_ts": now - 420.0,
            "last_output_ts": now - 400.0,  # idle=400s > WEDGE_SECS=300
            "state": "running",
            "exit_code": None,
        })

        result = self._run_wedge_watch()
        self.assertEqual(result.returncode, 2,
                         f"--wedge-watch must exit 2 for a wedged task; got {result.returncode}; "
                         f"stdout={result.stdout!r} stderr={result.stderr!r}")
        err = result.stderr.decode()
        self.assertIn("possibly wedged", err,
                      f"stderr must contain 'possibly wedged' (primary asyncRewake channel); "
                      f"got stderr={err!r}")

    # ------------------------------------------------------------------
    # WW2: healthy task (idle<300s) -> exits 0, emits nothing
    # ------------------------------------------------------------------
    def test_healthy_task_exits_0_silent(self):
        """WW2: state=running + idle<300s -> exits 0 and stdout is empty."""
        now = time.time()
        _write_status(self.statedir, "task-healthy", {
            "pid": 1,
            "command": "active job",
            "start_ts": now - 10.0,
            "last_output_ts": now - 5.0,  # idle=5s << 300s
            "state": "running",
            "exit_code": None,
        })

        result = self._run_wedge_watch()
        self.assertEqual(result.returncode, 0,
                         f"--wedge-watch must exit 0 for a healthy task; got {result.returncode}; "
                         f"stdout={result.stdout!r} stderr={result.stderr!r}")
        self.assertEqual(result.stdout.strip(), b"",
                         f"--wedge-watch must emit nothing for a healthy task; got: {result.stdout!r}")
        self.assertEqual(result.stderr.strip(), b"",
                         f"--wedge-watch must emit nothing on stderr for a healthy task; got: {result.stderr!r}")

    # ------------------------------------------------------------------
    # WW3: status dir absent -> exits 0 silent
    # ------------------------------------------------------------------
    def test_absent_statedir_exits_0_silent(self):
        """WW3: no statedir -> exits 0 and emits nothing."""
        import shutil
        if os.path.isdir(self.statedir):
            shutil.rmtree(self.statedir)

        result = self._run_wedge_watch()
        self.assertEqual(result.returncode, 0,
                         f"--wedge-watch must exit 0 when statedir absent; got {result.returncode}")
        self.assertEqual(result.stdout.strip(), b"",
                         f"--wedge-watch must emit nothing when statedir absent; got: {result.stdout!r}")

    # ------------------------------------------------------------------
    # WW4: statedir exists but no files -> exits 0 silent
    # ------------------------------------------------------------------
    def test_empty_statedir_exits_0_silent(self):
        """WW4: statedir exists but empty -> exits 0 and emits nothing."""
        os.makedirs(self.statedir, exist_ok=True)

        result = self._run_wedge_watch()
        self.assertEqual(result.returncode, 0,
                         f"--wedge-watch must exit 0 when no status files; got {result.returncode}")
        self.assertEqual(result.stdout.strip(), b"",
                         f"--wedge-watch must emit nothing with empty statedir; got: {result.stdout!r}")

    # ------------------------------------------------------------------
    # WW5: pid gone (ps fails) + idle>300s -> treated as wedged, exits 2
    # ------------------------------------------------------------------
    def test_dead_pid_long_idle_treated_as_wedged(self):
        """WW5: pid=gone + idle>300s -> exits 2 with 'possibly wedged' on stderr (edge case: pid gone)."""
        now = time.time()
        _write_status(self.statedir, "task-dead-long", {
            "pid": 99998,  # almost certainly absent
            "command": "lost process",
            "start_ts": now - 500.0,
            "last_output_ts": now - 310.0,  # idle=310s > WEDGE_SECS=300
            "state": "running",
            "exit_code": None,
        })

        result = self._run_wedge_watch()
        self.assertEqual(result.returncode, 2,
                         f"--wedge-watch must exit 2 for dead-pid with long idle; got {result.returncode}; "
                         f"stderr={result.stderr!r}")
        err = result.stderr.decode()
        self.assertIn("possibly wedged", err,
                      f"stderr must contain 'possibly wedged' for dead pid + long idle; got: {err!r}")

    # ------------------------------------------------------------------
    # WW6: worktree settings.json has --wedge-watch hook with asyncRewake:true
    # ------------------------------------------------------------------
    def test_worktree_settings_has_wedge_watch_hook_with_asyncRewake(self):
        """WW6: worktree settings.json PostToolUse has a hook for --wedge-watch with asyncRewake:true."""
        self.assertTrue(os.path.isfile(self.WORKTREE_SETTINGS),
                        f"worktree settings.json not found at {self.WORKTREE_SETTINGS!r}")
        with open(self.WORKTREE_SETTINGS) as fh:
            settings = json.load(fh)

        post_tool_use = settings.get("hooks", {}).get("PostToolUse", [])
        self.assertTrue(post_tool_use, "settings.json must have PostToolUse hooks section")

        # Find any hook entry containing '--wedge-watch' in its command
        wedge_hooks = []
        for group in post_tool_use:
            for hook in group.get("hooks", []):
                cmd = hook.get("command", "")
                if "--wedge-watch" in cmd:
                    wedge_hooks.append(hook)

        self.assertTrue(wedge_hooks,
                        f"No --wedge-watch hook found in settings.json PostToolUse; "
                        f"entries: {post_tool_use!r}")

        # Each matching hook must have asyncRewake:true
        for hook in wedge_hooks:
            self.assertTrue(hook.get("asyncRewake"),
                            f"--wedge-watch hook must have asyncRewake:true; hook: {hook!r}")

    # ------------------------------------------------------------------
    # WW8: wedge telemetry goes to stderr (primary asyncRewake channel),
    #      NOT to stdout -- per spec edgeCase and asyncRewake contract.
    #      "CC's asyncRewake delivery actually reads stderr || stdout"
    #      (security_reminder_hook.py:241); stderr is the intended channel.
    # ------------------------------------------------------------------
    def test_wedge_line_emitted_on_stderr_not_stdout(self):
        """WW8: 'possibly wedged' line appears on stderr; stdout must be empty."""
        now = time.time()
        _write_status(self.statedir, "task-wedge-fd", {
            "pid": 99997,
            "command": "fd channel test",
            "start_ts": now - 600.0,
            "last_output_ts": now - 350.0,  # idle=350s > WEDGE_SECS=300
            "state": "running",
            "exit_code": None,
        })

        result = self._run_wedge_watch()
        self.assertEqual(result.returncode, 2,
                         f"--wedge-watch must exit 2; got {result.returncode}; "
                         f"stdout={result.stdout!r} stderr={result.stderr!r}")
        # Primary channel: stderr must carry the telemetry
        err = result.stderr.decode()
        self.assertIn("possibly wedged", err,
                      f"stderr must contain 'possibly wedged' (primary asyncRewake channel); "
                      f"got stderr={err!r}, stdout={result.stdout.decode()!r}")
        # stdout must be clean -- asyncRewake body is on stderr
        self.assertEqual(result.stdout.strip(), b"",
                         f"stdout must be empty when telemetry is on stderr; got: {result.stdout!r}")

    # ------------------------------------------------------------------
    # WW9: healthy task (idle>300s but cpu>0) -> exits 0, emits nothing
    #      Tests the second branch of the wedge guard:
    #        idle > WEDGE_SECS  AND  cpu_is_zero  -> wedged (exit 2)
    #        idle > WEDGE_SECS  AND  NOT cpu_is_zero  -> healthy (exit 0)
    #      _ps_cpu is monkeypatched to return 2.5% to avoid flakiness from
    #      real ps timing (a live process may briefly read 0.0% during idle).
    # ------------------------------------------------------------------
    def test_long_idle_but_active_cpu_exits_0_silent(self):
        """WW9: state=running + idle>300s + cpu>0 -> exits 0 and emits nothing (cpu branch)."""
        import importlib.util
        from unittest.mock import patch

        # Load the module fresh so we can patch its internal _ps_cpu.
        spec = importlib.util.spec_from_file_location("watchdog_read", HOOK)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        now = time.time()
        _write_status(self.statedir, "task-active-cpu", {
            "pid": os.getpid(),           # current test process -- definitely alive
            "command": "long-idle-but-active",
            "start_ts": now - 600.0,
            "last_output_ts": now - 400.0,  # idle=400s > WEDGE_SECS=300s
            "state": "running",
            "exit_code": None,
        })

        key = self.key
        # Monkeypatch _ps_cpu at module level so it returns 2.5 (>CPU_ZERO_THRESHOLD=0.5)
        with patch.object(mod, "_ps_cpu", return_value=2.5):
            exit_code = mod._wedge_watch(key, verbose=False)

        self.assertEqual(exit_code, 0,
                         "cpu>0 task with idle>300s must NOT be treated as wedged; "
                         f"expected exit 0 but got {exit_code}")

if __name__ == "__main__":
    unittest.main()
