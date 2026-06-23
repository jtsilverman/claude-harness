# Spec Template

The canonical layout of a locked spec. Interrogation drives the top sections (Requirements through Chunk decomposition); the bottom sections are runtime state that accumulates as chunks ship.

```
# Spec: <slug>

**Status:** Locked | Shipped — YYYY-MM-DD | Abandoned — YYYY-MM-DD
**Created:** YYYY-MM-DD
**Locked:** YYYY-MM-DD

## Context
## Requirements
## Constraints
## Non-goals
## Interfaces / data model
## Acceptance criteria
## Test strategy
## Execution boundaries
## Chunk decomposition
## CEO demo plan
## Testing chunks
## Execution state        # default for multi-chunk specs — per-chunk status board (pending | building | awaiting-review | approved | merged | failed | deferred)
## Current chunk          # fallback for a genuine strict-dependency chain (single-threaded only)
## Completed chunks
## Backfill decisions     # seeded empty at lock; backfill-decisions Steps 2-4 append/drain; drained by ship-spec
## Open questions
## Follow-up (post-ship, separate spec)
```

## Section notes

**`## Backfill decisions`** is seeded empty at lock time and is the on-disk home for the defer-and-backfill queue (`backfill-decisions` Steps 2-4 append/drain), so a logged decision survives a `/clear`. Place it between `## Completed chunks` and `## Open questions`; `ship-spec` drains it at ship.

**`## Execution state`** is the default board for any multi-chunk spec: one line per chunk, `- <id>: <status>`, where status is `pending | building | awaiting-review | approved | merged | failed | deferred`. The board is the cockpit's sole-writer surface (only the cockpit writes it, only at merge, serially — so the spec-state race never exists), read and written through the codec at `scripts/exec_state.py`, and joined with each chunk's `depends-on:`/`touches:` Scheduling field to feed `scripts/runnable_set.py`. It is pure run-state: `ship-spec` clears it at archive (the Finalize-the-archive step) so a shipped spec carries no stale board. **`## Current chunk`** is the fallback for a spec whose chunks form a true strict dependency chain and will never run in parallel — use it only then, and omit `## Execution state` in that case.

**`## CEO demo plan`** records the milestone demos the COO drafts and co-selects with the operator at lock time (see `spec-collaboration` SKILL.md § The CEO demo plan table). The section holds a markdown TABLE, the cockpit's detection surface for firing the demo-assembler; it is required for every multi-chunk spec. The plan holds **2-4 rows**; each row carries four columns:

- **trigger chunks** — the bare chunk ids whose completion fires the demo (e.g. `3, 4`).
- **what + how** — **free-form**: what gets shown and how it's shown (a CLI run, a rendered page, a before/after, a diff). There is no fixed shape; write whatever fits *this* milestone.
- **what it shows** — the capability or product decision the demo surfaces.
- **fork?** — whether this milestone is a *show-and-tell* (confirm we're on track) or a *direction-fork* (a real direction choice opens; the operator's call decides which way).

Required row layout (a markdown table with this column set; the cockpit parses it):

```
| trigger chunks | what + how (free-form) | what it shows | fork? |
|----------------|------------------------|---------------|-------|
| 3, 4           | run the new CLI on a sample spec, show the board | the scheduler picks the runnable set | show-and-tell |
| 7              | show two candidate layouts side by side | which review surface the operator prefers | direction-fork |
```

The COLUMN SET is fixed because the cockpit parses it; the CONTENT stays per-milestone judgment, never a closed enum. `show-and-tell` and `direction-fork` are *named flavors* the author picks between by judgment for each milestone, and the what+how column is free-form, not a fixed template: a backend-glue milestone shows a CLI transcript, a UI milestone shows a rendered screen.

## Per-chunk entry schema

Each chunk in `## Chunk decomposition` is ONE schema entry in the wire shape the cockpit dispatches verbatim (the chunk-spec shape IS the payload shape; the drafter MUST write all eleven fields per chunk):

```
{ chunkId, specSlug, tier: "S"|"A"|"B"|"C",
  currentState, requirements, endState,
  acceptanceCriteria: [...], edgeCases: [...], touches: [...], dependsOn: [...], nonGoals: [...] }
```

See `spec-collaboration` SKILL.md § Chunk decomposition format for the field definitions, § Tier for the dual-axis tier trigger recorded as a comment on the `tier` line, § The id contract for the bare-N rule, and § The touches contract for the repo-relative/non-gitignored requirement on `touches` (a new file the chunk creates is valid). Runtime fields (worktree, branch, injectedDocs) are cockpit-attached at dispatch, never authored in the spec.

## The id contract in this example (board id = entry title = chunkId = dependsOn, all bare N)

The board id, the entry title, the `chunkId` field, and every `dependsOn` reference must string-match in the **bare chunk number N** (no `C`/`chunk` prefix; `scripts/runnable_set.py` joins them by literal string equality, and the codec `scripts/exec_state.py` is a passthrough that emits whatever id the board holds, so bare ids in => bare N out, no code change). A worked example, self-consistent across all id sites:

```
## Chunk decomposition
**Chunk 1**
{ chunkId: "1", specSlug: "<slug>", tier: "B",  // complexity: moderate (single transform); blast-radius: recoverable (git revert)
  currentState: "<one line: what is true now>",
  requirements: "<the behavior shift, naming the file or interface>",
  endState: "<one line: what is true after>",
  acceptanceCriteria: ["<bash check>"], edgeCases: ["empty input", "duplicate id"], touches: ["path/to/file.py"], dependsOn: [], nonGoals: ["<not this>"] }
**Chunk 2**
{ chunkId: "2", specSlug: "<slug>", tier: "A",  // complexity: high (new persistence seam); blast-radius: recoverable (revert)
  currentState: "<one line>",
  requirements: "<the behavior shift>",
  endState: "<one line>",
  acceptanceCriteria: ["<bash check>"], edgeCases: ["concurrent write to same row", "already-exists (idempotence)"], touches: ["path/to/other.py"], dependsOn: ["1"], nonGoals: ["<not this>"] }

## Execution state
- 1: pending
- 2: pending
```

Note the board rows are bare (`- 1:`, `- 2:`), never prefixed (`- C1:` is the F9 outlier), and match the `**Chunk 1**`/`**Chunk 2**` titles, the `chunkId` fields, and the `dependsOn: ["1"]` reference.

## Pre-lock self-check

Before lock, the drafter runs the **pre-lock self-check** (`spec-collaboration` SKILL.md § Pre-lock self-check): every chunk entry has all eleven schema fields including edgeCases (schema-presence), every `tier` line carries its dual-axis trigger comment, the board id / entry title / chunkId / dependsOn / demo-plan trigger ids are id-consistent in bare N, every `touches` entry is a valid repo-relative, non-gitignored path (a new file the chunk creates is fine), standalone acceptance scripts are listed as deliverables in `touches`, and the `## CEO demo plan` table is present.
