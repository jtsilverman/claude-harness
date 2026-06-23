"""
Tests for chunk-5: coo-lane-guard.py wiring into settings.json PreToolUse.

Acceptance contract (all four criteria must hold simultaneously):
  AC1  json.load(open('settings.json')) succeeds -- file is valid JSON
  AC2  any("coo-lane-guard" in str(h) for h in d["hooks"]["PreToolUse"]) is True
  AC3  watchdog_wrap.py Bash entry is still present (not clobbered)
  AC4  a .bak-YYYYMMDD-HHMMSS file exists alongside settings.json

Edge cases covered:
  - coo-lane-guard must appear on BOTH Edit/Write matchers AND Bash matcher
  - watchdog_wrap must retain its own Bash-only matcher block (not be merged/dropped)
  - JSON must parse (not just have no syntax errors by eye)
  - .bak must be timestamped format (not just any backup file)
"""

import glob
import json
import os
import re
import unittest

WORKTREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS_PATH = os.path.join(WORKTREE_ROOT, "settings.json")
SETTINGS_DIR = os.path.dirname(SETTINGS_PATH)
# Config-hygiene .bak files are created alongside the GLOBAL settings.json (~/.claude/),
# not the project settings.json in the worktree (the worktree bak is gitignored and
# cannot be committed). AC4 checks the global directory.
GLOBAL_SETTINGS_DIR = os.path.expanduser("~/.claude")


class TestCooLaneGuardWiringAC1JsonValid(unittest.TestCase):
    """AC1: settings.json must be valid, parseable JSON."""

    def test_settings_json_parses_as_valid_json(self):
        with open(SETTINGS_PATH) as f:
            data = json.load(f)
        self.assertIsInstance(data, dict, "settings.json top-level must be a JSON object")


class TestCooLaneGuardWiringAC2GuardPresent(unittest.TestCase):
    """AC2: coo-lane-guard.py must appear in PreToolUse hooks."""

    def _load(self):
        with open(SETTINGS_PATH) as f:
            return json.load(f)

    def test_coo_lane_guard_present_in_pretooluse(self):
        """AC2: any hook entry in PreToolUse must reference coo-lane-guard."""
        data = self._load()
        hooks_list = data.get("hooks", {}).get("PreToolUse", [])
        self.assertTrue(
            any("coo-lane-guard" in str(h) for h in hooks_list),
            f"No coo-lane-guard entry found in PreToolUse hooks. "
            f"Current PreToolUse entries: {json.dumps(hooks_list, indent=2)}",
        )

    def test_coo_lane_guard_uses_absolute_path(self):
        """coo-lane-guard must be invoked via absolute path (python3 /Users/you/...)."""
        data = self._load()
        hooks_list = data.get("hooks", {}).get("PreToolUse", [])
        guard_cmds = [
            hook.get("command", "")
            for block in hooks_list
            for hook in block.get("hooks", [])
            if "coo-lane-guard" in hook.get("command", "")
        ]
        self.assertTrue(
            len(guard_cmds) >= 1,
            "Expected at least one coo-lane-guard command in PreToolUse",
        )
        for cmd in guard_cmds:
            self.assertRegex(
                cmd,
                r"python3\s+/",
                f"coo-lane-guard command must use absolute path: {cmd!r}",
            )

    def test_coo_lane_guard_fires_on_edit_matcher(self):
        """coo-lane-guard must fire on the Edit matcher."""
        data = self._load()
        hooks_list = data.get("hooks", {}).get("PreToolUse", [])
        edit_blocks = [
            b for b in hooks_list
            if re.search(r"\bEdit\b", str(b.get("matcher", "")))
        ]
        found = any(
            "coo-lane-guard" in hook.get("command", "")
            for b in edit_blocks
            for hook in b.get("hooks", [])
        )
        self.assertTrue(
            found,
            f"No coo-lane-guard entry with an Edit matcher found. "
            f"PreToolUse blocks: {json.dumps(hooks_list, indent=2)}",
        )

    def test_coo_lane_guard_fires_on_write_matcher(self):
        """coo-lane-guard must fire on the Write matcher."""
        data = self._load()
        hooks_list = data.get("hooks", {}).get("PreToolUse", [])
        write_blocks = [
            b for b in hooks_list
            if re.search(r"\bWrite\b", str(b.get("matcher", "")))
        ]
        found = any(
            "coo-lane-guard" in hook.get("command", "")
            for b in write_blocks
            for hook in b.get("hooks", [])
        )
        self.assertTrue(
            found,
            f"No coo-lane-guard entry with a Write matcher found. "
            f"PreToolUse blocks: {json.dumps(hooks_list, indent=2)}",
        )

    def test_coo_lane_guard_fires_on_bash_matcher(self):
        """coo-lane-guard must fire on the Bash matcher."""
        data = self._load()
        hooks_list = data.get("hooks", {}).get("PreToolUse", [])
        bash_blocks = [
            b for b in hooks_list
            if re.search(r"\bBash\b", str(b.get("matcher", "")))
        ]
        found = any(
            "coo-lane-guard" in hook.get("command", "")
            for b in bash_blocks
            for hook in b.get("hooks", [])
        )
        self.assertTrue(
            found,
            f"No coo-lane-guard entry with a Bash matcher found. "
            f"PreToolUse blocks: {json.dumps(hooks_list, indent=2)}",
        )


class TestCooLaneGuardWiringAC3WatchdogPreserved(unittest.TestCase):
    """AC3: existing watchdog_wrap.py Bash entry must still be present."""

    def test_watchdog_wrap_bash_entry_still_present(self):
        """The watchdog_wrap.py hook on Bash must not be clobbered."""
        with open(SETTINGS_PATH) as f:
            data = json.load(f)
        hooks_list = data.get("hooks", {}).get("PreToolUse", [])
        bash_blocks = [
            b for b in hooks_list
            if re.search(r"\bBash\b", str(b.get("matcher", "")))
        ]
        found = any(
            "watchdog_wrap" in hook.get("command", "")
            for b in bash_blocks
            for hook in b.get("hooks", [])
        )
        self.assertTrue(
            found,
            f"watchdog_wrap.py Bash hook was clobbered or is missing. "
            f"PreToolUse blocks: {json.dumps(hooks_list, indent=2)}",
        )


class TestCooLaneGuardWiringAC4BakExists(unittest.TestCase):
    """AC4: a timestamped .bak-YYYYMMDD-HHMMSS file must exist alongside the global settings.json.

    The project-level settings.json bak is gitignored (*.bak-* in .gitignore) and cannot
    be committed. The relevant config-hygiene backup lives alongside the GLOBAL settings.json
    at ~/.claude/settings.json.bak-YYYYMMDD-HHMMSS.
    """

    def test_bak_file_exists_with_timestamp_format(self):
        """A .bak-YYYYMMDD-HHMMSS backup file must exist next to the global settings.json."""
        pattern = os.path.join(GLOBAL_SETTINGS_DIR, "settings.json.bak-[0-9]*")
        matches = glob.glob(pattern)
        self.assertTrue(
            len(matches) >= 1,
            f"No settings.json.bak-* file found in {GLOBAL_SETTINGS_DIR}. "
            "Config-hygiene requires a timestamped backup before rewriting settings.json. "
            "Note: the worktree bak is gitignored; check the global ~/.claude/ directory.",
        )
        # Verify at least one matches the strict YYYYMMDD-HHMMSS format
        ts_re = re.compile(r"settings\.json\.bak-\d{8}-\d{6}$")
        valid = [m for m in matches if ts_re.search(os.path.basename(m))]
        self.assertTrue(
            len(valid) >= 1,
            f"Found backup files {matches} but none match the "
            f"settings.json.bak-YYYYMMDD-HHMMSS format required by config-hygiene.",
        )


if __name__ == "__main__":
    unittest.main()
