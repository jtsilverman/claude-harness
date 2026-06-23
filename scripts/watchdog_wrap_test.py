"""
Tests for scripts/watchdog_wrap.py -- a PreToolUse hook.

Invocation shape: the harness pipes a PreToolUse event JSON on stdin and reads
the hook's stdout JSON. We mirror that exactly: feed crafted stdin, read stdout.

The hook's contract (the chunk's full acceptance):
  - Bash + tool_input.run_in_background:true  -> stdout JSON with
      hookSpecificOutput.updatedInput whose command invokes watchdog_run.py,
      retaining run_in_background:true and EVERY other tool_input field.
  - foreground Bash (no run_in_background)    -> NO updatedInput (empty/no output).
  - non-Bash tool                            -> NO updatedInput.
  - malformed / partial stdin JSON           -> NO updatedInput, exit 0 (fail-open).

Edges pinned:
  - subagent (agent_id present) keys the statedir on agent_id, not session_id.
  - a command containing quotes + newlines survives the cmdfile round-trip.

The wrapped command shape:
  python3 <abs>/watchdog_run.py /tmp/claude-watchdog/<key> <cmdfile>
"""

import json
import os
import shlex
import subprocess
import sys
import unittest

WRAP = os.path.join(os.path.dirname(__file__), "watchdog_wrap.py")


def _invoke(payload):
    """Invoke the hook with `payload` (dict -> JSON, or a raw str) on stdin.

    Returns (returncode, stdout_text, stderr_text).
    """
    if isinstance(payload, (bytes, bytearray)):
        stdin_bytes = bytes(payload)
    elif isinstance(payload, str):
        stdin_bytes = payload.encode()
    else:
        stdin_bytes = json.dumps(payload).encode()
    proc = subprocess.run(
        [sys.executable, WRAP],
        input=stdin_bytes,
        capture_output=True,
        timeout=10,
    )
    return proc.returncode, proc.stdout.decode(), proc.stderr.decode()


def _updated_input(stdout_text):
    """Parse stdout and return hookSpecificOutput.updatedInput, or None if absent."""
    text = stdout_text.strip()
    if not text:
        return None
    obj = json.loads(text)
    return obj.get("hookSpecificOutput", {}).get("updatedInput")


class TestWatchdogWrap(unittest.TestCase):

    # ------------------------------------------------------------------
    # AC1 -- Bash + run_in_background:true -> updatedInput wrapping watchdog_run.py,
    #        preserving run_in_background:true and every other tool_input field.
    # ------------------------------------------------------------------
    def test_bg_bash_yields_wrapped_updated_input(self):
        payload = {
            "session_id": "sess-abc",
            "tool_name": "Bash",
            "tool_input": {
                "command": "echo hello",
                "run_in_background": True,
                "description": "say hello",
                "timeout": 5000,
            },
        }
        rc, out, err = _invoke(payload)
        self.assertEqual(rc, 0, f"hook must exit 0; stderr={err}")

        ui = _updated_input(out)
        self.assertIsNotNone(ui, "bg Bash must yield hookSpecificOutput.updatedInput")

        # command rewritten to invoke watchdog_run.py
        self.assertIn("watchdog_run.py", ui["command"],
                      "rewritten command must invoke watchdog_run.py")
        # run_in_background preserved as true
        self.assertIs(ui["run_in_background"], True,
                      "run_in_background:true must be preserved")
        # every other tool_input field preserved verbatim
        self.assertEqual(ui["description"], "say hello",
                         "other tool_input fields must be preserved")
        self.assertEqual(ui["timeout"], 5000,
                         "other tool_input fields must be preserved")

        # the wrapped command must be a valid argv:
        #   python3 <abs>/watchdog_run.py /tmp/claude-watchdog/<key> <cmdfile>
        parts = shlex.split(ui["command"])
        self.assertGreaterEqual(len(parts), 4)
        self.assertTrue(parts[1].endswith("watchdog_run.py"))
        # statedir keyed on session_id when no agent_id present
        self.assertEqual(parts[2], "/tmp/claude-watchdog/sess-abc",
                         "statedir must be /tmp/claude-watchdog/<session_id>")
        # the original command lives in the cmdfile, NOT inline
        cmdfile = parts[3]
        with open(cmdfile) as fh:
            self.assertEqual(fh.read(), "echo hello",
                             "original command must round-trip through the cmdfile")

    # ------------------------------------------------------------------
    # AC2 -- foreground Bash (no run_in_background) -> NO updatedInput.
    # ------------------------------------------------------------------
    def test_foreground_bash_yields_no_updated_input(self):
        payload = {
            "session_id": "sess-abc",
            "tool_name": "Bash",
            "tool_input": {"command": "echo hi"},
        }
        rc, out, err = _invoke(payload)
        self.assertEqual(rc, 0)
        self.assertIsNone(_updated_input(out),
                          "foreground Bash must NOT be wrapped")

    def test_foreground_bash_explicit_false_yields_no_updated_input(self):
        payload = {
            "session_id": "sess-abc",
            "tool_name": "Bash",
            "tool_input": {"command": "echo hi", "run_in_background": False},
        }
        rc, out, err = _invoke(payload)
        self.assertEqual(rc, 0)
        self.assertIsNone(_updated_input(out),
                          "run_in_background:false must NOT be wrapped")

    # ------------------------------------------------------------------
    # AC3 -- non-Bash tool -> NO updatedInput.
    # ------------------------------------------------------------------
    def test_non_bash_tool_yields_no_updated_input(self):
        payload = {
            "session_id": "sess-abc",
            "tool_name": "Read",
            "tool_input": {"file_path": "/tmp/x", "run_in_background": True},
        }
        rc, out, err = _invoke(payload)
        self.assertEqual(rc, 0)
        self.assertIsNone(_updated_input(out),
                          "non-Bash tool must NOT be wrapped, even with run_in_background")

    # ------------------------------------------------------------------
    # AC4 -- malformed / partial stdin JSON -> NO updatedInput, exit 0 (fail-open).
    # ------------------------------------------------------------------
    def test_malformed_json_fails_open(self):
        rc, out, err = _invoke("{ this is not valid json ")
        self.assertEqual(rc, 0, "malformed stdin must still exit 0 (fail-open)")
        self.assertIsNone(_updated_input(out),
                          "malformed stdin must NOT yield updatedInput")

    def test_partial_json_missing_tool_input_fails_open(self):
        rc, out, err = _invoke({"session_id": "sess-abc", "tool_name": "Bash"})
        self.assertEqual(rc, 0, "partial JSON must exit 0 (fail-open)")
        self.assertIsNone(_updated_input(out),
                          "partial JSON (no tool_input) must NOT yield updatedInput")

    def test_empty_stdin_fails_open(self):
        rc, out, err = _invoke("")
        self.assertEqual(rc, 0, "empty stdin must exit 0 (fail-open)")
        self.assertIsNone(_updated_input(out))

    # ------------------------------------------------------------------
    # Edge -- subagent: agent_id present keys statedir on agent_id, not session_id.
    # ------------------------------------------------------------------
    def test_agent_id_keys_statedir_over_session_id(self):
        payload = {
            "session_id": "sess-abc",
            "agent_id": "agent-xyz",
            "tool_name": "Bash",
            "tool_input": {"command": "echo sub", "run_in_background": True},
        }
        rc, out, err = _invoke(payload)
        self.assertEqual(rc, 0)
        ui = _updated_input(out)
        self.assertIsNotNone(ui)
        parts = shlex.split(ui["command"])
        self.assertEqual(parts[2], "/tmp/claude-watchdog/agent-xyz",
                         "agent_id must take precedence over session_id for the statedir key")

    # ------------------------------------------------------------------
    # Edge -- command with quotes + newlines survives the cmdfile round-trip.
    # ------------------------------------------------------------------
    def test_quotes_and_newlines_survive_cmdfile_roundtrip(self):
        gnarly = "echo \"a 'b' c\"\nprintf 'line1\\nline2\\n'\necho done"
        payload = {
            "session_id": "sess-abc",
            "tool_name": "Bash",
            "tool_input": {"command": gnarly, "run_in_background": True},
        }
        rc, out, err = _invoke(payload)
        self.assertEqual(rc, 0)
        ui = _updated_input(out)
        self.assertIsNotNone(ui)
        parts = shlex.split(ui["command"])
        cmdfile = parts[3]
        with open(cmdfile) as fh:
            self.assertEqual(fh.read(), gnarly,
                             "quotes + newlines must survive byte-for-byte through the cmdfile")


    # ------------------------------------------------------------------
    # Finding-2 pin: slash-bearing key resolves to the same basename dir in
    # both wrap.py (writer) and read.py (reader).
    # ------------------------------------------------------------------
    def test_slash_bearing_key_resolves_same_dir_in_wrap_and_read(self):
        """A slash-containing agent_id must be basename-sanitized in wrap.py so
        wrap and read derive the same statedir. Without the fix wrap uses the raw
        path (path-traversal) while read uses basename -- they diverge.

        Specifically: wrap must emit /tmp/claude-watchdog/attempt (basename of
        "some/traversal/attempt"), not /tmp/claude-watchdog/some/traversal/attempt.
        """
        slash_key = "some/traversal/attempt"
        # read.py applies: os.path.basename(str(raw_key)) or "default"
        expected_statedir = "/tmp/claude-watchdog/attempt"

        payload = {
            "session_id": "sess-abc",
            "agent_id": slash_key,
            "tool_name": "Bash",
            "tool_input": {"command": "echo slash_key_test", "run_in_background": True},
        }
        rc, out, err = _invoke(payload)
        self.assertEqual(rc, 0, f"hook must exit 0; stderr={err}")

        ui = _updated_input(out)
        self.assertIsNotNone(ui, "bg Bash must yield updatedInput")

        parts = shlex.split(ui["command"])
        statedir = parts[2]  # /tmp/claude-watchdog/<key>
        self.assertEqual(
            statedir,
            expected_statedir,
            f"wrap.py must sanitize slash-bearing key with basename: "
            f"expected {expected_statedir!r}, got {statedir!r}"
        )


if __name__ == "__main__":
    unittest.main()
