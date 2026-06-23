#!/usr/bin/env python3
"""Unit tests for codex-review.sh's tier_config -- chunk 9's tier-scaled knob.

Durable regression suite (lives next to the script, not in specs/scripts/),
because every chunk-checkpoint and worker-pipeline review delegates to
codex-review.sh, and a wrong tier->args mapping silently weakens (or breaks)
the verification net on every chunk.

Run: python3 scripts/codex_review_test.py   (exit 0 = all pass, 1 = any fail)

tier_config(TIER) is the pure half of the tier knob: given a chunk's S/A/B/C tier
it echoes the `codex review` config args (`-c key=value` lines) for that tier --
no codex call, sourceable, unit-testable. The mapping (verified against
~/.codex/models_cache.json 2026-06-03):

  S -> strongest model + xhigh effort  : -c model=gpt-5.5  -c model_reasoning_effort=xhigh
                                         (xhigh is the ceiling for gpt-5.5/5.4/mini;
                                          "max" is NOT valid for these models)
  A -> strongest model + high effort   : -c model=gpt-5.5  -c model_reasoning_effort=high
  B -> lightest model + medium effort  : -c model=gpt-5.4-mini  -c model_reasoning_effort=medium
                                         (chunk-9 flip: B is the highest-VOLUME tier, so it now
                                         FIRES Codex on the cheap cross-model lens instead of
                                         skipping -- a cheap second model on the common path)
  '' -> pre-tier default               : -c model_reasoning_effort=medium  (NO model override,
                                         byte-identical to the pre-tier behavior so the existing
                                         no-tier chunk-checkpoint caller is unaffected). B and ''
                                         now DIVERGE: B carries the gpt-5.4-mini model, '' does not.
  C -> lightest model + low effort     : -c model=gpt-5.4-mini  -c model_reasoning_effort=low

The binding acceptance property (spec chunk 9): Tier A and Tier C produce
DISTINCT codex invocation args -- model AND effort differ; and after the chunk-9
flip Tier B and the absent ('') tier ALSO diverge (B fires the cheap lens).
"""

import subprocess
import sys

SCRIPT = "scripts/codex-review.sh"


def tier_config(tier):
    """Source codex-review.sh and call tier_config TIER; return (rc, stdout).

    Sourcing does not run main() -- the script guards main behind
    BASH_SOURCE==$0, which is false when sourced via `bash -c 'source ...'`.
    So this exercises the pure tier_config function in isolation, no codex call.
    """
    # Pass the tier as a positional ($1) so an empty-string tier is a real,
    # distinct argument (not "no argument"), matching how main() forwards it.
    cmd = f'source {SCRIPT}; tier_config "$1"'
    p = subprocess.run(
        ["bash", "-c", cmd, "_", tier],
        capture_output=True,
        text=True,
    )
    return p.returncode, p.stdout


def parse_review(fixture):
    """Source codex-review.sh and pipe FIXTURE through parse_review's stdin.

    Same sourcing trick as tier_config: `source ...` does not run main()
    (guarded behind BASH_SOURCE==$0), so this exercises the pure parse_review
    function in isolation, no codex/network call. parse_review reads raw
    `codex review` output on stdin and emits findings + a RESULT line on stdout.
    """
    cmd = f'source {SCRIPT}; parse_review'
    p = subprocess.run(
        ["bash", "-c", cmd],
        input=fixture,
        capture_output=True,
        text=True,
    )
    return p.returncode, p.stdout


def args_list(stdout):
    """The emitted args as a clean list (drops blank lines)."""
    return [ln for ln in stdout.splitlines() if ln.strip()]


CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn
    return deco


@case("Tier S = strongest model + xhigh effort (catastrophic top tier, ceiling reasoning level)")
def _():
    rc, out = tier_config("S")
    assert rc == 0, f"Tier S should succeed, rc={rc}"
    assert "model=gpt-5.5" in out, f"Tier S missing strongest model: {out!r}"
    assert "model_reasoning_effort=xhigh" in out, f"Tier S missing xhigh effort: {out!r}"


@case("Tier S vs Tier A = same model but distinct effort (xhigh vs high)")
def _():
    _, s = tier_config("S")
    _, a = tier_config("A")
    assert s != a, "Tier S and Tier A must produce different args"
    assert "model=gpt-5.5" in s and "model=gpt-5.5" in a, "both S and A must use gpt-5.5"
    assert "effort=xhigh" in s, f"Tier S must use xhigh effort: {s!r}"
    assert "effort=high" in s or "effort=xhigh" in s, "sanity check"
    assert "effort=high" in a and "effort=xhigh" not in a, f"Tier A must use high (not xhigh): {a!r}"


@case("Tier A = strongest model + high effort (unchanged)")
def _():
    rc, out = tier_config("A")
    assert rc == 0, f"Tier A should succeed, rc={rc}"
    assert "model=gpt-5.5" in out, f"Tier A missing strongest model: {out!r}"
    assert "model_reasoning_effort=high" in out, f"Tier A missing high effort: {out!r}"
    assert "xhigh" not in out, f"Tier A must NOT use xhigh (that is Tier S): {out!r}"


@case("Tier C = lightest model + low effort")
def _():
    rc, out = tier_config("C")
    assert rc == 0, f"Tier C should succeed, rc={rc}"
    assert "model=gpt-5.4-mini" in out, f"Tier C missing lightest model: {out!r}"
    assert "model_reasoning_effort=low" in out, f"Tier C missing low effort: {out!r}"


@case("Tier A vs Tier C produce DISTINCT args (model AND effort differ) -- the acceptance property")
def _():
    _, a = tier_config("A")
    _, c = tier_config("C")
    assert a != c, "Tier A and C must produce different args"
    # model differs
    assert "gpt-5.5" in a and "gpt-5.4-mini" in c, "models must differ between A and C"
    # effort differs
    assert "effort=high" in a and "effort=low" in c, "efforts must differ between A and C"


@case("Tier B = lightest model + medium effort (chunk-9 flip: B fires the cheap cross-model lens)")
def _():
    rc, out = tier_config("B")
    assert rc == 0, f"Tier B should succeed, rc={rc}"
    # Chunk 9 flips B from "no model override (skip)" to the cheap cross-model lens:
    # gpt-5.4-mini at the same medium effort, so Codex now fires on the high-volume
    # tier. The model id goes via `-c model=...` (codex review has no -m flag).
    assert "model=gpt-5.4-mini" in out, f"Tier B must use the lightest model gpt-5.4-mini: {out!r}"
    assert "model_reasoning_effort=medium" in out, f"Tier B must keep medium effort: {out!r}"


@case("No tier (empty) DIVERGES from Tier B after the chunk-9 flip (absent stays bare, B carries the model)")
def _():
    # Pre-chunk-9 these shared one branch; the flip splits them. The absent path
    # stays byte-identical to the pre-tier default (medium, NO model override) so
    # the no-tier chunk-checkpoint caller is unaffected; Tier B now carries the
    # gpt-5.4-mini model. They must no longer be equal.
    _, empty = tier_config("")
    _, b = tier_config("B")
    assert args_list(empty) != args_list(b), f"empty tier must DIVERGE from Tier B now: {empty!r} vs {b!r}"
    assert "model=" not in empty, f"absent tier must NOT override the model (pre-tier default): {empty!r}"
    assert "model_reasoning_effort=medium" in empty, f"absent tier must keep medium effort: {empty!r}"


@case("Unknown tier fails loud (nonzero exit)")
def _():
    rc, _out = tier_config("Z")
    assert rc != 0, "unknown tier must fail loud, not silently pick a default"


@case("Emitted args are well-formed -c pairs (each value line preceded by a -c flag)")
def _():
    for tier in ("S", "A", "B", "C"):
        _, out = tier_config(tier)
        args = args_list(out)
        # codex review takes `-c key=value`; every key=value must follow a `-c`.
        for i, tok in enumerate(args):
            if "=" in tok:
                assert i > 0 and args[i - 1] == "-c", (
                    f"Tier {tier}: '{tok}' not preceded by -c: {args!r}"
                )


# --- parse_review: the [P<n>] finding-line format pin --------------------------
# parse_review keys CLEAN-vs-FINDINGS strictly on the `[P<n>]` severity tag
# (codex-review.sh lines 46-68): a line shaped `- [P<n>] <title> -- <file>:<lines>`
# is a finding; prose without a tag is CLEAN; a bare-dash diff line (no tag) is
# NOT a finding. These cases pin that load-bearing format so a refactor of the
# grep regex that silently broke detection would fail loud here, not in prod.


@case("parse_review: a `- [P1] ... -- file:L` line counts as one finding (FINDINGS=1)")
def _():
    rc, out = parse_review("- [P1] SQL injection in query builder -- db.py:42\n")
    assert rc == 0, f"parse_review should succeed, rc={rc}"
    assert "RESULT: FINDINGS=1" in out, f"a [P1] line must read FINDINGS=1: {out!r}"
    assert "RESULT: CLEAN" not in out, f"a tagged finding must NOT read CLEAN: {out!r}"


@case("parse_review: clean REASONING prose with no [P<n>] tag reads CLEAN")
def _():
    fixture = (
        "REASONING: this change only edits a comment and does not alter "
        "runtime behavior, so it should not break existing code.\n"
    )
    rc, out = parse_review(fixture)
    assert rc == 0, f"parse_review should succeed, rc={rc}"
    assert "RESULT: CLEAN" in out, f"untagged prose must read CLEAN: {out!r}"
    assert "FINDINGS" not in out, f"clean prose must NOT report findings: {out!r}"


@case("parse_review: bare-dash diff-noise lines (no [P<n>] tag) are NOT counted as findings")
def _():
    # A unified diff has lines starting with a bare '-' / '+'; none carry a
    # [P<n>] tag, so keying on the tag (not the dash) must read CLEAN.
    fixture = (
        "--- a/db.py\n"
        "+++ b/db.py\n"
        "- old_line = compute()\n"
        "+ new_line = compute()\n"
    )
    rc, out = parse_review(fixture)
    assert rc == 0, f"parse_review should succeed, rc={rc}"
    assert "RESULT: CLEAN" in out, f"bare-dash diff lines must NOT be findings: {out!r}"
    assert "FINDINGS" not in out, f"diff noise must not be miscounted as findings: {out!r}"


@case("parse_review: counts multiple distinct [P<n>] findings (FINDINGS=2)")
def _():
    fixture = (
        "- [P1] SQL injection in query builder -- db.py:42\n"
        "- [P2] missing auth check on admin route -- routes.py:88\n"
    )
    rc, out = parse_review(fixture)
    assert rc == 0, f"parse_review should succeed, rc={rc}"
    assert "RESULT: FINDINGS=2" in out, f"two tagged findings must read FINDINGS=2: {out!r}"


def main():
    passed = 0
    failed = 0
    for name, fn in CASES:
        try:
            fn()
            print(f"  ok   {name}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL {name}\n         {e}")
            failed += 1
        except Exception as e:  # noqa: BLE001 -- surface any unexpected error as a failure
            print(f"  ERROR {name}\n         {type(e).__name__}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed ({len(CASES)} total)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
