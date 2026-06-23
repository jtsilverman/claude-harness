---
name: reset-or-decompose
description: Use on attempt 3 of a chunk (2 failed implementation attempts), to route true failures through diagnosis, capture, and branch cleanup without free-wheeling.
---

> **Communication discipline.** Apply `~/.claude/coo/communication-discipline.md` throughout this skill: TLDR on multi-point output, two-line teach format on new concepts, callback over re-derivation when concepts repeat, real vocabulary with plain unpack, conclusion before justification, slow down when complex.

# Reset or Decompose

## Overview

The stop-decision at two-failure is handled by `disciplines/worker-discipline.md` (the reset rule); Claude holds it without this skill. This skill owns the downstream: distinguishing true failure from scope-revision, narrowing four options to 1-2 via diagnosis, invoking `capture-learning` with resolution metadata, and walking the operator through destructive git ops and spec edits.

## When it fires

- the chunk-end self-check on attempt 3+ (2 failed already).
- the operator manually at any failed-twice checkpoint.

## Step 1: Confirm failed-attempt count

Count **failed** attempts, not existing attempt branches. A branch may exist from a successful attempt or be an empty placeholder. Ask the operator directly: "how many attempts have failed?"

When git is available, show `attempt/<chunk>-N` branches as context but do not treat branch count as the count. the operator confirms.

If fewer than 2 failed attempts, stop and redirect back to the normal chunk-end self-check (`disciplines/worker-discipline.md`). This skill doesn't fire until the two-strike cap is reached.

## Step 2: Failure vs revision check

Ask the operator directly: was this a **failure** (one of the three canonical cases) or a **revision** (scope shifted, changed mind)?

Failure = acceptance test didn't pass, verification surfaced scope-wrong result, or approach collapsed on edge cases.

Revision = same chunk, different approach decided mid-stream without the above.

**If revision:** stop and hand off to `spec-collaboration` for chunk revision. Do NOT invoke the four-options flow. Do NOT invoke capture-learning as failure. Revisions don't trigger reset discipline.

**If failure:** continue to step 3.

## Step 3: Diagnose root cause

Ask: what specifically failed across both attempts?

- **Test didn't pass, approach looks right** → reset (likely detail bug, fresh attempt).
- **Verification showed scope too big or wrong files** → shrink or decompose (scope issue, not approach).
- **Approach collapsed on edge cases** → reset (wrong approach) or decompose (edge cases are their own sub-problem).
- **Understanding gap** (the operator can't explain even after teaching mode) → decompose (smaller units) or abandon (premature).
- **The chunk itself was wrong** → abandon.
- **Discovery, not failure** (the chunk's approach was fine, but mid-impl revealed a precondition or side quest that should have been its own chunk and that's what the attempts kept colliding with) → hand off to `chunk-pivot` as a retrofit: pause this chunk, carve a sub-chunk for the discovered work with mini-spec discipline, then resume the parent. See `disciplines/worker-discipline.md` (mid-impl discovery vs failure).

Narrow to 1-2 options. Do not list all four unless diagnosis is genuinely ambiguous.

## Step 4: the operator picks, writes rationale

the operator picks from the narrowed options. One sentence: which option and why. Own words. Do not draft.

## Step 5: Execute branch ops

Per option:

- **Shrink or decompose:** no branch changes.
- **Reset:** destructive. Split into separate commands for per-branch confirmation. First `git checkout feat/<spec-name>` (safe, auto-run). Then one `git branch -D attempt/<chunk>-N` per branch, each with its own confirmation. Never batch deletes onto one command line. Never auto-run `git branch -D` or `git reset --hard`.
- **Abandon:** same per-branch destructive cleanup as reset, plus spec edit in step 6. Delete branches first, then spec edit. Each branch delete and the spec edit each get their own confirmation.

On `~/.claude/` (not a git repo): flag "no branches to clean up; proceeding to spec update and capture." Not an error.

## Step 5.5: Outcome escalation (default reset -> heavy retry)

A DEFAULT chunk that reaches this skill was mis-tiered: it under-powered the work. On the RESET option, escalate it to HEAVY for the retry. The walk (install VERBATIM):

```
OUTCOME ESCALATION: a DEFAULT chunk that hits reset-or-decompose (2 failed attempts) or 2 judge
fix-rounds was mis-tiered -- it escalates to HEAVY on the retry.
```

Apply it only on RESET (a fresh attempt at the same chunk): change the chunk's `tier` line to `heavy` with the two trigger answers updated to reflect what the failure revealed (the complexity or blast-radius the original read missed), so the retry dispatches the heavier builder. Shrink and decompose re-tier the resulting sub-chunks on their own merits; abandon removes the chunk, so no retry tier applies. A chunk already at HEAVY does not escalate further -- it routes through the normal diagnosis options above.

## Step 6: Update spec

Three-stage handoff (close out the attempt, capture the failure, hand the decision to the COO/the operator):

- Draft the spec diff. Mechanical spec hygiene only: shrink = update chunk description; decompose = replace chunk with sub-chunks; reset = keep description, clear attempt history; abandon = remove chunk from decomposition list. Approach notes, lessons learned, and forward-looking substance are the operator's to write, not Claude's to draft.
- Show the operator the proposed diff.
- Apply only on the operator's approval.

Never silently edit `specs/current.md`.

## Step 7: Invoke capture-learning

Call `capture-learning` with structured payload:

```
category: failure
project: <slug from spec H1>
chunk: <current chunk name>
attempts: [attempt/<chunk>-1, attempt/<chunk>-2]
cause: <the operator's one-sentence failure diagnosis from step 3>
resolution:
  option: shrink | decompose | reset | abandon
  rationale: <the operator's one-sentence from step 4>
```

the operator writes `cause` and `rationale` substance. Claude files.

## Hard rules

- Do not fire on fewer than 2 failed attempts. Count failures, not branches.
- Revisions route to `spec-collaboration`, not through this skill.
- Never list all four options when diagnosis narrows to 1-2.
- Destructive git ops (`branch -D`, `reset --hard`) require explicit the operator confirmation per command. Never batch.
- the operator writes cause and rationale. Claude never drafts.
- Never silently edit `specs/current.md`.
- Always call `capture-learning` on true failure; never skip.
