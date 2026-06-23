#!/usr/bin/env python3
"""
watchdog_wrap.py -- a PreToolUse hook that transparently wraps backgrounded Bash.

Reads a PreToolUse event JSON on stdin. When (and only when) the tool is `Bash`
and `tool_input.run_in_background` is true, it rewrites the command so the real
run goes through the watchdog supervisor (`watchdog_run.py`, chunk 1), which
tees output byte-identically and maintains a live status JSON. Everything else --
foreground Bash, non-Bash tools, and any malformed/partial input -- passes
through untouched.

Rewrite shape (emitted via hookSpecificOutput.updatedInput):
    python3 <abs>/watchdog_run.py /tmp/claude-watchdog/<key> <cmdfile>
where <abs> is this hook's own directory (so the wrapper resolves to the same
scripts/ dir wherever the hook lives), <key> = agent_id || session_id || "default"
(a subagent keys its statedir on agent_id, so concurrent subagents never collide),
and <cmdfile> is a temp file holding the original command verbatim (quotes and
newlines survive the round-trip; they are NOT re-quoted onto a shell line).

run_in_background:true and every other tool_input field are preserved on the
updatedInput, so the harness still backgrounds the (now wrapped) command.

FAIL-OPEN is the cardinal rule: on ANY error -- malformed JSON, missing fields,
unwritable temp dir, anything -- the hook emits NO updatedInput and exits 0, so
the ORIGINAL command runs unwrapped. A watchdog bug must never block a command.

COLLISION NOTE: two PreToolUse rewriters that both emit updatedInput for Bash
would clobber each other (last writer wins). This is the ONLY PreToolUse Bash
rewriter registered; do not register a second without reconciling the chain.

Usage (invoked by the harness, stdin = event JSON):
    watchdog_wrap.py [--verbose]
"""

import json
import os
import shlex
import sys
import tempfile

STATEDIR_BASE = "/tmp/claude-watchdog"


def _verbose(msg, verbose):
    if verbose:
        print(f"[watchdog_wrap] {msg}", file=sys.stderr, flush=True)


def _build_updated_input(payload, verbose):
    """Return the updatedInput dict for a bg-Bash event, or None to pass through.

    Raises on any unexpected condition; the caller turns that into fail-open.
    """
    tool_name = payload.get("tool_name")
    if tool_name != "Bash":
        _verbose(f"tool_name={tool_name!r} is not Bash -> pass through", verbose)
        return None

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        _verbose("tool_input missing or not an object -> pass through", verbose)
        return None

    if tool_input.get("run_in_background") is not True:
        _verbose("run_in_background is not true (foreground) -> pass through", verbose)
        return None

    command = tool_input.get("command")
    if not isinstance(command, str):
        _verbose("command missing or not a string -> pass through", verbose)
        return None

    # Key the statedir on agent_id (subagent) first, then session_id, then a
    # fixed default. agent_id taking precedence keeps concurrent subagents in
    # distinct statedirs. Sanitize with basename (matching watchdog_read.py) to
    # prevent path-traversal and ensure writer and reader resolve the same dir.
    raw_key = payload.get("agent_id") or payload.get("session_id") or "default"
    key = os.path.basename(str(raw_key)) or "default"
    statedir = os.path.join(STATEDIR_BASE, key)

    # Write the original command verbatim to a temp cmdfile. The bytes are
    # preserved exactly -- quotes and newlines round-trip because they live in a
    # file, not on a re-quoted shell line.
    os.makedirs(STATEDIR_BASE, exist_ok=True)
    fd, cmdfile = tempfile.mkstemp(prefix="cmd-", suffix=".sh", dir=STATEDIR_BASE)
    with os.fdopen(fd, "w") as fh:
        fh.write(command)
    _verbose(f"key={key!r} statedir={statedir!r} cmdfile={cmdfile!r}", verbose)

    # <abs> = this hook's own directory, so the wrapper resolves to the sibling
    # watchdog_run.py wherever the hook is installed.
    here = os.path.dirname(os.path.realpath(__file__))
    runner = os.path.join(here, "watchdog_run.py")

    # Quote each path so the rewritten command is a well-formed shell line even
    # if a path ever contains a space. The cmdfile content itself is untouched.
    new_command = (
        f"python3 {shlex.quote(runner)} "
        f"{shlex.quote(statedir)} {shlex.quote(cmdfile)}"
    )

    # Preserve run_in_background:true and every other tool_input field; only the
    # command is replaced.
    updated = dict(tool_input)
    updated["command"] = new_command
    _verbose(f"wrapped command -> {new_command!r}", verbose)
    return updated


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    verbose = "--verbose" in argv

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception as exc:  # fail-open: malformed/empty stdin -> original runs
        _verbose(f"stdin not valid JSON ({exc!r}) -> fail-open, no updatedInput", verbose)
        return 0

    try:
        updated = _build_updated_input(payload, verbose)
    except Exception as exc:  # fail-open: any wrap error -> original runs
        _verbose(f"wrap error ({exc!r}) -> fail-open, no updatedInput", verbose)
        return 0

    if updated is None:
        return 0  # pass through: emit nothing

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "updatedInput": updated,
        }
    }
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
