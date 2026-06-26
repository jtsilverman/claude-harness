---
name: spec
description: Use before any non-trivial change (behavior change, spans files, new files) to produce the one-paragraph spec the build and reviewer anchor against. Runs the heavier front of the build loop -- orient comprehensively, draft intent + acceptance + non-goals, a bounded creativity beat, pressure-test, then the user signs off intent/acceptance/non-goals only. The spec is the live progress record; getting it right is the cheapest place to catch errors.
---

# Spec

The spec is the seam between the user's language (behavior + intent) and the build's (code). A wrong or thin spec compromises the whole build, so this phase is deliberately the heaviest. Orientation is the single highest correctness lever; spend here.

## Steps

1. **Orient comprehensively.** Spawn an `Explore` subagent to dig the project wiki index + the relevant code + read `MEMORY.md`; it returns a COMPACT grounded map (what exists, what depends on what, what is non-obvious). Compact is required -- unfiltered context degrades the build. The map goes into the spec.

2. **Draft the spec** (one paragraph, plus the decomposition):
   - **Intent** -- what behavior changes and why, in the user's terms.
   - **Acceptance criteria** -- observable behavior ("input X produces output Y"), each one testable. Never "no errors thrown."
   - **Non-goals** -- what is explicitly out of scope (naming what is out is as load-bearing as what is in; this is the scope-creep guard).
   - **Orientation findings** -- the compact map from step 1.
   - **Decomposition** -- the commit-sized units, in order. Units are commit + planning boundaries, NOT dispatch units; the session builds them in one continuous context, not a worker fleet.

3. **Creativity beat (bounded, one beat not a phase).** Name 1-2 alternative approaches and the 10x-vs-asked version, pick one with reasoning, AND name the simplest form that works. This serves creativity and YAGNI at once -- you cannot pick "simplest viable" without considering options. Where the user (vision) and the session (implementation) collaborate. Keep it to a beat; if it starts generating scope, that is the signal to stop.

4. **Pressure-test.** Run `grill-me` to argue the design's weak points with the user. Then dispatch the `reviewer` in spec mode (fresh context) to check the spec is complete, grounded, non-contradictory against the codebase reality. Resolve findings by evidence.

5. **the user signs off.** He approves intent + acceptance + non-goals only. He does not sign off on files, test design, or implementation -- that is the build's lane. On sign-off, the spec is frozen for the task; a new requirement discovered mid-build is surfaced to the user as a follow-up task, never silently absorbed.

## What this is not

Not a multi-phase waterfall (heavy process degrades correctness). Not retrofitted to existing code (behavior is defined before generation). Trivial/mechanical changes skip this skill entirely -- branch, do it, eyeball the diff, the user merges.
