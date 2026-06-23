#!/usr/bin/env python3
"""
watchdog_read.py -- PostToolUse hook: reads watchdog status files and surfaces
per-task telemetry into the launching context after each Bash tool call.

Reads a PostToolUse event JSON on stdin. Derives a key from agent_id||session_id,
globs /tmp/claude-watchdog/<key>/*.json for task status files, computes elapsed
and idle time for each, snapshots ps for running pids, and emits a compact one-
line-per-task additionalContext block.

SUPPRESSES output entirely when no task files exist or all are stale-finished
(so idle contexts see nothing).

Loud line on non-zero exit (EXITED <code>) and on running+idle>WEDGE_SECS+cpu~0
(possibly wedged, verify).

FAIL-OPEN: on any error, exits 0 with no output. A hook bug must never block a
Bash tool call from completing.

Usage (invoked by the harness, stdin = PostToolUse event JSON):
    watchdog_read.py [--verbose]
"""

import glob
import json
import os
import subprocess
import sys
import time
from typing import Optional

STATEDIR_BASE = "/tmp/claude-watchdog"
WEDGE_SECS = 300  # idle threshold to consider a running task possibly wedged
CPU_ZERO_THRESHOLD = 0.5  # %cpu below this is treated as "cpu~0" for wedge check


def _verbose(msg: str, verbose: bool) -> None:
    if verbose:
        print(f"[watchdog_read] {msg}", file=sys.stderr, flush=True)


def _ps_cpu(pid: int, verbose: bool) -> Optional[float]:
    """
    Snapshot cpu% for a pid via `ps -o %cpu= -p <pid>`.
    Returns None if ps fails (pid gone, permission error, etc.).
    """
    try:
        result = subprocess.run(
            ["ps", "-o", "%cpu=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=3,
        )
        out = result.stdout.strip()
        if out:
            return float(out.split()[0])
        return None
    except Exception as exc:
        _verbose(f"ps failed for pid={pid}: {exc!r}", verbose)
        return None


def _format_elapsed(seconds: float) -> str:
    """Format elapsed seconds as a compact human string."""
    s = int(seconds)
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m{s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m"


def _build_line(status: dict, now: float, verbose: bool) -> Optional[str]:
    """
    Build a single compact telemetry line for one task status file.
    Returns None if the task should be suppressed (stale-finished with exit_code=0).
    """
    state = status.get("state", "unknown")
    exit_code = status.get("exit_code")
    pid = status.get("pid")
    command = status.get("command", "?")
    start_ts = status.get("start_ts", now)
    last_output_ts = status.get("last_output_ts", start_ts)

    elapsed = now - start_ts
    idle = now - last_output_ts

    # Suppress clean-finished tasks (state=exited, exit_code=0) to keep output quiet
    # for benign completed background work.
    if state == "exited" and exit_code == 0:
        return None

    taskid_hint = (command[:30] + "...") if len(command) > 30 else command

    if state == "running":
        cpu = _ps_cpu(pid, verbose) if pid else None
        cpu_str = f" cpu={cpu:.1f}%" if cpu is not None else ""
        parts = [f"running {_format_elapsed(elapsed)}{cpu_str}  [{taskid_hint}]"]

        # Wedge check: idle > threshold AND cpu is ~0 (or ps failed = pid gone)
        cpu_is_zero = cpu is None or cpu < CPU_ZERO_THRESHOLD
        if idle > WEDGE_SECS and cpu_is_zero:
            parts.append(f"idle={_format_elapsed(idle)} -- possibly wedged, verify")

        return "  ".join(parts)

    elif state in ("exited", "signaled"):
        return f"EXITED {exit_code}  [{taskid_hint}]  elapsed={_format_elapsed(elapsed)}"

    else:
        # Unknown state -- surface it
        return f"state={state} exit_code={exit_code}  [{taskid_hint}]"


def _wedge_watch(key: str, verbose: bool) -> int:
    """
    --wedge-watch mode: proactive scan for wedged tasks.

    Scans /tmp/claude-watchdog/<key>/*.json for any task with:
      state=running, idle > WEDGE_SECS, cpu~0 (or pid gone)

    Exits 2 with a plain 'possibly wedged' telemetry line on STDERR when a
    wedge is detected. asyncRewake reads 'stderr || stdout' for the model-
    visible rewake body (confirmed empirically: CC harness v2.1.177, 2026-06-
    15; a PostToolUse hook with asyncRewake:true exiting 2 wakes the launching
    context with its stderr as a system reminder -- stdout is the fallback
    channel only). Writing to stderr is the primary channel per spec edgeCase:
    'ensure the wedge line is on stderr (or stdout fallback per the field's
    contract)'. Exits 0 with no output when all tasks look healthy or no tasks
    exist.

    This mode does NOT emit hookSpecificOutput JSON -- it emits a plain text
    line so the asyncRewake rewakeMessage is the telemetry directly.

    Spike result (asyncRewake confirmed: YES):
      asyncRewake:true on a PostToolUse hook + exit code 2 wakes the model.
      The rewakeMessage field in hooks.json is the static user-visible TUI
      message; the dynamic model-visible body is the hook's stderr (with
      stdout as fallback when stderr is empty). Source: security_reminder_
      hook.py:240-244 in-repo documentation + COO empirical confirmation
      prior to this chunk's dispatch.
    """
    statedir = os.path.join(STATEDIR_BASE, key)
    _verbose(f"[wedge-watch] key={key!r} statedir={statedir!r}", verbose)

    if not os.path.isdir(statedir):
        _verbose("[wedge-watch] statedir absent -> exit 0 silent", verbose)
        return 0

    pattern = os.path.join(statedir, "*.json")
    files = sorted(glob.glob(pattern))
    if not files:
        _verbose("[wedge-watch] no status files -> exit 0 silent", verbose)
        return 0

    now = time.time()
    wedged_lines = []
    for fpath in files:
        try:
            with open(fpath) as fh:
                status = json.load(fh)
        except Exception as exc:
            _verbose(f"[wedge-watch] failed to load {fpath!r}: {exc!r}", verbose)
            continue

        state = status.get("state", "unknown")
        if state != "running":
            _verbose(f"[wedge-watch] {os.path.basename(fpath)}: state={state!r} -> skip", verbose)
            continue

        pid = status.get("pid")
        start_ts = status.get("start_ts", now)
        last_output_ts = status.get("last_output_ts", start_ts)
        command = status.get("command", "?")
        elapsed = now - start_ts
        idle = now - last_output_ts

        if idle <= WEDGE_SECS:
            _verbose(
                f"[wedge-watch] {os.path.basename(fpath)}: idle={idle:.0f}s <= {WEDGE_SECS}s -> healthy",
                verbose,
            )
            continue

        # idle > WEDGE_SECS: check cpu
        cpu = _ps_cpu(pid, verbose) if pid else None
        cpu_is_zero = cpu is None or cpu < CPU_ZERO_THRESHOLD
        if not cpu_is_zero:
            _verbose(
                f"[wedge-watch] {os.path.basename(fpath)}: idle>{WEDGE_SECS}s but cpu={cpu:.1f}% -> not wedged",
                verbose,
            )
            continue

        taskid_hint = (command[:30] + "...") if len(command) > 30 else command
        line = (
            f"running {_format_elapsed(elapsed)}  [{taskid_hint}]  "
            f"idle={_format_elapsed(idle)} -- possibly wedged, verify"
        )
        _verbose(f"[wedge-watch] WEDGE DETECTED: {line}", verbose)
        wedged_lines.append(line)

    if not wedged_lines:
        _verbose("[wedge-watch] no wedged tasks -> exit 0 silent", verbose)
        return 0

    # Exit 2 so asyncRewake fires; emit telemetry lines on stderr.
    # asyncRewake reads 'stderr || stdout' for the model-visible body; stderr
    # is the primary channel per spec edgeCase and in-repo documentation
    # (security_reminder_hook.py:240-244).
    print("\n".join(wedged_lines), file=sys.stderr)
    return 2


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    verbose = "--verbose" in argv
    wedge_watch = "--wedge-watch" in argv

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception as exc:
        _verbose(f"stdin not valid JSON ({exc!r}) -> fail-open, no output", verbose)
        return 0

    # Derive key: agent_id takes precedence (subagents keep distinct statedirs).
    # Sanitise with basename to prevent path-traversal (e.g. key="../../etc").
    raw_key = payload.get("agent_id") or payload.get("session_id") or "default"
    key = os.path.basename(str(raw_key)) or "default"

    if wedge_watch:
        return _wedge_watch(key, verbose)

    _verbose(f"key={key!r} statedir={os.path.join(STATEDIR_BASE, key)!r}", verbose)
    statedir = os.path.join(STATEDIR_BASE, key)

    # Glob all *.json status files
    if not os.path.isdir(statedir):
        _verbose("statedir absent -> suppress output", verbose)
        return 0

    pattern = os.path.join(statedir, "*.json")
    files = sorted(glob.glob(pattern))
    if not files:
        _verbose("no status files -> suppress output", verbose)
        return 0

    now = time.time()
    lines = []
    for fpath in files:
        try:
            with open(fpath) as fh:
                status = json.load(fh)
        except Exception as exc:
            _verbose(f"failed to load {fpath!r}: {exc!r}", verbose)
            continue

        line = _build_line(status, now, verbose)
        if line is not None:
            lines.append(line)
        else:
            _verbose(f"suppressed (clean exit) {os.path.basename(fpath)}", verbose)

    if not lines:
        _verbose("all tasks suppressed -> no output", verbose)
        return 0

    additional_context = "\n".join(lines)
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": additional_context,
        }
    }
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
