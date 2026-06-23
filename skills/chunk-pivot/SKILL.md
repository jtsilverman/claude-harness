---
name: chunk-pivot
description: Use when implementation mid-chunk reveals a non-trivial side quest. Triggers include a precondition that must ship before current work can continue, a dependency that needs its own chunk, or scope discovered live that does not fit the current chunk's contract. Distinct from a bug (use systematic-debugging) and from 2-failure (use reset-or-decompose). Spec-gate threshold: would create a new file, touches a module outside the chunk's declared scope, requires its own failing test, or exceeds about 30 lines net new code.
---

# Chunk Pivot

Mid-implementation pivot: carve a sub-chunk inline (parent paused, dotted-decimal numbering like `6 → 6.1`), isolate parent WIP, run the sub-chunk through normal Phase 3-6 discipline, then resume the parent with re-read + re-test + ripple-check.

## When it fires

Phase 4 (Execute), mid-implementation, when scope discovery hits the spec-gate threshold (new file, out-of-scope module, own failing test needed, or ~30+ lines net new). See `disciplines/worker-discipline.md` for the full routing split between pivot / `systematic-debugging` / `reset-or-decompose`.

## Step 1: Surface and confirm

Rule 7 inline, one line:

```
Looks like a pivot. Carving N.M SIDE: <name>. <One-line why parent is blocked>. Flag if not.
```

`N` = parent chunk number, `M` starts at 1, increments per pivot under the same parent. Proceed to Step 2 if the operator doesn't flag.

## Step 2: Pause parent chunk (Resume direction required)

Write a `**Resume direction (post-pivot):**` line into `specs/current.md` § Current chunk under the parent entry.

**Required elements** (refuse to proceed if any are missing):

1. File path the parent was editing.
2. First concrete action on resume (function name, edit site, command).
3. Reference line numbers in WIP code or spec.
4. What the pivot unblocks, one phrase.

Format:

```
**Resume direction (post-pivot):** Edit `<file>` at line(s) <N>; first action is <X>. Pivot unblocks <Y>.
```

Vague pointers like "continue what you were doing" are refused. If you can't write a concrete pointer, back out to a clean spot first.

## Step 3: Isolate parent WIP (pick one)

**Worktree (default for non-trivial pivots).** Spawn a worktree at `<repo-root>/.worktrees/<spec-name>-pivot-<N.M>` on a new branch `feat/<spec-name>-pivot-<N.M>` branched from the current feature branch (the `.worktrees/` convention + the safety gate of confirming a clean state first; see `rules/git-discipline.md` § Destructive operations). Parent WIP stays uncommitted in the parent worktree; pivot work happens in the isolated worktree. Change cwd to the pivot worktree before any subsequent edits.

**WIP commit (short pivots only).** When the pivot is expected to span under 30 minutes AND touches files in a clearly separate module from parent WIP: commit parent WIP with `WIP: <chunk-N>`, branch off via `git checkout -b feat/<spec-name>-pivot-<N.M>`, then `git reset --hard HEAD~1` on the pivot branch to leave it starting from a clean pre-WIP state. The WIP commit makes the parent's paused state visible in branch history.

**Stash is banned.** Hidden state defeats the resume protocol.

## Step 4: Carve sub-chunk in spec (mini-spec required)

Edit `specs/current.md` on the pivot branch:

1. **`## Chunk decomposition`**: append `(paused mid-impl, see N.M)` to the parent entry; insert a new `N.M` line with `SIDE:` prefix.
2. **The board pointer**: on an `## Execution state`-board spec (the default), add a `- N.M: pending` board row and mark the parent row paused; on a strict-chain fallback spec, flip the `## Current chunk` pointer to N.M.
3. **Mini-spec body for N.M** (required floor):
    - One paragraph: why this side quest is needed and what it unblocks.
    - Two to three acceptance criteria: testable conditions, not "make it work."
    - One line "what unblocks parent": the specific parent state waiting on this pivot.

A pivot without acceptance criteria is a patch wearing a chunk number.

**Pipeline-dispatch mode.** Mirrors the worker discipline's capture-learning DRAFT-AND-RETURN carve-out (`disciplines/worker-discipline.md`). A pipeline-dispatched worker does NOT edit `specs/current.md` (the COO is the sole writer of shared state): it drafts the pivot — the Step 2 Resume direction + the Step 4 mini-spec (one-paragraph why, 2-3 acceptance criteria, what-unblocks-parent) — into its return bundle and fails loud, and the COO applies the spec writes and schedules N.M sole-writer at merge. The direct-dispatch worker (run outside the pipeline) writes the spec itself as Steps 2 and 4 describe.

**Numbering note.** Dotted-decimal `N.M` is the parent-child pivot convention. The sibling-decimal convention (e.g. `8.5 → 8.6` from substrate splits at chunk-kickoff prework) is parallel, not the same thing.

## Step 5: Run pivot through Phase 3-6

From the pivot worktree, run the pivot through normal chunk discipline:

1. `recall` (unless trivial).
2. `chunk-kickoff`: own prediction and tier, independent of parent.
3. Failing test first via `tdd-red` (driven by Step 4 acceptance criteria).
4. Implement via `tdd-green` (minimal to pass, then REFACTOR / delete-what-it-obsoletes).
5. Verify against the hierarchy in `disciplines/worker-discipline.md` § Verify (evidence before any done claim).
6. Close the pivot with the chunk-end self-check (`disciplines/worker-discipline.md` § Self-check), route lessons through `capture-learning`, draft the commit.

If the pivot hits 2-failure, invoke `reset-or-decompose` scoped to the pivot. Pivot abandonment may cascade to parent abandonment.

## Step 6: Resume parent

1. **Merge pivot back.**
    - *Worktree path:* switch to parent worktree, `git merge feat/<spec-name>-pivot-<N.M>`, then `git worktree remove` the pivot worktree.
    - *WIP-commit path:* switch to parent feature branch (at the `WIP: <chunk-N>` commit), `git reset --soft HEAD~1` to un-WIP, then `git merge feat/<spec-name>-pivot-<N.M>`. Delete pivot branch with `git branch -d`.
2. **Update spec.** Move N.M to `## Completed chunks`. Update parent N entry to `(resumed from pivot N.M)`. Flip `## Current chunk` back to N.
3. **Re-read the parent chunk's full spec entry and the Resume direction pointer.** Mid-impl context was evicted; the pointer is the reload key.
4. **Re-run the parent chunk's failing test.** Confirm current state: still RED (continue impl) or now GREEN (go straight to the chunk-end self-check).
5. **Re-run typecheck/lint/quick smoke** to surface ripple effects from pivot changes on parent WIP.
6. Continue Phase 4 from the Resume direction's "first concrete action."

## Discipline rules

1. **Mini-spec required.** One-paragraph why + 2-3 acceptance criteria + "what unblocks parent." No exceptions.
2. **Cap nesting at 1.** A pivot inside a pivot (e.g. 6.1.1) is forbidden. If a side quest surfaces inside a pivot, escalate to `reset-or-decompose` on the parent.
3. **No separate spec file.** Pivots stay in `specs/current.md`. Single source of truth.
4. **Visible parent pause.** Worktree or explicit WIP commit -- both leave paused state visible. Stash is banned.
5. **Pivot 2-failure scoped to pivot.** `reset-or-decompose` fires on the pivot first; cascade to parent is a separate routing decision.

## Red flags, STOP

- About to patch a non-trivial side quest into the current chunk's diff.
- About to spawn a pivot without writing a Resume direction.
- About to carve a pivot inside a pivot.
- About to skip the pivot's kickoff because "it's a small one."
- About to resume parent without re-running its failing test.
- About to write `**Resume direction (post-pivot):** continue what you were doing`.

## When NOT to invoke

- Discovery is a bug: use `systematic-debugging`.
- Chunk has failed twice: use `reset-or-decompose`.
- "Side quest" is 1-2 lines of in-scope refactor: patch within chunk, surface inline (Rule 7).
- At chunk-end, not mid-impl: the chunk-end self-check scope review (`disciplines/worker-discipline.md`) handles drift.
- At chunk-start, not mid-impl: `chunk-kickoff` prework probe handles substrate splits.
