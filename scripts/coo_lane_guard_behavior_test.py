"""
Behavioral tests for coo-lane-guard.py hook logic.

Pins:
  - Warn message names the real merge CLI (python3 scripts/merge_engine.py merge
    --repo <repo> --feature <feature> --chunk <chunk>), NOT the stale
    merge_chunk_branch Python function name.
  - merge_chunk_branch as a bare command string is NOT allowlisted (there is no
    such CLI subcommand; the allowlist entry was dead and has been removed).
  - The real merge_engine.py invocation IS allowlisted (the COO's sanctioned merge path).
  - A hand-rolled `git rebase` in a Bash call still triggers the warn (§5 detection
    not broken by the allowlist cleanup).
"""

import json
import sys
import os
import unittest
from io import StringIO
from unittest.mock import patch

# Insert the worktree root so we can import the hook as a module.
_WORKTREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_WORKTREE_ROOT, "hooks"))

import importlib.util

# Load hook module without executing __main__.
_HOOK_PATH = os.path.join(_WORKTREE_ROOT, "hooks", "coo-lane-guard.py")
_spec = importlib.util.spec_from_file_location("coo_lane_guard", _HOOK_PATH)
_coo_lane_guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_coo_lane_guard)


def _make_bash_payload(command, agent_id=None):
    """Build a minimal PreToolUse Bash payload."""
    p = {"tool_name": "Bash", "tool_input": {"command": command}}
    if agent_id is not None:
        p["agent_id"] = agent_id
    return p


def _make_edit_payload(file_path, agent_id=None):
    """Build a minimal PreToolUse Edit payload."""
    p = {"tool_name": "Edit", "tool_input": {"file_path": file_path}}
    if agent_id is not None:
        p["agent_id"] = agent_id
    return p


def _run_hook(payload):
    """Run the full hook main() with the given payload, return stdout text."""
    raw = json.dumps(payload)
    with patch("sys.stdin", StringIO(raw)), patch("sys.stdout", new_callable=StringIO) as mock_out:
        # Suppress log writes.
        with patch.object(_coo_lane_guard, "_append_log", return_value=None):
            _coo_lane_guard.main([])
        return mock_out.getvalue()


class TestWarnMessageNamesRealMergeCLI(unittest.TestCase):
    """The warn message must use the real merge_engine.py merge CLI, not merge_chunk_branch."""

    def _get_warn_message(self):
        """Trigger a §5 warn (git rebase) and return the additionalContext text."""
        payload = _make_bash_payload("git rebase feat/some-branch")
        out = _run_hook(payload)
        self.assertTrue(out.strip(), "Expected warn output but got empty stdout")
        data = json.loads(out)
        return data["hookSpecificOutput"]["additionalContext"]

    def test_warn_message_contains_real_merge_cli(self):
        """Warn text must reference the real CLI: merge_engine.py merge --repo ... --feature ... --chunk ..."""
        msg = self._get_warn_message()
        self.assertIn(
            "merge_engine.py merge",
            msg,
            f"Warn message must contain 'merge_engine.py merge'. Got:\n{msg}",
        )
        self.assertIn("--repo", msg, "Warn message must include --repo flag")
        self.assertIn("--feature", msg, "Warn message must include --feature flag")
        self.assertIn("--chunk", msg, "Warn message must include --chunk flag")

    def test_warn_message_does_not_name_merge_chunk_branch(self):
        """Warn text must NOT reference the stale Python function name merge_chunk_branch."""
        msg = self._get_warn_message()
        self.assertNotIn(
            "merge_chunk_branch",
            msg,
            f"Warn message must NOT contain stale 'merge_chunk_branch'. Got:\n{msg}",
        )


class TestAllowlistBehavior(unittest.TestCase):
    """Allowlist: real merge_engine.py is silent; merge_chunk_branch bare cmd is no longer allowlisted."""

    def test_real_merge_engine_invocation_is_silent(self):
        """python3 scripts/merge_engine.py merge --repo ... is the COO's sanctioned path: must be silent."""
        cmd = "python3 scripts/merge_engine.py merge --repo /path/to/repo --feature feat/x --chunk attempt/c1-1"
        payload = _make_bash_payload(cmd)
        out = _run_hook(payload)
        # No warn output means empty stdout (the hook exits 0 silently).
        self.assertEqual(
            out.strip(),
            "",
            f"Real merge_engine.py merge must be allowlisted (silent). Got:\n{out}",
        )

    def test_merge_chunk_branch_bare_not_in_allowlist(self):
        """merge_chunk_branch is an internal Python function name, not a CLI token.

        It was previously in the allowlist but is dead/misleading: no COO would
        ever type it as a CLI command. After removal it should no longer suppress
        a warn if it ever appears in a compound command with a gated action.

        Standalone 'merge_chunk_branch' alone is not a gated §1/§5 action either
        (not git rebase/merge/checkout, not python3 -m, not an Edit). So a bare
        invocation is simply not gated -- the test verifies it is silent not because
        the allowlist catches it but because it doesn't match any gated class.
        """
        # A compound command that would have been masked by the old allowlist:
        # merge_chunk_branch alongside a gated git rebase MUST still warn (Finding A:
        # gated action wins over allowlist match).
        cmd = "merge_chunk_branch feat/x && git rebase main"
        payload = _make_bash_payload(cmd)
        out = _run_hook(payload)
        # git rebase is §5 gated -- warn must fire despite merge_chunk_branch presence.
        self.assertTrue(
            out.strip(),
            "git rebase in a compound command must trigger a warn even if merge_chunk_branch is present",
        )
        data = json.loads(out)
        self.assertIn("merge:git-rebase", data["hookSpecificOutput"]["additionalContext"])

    def test_git_rebase_alone_triggers_warn(self):
        """§5 detection: bare git rebase must still trigger the warn (not broken by cleanup)."""
        payload = _make_bash_payload("git rebase origin/main")
        out = _run_hook(payload)
        self.assertTrue(out.strip(), "git rebase must trigger a §5 warn")
        data = json.loads(out)
        ctx = data["hookSpecificOutput"]["additionalContext"]
        self.assertIn("merge:git-rebase", ctx)


class TestWriteGatedReadFree(unittest.TestCase):
    """P6 split: the guard gates WRITES (edit/commit of build artifacts), not READS.

    A read-only RUN of project code (a suite run, a script, a diff) is the COO
    staying informed -- observation bypasses no gate. The guard must NOT warn on
    it. The previous build gated `python3 -m` and direct `.py` execution; that
    blinded the integrator and is the case this chunk un-gates.
    """

    # --- READ is free: project-code RUNS no longer warn ---

    def test_readonly_pytest_run_does_not_warn(self):
        """A read-only `python3 -m pytest` by the COO must NOT fire the guard.

        coo-lane-guard.py:150 `_BASH_RUN_RE` currently gates `python3 -m`; this is
        the case the guard gets WRONG. A suite run is a READ, not a WRITE.
        """
        payload = _make_bash_payload("python3 -m pytest scripts/coo_lane_guard_behavior_test.py -q")
        out = _run_hook(payload)
        self.assertEqual(
            out.strip(),
            "",
            f"A read-only `python3 -m pytest` run must be silent (READ is free). Got:\n{out}",
        )

    def test_node_test_run_does_not_warn(self):
        """A read-only `node --test` by the COO must NOT fire the guard (already silent)."""
        payload = _make_bash_payload("node --test workflows/foo_test.js")
        out = _run_hook(payload)
        self.assertEqual(
            out.strip(),
            "",
            f"A read-only `node --test` run must be silent (READ is free). Got:\n{out}",
        )

    def test_direct_py_script_run_does_not_warn(self):
        """A read-only direct `python3 scripts/foo.py` run must NOT fire the guard.

        Running a project script to learn state is a READ; only a WRITE (edit/commit)
        is gated.
        """
        payload = _make_bash_payload("python3 scripts/some_report.py --dry-run")
        out = _run_hook(payload)
        self.assertEqual(
            out.strip(),
            "",
            f"A read-only direct `.py` script run must be silent (READ is free). Got:\n{out}",
        )

    # --- WRITE is gated: edits and commits of build artifacts still warn ---

    def test_edit_of_code_class_file_still_warns(self):
        """A WRITE (Edit) of a code-class file from the main session must still warn."""
        payload = _make_edit_payload("workflows/worker-pipeline.js")
        out = _run_hook(payload)
        self.assertTrue(
            out.strip(),
            "An Edit of a code-class file (WRITE) must still warn.",
        )
        data = json.loads(out)
        self.assertIn("edit:code-class", data["hookSpecificOutput"]["additionalContext"])

    def test_git_commit_of_code_class_still_warns(self):
        """A `git commit` of a build-code path (WRITE) must still warn."""
        payload = _make_bash_payload("git commit -m 'feat: thing' hooks/coo-lane-guard.py")
        out = _run_hook(payload)
        self.assertTrue(
            out.strip(),
            "A git commit naming a code-class path (WRITE) must still warn.",
        )
        data = json.loads(out)
        self.assertIn("commit:code-class", data["hookSpecificOutput"]["additionalContext"])

    def test_git_rebase_merge_still_warns(self):
        """§5 hand-rolled merge (git rebase) is a WRITE to history; must still warn."""
        payload = _make_bash_payload("git rebase feat/x")
        out = _run_hook(payload)
        self.assertTrue(out.strip(), "git rebase (hand-rolled merge) must still warn.")
        data = json.loads(out)
        self.assertIn("merge:git-rebase", data["hookSpecificOutput"]["additionalContext"])

    def test_merge_engine_run_still_silent(self):
        """The sanctioned merge_engine.py run stays allowlisted (READ-free path intact)."""
        cmd = "python3 scripts/merge_engine.py merge --repo /r --feature feat/x --chunk attempt/c1-1"
        payload = _make_bash_payload(cmd)
        out = _run_hook(payload)
        self.assertEqual(out.strip(), "", f"merge_engine.py run must stay silent. Got:\n{out}")

    def test_no_run_project_code_class_anywhere(self):
        """The `run:project-code` warn class must be gone: no RUN of project code warns.

        Pins the un-gating at the class level -- a compound read-only command mixing a
        suite run with a diff must not surface the retired run-gate class.
        """
        payload = _make_bash_payload("python3 -m pytest && git diff hooks/coo-lane-guard.py")
        out = _run_hook(payload)
        self.assertEqual(
            out.strip(),
            "",
            f"A read-only run+diff compound command must be silent. Got:\n{out}",
        )


if __name__ == "__main__":
    unittest.main()
