#!/usr/bin/env python3
"""
watchdog_gc.py -- SessionEnd hook: garbage-collect stale watchdog status files.

Deletes status files older than GC_AGE (default 24h) strictly under
/tmp/claude-watchdog, then removes any key-dirs that become empty.

HARD CONSTRAINT: refuses to operate if the configured root does not resolve
to /tmp/claude-watchdog (exits non-zero).

FAIL-OPEN: individual unlink/rmdir races (ENOENT) are silently ignored so
concurrent sessions sweeping at the same time don't crash each other.

Usage (invoked by the harness on SessionEnd):
    watchdog_gc.py [--root ROOT] [--gc-age-hours N]
"""

import argparse
import os
import sys
import time

REQUIRED_ROOT = os.path.realpath("/tmp/claude-watchdog")
DEFAULT_GC_AGE_HOURS = 24


def _log(verbose: bool, msg: str) -> None:
    """Print msg to stderr when verbose is enabled."""
    if verbose:
        print(f"[watchdog_gc] {msg}", file=sys.stderr)


def run_gc(root: str, gc_age_seconds: float, verbose: bool = False) -> None:
    """Delete status files older than gc_age_seconds under root, then clean empty dirs."""
    if not os.path.isdir(root):
        _log(verbose, f"root absent, nothing to do: {root}")
        return  # root absent -> no-op

    now = time.time()
    cutoff = now - gc_age_seconds
    _log(verbose, f"scanning root={root} cutoff_age={gc_age_seconds}s")

    # Backstop: sweep stale cmd-*.sh files at the root level.
    # These are written by watchdog_wrap.py via tempfile.mkstemp(dir=root) and
    # should be unlinked by watchdog_run.py after consuming them; this pass cleans
    # up any that survived a crash before the unlink.
    for root_name in os.listdir(root):
        if not root_name.startswith("cmd-"):
            continue
        root_entry = os.path.join(root, root_name)
        if os.path.islink(root_entry) or not os.path.isfile(root_entry):
            _log(verbose, f"skipping non-regular root entry: {root_entry}")
            continue
        try:
            mtime = os.stat(root_entry).st_mtime
        except OSError:
            _log(verbose, f"stat race (already gone): {root_entry}")
            continue
        if mtime < cutoff:
            _log(verbose, f"deleting stale root cmd-file (age={now - mtime:.0f}s): {root_entry}")
            try:
                os.unlink(root_entry)
            except OSError as exc:
                _log(verbose, f"unlink race ignored: {root_entry}: {exc}")
        else:
            _log(verbose, f"keeping fresh root cmd-file (age={now - mtime:.0f}s): {root_entry}")

    for key_dir_name in os.listdir(root):
        key_dir = os.path.join(root, key_dir_name)
        if not os.path.isdir(key_dir):
            continue
        # Only follow real dirs, not symlinks that escape root
        if os.path.islink(key_dir):
            _log(verbose, f"skipping symlink key-dir: {key_dir}")
            continue

        for fname in os.listdir(key_dir):
            fpath = os.path.join(key_dir, fname)
            # Only delete regular files (no symlinks, no subdirs)
            if os.path.islink(fpath) or not os.path.isfile(fpath):
                _log(verbose, f"skipping non-regular entry: {fpath}")
                continue
            try:
                mtime = os.stat(fpath).st_mtime
            except OSError:
                _log(verbose, f"stat race (already gone): {fpath}")
                continue  # race: already gone
            if mtime < cutoff:
                _log(verbose, f"deleting stale file (age={now - mtime:.0f}s): {fpath}")
                try:
                    os.unlink(fpath)
                except OSError as exc:
                    _log(verbose, f"unlink race ignored: {fpath}: {exc}")
                    pass  # tolerate ENOENT from concurrent sweeps
            else:
                _log(verbose, f"keeping fresh file (age={now - mtime:.0f}s): {fpath}")

        # Remove the key-dir if it is now empty
        try:
            remaining = os.listdir(key_dir)
            if not remaining:
                _log(verbose, f"removing emptied key-dir: {key_dir}")
                os.rmdir(key_dir)
            else:
                _log(verbose, f"keeping non-empty key-dir ({len(remaining)} entries): {key_dir}")
        except OSError as exc:
            _log(verbose, f"rmdir race ignored: {key_dir}: {exc}")
            pass  # tolerate races


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="GC stale watchdog status files")
    parser.add_argument("--root", default=REQUIRED_ROOT,
                        help="Root directory (must be /tmp/claude-watchdog)")
    parser.add_argument("--gc-age-hours", type=float, default=DEFAULT_GC_AGE_HOURS,
                        help="Delete files older than this many hours (default 24)")
    parser.add_argument("--verbose", action="store_true",
                        help="Emit diagnostic trace to stderr (branch decisions + skips)")
    args = parser.parse_args(argv)

    # Safety check: resolve the provided root and require it equals REQUIRED_ROOT
    try:
        resolved = os.path.realpath(os.path.abspath(args.root))
    except Exception:
        print("[watchdog_gc] ERROR: cannot resolve root path", file=sys.stderr)
        return 1

    if resolved != REQUIRED_ROOT:
        print(
            f"[watchdog_gc] ERROR: root '{args.root}' resolves to '{resolved}', "
            f"which is not '{REQUIRED_ROOT}'. Refusing to operate.",
            file=sys.stderr,
        )
        return 1

    run_gc(root=resolved, gc_age_seconds=args.gc_age_hours * 3600, verbose=args.verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
