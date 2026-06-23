#!/usr/bin/env python3
"""Test: chunk-kickoff SKILL.md contains a tier-gated skeleton-sketch step.

Acceptance criteria (chunk 9):
  1. The skill adds a skeleton-sketch step gated to S/A tiers.
  2. B/C chunks explicitly skip the skeleton step.

This test reads skills/chunk-kickoff/SKILL.md and asserts both structural
facts about the doc. It is a content-inspection test over a markdown skill file
-- no subprocess, no mocking, stdlib only.

Run: python3 scripts/chunk_kickoff_skeleton_test.py  (exit 0 = pass, 1 = fail)
"""

import pathlib
import sys

HERE = pathlib.Path(__file__).parent
SKILL_FILE = HERE.parent / "skills" / "chunk-kickoff" / "SKILL.md"

_failures = []
_passes = []


def check(name, cond, detail=""):
    if cond:
        _passes.append(name)
        print(f"PASS  {name}")
    else:
        _failures.append((name, detail))
        print(f"FAIL  {name}  {detail}")


def test_skeleton_step_present_and_tier_gated():
    """SKILL.md must contain a skeleton-sketch step that mentions S/A tiers."""
    content = SKILL_FILE.read_text()
    lines = content.splitlines()

    # Criterion 1a: the word "skeleton" must appear in a step context
    has_skeleton_word = any("skeleton" in line.lower() for line in lines)
    check(
        "skill contains the word 'skeleton'",
        has_skeleton_word,
        f"No 'skeleton' found in {SKILL_FILE}",
    )

    # Criterion 1b: S/A tier gate must be co-located with skeleton (within the
    # same section/paragraph).  We look for any line within 15 lines of a
    # skeleton line that mentions S/A or equivalent.
    skeleton_lines = [i for i, ln in enumerate(lines) if "skeleton" in ln.lower()]
    tier_sa_nearby = False
    for idx in skeleton_lines:
        window = lines[max(0, idx - 15) : idx + 16]
        window_text = "\n".join(window)
        if any(kw in window_text for kw in ["S/A", "S and A", "Tier S", "Tier A", "tiers S", "tiers A"]):
            tier_sa_nearby = True
            break
    check(
        "skeleton step is gated to S/A tiers (S/A mention near skeleton word)",
        tier_sa_nearby,
        f"No S/A tier gate found near skeleton mentions (skeleton at lines {skeleton_lines})",
    )


def test_bc_skip_explicitly_stated():
    """SKILL.md must explicitly tell B/C chunks to skip the skeleton step."""
    content = SKILL_FILE.read_text()
    lines = content.splitlines()

    # Look for a line that mentions B/C (or equivalent) AND skip near skeleton context
    bc_skip_found = False
    skeleton_lines = [i for i, ln in enumerate(lines) if "skeleton" in ln.lower()]

    for idx in skeleton_lines:
        window = lines[max(0, idx - 20) : idx + 21]
        window_text = "\n".join(window)
        has_bc = any(kw in window_text for kw in ["B/C", "B and C", "Tier B", "Tier C", "tiers B", "tiers C"])
        has_skip = "skip" in window_text.lower()
        if has_bc and has_skip:
            bc_skip_found = True
            break

    check(
        "B/C chunks explicitly skip the skeleton step",
        bc_skip_found,
        f"No B/C + skip combination found near skeleton mentions (skeleton at lines {skeleton_lines})",
    )


def _get_step25_body(lines):
    """Return the body lines of Step 2.5 (lines after the heading, up to the next ## heading).

    Returns an empty list if the section is not found or has no body lines.
    """
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith("## ") and "2.5" in ln and "skeleton" in ln.lower():
            start = i
            break
    if start is None:
        return []
    body = []
    for ln in lines[start + 1 :]:
        if ln.startswith("## "):
            break
        body.append(ln)
    return body


def test_skeleton_body_has_instruction_text():
    """Step 2.5 body must contain prose instruction text, not just the heading.

    The heading alone satisfies keyword-proximity checks; this test ensures the
    body (lines between the heading and the next ## section) is non-trivial.
    """
    content = SKILL_FILE.read_text()
    lines = content.splitlines()

    body = _get_step25_body(lines)
    body_text = "\n".join(body)

    # At least one non-blank body line must exist
    non_blank_body = [ln for ln in body if ln.strip()]
    check(
        "Step 2.5 body has at least one non-blank instruction line",
        len(non_blank_body) >= 1,
        f"Step 2.5 body is empty (heading found but no body lines before next ## section)",
    )

    # Body must mention what to sketch (module structure OR function signatures OR similar)
    has_sketch_content = any(
        kw in body_text.lower()
        for kw in ["module structure", "function signature", "file path", "exported name", "rough signature"]
    )
    check(
        "Step 2.5 body describes what to sketch (module/signature/path content)",
        has_sketch_content,
        f"Step 2.5 body does not describe sketch content: {body_text!r}",
    )


def test_skeleton_no_tier_fallback():
    """Step 2.5 must specify what to do when tier is absent from the payload.

    A step gated by tier must handle the missing-tier case explicitly; otherwise
    the agent is left to guess whether to run or skip the step.
    """
    content = SKILL_FILE.read_text()
    lines = content.splitlines()

    body = _get_step25_body(lines)
    body_text = "\n".join(body)

    has_notier_fallback = any(
        kw in body_text.lower()
        for kw in [
            "tier not in payload",
            "absent",
            "not present",
            "no tier",
            "missing tier",
            "tier is absent",
            "if absent",
            "when absent",
            "if the tier",
            "if no tier",
        ]
    )
    check(
        "Step 2.5 specifies fallback when tier is absent from payload",
        has_notier_fallback,
        f"Step 2.5 body has no no-tier fallback; body: {body_text!r}",
    )


def main():
    if not SKILL_FILE.exists():
        print(f"ERROR: skill file not found: {SKILL_FILE}")
        sys.exit(1)

    test_skeleton_step_present_and_tier_gated()
    test_bc_skip_explicitly_stated()
    test_skeleton_body_has_instruction_text()
    test_skeleton_no_tier_fallback()

    print()
    print(f"{len(_passes)} passed, {len(_failures)} failed")
    if _failures:
        for name, detail in _failures:
            print(f"  FAILED: {name}  {detail}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
