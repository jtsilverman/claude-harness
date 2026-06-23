#!/usr/bin/env python3
"""RED test for the CEO-demo PUSH detection primitive (ceo-demo-layer chunk 3).

Run: python3 scripts/demo_detect_test.py   (exit 0 = all pass, 1 = any fail)

What this pins
--------------
The cockpit's PUSH demo lifeline (skills/cockpit/SKILL.md, after the post-merge
board write) needs a MECHANICAL, directly-testable half: given the spec text
(which carries the `## CEO demo plan` and the `## Execution state` board) plus
the set of milestone ids that ALREADY fired on a prior tick, decide which
milestones are due to fire NOW. The fire / sole-write demos/<slug>/M<n>.md /
surface-the-FYI half is Claude orchestration and is not unit-tested here; this
test exercises ONLY the detection primitive end-to-end on a fixture spec, with
no Agent-tool call (per recall `sigil-split-primitives-vs-orchestration`).

The single behavior under test: FIRE EXACTLY ONCE per milestone. A milestone
whose FULL trigger chunk set has reached `merged` is returned on the tick where
it first completes, but is NOT returned again on a later tick once its id sits
in the persisted fired set. This is the spec's central detection footgun ("track
which milestones already fired so a later merge tick does not re-fire"). The
partial-trigger-set and absent-`## CEO demo plan` cases are SEPARATE behaviors
(separate acceptance criteria) and are deliberately NOT asserted here -- one
behavior per RED.

Contract pinned (implementer may rename; surfaced as a Rule 7 decision):
    demo_detect.due_milestones(spec_text, fired_ids) -> list of milestone dicts,
    one per CEO-demo-plan milestone whose every trigger chunk id is status
    `merged` on the board AND whose own id is NOT in `fired_ids`. Each returned
    dict identifies the milestone by its `M<n>` id (1-based row order, matching
    the durable demo file demos/<slug>/M<n>.md). Mirrors the codec shape of
    scripts/exec_state.py (parse_execution_state(text)) and
    scripts/runnable_set.py (runnable_set(chunks)): a pure function over the
    spec text + persisted state, returning what to act on.

RED expectation: scripts/demo_detect.py does not exist yet, so importing
`due_milestones` raises ModuleNotFoundError -- the feature is missing, which is
the right reason to fail. GREEN: the module exists, the exactly-once gate holds.
"""
import sys

# Fixture spec: one CEO-demo-plan milestone (M1) whose FULL trigger set is {1, 2},
# and a board where BOTH chunk 1 and chunk 2 are `merged`. So on a tick with an
# empty fired set, M1 is due; once M1 is recorded as fired, a re-tick must NOT
# re-yield it. (Chunk 3 is still `building` and triggers nothing -- it is here
# only to make the board realistic, not to fire anything.)
FIXTURE_SPEC = """\
# Spec: demo-detect fixture

## Chunk decomposition
**Chunk 1: first** Acceptance: x. Tier: B. Scheduling: depends-on: []; touches: a
**Chunk 2: second** Acceptance: y. Tier: B. Scheduling: depends-on: [1]; touches: b
**Chunk 3: third** Acceptance: z. Tier: B. Scheduling: depends-on: [2]; touches: c

## CEO demo plan

| trigger chunks | what + how (free-form) | what it shows | fork? |
|----------------|------------------------|---------------|-------|
| 1, 2           | run the new CLI on a sample spec, show the board | the scheduler picks the runnable set | show-and-tell |

## Execution state

- 1: merged
- 2: merged
- 3: building

## Completed chunks
"""


# BULLET-format fixture: the shape the real specs/current.md actually uses (a
# dash-led, pipe-delimited row whose FIRST cell is the literal `**M<n>**` id and
# whose trigger cell carries a `trigger:` label) -- not the suggested-but-not-
# required markdown table. The italic caption line and the blank line after the
# heading must be ignored. Board: chunks 1,2,5 merged, 3 building, 4 pending --
# so M1 (triggers {1,2}, both merged), M3 (trigger {5}, merged) and M10 (trigger
# {1}, merged) are due, while M2 (trigger {3}, building) and M11 (trigger {4},
# pending) are NOT. This is the regression fixture for the Codex P2 bug: the old
# parser dropped M1 as a "header", derived ids from a positional counter, and
# never stripped the `trigger:` label -- so it returned [] on this real shape.
# The multi-digit M10/M11 ids pin that the literal id is read, not synthesized
# from a 1-based counter (positional ids would mislabel rows 4/5 as M4/M5).
BULLET_SPEC = """\
# Spec: bullet-format fixture

## CEO demo plan

*(Dogfood -- my proposals for what to show you; we settle them together.)*

- **M1** | trigger: 1, 2 | what+how: run the new step live | shows: built + works | **show-and-tell**.
- **M2** | trigger: 3 | what+how: the push loop live | shows: works end-to-end | **show-and-tell**.
- **M3** | trigger: 5 | what+how: the pull path live | shows: works on-demand | **show-and-tell**.
- **M10** | trigger: 1 | what+how: a multi-digit id | shows: id read literally | **direction-fork**.
- **M11** | trigger: 4 | what+how: a multi-digit id, not yet merged | shows: nothing | **show-and-tell**.

## Execution state

- 1: merged
- 2: merged
- 3: building
- 4: pending
- 5: merged

## Completed chunks
"""


# Absent-section fixture: a spec with NO `## CEO demo plan` section at all. Per
# the second C3 acceptance behavior, due_milestones must return [] cleanly (the
# cockpit fires nothing on specs that carry no demo plan).
NO_PLAN_SPEC = """\
# Spec: no-demo-plan fixture

## Execution state

- 1: merged
- 2: merged

## Completed chunks
"""


# Edge-case fixture: rows that must NOT crash the parser and must NOT fire.
#   - M1: an EMPTY trigger cell (`trigger:` with nothing after) -> an empty
#     trigger set is treated as not-yet-complete, never vacuously-done.
#   - M2: a MALFORMED row missing the trailing cells (only an id + trigger) ->
#     a missing fork cell defaults to "" and never raises IndexError.
#   - M3: a well-formed row whose single trigger {1} IS merged -> the one row
#     that fires, proving the malformed siblings did not break the parse.
EDGE_SPEC = """\
# Spec: edge-case fixture

## CEO demo plan

- **M1** | trigger: | what+how: empty trigger cell | shows: nothing | **show-and-tell**.
- **M2** | trigger: 1
- **M3** | trigger: 1 | what+how: the one that fires | shows: it works | **show-and-tell**.

## Execution state

- 1: merged

## Completed chunks
"""


# Brace/set-notation fixture: the real specs/current.md CEO-demo-plan table uses
# SET notation in the trigger column -- `{12}`, `{7, 8, 9}` -- not bare ids. The
# old _trigger_ids split on `[,\s]+` only, so `{7, 8, 9}` parsed to
# ['{7','8','9}'] and `{12}` to ['{12}'], none of which match the clean board ids
# -> NO milestone ever fired (a silent cockpit-demo dead end surfaced live during
# the coo-fleet-tuning run). Board: 7,8,9 merged, 12 pending -> M2 (trigger
# {7,8,9}) fires, M1 (trigger {12}) does not.
BRACE_SPEC = """\
# Spec: brace-notation fixture

## CEO demo plan

| Trigger | What + how | What it shows | Fork? |
|---|---|---|---|
| {12} | the autoload number | the split worked | show-and-tell |
| {7, 8, 9} | the model matrix | the fleet is tuned | show-and-tell |

## Execution state

- 7: merged
- 8: merged
- 9: merged
- 12: pending

## Completed chunks
"""


# Real 5-column CEO-demo-plan table fixture: the EXACT shape the live
# specs/current.md uses -- `| Milestone | Trigger chunks | What + how | Shows |
# Fork? |` with a LEADING Milestone column that carries the `M<n> — <label>` id.
# This is the regression fixture for BD-3: the TABLE branch read triggers from
# cells[0] (the Milestone column, e.g. "M1 — Grader sees a session", which never
# matches a board id) and fork from cells[3] (the Shows column), so on the real
# 5-col table NO milestone ever fired (due_milestones returned []). Board: 1,2
# merged, 3 building, 4 pending -> M1 (triggers {1,2}, both merged) is due with
# fork "show-and-tell"; M2 (triggers {3,4}, only 3 building / 4 pending) is a
# partial set and must NOT fire. The Milestone cell carries an em-dash label, so
# the parser must take the M<n> id from the Milestone column (not synthesize a
# positional id) AND read triggers from the Trigger-chunks column (cells[1]) and
# fork from the Fork? column (cells[4]).
FIVE_COL_SPEC = """\
# Spec: real 5-col CEO-demo-plan fixture

## CEO demo plan

| Milestone | Trigger chunks | What + how | Shows | Fork? |
|---|---|---|---|---|
| M1 — Grader sees a session | 1, 2 | CLI: run the grader on THIS session | The headline working on real data | show-and-tell |
| M2 — Knows when to stop | 3, 4 | Before/after: clean vs messy session | Self-termination + the capture feed | direction-fork (revisit propose-vs-auto) |

## Execution state

- 1: merged
- 2: merged
- 3: building
- 4: pending

## Completed chunks
"""


def main():
    failures = 0

    def check(name, cond):
        nonlocal failures
        ok = bool(cond)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
        if not ok:
            failures += 1

    # Import inside main so a missing module fails on the assertions below
    # (a clean RED "feature missing"), not as an uncaught collection error.
    from demo_detect import due_milestones

    # First tick: nothing has fired yet. M1's full trigger set {1, 2} is merged,
    # so M1 is due exactly once.
    first = due_milestones(FIXTURE_SPEC, set())
    first_ids = {m["id"] for m in first}
    check(
        "first tick (empty fired set) yields milestone M1 -- full trigger set {1,2} is merged",
        first_ids == {"M1"},
    )

    # Second tick: M1 is now in the persisted fired set. A later merge tick must
    # NOT re-fire it -- the exactly-once invariant. due_milestones returns [].
    second = due_milestones(FIXTURE_SPEC, {"M1"})
    check(
        "second tick (M1 already fired) yields nothing -- exactly-once, no re-fire",
        list(second) == [],
    )

    # --- BULLET format (the real specs/current.md shape) -- regression for the
    # Codex P2 parse bug ---------------------------------------------------------
    bullet = due_milestones(BULLET_SPEC, set())
    bullet_by_id = {m["id"]: m for m in bullet}
    check(
        "bullet format: exactly {M1, M3, M10} fire (their full trigger sets are merged); M2, M11 do not",
        set(bullet_by_id) == {"M1", "M3", "M10"},
    )
    check(
        "bullet format: M2 does NOT fire -- its trigger {3} is still building (partial/unmet set)",
        "M2" not in bullet_by_id,
    )
    check(
        "bullet format: M10 (multi-digit) fires with its LITERAL id, not a positional M4",
        "M10" in bullet_by_id,
    )
    check(
        "bullet format: M11 (trigger {4} pending) does NOT fire",
        "M11" not in bullet_by_id,
    )
    check(
        "bullet format: the literal M1 id is read (the leading **M1** row is not eaten as a header)",
        "M1" in bullet_by_id,
    )
    check(
        "bullet format: trigger ids are parsed past the `trigger:` label -> M1.triggers == ['1','2']",
        bullet_by_id.get("M1", {}).get("triggers") == ["1", "2"],
    )
    check(
        "bullet format: the fork flavor is read from the LAST cell (M1 -> show-and-tell)",
        "show-and-tell" in bullet_by_id.get("M1", {}).get("fork", ""),
    )

    # --- Partial-trigger-set -> no fire (separate C3 acceptance behavior) -------
    # A milestone whose trigger set is only PARTLY merged must not fire (every
    # trigger id must be `merged`). Dedicated fixture: M1's set is {1, 2} but
    # only chunk 1 is merged (chunk 2 is building) -> M1 must return nothing.
    partial = due_milestones(
        """\
# Spec: partial-trigger fixture

## CEO demo plan

- **M1** | trigger: 1, 2 | what+how: half its set merged | shows: nothing | **show-and-tell**.

## Execution state

- 1: merged
- 2: building
""",
        set(),
    )
    check(
        "partial trigger set: M1 ({1,2}, only 1 merged) does NOT fire -- every trigger must be merged",
        partial == [],
    )

    # --- Absent `## CEO demo plan` section -> [] (separate C3 acceptance) -------
    check(
        "absent demo-plan section yields [] cleanly (no-op on specs with no plan)",
        due_milestones(NO_PLAN_SPEC, set()) == [],
    )

    # --- Edge cases: empty trigger cell, malformed row, multi-digit id ----------
    edge = due_milestones(EDGE_SPEC, set())
    edge_ids = {m["id"] for m in edge}
    check(
        "edge: empty trigger cell (M1) does NOT fire -- empty set is not vacuously-done",
        "M1" not in edge_ids,
    )
    check(
        "edge: malformed row missing trailing cells (M2) does not crash; absent fork -> not fired here",
        "M2" not in edge_ids,
    )
    check(
        "edge: a well-formed sibling (M3, trigger {1} merged) still fires past the malformed rows",
        edge_ids == {"M3"},
    )

    # --- Brace / set notation in the trigger column (the real specs/current.md
    # shape) -- regression for the cockpit-demo dead end surfaced live ----------
    brace = due_milestones(BRACE_SPEC, set())
    brace_by_id = {m["id"]: m for m in brace}
    check(
        "brace notation: M2 ({7, 8, 9} all merged) fires -- braces stripped from the ids",
        brace_by_id.get("M2", {}).get("triggers") == ["7", "8", "9"],
    )
    check(
        "brace notation: M1 ({12} pending) does NOT fire",
        "M1" not in brace_by_id,
    )
    check(
        "brace notation: exactly {M2} is due",
        set(brace_by_id) == {"M2"},
    )

    # --- BD-3: the real 5-column CEO-demo-plan table (Milestone | Trigger chunks
    # | What + how | Shows | Fork?) -- the live specs/current.md shape -----------
    import demo_detect as _demo_detect_mod

    five = due_milestones(FIVE_COL_SPEC, set())
    five_by_id = {m["id"]: m for m in five}
    check(
        "5-col table: exactly {M1} fires -- its full trigger set {1,2} is merged",
        set(five_by_id) == {"M1"},
    )
    check(
        "5-col table: M1.id is read from the Milestone column (M1, not a positional synthesis)",
        "M1" in five_by_id,
    )
    check(
        "5-col table: M1 triggers come from the Trigger-chunks column (cells[1]) -> ['1','2'], "
        "NOT from the Milestone column",
        five_by_id.get("M1", {}).get("triggers") == ["1", "2"],
    )
    check(
        "5-col table: M1 fork comes from the Fork? column (cells[4]) -> 'show-and-tell', "
        "NOT the Shows column",
        five_by_id.get("M1", {}).get("fork") == "show-and-tell",
    )
    check(
        "5-col table: M2 ({3,4}, only 3 building / 4 pending) is a partial set and does NOT fire",
        "M2" not in five_by_id,
    )

    # already-fired id is skipped even on the 5-col table (exactly-once holds for
    # the table shape too, not just the bullet form).
    five_after = due_milestones(FIVE_COL_SPEC, {"M1"})
    check(
        "5-col table: an already-fired id in fired_ids (M1) is skipped on a re-tick -> []",
        list(five_after) == [],
    )

    # --- Docstring no longer claims the bullet form is canonical -----------------
    # The original docstring asserted "the real specs/current.md uses the bullet
    # form" -- now false (current.md uses the 5-col table). The corrected
    # docstring must not claim bullet-only / bullet-canonical.
    doc = (due_milestones.__doc__ or "") + " " + (_demo_detect_mod.__doc__ or "")
    check(
        "docstring no longer claims the real specs/current.md uses the bullet form",
        "the real specs/current.md uses the bullet form" not in doc,
    )
    check(
        "docstring no longer documents the wrong table column layout "
        "(the pre-fix 'fork is column 3' claim is gone)",
        "the fork is column 3" not in doc,
    )

    total = 25
    print(f"\n{total - failures}/{total} passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
