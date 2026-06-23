---
name: chunk-kickoff
description: Use at chunk start (Phase 3 prework, after the task statement is locked and recall has run, before failing-test-first) to self-orient on what the chunk will do. Tier arrives from the dispatch payload; chunk-kickoff does not classify it. No human prediction step; the model orients itself and proceeds.
---

> **Communication discipline.** Apply `~/.claude/coo/communication-discipline.md` throughout this skill: TLDR on multi-point output, two-line teach format on new concepts, callback over re-derivation when concepts repeat, real vocabulary with plain unpack, conclusion before justification, slow down when complex.

# Chunk Kickoff

## Overview

The single chunk-start step where the model self-orients on what the chunk is about to do. **No human prediction step.** the operator is the CEO: he locked his understanding at spec time (the pre-lock narrative) and reviews at chunk-end (the plain-English explanation, `disciplines/worker-discipline.md`). Kickoff is not a gate he stands at; it is Claude orienting itself before the failing test, surfacing a one-line "this chunk is about X" so the operator stays informed without being asked to approve. Tier arrives from the dispatch payload (set at spec decomposition); chunk-kickoff surfaces it but does not re-derive it.

The point is the model knowing what it is about to build -- file, behavior shift, observable outcome, what the change obsoletes -- before it writes the test. That self-orientation is surfaced inline, not quizzed.

## When it fires

Phase 3 (Scaffold verification), after the task statement is locked and `recall` has run, before the failing test gets written. Skip only on genuinely trivial chunks (single-line typo fix, mechanical rename of one identifier in one file) where there is nothing meaningful to orient on; flag the skip out loud so it's auditable. A multi-file scaffold is mechanical but not trivial -- it still runs kickoff. ("Trivial" is narrower than a `default`-tier chunk; see `[[chunk-kickoff-tier-c-not-trivial]]`.)

Do not invoke at chunk-end; kickoff fires before work, not after. The end of chunk N triggers the start of chunk N+1; this skill is the start half.

**Tier arrives from the dispatch payload.** The tier is assigned at spec decomposition and arrives in the build-agent's dispatch payload -- chunk-kickoff does NOT re-derive or classify it. If the payload carries a tier, surface it alongside the orientation. If absent, note it as "tier not in payload" and move on; do not run the heavy-trigger walk to set a tier from scratch.

**Kickoff confirms the two heavy-trigger answers (does not set them).** The tier was set at decomposition by the heavy-trigger walk; kickoff reads the two answers off the chunk's `tier` line and confirms they still match the chunk as it will actually build. The walk (set at decomposition, confirmed here):

```
A chunk is HEAVY iff EITHER answer is yes (write both answers on the tier line):
  - Blast-radius: does a failure corrupt state with no clean rollback, or touch
    irreversible / external / shared state?
  - Complexity: does it introduce a new concurrency seam, a new architecture / abstraction,
    or genuinely novel logic a senior would have to think hard about?
If NEITHER is yes -> DEFAULT. The two answers, not a vibe, set the tier.
```

Confirm both answers against the chunk's touches + requirements. If a default chunk now reads as touching irreversible/shared state or introducing a concurrency seam, surface the mismatch (Rule 7 inline) so the author re-tiers; kickoff never silently re-tiers.

## Step 1: Read the chunk spec entry

Pull the next chunk's content from `specs/current.md`:
- The chunk's entry in `## Chunk decomposition` (the numbered list).
- The Pre-lock synopsis paragraph 2 entry for this chunk if present (from `spec-collaboration` § Pre-lock teaching synopsis).
- The chunk's acceptance criteria (locked at Phase 3 prework).

If no current chunk is declared in `specs/current.md`, stop and flag -- kickoff against an undeclared chunk is a category error.

## Step 2: Self-orient -- one-line "about X" + the orienting bullets

Claude orients itself on the chunk and surfaces the orientation to the operator. Lead with one plain-English line, then the supporting bullets. **No quiz, no wait.** This is a Rule 7 inline surface (state it, proceed; the operator overrides if the read is wrong), not a gate the operator stands at.

Open with the headline:

> **This chunk is about** [one plain-English line -- the purpose, what problem it solves].

Then the orienting bullets, one line each, no jargon:

- **File or interface:** [concrete path or function name]
- **Behavior shift:** [what observable behavior changes]
- **After it ships:** [one concrete thing that should be true -- a test that passes, an output that appears, a side effect that didn't happen before]
- **Likely obsoletes:** [pre-existing code -- branches, helpers, imports, tests, comments, fields, config -- that the new behavior renders unreachable, unused, or redundant; say "no obvious obsoletion candidates" if nothing comes to mind. Articulation is the gate, not the answer. the chunk-end self-check (the REFACTOR dead-code scan, `disciplines/worker-discipline.md`) then verifies the named candidates actually got deleted.]

Keep each bullet to one line. If a bullet wants to grow into a paragraph, the chunk is doing too much -- flag scope drift and stop.

Seed from the spec's pre-lock synopsis paragraph 2 entry for this chunk, but refresh for what shipped in prior chunks (the synopsis was a lock-time view; this is the just-in-time refresh). If the synopsis is missing or stale, write the bullets fresh from the chunk's entry in `## Chunk decomposition` and acceptance criteria.

The **Likely obsoletes** bullet is load-bearing: it is the prediction sister to the chunk-end self-check (the REFACTOR dead-code scan, `disciplines/worker-discipline.md`), which verifies the named candidates actually got deleted. When the chunk renames an identifier, grep for it first to surface incidental references (see `[[obsoletion-prediction-grep-renamed-identifiers]]`).

## Step 2.5: Skeleton sketch (heavy tier only; default chunks skip this step)

For heavy chunks, before writing the failing test, sketch the module structure and function signatures the chunk will introduce. One short block: file path, exported names, rough signatures. Record it in the kickoff artifact (inline in chat). This sketch is the pre-RED design surface -- it locks the interface shape before the test can ossify a wrong one.

default chunks skip this step entirely. If the tier is absent from the payload, skip this step and note "tier not in payload" -- do not run the heavy decision tree.

## Step 3: Hand back to Phase 3 → failing-test-first

Note in the chunk's prework that kickoff locked the orientation (and, for heavy, the skeleton). Surface the tier from the dispatch payload if present. Continue to `tdd-red` for the failing test.

## Hard rules

- **No human prediction step.** Claude self-orients and surfaces it inline (Step 2); it does not ask the operator to predict or explain the chunk back. Teaching at the *start* of a chunk was removed in the review-mode redesign -- the human's understanding is locked at spec time (the pre-lock narrative) and confirmed at chunk-end (the plain-English explanation, `disciplines/worker-discipline.md`). Kickoff is forward orientation for the model, not a teaching gate for the operator.
- Surface the orientation inline, then proceed. No per-step approval; this is the out-of-the-loop contract.
- The **Likely obsoletes** bullet is mandatory articulation, verified at the chunk-end self-check (the REFACTOR dead-code scan, `disciplines/worker-discipline.md`). Naming "no obvious candidates" is allowed; skipping the bullet is not.
- **Tier is NOT classified here.** Tier is set at spec decomposition and arrives in the dispatch payload. Surface the payload tier; do not re-derive it from chunk content. If absent, say "tier not in payload" and move on.
- Skip only on trivial chunks (single-line typo, single-identifier rename in one file). Flag the skip out loud. A non-trivial chunk that *feels* small does not qualify; a multi-file scaffold is not trivial even when mechanical.
- Do not invoke at chunk-end. Kickoff fires before work, capture-learning fires after.
- If the chunk has no entry in `specs/current.md`, stop. Don't kickoff against an undeclared chunk.
