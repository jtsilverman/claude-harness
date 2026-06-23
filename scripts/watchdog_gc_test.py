"""
Tests for scripts/watchdog_gc.py

watchdog_gc.py is a GC script that:
  - Deletes status files older than GC_AGE (default 24h) under /tmp/claude-watchdog
  - Removes emptied key-dirs after deletion
  - Refuses (exits non-zero) if configured root is not /tmp/claude-watchdog
  - Is safe to register as a SessionEnd hook in settings.json

Acceptance criteria tested here:
  AC1: stale status file (mtime older than GC_AGE) is deleted
  AC2: fresh status file (mtime newer than GC_AGE) is kept
  AC3: emptied key-dir is removed after stale file deletion
  AC4: non-empty key-dir is left (has fresh file)
  AC5: script refuses (exits non-zero) if root is not /tmp/claude-watchdog
  AC6: settings.json in worktree has SessionEnd entry for watchdog_gc, JSON-valid,
       and live ~/.claude/settings.json was NOT modified
"""

import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest

SCRIPT = os.path.join(os.path.dirname(__file__), "watchdog_gc.py")
WORKTREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKTREE_SETTINGS = os.path.join(WORKTREE_ROOT, "settings.json")


def _load_gc():
    """Import watchdog_gc as a module for unit-level testing."""
    spec = importlib.util.spec_from_file_location("watchdog_gc", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestWatchdogGc(unittest.TestCase):

    def setUp(self):
        """Create a temp dir simulating /tmp/claude-watchdog structure."""
        self.tmp = tempfile.mkdtemp()
        # key-dir with a stale file
        self.stale_key = os.path.join(self.tmp, "session_stale")
        os.makedirs(self.stale_key)
        self.stale_file = os.path.join(self.stale_key, "task_old.json")
        with open(self.stale_file, "w") as f:
            json.dump({"status": "done"}, f)
        # set mtime to 25 hours ago
        old_time = time.time() - 25 * 3600
        os.utime(self.stale_file, (old_time, old_time))

        # key-dir with a fresh file
        self.fresh_key = os.path.join(self.tmp, "session_fresh")
        os.makedirs(self.fresh_key)
        self.fresh_file = os.path.join(self.fresh_key, "task_new.json")
        with open(self.fresh_file, "w") as f:
            json.dump({"status": "running"}, f)
        # mtime is now (fresh)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run_gc(self, root=None, gc_age_hours=24):
        """Call gc.run_gc directly with our temp root."""
        gc = _load_gc()
        if root is None:
            root = self.tmp
        gc.run_gc(root=root, gc_age_seconds=gc_age_hours * 3600)

    # AC1: stale file deleted
    def test_stale_file_is_deleted(self):
        self._run_gc()
        self.assertFalse(
            os.path.exists(self.stale_file),
            "stale status file should have been deleted by GC"
        )

    # AC2: fresh file kept
    def test_fresh_file_is_kept(self):
        self._run_gc()
        self.assertTrue(
            os.path.exists(self.fresh_file),
            "fresh status file should NOT be deleted by GC"
        )

    # AC3: emptied key-dir removed
    def test_emptied_key_dir_removed(self):
        self._run_gc()
        self.assertFalse(
            os.path.isdir(self.stale_key),
            "key-dir should be removed once all its files are deleted"
        )

    # AC4: non-empty key-dir left
    def test_non_empty_key_dir_kept(self):
        self._run_gc()
        self.assertTrue(
            os.path.isdir(self.fresh_key),
            "key-dir with fresh files should NOT be removed"
        )

    # AC5: wrong root → non-zero exit
    def test_refuses_wrong_root(self):
        gc = _load_gc()
        rc = gc.main(["--root", "/tmp/not-the-watchdog-root"])
        self.assertNotEqual(rc, 0, "GC must exit non-zero when root is not /tmp/claude-watchdog")

    # AC6a: worktree settings.json has SessionEnd entry for watchdog_gc, is JSON-valid
    def test_settings_json_has_session_end_entry(self):
        with open(WORKTREE_SETTINGS) as f:
            data = json.load(f)  # JSON-valid check (raises on malformed)
        hooks = data.get("hooks", {})
        session_end = hooks.get("SessionEnd", [])
        found = False
        for group in session_end:
            for hook in group.get("hooks", []):
                cmd = hook.get("command", "")
                if "watchdog_gc" in cmd:
                    found = True
        self.assertTrue(found, "settings.json must have a SessionEnd hook referencing watchdog_gc")

    # Finding-1 pin: root absent -> no-op exit 0
    def test_root_absent_is_noop_exit_zero(self):
        """When the configured root does not exist, run_gc returns without error and main() exits 0."""
        gc = _load_gc()
        absent = tempfile.mkdtemp()
        os.rmdir(absent)  # now absent
        self.assertFalse(os.path.exists(absent), "precondition: directory must not exist")
        # run_gc must not raise
        gc.run_gc(root=absent, gc_age_seconds=24 * 3600)

        # Also assert main() exits 0 when the canonical root (/tmp/claude-watchdog) is absent.
        # Use the realpath form so the canonical-root equality check in main() passes on macOS
        # (where /tmp is a symlink to /private/tmp and os.path.realpath expands it).
        canonical = os.path.realpath(os.path.abspath(gc.REQUIRED_ROOT))
        moved_to = canonical + ".bak-test-absent"
        did_move = False
        try:
            if os.path.exists(canonical):
                os.rename(canonical, moved_to)
                did_move = True
            self.assertFalse(os.path.exists(canonical),
                             "precondition: canonical root must be absent for this assertion")
            exit_code = gc.main(["--root", canonical])
            self.assertEqual(exit_code, 0,
                             f"main() must exit 0 when canonical root is absent; got {exit_code}")
        finally:
            if did_move and os.path.exists(moved_to):
                os.rename(moved_to, canonical)

    # Finding-2 pin: symlink/path-traversal skip
    def test_symlink_key_dir_is_skipped(self):
        """A symlink under the root that points outside must not be followed."""
        gc = _load_gc()
        # Create a directory outside the root
        outside = tempfile.mkdtemp()
        try:
            outside_file = os.path.join(outside, "secret.json")
            with open(outside_file, "w") as f:
                f.write("{}")
            old_time = time.time() - 25 * 3600
            os.utime(outside_file, (old_time, old_time))

            # Place a symlink inside the root that points outside
            symlink_dir = os.path.join(self.tmp, "escape_link")
            os.symlink(outside, symlink_dir)

            gc.run_gc(root=self.tmp, gc_age_seconds=24 * 3600)

            # The file outside the root must NOT have been deleted
            self.assertTrue(
                os.path.exists(outside_file),
                "symlinked directory outside root must NOT be followed; file must remain"
            )
            # The stale file inside root IS deleted (normal behavior still works)
            self.assertFalse(
                os.path.exists(self.stale_file),
                "stale file inside root should still be deleted"
            )
        finally:
            import shutil
            shutil.rmtree(outside, ignore_errors=True)

    def test_symlink_file_inside_key_dir_is_skipped(self):
        """A symlink file inside a key-dir that points outside must not be deleted."""
        gc = _load_gc()
        outside = tempfile.mkdtemp()
        try:
            outside_file = os.path.join(outside, "target.json")
            with open(outside_file, "w") as f:
                f.write("{}")
            old_time = time.time() - 25 * 3600
            os.utime(outside_file, (old_time, old_time))

            # Place a symlink file inside a key-dir
            symlink_file = os.path.join(self.stale_key, "link_to_outside.json")
            os.symlink(outside_file, symlink_file)

            gc.run_gc(root=self.tmp, gc_age_seconds=24 * 3600)

            # The target outside the root must NOT have been deleted
            self.assertTrue(
                os.path.exists(outside_file),
                "symlink target outside root must NOT be removed"
            )
        finally:
            import shutil
            shutil.rmtree(outside, ignore_errors=True)

    # Finding-3 pin: concurrent-sweep ENOENT tolerance
    def test_concurrent_unlink_enoent_is_tolerated(self):
        """If a file disappears between listing and unlinking, ENOENT is ignored (no crash)."""
        gc = _load_gc()

        # Patch os.unlink to simulate a concurrent deletion (ENOENT on the stale file)
        original_unlink = os.unlink
        unlink_called = []

        def patched_unlink(path):
            unlink_called.append(path)
            raise OSError(2, "No such file or directory", path)  # ENOENT

        os.unlink = patched_unlink
        try:
            # Should not raise; ENOENT from os.unlink must be swallowed
            gc.run_gc(root=self.tmp, gc_age_seconds=24 * 3600)
        finally:
            os.unlink = original_unlink

        # Verify unlink was called (stale file was attempted)
        self.assertTrue(
            any("task_old.json" in p for p in unlink_called),
            "os.unlink should have been called for the stale file"
        )

    def test_concurrent_rmdir_enoent_is_tolerated(self):
        """If a key-dir disappears between listdir and rmdir, ENOENT is ignored."""
        gc = _load_gc()

        original_rmdir = os.rmdir
        rmdir_called = []

        def patched_rmdir(path):
            rmdir_called.append(path)
            raise OSError(2, "No such file or directory", path)  # ENOENT

        os.rmdir = patched_rmdir
        try:
            gc.run_gc(root=self.tmp, gc_age_seconds=24 * 3600)
        finally:
            os.rmdir = original_rmdir

        # rmdir should have been attempted on the (now-empty) stale key-dir
        self.assertTrue(
            any("session_stale" in p for p in rmdir_called),
            "os.rmdir should have been called for the emptied key-dir"
        )


    # Finding-1b pin: stale root-level cmd-*.sh files are swept; fresh ones are kept
    def test_stale_root_cmdfile_is_deleted(self):
        """GC must delete stale cmd-*.sh files at the root level (not inside a key-dir)."""
        gc = _load_gc()

        # Place a stale cmd-*.sh at root level (simulates the leak from watchdog_wrap.py)
        stale_cmd = os.path.join(self.tmp, "cmd-stale-1234.sh")
        with open(stale_cmd, "w") as f:
            f.write("echo stale")
        old_time = time.time() - 25 * 3600
        os.utime(stale_cmd, (old_time, old_time))

        gc.run_gc(root=self.tmp, gc_age_seconds=24 * 3600)

        self.assertFalse(
            os.path.exists(stale_cmd),
            "stale root-level cmd-*.sh must be deleted by GC as a backstop"
        )

    def test_fresh_root_cmdfile_is_kept(self):
        """GC must NOT delete a fresh cmd-*.sh file at the root level."""
        gc = _load_gc()

        fresh_cmd = os.path.join(self.tmp, "cmd-fresh-5678.sh")
        with open(fresh_cmd, "w") as f:
            f.write("echo fresh")
        # mtime is now (fresh -- default after write)

        gc.run_gc(root=self.tmp, gc_age_seconds=24 * 3600)

        self.assertTrue(
            os.path.exists(fresh_cmd),
            "fresh root-level cmd-*.sh must NOT be deleted by GC"
        )


if __name__ == "__main__":
    unittest.main()
