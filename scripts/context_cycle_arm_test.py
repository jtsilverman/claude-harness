#!/usr/bin/env python3
"""RED-stage spec for CHUNK 13 -- Arm the semi-auto context-cycle.

Chunks 11 + 12 already shipped and proved (40 green in context_cycle_test.py):
  - chunk 11: the pure decision logic `decide_cycle` (CYCLE iff at a merge
    boundary AND context-pct strictly > threshold X, X read from the config env
    var CONTEXT_CYCLE_THRESHOLD_PCT, defaulting to a disabled sentinel 101 that
    never trips), unit-tested at ARBITRARY LOW thresholds (10 / 47 / 48).
  - chunk 12: the statusline -> state/context-pct -> context_cycle bridge.

Chunk 13 does NOT change the decision script. It (1) WIRES the surface into the
cockpit at the production-armed threshold X=45 (Open question G5 resolved: X=45),
replacing the disabled sentinel / `$X` placeholder, replaces the comment-only
`: # finish-chunk -> /clear` action placeholder with the real COO surface prose
("clear and I'll resume from the board"), and drops the "deferred / not armed /
Open question Q-cycle" language; and (2) documents the full mechanism + the
resume-from-board contract in coo/context-cycling.md, likewise updated to ARMED.

The cockpit is SEMI-AUTO: the COO CANNOT /clear itself. At a merge boundary past
45% it SURFACES to the operator "clear and I'll resume from the board"; JAKE performs the
clear; the COO resumes from the durable board. Never mid-chunk. No self-clear.

This RED pins the FULL chunk-13 acceptance contract -- it must fail until chunk 13
ships, and an implementation that only does part of the contract (e.g. arms 45 in
the decision path but leaves the skill prose as the deferred placeholder) must
NOT pass. The acceptance criteria each get >=1 assertion below.

LIVE-INTEGRATION GAP (documented per testing-discipline.md): a TRUE live boundary
fire -- the COO actually sitting in a long-running cockpit session at >45% context
right after a real chunk merge, surfacing the suggestion, the operator clearing, the COO
resuming -- cannot be reproduced inside this worker worktree (there is no live
cockpit session, no live context-window number, and the COO cannot /clear itself;
the clear is the operator's manual act). So per testing-discipline.md the decision PATH is
exercised faithfully here: `decide_cycle` is called at the ARMED value X=45 (the
exact value the cockpit injects, asserted to be the value SKILL.md wires) across
the boundary cases the acceptance names (>45 -> CYCLE; ==45 and <45 -> NO_CYCLE;
mid-chunk -> NO_CYCLE), AND the armed surface + resume-from-board contract are
pinned in the SKILL.md / doc artifacts. The live boundary fire remains a manual
verification owed at cockpit-arming time.

Run: python3 scripts/context_cycle_arm_test.py   (exit 0 = all pass, 1 = any fail)

Acceptance criteria pinned (chunk 13):
  AC-B (behavioral, armed path): a merge-boundary check with context-pct > 45
       surfaces clear-and-resume (CYCLE); below 45 OR mid-chunk does NOT
       (NO_CYCLE). Strict '>' so 45 == 45 is NO_CYCLE. Exercised at the ARMED
       value 45, the exact threshold the cockpit injects.
  AC-S1 SKILL.md arms the self-check at threshold 45 -- it wires the literal
       CONTEXT_CYCLE_THRESHOLD_PCT=45 (not the `$X` placeholder / sentinel).
  AC-S2 SKILL.md states the COO SURFACES the clear-and-resume action ("clear and
       I'll resume from the board") -- the real surface prose, replacing the
       comment-only `: # finish-chunk -> /clear` action placeholder.
  AC-S3 SKILL.md states the never-mid-chunk + no-self-clear (semi-auto; the operator
       performs the clear) constraints.
  AC-S4 SKILL.md drops the "deferred / Open question Q-cycle / not yet set by
       the operator / not armed" language -- the surface is armed now, not deferred.
  AC-D1 coo/context-cycling.md documents the mechanism + the resume-from-board
       contract, updated to ARMED-at-45 (records 45) and the semi-auto
       no-self-clear invariant (the operator clears, the COO surfaces + resumes).
  AC-D2 coo/context-cycling.md drops the "deferred / not armed / Open question
       Q-cycle / disabled sentinel as the production state" language.
  PARITY the armed value the cockpit wires (45) is the same value the decision
       path is proven at -- so the scripted path faithfully mirrors production,
       not an arbitrary threshold.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # scripts/ -> worktree root
SCRIPT = os.path.join(HERE, "context_cycle.sh")
SKILL = os.path.join(ROOT, "skills", "cockpit", "SKILL.md")
DOC = os.path.join(ROOT, "coo", "coo-sop.md")

# The production-armed threshold resolved for this spec (Open question G5: X=45).
ARMED = 45

_passes = []
_failures = []


def check(name, cond, detail=""):
    if cond:
        _passes.append(name)
        print(f"PASS  {name}")
    else:
        _failures.append((name, detail))
        print(f"FAIL  {name}  {detail}")


def read_text(path):
    """Read PATH, or "" if absent.

    A missing artifact is the feature-missing signal, so the content checks FAIL
    cleanly on their assertion (empty text contains none of the required tokens)
    instead of erroring with FileNotFoundError before the assertion is reached --
    a test that errors before its assertion is not a valid RED.
    """
    try:
        return open(path).read()
    except FileNotFoundError:
        return ""


def decide(args, threshold_pct):
    """Source context_cycle.sh and call `decide_cycle` with ARGS; threshold via env.

    Mirrors context_cycle_test.py's harness: sourcing does NOT run main()
    (guarded behind BASH_SOURCE==$0), so this exercises the pure decision
    function only -- no /clear, no live-context read, no side effect. The chunk
    does not touch the script; we re-source it here only to PROVE the armed
    threshold value 45 produces the acceptance-named CYCLE / NO_CYCLE outcomes
    (the faithfully-scripted decision path standing in for the live boundary).
    """
    cmd = f'source "{SCRIPT}"; decide_cycle "$@"'
    env = dict(os.environ)
    env["CONTEXT_CYCLE_THRESHOLD_PCT"] = str(threshold_pct)
    proc = subprocess.run(
        ["bash", "-c", cmd, "_", *args],
        capture_output=True,
        text=True,
        env=env,
    )
    return proc.returncode, proc.stdout, proc.stderr


def run_via_bridge(args, threshold_pct, state_pct):
    """EXECUTE context_cycle.sh (real main() path) with the state/context-pct bridge.

    This is the FAITHFULLY-SCRIPTED production invocation: the cockpit's armed
    call drops --context-pct and lets the script self-source the live percent from
    $HOME/.claude/state/context-pct (the chunk-12 statusline bridge) via the
    file-fallback in main(). We pin an ISOLATED $HOME (tempdir) so the live state
    file is never read or clobbered, write STATE_PCT into the fixture bridge file,
    then run the script EXECUTED (not sourced) with ARGS and no --context-pct.
    Returns (rc, stdout, stderr).
    """
    import tempfile

    env = dict(os.environ)
    env["CONTEXT_CYCLE_THRESHOLD_PCT"] = str(threshold_pct)
    with tempfile.TemporaryDirectory() as home:
        state_dir = os.path.join(home, ".claude", "state")
        os.makedirs(state_dir, exist_ok=True)
        if state_pct is not None:
            with open(os.path.join(state_dir, "context-pct"), "w") as fh:
                fh.write(str(state_pct))
        env["HOME"] = home
        proc = subprocess.run(
            ["bash", SCRIPT, *args],
            capture_output=True,
            text=True,
            env=env,
        )
    return proc.returncode, proc.stdout, proc.stderr


def signal(stdout):
    """The terminal decision token on stdout (CYCLE / NO_CYCLE), stripped."""
    toks = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
    return toks[-1] if toks else ""


def skill_armed_thresholds():
    """Every integer wired as CONTEXT_CYCLE_THRESHOLD_PCT=<N> in SKILL.md.

    Matches the env-assignment form (the way the cockpit injects the threshold
    into the script call), e.g. CONTEXT_CYCLE_THRESHOLD_PCT=45 or
    CONTEXT_CYCLE_THRESHOLD_PCT="45". The `$X` placeholder is NOT an integer, so
    an un-armed skill yields no integer here -> the armed-value assertions fail
    cleanly until the surface is wired to a literal.
    """
    import re

    text = read_text(SKILL)
    return re.findall(r'CONTEXT_CYCLE_THRESHOLD_PCT=["\']?(\d+)', text)


def skill_armed_call():
    """The armed `context_cycle.sh` invocation text in SKILL.md (the call site).

    Returns the slice of SKILL.md spanning the armed `bash scripts/context_cycle.sh`
    invocation -- from the `context_cycle.sh` token to the end of the `$(...)`
    command substitution that captures the decision -- so the bridge-consumption
    assertion can inspect exactly what flags the cockpit passes the script.
    Returns "" if the invocation is absent.
    """
    text = read_text(SKILL)
    start = text.find("bash scripts/context_cycle.sh")
    if start == -1:
        return ""
    # The invocation is a `decision="$(... )"` substitution; capture through the
    # closing `)"` that terminates it (the call may wrap across a line with `\`).
    end = text.find(')"', start)
    if end == -1:
        end = text.find("\n", start)
    return text[start : end + 2 if end != -1 else len(text)]


# ===========================================================================
# AC-B + PARITY -- the ARMED decision path (X = 45).
# The faithfully-scripted stand-in for the live boundary fire: at the exact
# production threshold 45, context > 45 at a merge boundary surfaces the cycle
# (CYCLE); below 45, exactly 45 (strict '>'), and mid-chunk all do NOT.
# ===========================================================================
def test_armed_over_threshold_at_merge_boundary_cycles():
    rc, out, err = decide(["--at-merge-boundary", "--context-pct", "46"], threshold_pct=ARMED)
    check(
        "AC-B armed X=45: context 46 > 45 AT merge boundary -> CYCLE (surfaces clear-and-resume)",
        rc == 0 and signal(out) == "CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


def test_armed_below_threshold_at_merge_boundary_does_not_cycle():
    rc, out, err = decide(["--at-merge-boundary", "--context-pct", "44"], threshold_pct=ARMED)
    check(
        "AC-B armed X=45: context 44 < 45 AT merge boundary -> NO_CYCLE (below threshold)",
        rc == 0 and signal(out) == "NO_CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


def test_armed_equality_at_merge_boundary_does_not_cycle():
    # Strict '>' at the ARMED value: context exactly 45 == threshold 45 -> NO_CYCLE.
    rc, out, err = decide(["--at-merge-boundary", "--context-pct", "45"], threshold_pct=ARMED)
    check(
        "AC-B armed X=45: context 45 == 45 AT merge boundary -> NO_CYCLE ('>' not '>=')",
        rc == 0 and signal(out) == "NO_CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


def test_armed_mid_chunk_never_cycles_even_far_over():
    # The never-mid-chunk safety property at the armed value: NOT at a merge
    # boundary -> NO_CYCLE even at 99% (far over 45). No self-clear mid-chunk.
    rc, out, err = decide(["--context-pct", "99"], threshold_pct=ARMED)
    check(
        "AC-B armed X=45: 99% but NOT at merge boundary -> NO_CYCLE (never mid-chunk)",
        rc == 0 and signal(out) == "NO_CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


# ===========================================================================
# AC-S1 + PARITY -- SKILL.md ARMS the self-check at 45 (the literal value, not
# the `$X` placeholder), and that wired value is the SAME 45 the decision path
# above is proven at (so the scripted path faithfully mirrors production).
# ===========================================================================
def test_skill_md_arms_threshold_45_not_placeholder():
    wired = skill_armed_thresholds()
    check(
        "AC-S1 SKILL.md wires the LITERAL CONTEXT_CYCLE_THRESHOLD_PCT=45 (armed, not the $X placeholder)",
        str(ARMED) in wired,
        f"thresholds wired in SKILL.md: {wired!r} (expected to include '45'; "
        f"the `$X` placeholder/sentinel is not an armed literal)",
    )


def test_skill_md_armed_value_matches_proven_decision_path():
    # PARITY: every threshold the skill wires must be the armed 45 -- a stray
    # different literal (e.g. a leftover sentinel 101, or a wrong 50) would mean
    # the scripted decision path (proven at 45) does NOT mirror what production
    # runs. The skill must wire exactly the armed value, nothing else.
    wired = skill_armed_thresholds()
    check(
        "PARITY SKILL.md wires ONLY the armed 45 (no stray/sentinel threshold) so the proven path mirrors production",
        wired != [] and all(v == str(ARMED) for v in wired),
        f"thresholds wired in SKILL.md: {wired!r} (must be non-empty and all == '45')",
    )


# ===========================================================================
# AC-BRIDGE -- the armed SKILL.md call CONSUMES the state/context-pct bridge.
# Codex Tier-A [P2] fix: the armed call must DROP --context-pct (the cockpit
# never holds a defined $ctx_pct), letting context_cycle.sh self-source the live
# percent from the chunk-12 bridge via its file fallback. Passing an empty
# --context-pct both defeats that fallback (the guard skips the state-file read
# when --context-pct is present) AND makes the script reject with 'needs N'. Two
# halves: (1) the SKILL.md armed call passes no --context-pct / no $ctx_pct;
# (2) the documented call shape actually decides via the state-file bridge.
# ===========================================================================
def test_skill_md_armed_call_does_not_pass_undefined_context_pct():
    call = skill_armed_call()
    # The armed invocation must NOT pass --context-pct (there is no defined
    # $ctx_pct at the cockpit call site; passing an empty one errors with
    # 'needs N' and defeats the bridge fallback). The bug-pin: neither the
    # --context-pct flag nor the undefined $ctx_pct var appears in the call.
    check(
        "AC-BRIDGE SKILL.md armed call passes NO --context-pct (consumes the state/context-pct bridge, not an undefined $ctx_pct)",
        call != "" and "--context-pct" not in call and "ctx_pct" not in call,
        f"armed call text from SKILL.md: {call!r} "
        f"(must drop --context-pct / $ctx_pct so context_cycle.sh self-sources the live percent from the bridge)",
    )


def test_armed_call_shape_decides_via_state_file_bridge():
    # FAITHFULLY-SCRIPTED production invocation: the documented armed call shape
    # (no --context-pct) EXECUTED against a fixture state/context-pct bridge in an
    # isolated $HOME. >45 -> CYCLE; <45 -> NO_CYCLE; mid-chunk -> NO_CYCLE. Proves
    # the armed call now produces a LIVE decision via the bridge, not rc 2.
    rc, out, err = run_via_bridge(["--at-merge-boundary"], threshold_pct=ARMED, state_pct=46)
    check(
        "AC-BRIDGE armed call (no --context-pct), bridge=46 > 45 AT merge boundary -> CYCLE via state file",
        rc == 0 and signal(out) == "CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )
    rc, out, err = run_via_bridge(["--at-merge-boundary"], threshold_pct=ARMED, state_pct=44)
    check(
        "AC-BRIDGE armed call (no --context-pct), bridge=44 < 45 AT merge boundary -> NO_CYCLE via state file",
        rc == 0 and signal(out) == "NO_CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )
    rc, out, err = run_via_bridge([], threshold_pct=ARMED, state_pct=46)
    check(
        "AC-BRIDGE armed call (no --context-pct, no boundary flag), bridge=46 -> NO_CYCLE (never mid-chunk) via state file",
        rc == 0 and signal(out) == "NO_CYCLE",
        f"rc={rc} signal={signal(out)!r} out={out!r} err={err!r}",
    )


# ===========================================================================
# AC-S2 -- SKILL.md states the real COO SURFACE action: "clear and I'll resume
# from the board" -- replacing the comment-only `: # finish-chunk -> /clear`
# action placeholder with actual surface prose the COO emits to the operator.
# ===========================================================================
def test_skill_md_states_coo_surfaces_clear_and_resume():
    text = read_text(SKILL)
    lower = text.lower()
    # The armed surface prose: the COO tells the operator to clear and that it resumes
    # from the board. "clear" + "resume" + "board" co-occurring in the armed
    # surface action, beyond the pre-existing § On resume mechanics.
    has_surface = (
        "clear and i'll resume from the board" in lower
        or ("clear and i will resume from the board" in lower)
        or ("clear" in lower and "i'll resume from the board" in lower)
    )
    check(
        "AC-S2 SKILL.md states the COO SURFACE: 'clear and I'll resume from the board'",
        has_surface,
        "SKILL.md must replace the `: # finish-chunk -> /clear` action placeholder "
        "with the real COO surface prose telling the operator to clear (the COO then resumes from the board)",
    )


def test_skill_md_drops_comment_only_action_placeholder():
    # The chunk-start placeholder was a comment-only no-op action:
    #   : # finish-chunk -> /clear -> auto-resume from the ## Execution state board
    # Arming replaces it with the real surface action; the bare-`:` comment-only
    # placeholder line must be gone.
    text = read_text(SKILL)
    placeholder = ": # finish-chunk -> /clear -> auto-resume from the ## Execution state board"
    check(
        "AC-S2 SKILL.md removed the comment-only `:` action placeholder (replaced by the real surface)",
        placeholder not in text,
        "the `: # finish-chunk -> /clear ...` comment-only placeholder must be replaced by the armed surface action",
    )


# ===========================================================================
# AC-S3 -- SKILL.md states the SEMI-AUTO constraints: never mid-chunk, and the
# COO CANNOT /clear itself (no self-clear -- the operator performs the clear).
# ===========================================================================
def test_skill_md_states_never_mid_chunk_and_no_self_clear():
    text = read_text(SKILL)
    lower = text.lower()
    check(
        "AC-S3 SKILL.md states the never-mid-chunk constraint",
        "mid-chunk" in lower,
        "SKILL.md must keep/state: the self-check fires at the merge boundary, NEVER mid-chunk",
    )
    # No-self-clear: the COO cannot /clear itself; the operator performs the clear
    # (semi-auto). Look for the invariant being stated, not just the word.
    no_self_clear = (
        ("cannot" in lower or "can't" in lower or "never" in lower or "does not" in lower or "doesn't" in lower)
        and "clear" in lower
        and ("jake" in lower or "semi-auto" in lower or "itself" in lower)
    )
    check(
        "AC-S3 SKILL.md states the no-self-clear / semi-auto invariant (the COO does not clear itself; the operator clears)",
        no_self_clear,
        "SKILL.md must state the COO CANNOT /clear itself (semi-auto): the operator performs the clear, the COO surfaces + resumes",
    )


# ===========================================================================
# AC-S4 -- SKILL.md DROPS the "deferred / Open question Q-cycle / not yet set /
# not armed" language. The surface is armed now; the deferred caveats must go.
# ===========================================================================
def test_skill_md_drops_deferred_and_qcycle_language():
    text = read_text(SKILL)
    lower = text.lower()
    stale = []
    if "q-cycle" in lower:
        stale.append("Q-cycle")
    if "not yet set by jake" in lower:
        stale.append("not yet set by the operator")
    # "not armed" describing the cycle threshold's production state must be gone.
    if "not armed" in lower or "is **not armed**" in lower:
        stale.append("not armed")
    # The specific deferral sentence: "arming the production threshold are deferred".
    if "arming the production threshold are deferred" in lower:
        stale.append("arming the production threshold are deferred")
    check(
        "AC-S4 SKILL.md DROPS the deferred / Q-cycle / not-yet-set / not-armed language (surface is armed now)",
        stale == [],
        f"SKILL.md still carries stale deferred/un-armed language: {stale!r}",
    )


# ===========================================================================
# AC-D1 -- coo/context-cycling.md documents the mechanism + the resume-from-board
# contract, updated to ARMED-at-45 and the semi-auto no-self-clear invariant.
# ===========================================================================
def test_doc_documents_armed_mechanism_and_resume_contract():
    text = read_text(DOC)
    lower = text.lower()
    check(
        "AC-D1 doc: explains the self-check mechanism (config-driven threshold)",
        "context_cycle.sh" in text and "config" in lower and "threshold" in lower,
        "coo/context-cycling.md must explain the config-driven threshold mechanism",
    )
    check(
        "AC-D1 doc: records the ARMED production threshold value 45",
        "45" in text,
        "the doc must record that X is now armed at 45 (Open question G5 resolved)",
    )
    check(
        "AC-D1 doc: documents the resume-from-board contract",
        "resume" in lower and "board" in lower,
        "the doc must document the resume-from-the-Execution-state-board contract",
    )
    # Semi-auto no-self-clear invariant: the COO cannot clear itself; the operator clears.
    no_self_clear = (
        ("cannot" in lower or "can't" in lower or "never" in lower or "does not" in lower or "doesn't" in lower)
        and "clear" in lower
        and ("jake" in lower or "semi-auto" in lower or "itself" in lower)
    )
    check(
        "AC-D1 doc: documents the semi-auto no-self-clear invariant (the COO does not clear itself; the operator clears)",
        no_self_clear,
        "the doc must document that the COO CANNOT /clear itself (semi-auto): the operator performs the clear, the COO surfaces + resumes from the board",
    )


# ===========================================================================
# AC-D2 -- coo/context-cycling.md DROPS the "deferred / not armed / Q-cycle /
# disabled sentinel as the production state" language (it is armed now).
# ===========================================================================
def test_doc_drops_deferred_and_unarmed_language():
    text = read_text(DOC)
    lower = text.lower()
    stale = []
    if "q-cycle" in lower:
        stale.append("Q-cycle")
    if "not yet set by jake" in lower:
        stale.append("not yet set by the operator")
    if "not armed" in lower:
        stale.append("not armed")
    # The "Deferred (not in this build): ... arming the production threshold"
    # bullet describing arming as still-deferred must be gone.
    if "arming the production threshold" in lower and "deferred" in lower:
        stale.append("arming-the-production-threshold-deferred")
    check(
        "AC-D2 doc: DROPS the deferred / not-armed / Q-cycle language (production threshold is armed at 45 now)",
        stale == [],
        f"coo/context-cycling.md still carries stale deferred/un-armed language: {stale!r}",
    )


def main():
    # AC-B + PARITY: armed decision path at X=45 (faithfully-scripted boundary).
    test_armed_over_threshold_at_merge_boundary_cycles()
    test_armed_below_threshold_at_merge_boundary_does_not_cycle()
    test_armed_equality_at_merge_boundary_does_not_cycle()
    test_armed_mid_chunk_never_cycles_even_far_over()
    # AC-S1 + PARITY: SKILL.md arms 45, matching the proven path.
    test_skill_md_arms_threshold_45_not_placeholder()
    test_skill_md_armed_value_matches_proven_decision_path()
    # AC-BRIDGE: armed call drops --context-pct and decides via the state-file bridge.
    test_skill_md_armed_call_does_not_pass_undefined_context_pct()
    test_armed_call_shape_decides_via_state_file_bridge()
    # AC-S2: SKILL.md states the real COO surface action.
    test_skill_md_states_coo_surfaces_clear_and_resume()
    test_skill_md_drops_comment_only_action_placeholder()
    # AC-S3: SKILL.md states the semi-auto constraints.
    test_skill_md_states_never_mid_chunk_and_no_self_clear()
    # AC-S4: SKILL.md drops the deferred language.
    test_skill_md_drops_deferred_and_qcycle_language()
    # AC-D1: doc documents armed mechanism + resume contract + no-self-clear.
    test_doc_documents_armed_mechanism_and_resume_contract()
    # AC-D2: doc drops the deferred language.
    test_doc_drops_deferred_and_unarmed_language()

    print()
    print(f"{len(_passes)} passed, {len(_failures)} failed")
    if _failures:
        for name, detail in _failures:
            print(f"  FAILED: {name}  {detail}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
