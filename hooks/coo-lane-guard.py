#!/usr/bin/env python3
"""
coo-lane-guard.py -- a PreToolUse hook that warns the MAIN COO session when it is
about to leave its lane (do a builder's job at the keystroke moment), without ever
blocking the call.

WHY THIS EXISTS: coo-sop §1 (the COO lane / no-hand-edit rule) and §5 (the merge
sequence) were rewritten 3x/6x by the redesigner and STILL recur, because the root
cause is execution discipline at the keystroke moment, not doc clarity. Prose is
the wrong lever. This hook is the just-in-time reminder that fires AT the action.

CONTRACT (warn-and-allow):
  - Reads a PreToolUse event JSON on stdin.
  - Exits 0 ALWAYS. A misclassification at worst annoys; it never corrupts. This is
    NOT a permissionDecision/deny hook (hard-blocking is an explicit non-goal).
  - Emits a non-blocking reminder ONLY when BOTH hold:
      (1) the call comes from the MAIN COO session -- agent_id ABSENT or empty
          (subagents, i.e. the build-agents, carry a non-empty agent_id and are
          the legitimate code-editors; they must stay silent), AND
      (2) the call matches a gated §1/§5 class (below).
  - On each emitted reminder, appends ONE line to the violation log (timestamp,
    tool, matched-class, brief path/cmd): the tuning signal that counters
    reminder-blindness and the substrate for a later escalation-after-N. Logging
    NEVER blocks and NEVER crashes the call: a log-write failure is swallowed and
    the reminder still fires (the warn matters more than the log).

EMISSION FIELD (pinned by the c4 RED probe against the live harness):
    hookSpecificOutput.additionalContext  (stdout JSON, exit 0)
This is the same non-blocking-reminder channel used by post-plan-sop-reminder.sh,
session-start.sh, and watchdog_read.py -- distinct from the BLOCKING
permissionDecision+systemMessage channel (a non-goal here). Verdict source:
in-repo confirmation (hooks/post-plan-sop-reminder.sh:32-51, scripts/watchdog_read.py:271-279)
plus the watchdog spec's settled additionalContext routing.

GATED CLASSES (WRITE is gated, READ is free -- P6):
  §1 (COO lane): the gate fires on a WRITE of a build artifact, never on a read.
    - Edit/Write of a code/test/skill/impl-doc path:
        *.py *.js *.mjs *.ts, *_test.*, skills/**, agents/**, disciplines/**,
        workflows/**
    - Bash that git-commits a code-class path.
    A read-only RUN of project code (a suite run like `python3 -m pytest` or
    `node --test`, a script, a diff) is the COO READING to learn the state;
    observation bypasses no gate, so it is NOT gated.
  §5 (merge sequence):
    - Bash that hand-rolls a chunk merge: `git rebase`, `git merge --ff-only`, or
      `git checkout <ref> --` against a chunk branch.

ALWAYS SILENT (no gate fires, even from the main session):
  - agent_id present (subagent).
  - Edit/Write paths: specs/current.md, specs/owed-items.md, coo/reader-model.md,
    coo/voice-corpus.md, anything under ~/Documents/brain/. A code-class path that
    lives under ~/Documents/brain is the WIKI, not repo code -> allowlist wins.
  - Bash that is not a gated WRITE: a suite RUN (`python3 -m pytest`, `node --test`),
    a script RUN (`python3 scripts/merge_engine.py merge ...`, context_cycle.sh,
    codex-review.sh, grader/ship workflows), a read-only git/journalctl/systemctl,
    `git worktree remove`, `git branch -d`.  These are READS -- they match no gate
    and fall through silently (P6); no explicit allowlist is needed.

FAIL-OPEN: empty/malformed stdin -> exit 0 silent. A hook bug must never crash a
tool call.

Usage (invoked by the harness, stdin = PreToolUse event JSON):
    coo-lane-guard.py [--verbose]
"""

import datetime
import json
import os
import re
import shlex
import sys

# Log destination. COO_LANE_GUARD_LOG overrides for tests / relocation; otherwise
# state/coo-lane-guard-violations.log relative to the repo root (this hook's
# parent's parent: hooks/ -> repo root).
_DEFAULT_LOG = os.path.join(
    os.path.dirname(os.path.dirname(os.path.realpath(__file__))),
    "state",
    "coo-lane-guard-violations.log",
)

# --- Path classification -----------------------------------------------------

# Allowlisted exact paths (basename-or-suffix match): board + COO-owned writable
# surfaces the COO legitimately edits by hand.
_ALLOWLIST_PATH_SUFFIXES = (
    "specs/current.md",
    "specs/owed-items.md",
    "coo/reader-model.md",
    "coo/voice-corpus.md",
)

# Anything under the wiki vault is the wiki, not repo code -> always silent.
_BRAIN_DIR = os.path.expanduser("~/Documents/brain")

# Code/test/skill/impl-doc path classes (the §1 Edit/Write gate).
_CODE_EXT_RE = re.compile(r"\.(py|js|mjs|ts)$")
_TEST_FILE_RE = re.compile(r"_test\.[^/]+$")
_CODE_DIR_RE = re.compile(r"(?:^|/)(skills|agents|disciplines|workflows)/")

# --- Bash classification -----------------------------------------------------

# No Bash allowlist is needed: the only gated Bash classes are §5 hand-rolled
# merges and §1 git-commits of code.  A read-only RUN of project code (a suite
# run, a script, a diff, journalctl/systemctl, a sanctioned merge_engine.py or
# ship-workflow invocation) is a READ -- it matches no gate and is silent by
# fall-through (P6: WRITE is gated, READ is free).  The former run-gate + its
# board-primitive/read-only-git allowlist are deleted with it.

# §5 hand-rolled chunk merge.
_BASH_MERGE_RES = (
    (re.compile(r"\bgit\s+rebase\b"), "merge:git-rebase"),
    (re.compile(r"\bgit\s+merge\s+--ff-only\b"), "merge:git-merge-ff-only"),
    (re.compile(r"\bgit\s+checkout\b.*\s--\s"), "merge:git-checkout-ref"),
)

# §1 WRITE gate: a git commit naming a code-class path.  A read-only RUN of
# project code (`python3 -m ...`, `python3 scripts/foo.py`, `node --test`) is a
# READ, not a WRITE, and is NOT gated (P6: WRITE is gated, READ is free).
_BASH_COMMIT_RE = re.compile(r"\bgit\s+commit\b")


def _verbose(msg, verbose):
    if verbose:
        print(f"[coo-lane-guard] {msg}", file=sys.stderr, flush=True)


def _is_main_session(payload):
    """True when the call is from the main COO session (agent_id absent or empty).

    A subagent (the build-agent) carries a non-empty agent_id; an empty-string
    agent_id is treated as the main session (pinned decision: empty == absent).
    """
    return not str(payload.get("agent_id") or "").strip()


def _path_is_allowlisted(path):
    """True when an Edit/Write target is an allowlisted (silent) path."""
    norm = path.replace("\\", "/")
    real = os.path.realpath(os.path.expanduser(norm))
    # Wiki vault wins over any code-class extension.
    if real == _BRAIN_DIR or real.startswith(_BRAIN_DIR + os.sep):
        return True
    return any(norm.endswith(suf) for suf in _ALLOWLIST_PATH_SUFFIXES)


def _path_is_code_class(path):
    """True when an Edit/Write target is a gated code/test/skill/impl-doc path."""
    norm = path.replace("\\", "/")
    if _CODE_EXT_RE.search(norm):
        return True
    if _TEST_FILE_RE.search(norm):
        return True
    if _CODE_DIR_RE.search(norm):
        return True
    return False


def _classify_edit_write(tool_input, verbose):
    """Return (matched_class, brief) for a gated Edit/Write, else (None, '')."""
    path = tool_input.get("file_path")
    if not isinstance(path, str) or not path:
        return None, ""
    if _path_is_allowlisted(path):
        _verbose(f"path allowlisted -> silent: {path}", verbose)
        return None, ""
    if _path_is_code_class(path):
        _verbose(f"code-class path -> reminder: {path}", verbose)
        return "edit:code-class", path
    _verbose(f"path not a gated class -> silent: {path}", verbose)
    return None, ""


def _classify_bash(command, verbose):
    """Return (matched_class, brief) for a gated Bash WRITE, else (None, '').

    Only WRITES are gated (P6): a §5 hand-rolled merge or a §1 git-commit of a
    code-class path.  A read-only RUN of project code matches no gate and is
    silent by fall-through.
    """
    # §5 hand-rolled chunk merge.
    for rx, cls in _BASH_MERGE_RES:
        if rx.search(command):
            _verbose(f"bash §5 merge ({rx.pattern!r}) -> reminder", verbose)
            return cls, command[:200]

    # §1 git commit naming a code-class path.
    if _BASH_COMMIT_RE.search(command) and _commit_touches_code(command):
        _verbose("bash §1 git-commit-of-code -> reminder", verbose)
        return "commit:code-class", command[:200]

    return None, ""


def _commit_touches_code(command):
    """True when a `git commit ...` command names at least one code-class path.

    A commit naming only board files is allowed; one naming any code-class path
    (even alongside a board file) warns -- code-class presence wins.

    The commit message text (the argument to -m/--message) and the message-file
    path (the argument to -F/--file) are excluded from the scan: words inside the
    message that happen to look like code paths are not path arguments.

    Uses shlex.split to honour shell quoting (a quoted multi-word -m message is
    one token, not several), falling back to str.split on shlex parse errors.
    """
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    skip_next = False
    for tok in tokens:
        if skip_next:
            skip_next = False
            continue
        # Skip the value that follows -m / --message / -F / --file.
        if tok in ("-m", "--message", "-F", "--file"):
            skip_next = True
            continue
        # Skip inline --message=<value> and --file=<value> forms.
        if tok.startswith("--message=") or tok.startswith("--file="):
            continue
        if _path_is_code_class(tok) and not _path_is_allowlisted(tok):
            return True
    return False


def _classify(payload, verbose):
    """Return (matched_class, brief) for a gated call, else (None, '').

    Subagent calls (agent_id present) are silent regardless of class.
    """
    if not _is_main_session(payload):
        _verbose("subagent (agent_id present) -> silent", verbose)
        return None, ""

    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None, ""

    if tool_name in ("Edit", "Write"):
        return _classify_edit_write(tool_input, verbose)
    if tool_name == "Bash":
        command = tool_input.get("command")
        if not isinstance(command, str) or not command:
            return None, ""
        return _classify_bash(command, verbose)

    return None, ""


def _append_log(tool_name, matched_class, brief, verbose):
    """Append ONE violation line. Never raises; a write failure is swallowed."""
    log_path = os.environ.get("COO_LANE_GUARD_LOG") or _DEFAULT_LOG
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        ts = datetime.datetime.now().isoformat(timespec="seconds")
        # One line, tab-separated, brief flattened so the line stays single.
        flat = brief.replace("\n", " ").replace("\t", " ")
        with open(log_path, "a") as fh:
            fh.write(f"{ts}\t{tool_name}\t{matched_class}\t{flat}\n")
        _verbose(f"logged -> {log_path}", verbose)
    except Exception as exc:  # log-write failure: swallow, the warn matters more
        _verbose(f"log write failed ({exc!r}) -> swallowed", verbose)


def _emit_reminder(matched_class, brief):
    """Print the non-blocking reminder via hookSpecificOutput.additionalContext."""
    msg = (
        "COO LANE GUARD (coo-sop §1/§5, warn-and-allow): this looks like a build-artifact "
        f"WRITE (an edit/commit of code) or a hand-rolled merge from the MAIN COO session "
        f"[{matched_class}: {brief[:120]}]. WRITE is gated; READ is free (a suite run, a diff, "
        "a script does NOT fire this guard). "
        "The COO orchestrates; it does NOT hand-edit code or hand-roll merges. "
        "If this is code/test/skill/impl-doc work, dispatch a build-agent (worker-pipeline). "
        "If this is a chunk merge, use "
        "python3 scripts/merge_engine.py merge --repo <repo> --feature <feature> --chunk <chunk>, "
        "not a hand-rolled git rebase/merge/checkout. Proceeding anyway (this never blocks); "
        "if it is a legitimate COO op, ignore this."
    )
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": msg,
        }
    }
    print(json.dumps(output))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    verbose = "--verbose" in argv

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception as exc:  # fail-open: empty/malformed stdin -> silent
        _verbose(f"stdin not valid JSON ({exc!r}) -> fail-open, silent", verbose)
        return 0

    if not isinstance(payload, dict):
        _verbose("payload not an object -> fail-open, silent", verbose)
        return 0

    try:
        matched_class, brief = _classify(payload, verbose)
    except Exception as exc:  # fail-open: any classify error -> silent
        _verbose(f"classify error ({exc!r}) -> fail-open, silent", verbose)
        return 0

    if matched_class is None:
        return 0  # silent: gated class not matched, or subagent, or allowlisted

    # Emit the reminder, then log. The log is best-effort; the reminder is not.
    _emit_reminder(matched_class, brief)
    _append_log(payload.get("tool_name", "?"), matched_class, brief, verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
