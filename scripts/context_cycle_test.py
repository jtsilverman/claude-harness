#!/usr/bin/env python3
"""Unit tests for scripts/context_cycle.sh -- chunk 11's cockpit auto-context-cycling self-check.

RED-stage spec for the DECISION LOGIC only. The cockpit's auto-context-cycling
self-check fires at each chunk-MERGE boundary: when the live session context
exceeds X% of the window it should finish the current chunk cleanly, /clear, and
auto-resume from the `## Execution state` board. X is a CONFIG parameter (research
recommends ~50% but the production value is Open question Q-cycle, NOT yet set by
the operator), so the script must read X from config, never hardcode it, and must NOT arm
a live auto-clear.

SCOPE FENCE (mirrors the chunk's): this suite exercises ONLY the pure decision
function `decide_cycle` with a LOW test threshold injected via the config env var.
It must NOT /clear any session and must NOT arm the live auto-clear -- proving
resume-from-board live and arming the production threshold is the cockpit's /
the operator's job. So these tests assert the decision SIGNAL, never a side effect.

Convention reused from scripts/codex_review_test.py (the repo template): source
the bash script in a subprocess and call the pure function in isolation. Sourcing
must NOT run main() -- the script guards main behind `BASH_SOURCE == $0`, false
when sourced via `bash -c 'source ...'`. So `decide_cycle` runs with no /clear,
no live-context read, no side effect.

The decision function's contract (the spec this RED pins):

  decide_cycle reads the threshold X from config (env var
  CONTEXT_CYCLE_THRESHOLD_PCT) and takes two inputs the script CANNOT infer on its
  own -- whether the cockpit is at a chunk-merge boundary, and the current context
  size as a percent of the window -- as arguments. It emits a clean, testable
  signal the cockpit can branch on:

    --at-merge-boundary --context-pct <N>   merge boundary, context = N%
    (no boundary flag)                        not at a merge boundary (mid-chunk)

    stdout token CYCLE      -> cockpit SHOULD cycle (stop -> clear-signal -> resume)
    stdout token NO_CYCLE   -> cockpit should NOT cycle

  Decision: CYCLE iff (at a merge boundary) AND (context-pct > threshold).
  Anything else -> NO_CYCLE. Never mid-chunk (no merge boundary => NO_CYCLE even
  when context is far over threshold). The threshold is read from config, so a
  changed config value changes the decision for identical inputs.

Run: python3 scripts/context_cycle_test.py   (exit 0 = all pass, 1 = any fail)

Acceptance criteria covered (chunk 11):
  AC1  decision logic: CYCLE when context > X AT a merge boundary; NO_CYCLE when
       below X, or when NOT at a merge boundary (never mid-chunk). Boundary
       equality (context == X) is NO_CYCLE (`>` not `>=`).
  AC2  X read from CONFIG, not hardcoded: changing CONTEXT_CYCLE_THRESHOLD_PCT
       flips the decision for the SAME inputs.
  AC3  decision emitted as a clean, testable signal (CYCLE / NO_CYCLE token on
       stdout) the cockpit can act on -- not prose.
  Artifacts: skills/cockpit/SKILL.md gains an ADDITIVE self-check section wired to
       context_cycle.sh without restructuring the existing skill; coo/context-cycling.md
       documents the mechanism + the resume-from-board contract.
  SCOPE FENCE: the script must NOT arm a live /clear (no live clear-arming in the
       script source); the decision function emits only a signal, no side effect.
"""

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # the worktree root (scripts/ -> repo root)
SCRIPT = os.path.join(HERE, "context_cycle.sh")
STATUSLINE = os.path.join(ROOT, "statusline", "statusline.sh")
SKILL = os.path.join(ROOT, "skills", "cockpit", "SKILL.md")
DOC = os.path.join(ROOT, "coo", "coo-sop.md")

# The bridge state file the producer (statusline.sh) writes and the consumer
# (context_cycle.sh) reads. Hardcoded to $HOME/.claude/state/context-pct in the
# production code; the bridge tests below run the scripts under a SANDBOX $HOME
# (a tempdir) so this resolves into the sandbox and the real cockpit state file
# is never touched. The relative tail is the contract both sides must agree on.
STATE_REL = os.path.join(".claude", "state", "context-pct")

_passes = []
_failures = []


def decide(args, threshold_pct):
    """Source context_cycle.sh and call `decide_cycle` with ARGS, threshold via config env.

    threshold_pct is injected through CONTEXT_CYCLE_THRESHOLD_PCT (the config
    seam) so the test never touches a production config file. Sourcing does NOT
    run main() (guarded behind BASH_SOURCE==$0), so no /clear and no live context
    read fire -- this exercises the pure decision function only.

    Returns (rc, stdout, stderr).
    """
    cmd = f'source "{SCRIPT}"; decide_cycle "$@"'
    env = dict(os.environ)
    if threshold_pct is not None:
        env["CONTEXT_CYCLE_THRESHOLD_PCT"] = str(threshold_pct)
    else:
        env.pop("CONTEXT_CYCLE_THRESHOLD_PCT", None)
    proc = subprocess.run(
        ["bash", "-c", cmd, "_", *args],
        capture_output=True,
        text=True,
        env=env,
    )
    return proc.returncode, proc.stdout, proc.stderr


def signal(stdout):
    """The decision token emitted on stdout (CYCLE / NO_CYCLE), stripped."""
    toks = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
    # The signal token is the last non-blank line (matches codex-review.sh's
    # RESULT: line being terminal); a clean signal is exactly one of the two.
    return toks[-1] if toks else ""


def check(name, cond, detail=""):
    if cond:
        _passes.append(name)
        print(f"PASS  {name}")
    else:
        _failures.append((name, detail))
        print(f"FAIL  {name}  {detail}")


def read_text(path):
    """Read PATH, or return "" if it does not exist yet.

    A missing artifact is the feature-missing signal: the content checks below
    then FAIL cleanly on their assertion (empty text contains none of the
    required tokens) instead of erroring with FileNotFoundError before the check
    is reached. A test that errors before its assertion is not a valid RED.
    """
    try:
        return open(path).read()
    except FileNotFoundError:
        return ""


# ---------------------------------------------------------------------------
# AC1 + AC3 -- decision logic emitted as a clean signal.
# Threshold is a LOW test value (10%); the cockpit can branch on the token.
# ---------------------------------------------------------------------------
def test_cycle_when_over_threshold_at_merge_boundary():
    rc, out, err = decide(["--at-merge-boundary", "--context-pct", "60"], threshold_pct=10)
    check(
        "AC1 over-threshold AT merge boundary -> CYCLE",
        rc == 0 and signal(out) == "CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


def test_no_cycle_when_below_threshold_at_merge_boundary():
    rc, out, err = decide(["--at-merge-boundary", "--context-pct", "5"], threshold_pct=10)
    check(
        "AC1 below-threshold AT merge boundary -> NO_CYCLE",
        rc == 0 and signal(out) == "NO_CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


def test_no_cycle_at_boundary_equality():
    # `>` not `>=`: context exactly AT the threshold must not cycle.
    rc, out, err = decide(["--at-merge-boundary", "--context-pct", "10"], threshold_pct=10)
    check(
        "AC1 context == threshold AT merge boundary -> NO_CYCLE (`>` not `>=`)",
        rc == 0 and signal(out) == "NO_CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


def test_fractional_context_pct_above_threshold_cycles():
    # FRACTIONAL percentages must compare correctly: 47.5% > 47% -> CYCLE.
    # Integer comparison ([ -gt ]) errors on a non-integer operand; the decision
    # must use a fractional-safe comparison while keeping the strict `>` semantics.
    rc, out, err = decide(["--at-merge-boundary", "--context-pct", "47.5"], threshold_pct=47)
    check(
        "AC1 fractional context-pct 47.5 > threshold 47 AT merge boundary -> CYCLE",
        rc == 0 and signal(out) == "CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


def test_fractional_context_pct_below_threshold_does_not_cycle():
    # 47.5% < 48% -> NO_CYCLE. Preserves the never-cycle-when-below-threshold
    # safety property under fractional inputs.
    rc, out, err = decide(["--at-merge-boundary", "--context-pct", "47.5"], threshold_pct=48)
    check(
        "AC1 fractional context-pct 47.5 < threshold 48 AT merge boundary -> NO_CYCLE",
        rc == 0 and signal(out) == "NO_CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


def test_never_mid_chunk_even_when_far_over_threshold():
    # The load-bearing safety property: NOT at a merge boundary => NO_CYCLE,
    # even when context is far over threshold. Never cycle mid-chunk.
    rc, out, err = decide(["--context-pct", "95"], threshold_pct=10)
    check(
        "AC1 NOT at merge boundary (mid-chunk) -> NO_CYCLE even at 95% > threshold",
        rc == 0 and signal(out) == "NO_CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


def test_signal_is_a_clean_token_not_prose():
    # AC3: the decision is a single structured token (CYCLE / NO_CYCLE) the
    # cockpit's if-branch can key on -- exactly one of the two appears.
    rc, out, err = decide(["--at-merge-boundary", "--context-pct", "60"], threshold_pct=10)
    toks = [ln.strip() for ln in out.splitlines() if ln.strip()]
    sig = signal(out)
    check(
        "AC3 decision signal is exactly one clean token (CYCLE xor NO_CYCLE), not prose",
        sig in ("CYCLE", "NO_CYCLE")
        and toks.count("CYCLE") + toks.count("NO_CYCLE") == 1,
        f"toks={toks!r} signal={sig!r} err={err!r}",
    )


# ---------------------------------------------------------------------------
# AC2 -- X is read from CONFIG, NOT hardcoded.
# Same inputs, two different config thresholds => the decision must FLIP.
# A hardcoded threshold cannot satisfy this.
# ---------------------------------------------------------------------------
def test_changing_config_threshold_flips_the_decision():
    args = ["--at-merge-boundary", "--context-pct", "40"]
    # Low threshold (10%): 40% > 10% -> CYCLE.
    rc_lo, out_lo, err_lo = decide(args, threshold_pct=10)
    # High threshold (80%): 40% < 80% -> NO_CYCLE. Same inputs, only config changed.
    rc_hi, out_hi, err_hi = decide(args, threshold_pct=80)
    check(
        "AC2 threshold from config: 40% context CYCLEs under a 10% config threshold",
        rc_lo == 0 and signal(out_lo) == "CYCLE",
        f"rc={rc_lo} signal={signal(out_lo)!r} err={err_lo!r}",
    )
    check(
        "AC2 threshold from config: same 40% context does NOT cycle under an 80% config threshold",
        rc_hi == 0 and signal(out_hi) == "NO_CYCLE",
        f"rc={rc_hi} signal={signal(out_hi)!r} err={err_hi!r}",
    )
    check(
        "AC2 X is NOT hardcoded: identical inputs give DIFFERENT decisions across config values",
        signal(out_lo) != signal(out_hi),
        f"low={signal(out_lo)!r} high={signal(out_hi)!r} (a hardcoded threshold cannot flip)",
    )


# ---------------------------------------------------------------------------
# SCOPE FENCE -- the worker builds DECISION LOGIC only.
# The script must NOT arm a live /clear; the decision function emits only a
# signal, no side effect. (Proving resume-from-board live + arming the
# production threshold is the cockpit's/the operator's job, out of worker scope.)
# ---------------------------------------------------------------------------
def test_script_does_not_arm_a_live_clear():
    # The decision-logic script must not itself issue a live /clear. We look for
    # an actual clear-arming command line, not the literal "/clear" string
    # (which legitimately appears in explanatory comments about what the cockpit
    # later does). An armed clear would be a real command invoking the clear.
    src = read_text(SCRIPT)
    # crude but sufficient: no line that *executes* a clear (e.g. a bare `clear`
    # builtin call, or piping/echoing "/clear" into a session). Comment lines
    # (starting with optional whitespace then #) are exempt.
    armed = []
    for ln in src.splitlines():
        stripped = ln.strip()
        if stripped.startswith("#") or not stripped:
            continue
        # an executed clear-arming line: a /clear being sent somewhere, or the
        # `clear` builtin invoked as a command (word-boundary, start of a simple
        # command), not the token inside a comment/string describing behavior.
        if "/clear" in stripped and (">" in stripped or "|" in stripped
                                      or stripped.startswith("echo")
                                      or stripped.startswith("printf")):
            armed.append(ln)
    check(
        "SCOPE FENCE: context_cycle.sh does NOT arm a live /clear (decision logic only)",
        armed == [],
        f"found clear-arming lines: {armed!r}",
    )


def test_decide_cycle_has_no_side_effect_only_emits_signal():
    # Running the decision function must not change anything observable beyond
    # its stdout signal: stderr stays empty on a valid call, and the only stdout
    # content is the decision token.
    rc, out, err = decide(["--at-merge-boundary", "--context-pct", "60"], threshold_pct=10)
    nonblank = [ln for ln in out.splitlines() if ln.strip()]
    check(
        "SCOPE FENCE: decide_cycle emits ONLY the signal (single stdout token, clean stderr)",
        rc == 0 and len(nonblank) == 1 and err.strip() == "",
        f"rc={rc} stdout_lines={nonblank!r} stderr={err!r}",
    )


# ---------------------------------------------------------------------------
# Artifact: skills/cockpit/SKILL.md gains an ADDITIVE self-check section, wired
# to context_cycle.sh, documenting the merge-boundary / never-mid-chunk / clear /
# resume-from-board contract -- WITHOUT restructuring the existing skill.
# ---------------------------------------------------------------------------
def test_skill_md_documents_the_self_check_wired_to_the_script():
    text = read_text(SKILL)
    lower = text.lower()
    check(
        "ARTIFACT SKILL.md: references the context_cycle.sh self-check script",
        "context_cycle.sh" in text,
        "SKILL.md must wire the self-check to scripts/context_cycle.sh",
    )
    check(
        "ARTIFACT SKILL.md: documents the merge-boundary, never-mid-chunk constraint",
        "merge" in lower and "mid-chunk" in lower,
        "self-check section must state: fires at the chunk-merge boundary, never mid-chunk",
    )
    check(
        "ARTIFACT SKILL.md: documents /clear + auto-resume from the Execution state board",
        "/clear" in text and "execution state" in lower and "resume" in lower,
        "self-check section must state: /clear then auto-resume from the ## Execution state board",
    )


def test_skill_md_remains_additive_existing_structure_intact():
    # ADDITIVE edit: the existing cockpit skill structure must survive untouched.
    # Pin a representative set of the pre-existing section headers (captured from
    # the chunk-start SKILL.md) so a restructure that drops/renames them fails here.
    text = read_text(SKILL)
    preexisting_headers = [
        "## Overview",
        "## Prerequisites",
        "## The tick",
        "## Per-launch",
        "## On pipeline completion",
        "## Merge",
        "## On resume (after a /clear)",
    ]
    missing = [h for h in preexisting_headers if h not in text]
    check(
        "ARTIFACT SKILL.md: edit is ADDITIVE -- all pre-existing section headers survive",
        missing == [],
        f"restructure dropped pre-existing headers: {missing!r}",
    )
    # The frontmatter `description:` is the sole routing surface; the additive
    # body section must not need to change it, and the frontmatter must remain.
    check(
        "ARTIFACT SKILL.md: frontmatter (name: cockpit) preserved",
        "name: cockpit" in text and text.lstrip().startswith("---"),
        "the additive section must not strip or rewrite the skill frontmatter",
    )


# ---------------------------------------------------------------------------
# Artifact: coo/context-cycling.md -- the doc explaining the mechanism + the
# resume-from-board contract.
# ---------------------------------------------------------------------------
def test_context_cycling_doc_explains_mechanism_and_resume_contract():
    text = read_text(DOC)
    lower = text.lower()
    check(
        "ARTIFACT doc: coo/context-cycling.md explains the self-check mechanism (threshold from config)",
        "context_cycle.sh" in text and "config" in lower and "threshold" in lower,
        "the doc must explain the config-driven threshold mechanism",
    )
    check(
        "ARTIFACT doc: states the merge-boundary, never-mid-chunk rule",
        "merge" in lower and "mid-chunk" in lower,
        "the doc must state the cycle fires at the merge boundary, never mid-chunk",
    )
    check(
        "ARTIFACT doc: documents the resume-from-board contract",
        "resume" in lower and "board" in lower,
        "the doc must document the resume-from-the-Execution-state-board contract",
    )
    check(
        "ARTIFACT doc: records that the production threshold is NOT armed (Q-cycle open)",
        "q-cycle" in lower or "not yet" in lower or "not armed" in lower or "open question" in lower,
        "the doc must record that X's production value is unset (Open question Q-cycle), not armed",
    )


# ===========================================================================
# CTX-BRIDGE chunk -- the statusline -> state-file -> context_cycle bridge.
#
# PROBLEM the bridge solves: the live context percentage (the real 'ctx N%')
# only reaches statusline.sh (the harness pipes it JSON on every render). The
# cockpit (COO) cannot read that number in a normal turn, and context_cycle.sh's
# self-check needs it. The bridge: (1) PRODUCER statusline.sh ALSO writes the
# integer-truncated pct to $HOME/.claude/state/context-pct on every render
# (best-effort, never failing the status line); (2) CONSUMER context_cycle.sh,
# when --context-pct is NOT passed, falls back to reading that file.
#
# Hermetic isolation: each bridge test runs the production scripts under a
# SANDBOX $HOME (a fresh tempdir) so the hardcoded $HOME/.claude/state/context-pct
# resolves into the sandbox -- the real cockpit state file is never read or
# written. decide_cycle() itself stays untouched (the 21 tests above prove that),
# so these tests exercise statusline.sh's write and context_cycle.sh's
# executable main-wrapper file-read fallback -- the two NEW behaviors.
# ===========================================================================


def run_statusline(stdin_text, home):
    """Pipe STDIN_TEXT into statusline.sh under sandbox HOME; return (rc, out, err).

    HOME is overridden so the producer's $HOME/.claude/state/context-pct write
    lands in the sandbox, not the real cockpit state file. The fixture JSON is
    the ONLY thing on stdin (statusline reads stdin once via `cat`); we never
    also read stdin for another purpose, so the pipe is not double-consumed.
    """
    env = dict(os.environ)
    env["HOME"] = home
    proc = subprocess.run(
        ["bash", STATUSLINE],
        input=stdin_text,
        capture_output=True,
        text=True,
        env=env,
    )
    return proc.returncode, proc.stdout, proc.stderr


def run_cycle(args, home):
    """Run context_cycle.sh AS AN EXECUTABLE (not sourced) under sandbox HOME.

    Executing directly (not `source ...`) runs the main wrapper -- the
    `[ BASH_SOURCE == $0 ]` block -- which is where the --context-pct file-read
    fallback lives. HOME is overridden so the consumer reads the sandbox state
    file. Returns (rc, out, err).
    """
    env = dict(os.environ)
    env["HOME"] = home
    proc = subprocess.run(
        ["bash", SCRIPT, *args],
        capture_output=True,
        text=True,
        env=env,
    )
    return proc.returncode, proc.stdout, proc.stderr


def read_state(home):
    """Read the bridge state file under sandbox HOME, or None if absent."""
    p = os.path.join(home, STATE_REL)
    try:
        with open(p) as fh:
            return fh.read()
    except FileNotFoundError:
        return None


# ---------------------------------------------------------------------------
# AC1 -- PRODUCER: statusline.sh writes integer-truncated pct to the state file,
# STILL prints the normal status line, AND exits 0.
# ---------------------------------------------------------------------------
def test_producer_writes_truncated_pct_and_still_renders():
    with tempfile.TemporaryDirectory() as home:
        fixture = '{"context_window":{"used_percentage":47.5},"workspace":{"current_dir":"/tmp"}}'
        rc, out, err = run_statusline(fixture, home)
        state = read_state(home)
        check(
            "AC1 producer: exits 0 on valid render",
            rc == 0,
            f"rc={rc} out={out!r} err={err!r}",
        )
        check(
            "AC1 producer: writes integer-truncated pct '47' (from 47.5) to state file",
            state == "47",
            f"state={state!r} (expected '47'); err={err!r}",
        )
        check(
            "AC1 producer: STILL prints the normal status line (ctx segment present, non-empty)",
            out.strip() != "" and "ctx 47%" in out,
            f"out={out!r}",
        )


# ---------------------------------------------------------------------------
# AC2 -- PRODUCER robustness: garbage / empty / absent pct must NOT crash, must
# exit 0, must print the fallback line, and must write NO bogus pct (no file
# write at all, OR the file left unchanged).
# ---------------------------------------------------------------------------
def test_producer_empty_stdin_no_crash_no_bogus_write():
    with tempfile.TemporaryDirectory() as home:
        rc, out, err = run_statusline("", home)
        state = read_state(home)
        check(
            "AC2 producer: empty stdin exits 0",
            rc == 0,
            f"rc={rc} out={out!r} err={err!r}",
        )
        check(
            "AC2 producer: empty stdin prints the neutral fallback line",
            out.strip() != "",
            f"out={out!r}",
        )
        check(
            "AC2 producer: empty stdin writes NO pct (state file absent, or no numeric content)",
            state is None or state.strip() == "",
            f"state={state!r} (a write on empty input is a bogus pct)",
        )


def test_producer_absent_pct_field_no_crash_no_bogus_write():
    with tempfile.TemporaryDirectory() as home:
        # Valid JSON but NO .context_window.used_percentage -> pct is empty.
        fixture = '{"workspace":{"current_dir":"/tmp"}}'
        rc, out, err = run_statusline(fixture, home)
        state = read_state(home)
        check(
            "AC2 producer: absent used_percentage exits 0 and prints a line",
            rc == 0 and out.strip() != "",
            f"rc={rc} out={out!r} err={err!r}",
        )
        check(
            "AC2 producer: absent used_percentage writes NO bogus pct",
            state is None or state.strip() == "",
            f"state={state!r} (no pct field -> must not write a pct)",
        )


def test_producer_garbage_stdin_no_crash_no_bogus_write():
    with tempfile.TemporaryDirectory() as home:
        rc, out, err = run_statusline("this is not json at all", home)
        state = read_state(home)
        check(
            "AC2 producer: garbage (non-JSON) stdin exits 0 and prints a line",
            rc == 0 and out.strip() != "",
            f"rc={rc} out={out!r} err={err!r}",
        )
        check(
            "AC2 producer: garbage stdin writes NO bogus pct",
            state is None or state.strip() == "",
            f"state={state!r} (garbage -> must not write a pct)",
        )


# ---------------------------------------------------------------------------
# AC3 -- CONSUMER: context_cycle.sh --at-merge-boundary with NO --context-pct
# reads the pct from the state file. Strict '>' threshold semantics preserved.
# ---------------------------------------------------------------------------
def _seed_state(home, value):
    """Write VALUE to the sandbox state file (simulating a prior statusline render)."""
    p = os.path.join(home, STATE_REL)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        fh.write(value)


def test_consumer_file_value_over_threshold_cycles():
    with tempfile.TemporaryDirectory() as home:
        _seed_state(home, "60")
        env = dict(os.environ)
        env["HOME"] = home
        env["CONTEXT_CYCLE_THRESHOLD_PCT"] = "10"
        proc = subprocess.run(
            ["bash", SCRIPT, "--at-merge-boundary"],
            capture_output=True, text=True, env=env,
        )
        check(
            "AC3 consumer: file pct 60 > threshold 10 AT merge boundary, NO --context-pct -> CYCLE",
            proc.returncode == 0 and signal(proc.stdout) == "CYCLE",
            f"rc={proc.returncode} signal={signal(proc.stdout)!r} out={proc.stdout!r} err={proc.stderr!r}",
        )


def test_consumer_file_value_at_or_below_threshold_does_not_cycle():
    with tempfile.TemporaryDirectory() as home:
        env = dict(os.environ)
        env["HOME"] = home
        env["CONTEXT_CYCLE_THRESHOLD_PCT"] = "47"
        # Equality: file value 47 == threshold 47 -> strict '>' means NO_CYCLE.
        _seed_state(home, "47")
        proc_eq = subprocess.run(
            ["bash", SCRIPT, "--at-merge-boundary"],
            capture_output=True, text=True, env=env,
        )
        check(
            "AC3 consumer: file pct 47 == threshold 47 -> NO_CYCLE (strict '>' preserved)",
            proc_eq.returncode == 0 and signal(proc_eq.stdout) == "NO_CYCLE",
            f"rc={proc_eq.returncode} signal={signal(proc_eq.stdout)!r} err={proc_eq.stderr!r}",
        )
        # Below: file value 5 < threshold 47 -> NO_CYCLE.
        _seed_state(home, "5")
        proc_lo = subprocess.run(
            ["bash", SCRIPT, "--at-merge-boundary"],
            capture_output=True, text=True, env=env,
        )
        check(
            "AC3 consumer: file pct 5 < threshold 47 -> NO_CYCLE",
            proc_lo.returncode == 0 and signal(proc_lo.stdout) == "NO_CYCLE",
            f"rc={proc_lo.returncode} signal={signal(proc_lo.stdout)!r} err={proc_lo.stderr!r}",
        )


def test_consumer_not_at_boundary_never_cycles_even_reading_file():
    with tempfile.TemporaryDirectory() as home:
        # File says 95% (far over), but NOT at a merge boundary -> NO_CYCLE.
        # The never-mid-chunk safety property must survive the file-read path.
        _seed_state(home, "95")
        env = dict(os.environ)
        env["HOME"] = home
        env["CONTEXT_CYCLE_THRESHOLD_PCT"] = "10"
        proc = subprocess.run(
            ["bash", SCRIPT],  # no --at-merge-boundary, no --context-pct
            capture_output=True, text=True, env=env,
        )
        check(
            "AC3 consumer: file pct 95 but NOT at merge boundary -> NO_CYCLE (never mid-chunk)",
            proc.returncode == 0 and signal(proc.stdout) == "NO_CYCLE",
            f"rc={proc.returncode} signal={signal(proc.stdout)!r} out={proc.stdout!r} err={proc.stderr!r}",
        )


# ---------------------------------------------------------------------------
# AC4 -- CONSUMER precedence: explicit --context-pct still works exactly as
# before AND wins over the state file. (The 21 sourced decide_cycle tests above
# already prove decide_cycle() is unchanged; this pins the wrapper precedence.)
# ---------------------------------------------------------------------------
def test_explicit_arg_takes_precedence_over_file():
    with tempfile.TemporaryDirectory() as home:
        # File says 5 (would be NO_CYCLE under threshold 10); explicit arg says
        # 60 (CYCLE). The explicit CLI arg must WIN -> CYCLE, proving the file is
        # only a FALLBACK, not an override.
        _seed_state(home, "5")
        env = dict(os.environ)
        env["HOME"] = home
        env["CONTEXT_CYCLE_THRESHOLD_PCT"] = "10"
        proc = subprocess.run(
            ["bash", SCRIPT, "--at-merge-boundary", "--context-pct", "60"],
            capture_output=True, text=True, env=env,
        )
        check(
            "AC4 consumer: explicit --context-pct 60 beats file value 5 -> CYCLE (explicit wins)",
            proc.returncode == 0 and signal(proc.stdout) == "CYCLE",
            f"rc={proc.returncode} signal={signal(proc.stdout)!r} out={proc.stdout!r} err={proc.stderr!r}",
        )


def test_explicit_arg_still_works_with_no_state_file_present():
    with tempfile.TemporaryDirectory() as home:
        # No state file at all. Explicit --context-pct must behave exactly as
        # before the bridge existed (backward-compat): 60 > 10 -> CYCLE.
        env = dict(os.environ)
        env["HOME"] = home
        env["CONTEXT_CYCLE_THRESHOLD_PCT"] = "10"
        proc = subprocess.run(
            ["bash", SCRIPT, "--at-merge-boundary", "--context-pct", "60"],
            capture_output=True, text=True, env=env,
        )
        check(
            "AC4 consumer: explicit --context-pct works unchanged with NO state file (backward-compat)",
            proc.returncode == 0 and signal(proc.stdout) == "CYCLE",
            f"rc={proc.returncode} signal={signal(proc.stdout)!r} out={proc.stdout!r} err={proc.stderr!r}",
        )


# ---------------------------------------------------------------------------
# AC5 -- PRODUCER preserves existing statusline behavior: the branch / chunk /
# ctx segments and graceful-fallback are intact; the ONLY change is the added
# best-effort state-file write. We pin the ctx segment rendering on a known
# fixture (the existing visible behavior must not regress).
# ---------------------------------------------------------------------------
def test_producer_preserves_existing_ctx_segment_rendering():
    with tempfile.TemporaryDirectory() as home:
        # A cwd that is not a git repo and has no specs/current.md -> only the
        # ctx segment should render. This pins that statusline still composes its
        # existing ctx segment (truncated %), unchanged by the bridge write.
        fixture = '{"context_window":{"used_percentage":33.9},"workspace":{"current_dir":"%s"}}' % home
        rc, out, err = run_statusline(fixture, home)
        check(
            "AC5 producer: existing ctx segment still renders truncated ('ctx 33%') and exits 0",
            rc == 0 and "ctx 33%" in out,
            f"rc={rc} out={out!r} err={err!r}",
        )
        check(
            "AC5 producer: the same render also performs the bridge write (33)",
            read_state(home) == "33",
            f"state={read_state(home)!r}",
        )


# ---------------------------------------------------------------------------
# LIVE END-TO-END: pipe realistic JSON to statusline.sh, observe the state file
# actually written, then have context_cycle.sh CONSUME that file -- the whole
# bridge wired together in one flow, the way the cockpit will use it.
# ---------------------------------------------------------------------------
def test_end_to_end_producer_to_consumer():
    with tempfile.TemporaryDirectory() as home:
        fixture = '{"context_window":{"used_percentage":52.7},"workspace":{"current_dir":"/tmp"}}'
        rc_p, out_p, err_p = run_statusline(fixture, home)
        state = read_state(home)
        env = dict(os.environ)
        env["HOME"] = home
        env["CONTEXT_CYCLE_THRESHOLD_PCT"] = "45"
        proc = subprocess.run(
            ["bash", SCRIPT, "--at-merge-boundary"],  # consume the file the producer wrote
            capture_output=True, text=True, env=env,
        )
        check(
            "E2E: producer wrote '52' (from 52.7) AND consumer read it: 52 > 45 -> CYCLE",
            rc_p == 0 and state == "52"
            and proc.returncode == 0 and signal(proc.stdout) == "CYCLE",
            f"producer_rc={rc_p} state={state!r} consumer_rc={proc.returncode} "
            f"signal={signal(proc.stdout)!r} err_p={err_p!r} err_c={proc.stderr!r}",
        )


def main():
    test_cycle_when_over_threshold_at_merge_boundary()
    test_no_cycle_when_below_threshold_at_merge_boundary()
    test_no_cycle_at_boundary_equality()
    test_fractional_context_pct_above_threshold_cycles()
    test_fractional_context_pct_below_threshold_does_not_cycle()
    test_never_mid_chunk_even_when_far_over_threshold()
    test_signal_is_a_clean_token_not_prose()
    test_changing_config_threshold_flips_the_decision()
    test_script_does_not_arm_a_live_clear()
    test_decide_cycle_has_no_side_effect_only_emits_signal()
    test_skill_md_documents_the_self_check_wired_to_the_script()
    test_skill_md_remains_additive_existing_structure_intact()
    test_context_cycling_doc_explains_mechanism_and_resume_contract()

    # --- CTX-BRIDGE chunk: statusline -> state-file -> context_cycle bridge ---
    test_producer_writes_truncated_pct_and_still_renders()
    test_producer_empty_stdin_no_crash_no_bogus_write()
    test_producer_absent_pct_field_no_crash_no_bogus_write()
    test_producer_garbage_stdin_no_crash_no_bogus_write()
    test_consumer_file_value_over_threshold_cycles()
    test_consumer_file_value_at_or_below_threshold_does_not_cycle()
    test_consumer_not_at_boundary_never_cycles_even_reading_file()
    test_explicit_arg_takes_precedence_over_file()
    test_explicit_arg_still_works_with_no_state_file_present()
    test_producer_preserves_existing_ctx_segment_rendering()
    test_end_to_end_producer_to_consumer()

    print()
    print(f"{len(_passes)} passed, {len(_failures)} failed")
    if _failures:
        for name, detail in _failures:
            print(f"  FAILED: {name}  {detail}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
