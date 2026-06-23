#!/usr/bin/env python3
"""
watchdog_run.py <statedir> <cmdfile>

Reads a shell command from <cmdfile>, runs it via bash -c, tees stdout+stderr
byte-identical to the real file descriptors, and maintains a live status JSON
at <statedir>/<taskid>.json with start/output/exit telemetry.

Re-exits with the child's exact exit code (128+signo for signal death).

Usage:
    watchdog_run.py [--verbose] <statedir> <cmdfile>
"""

import argparse
import json
import os
import select
import subprocess
import sys
import time


def _write_status(path: str, data: dict) -> None:
    """Atomically write status JSON: write to .tmp then rename."""
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


def _verbose(msg: str, verbose: bool) -> None:
    if verbose:
        print(f"[watchdog] {msg}", file=sys.stderr, flush=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verbose", action="store_true", help="emit diagnostic trace to stderr")
    parser.add_argument("statedir", help="directory to hold the status JSON file")
    parser.add_argument("cmdfile", help="file containing the shell command to run")
    args = parser.parse_args(argv)

    verbose = args.verbose
    statedir = args.statedir
    cmdfile = args.cmdfile

    # Read the command from cmdfile then unlink it -- the command is single-use
    # and is now held in memory; leaving the file leaks it permanently.
    # Tolerate ENOENT so a crashed-then-restarted supervisor doesn't fail.
    with open(cmdfile) as fh:
        command = fh.read().strip()
    try:
        os.unlink(cmdfile)
    except OSError:
        pass  # tolerate ENOENT or concurrent removal
    _verbose(f"command={command!r} cmdfile unlinked", verbose)

    # Derive taskid from cmdfile basename (strip extension)
    taskid = os.path.splitext(os.path.basename(cmdfile))[0]
    status_path = os.path.join(statedir, f"{taskid}.json")

    # Create statedir if absent
    os.makedirs(statedir, exist_ok=True)
    _verbose(f"statedir={statedir!r}  status_path={status_path!r}", verbose)

    start_ts = time.time()

    # Start the child process with separate pipes for stdout and stderr
    proc = subprocess.Popen(
        ["bash", "-c", command],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    _verbose(f"child pid={proc.pid}", verbose)

    # Write initial status
    status = {
        "pid": proc.pid,
        "command": command,
        "start_ts": start_ts,
        "last_output_ts": start_ts,
        "state": "running",
        "exit_code": None,
    }
    _write_status(status_path, status)

    # Tee stdout and stderr, updating last_output_ts on each chunk of output
    # We use select() to multiplex both pipes without blocking.
    stdout_fd = proc.stdout.fileno()
    stderr_fd = proc.stderr.fileno()
    open_fds = {stdout_fd, stderr_fd}

    while open_fds:
        readable, _, _ = select.select(list(open_fds), [], [])
        for fd in readable:
            chunk = os.read(fd, 4096)
            if chunk:
                if fd == stdout_fd:
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                else:
                    sys.stderr.buffer.write(chunk)
                    sys.stderr.buffer.flush()
                # Update last_output_ts on any output
                status["last_output_ts"] = time.time()
                _write_status(status_path, status)
                _verbose(f"output on fd={fd} len={len(chunk)} last_output_ts={status['last_output_ts']}", verbose)
            else:
                # EOF on this fd
                open_fds.discard(fd)

    proc.wait()
    returncode = proc.returncode
    _verbose(f"child exited returncode={returncode}", verbose)

    # Determine state and exit_code
    if returncode < 0:
        # Python reports signal death as negative returncode (-signo)
        signo = -returncode
        exit_code = 128 + signo
        state = "signaled"
        _verbose(f"child killed by signal {signo}  exit_code={exit_code}", verbose)
    else:
        exit_code = returncode
        state = "exited"

    status["state"] = state
    status["exit_code"] = exit_code
    _write_status(status_path, status)
    _verbose(f"status written: state={state}  exit_code={exit_code}", verbose)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
