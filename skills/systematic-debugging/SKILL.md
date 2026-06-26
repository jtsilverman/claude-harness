---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---

# Systematic Debugging

**Core principle:** Find root cause before attempting any fix. No fixes without completing Phase 1.

## The Four Phases

Complete each phase before moving to the next.

### Phase 1: Root Cause Investigation

1. **Read error messages completely** — stack traces, line numbers, file paths, error codes.
2. **Reproduce consistently** — nail down exact steps. If not reproducible, gather more data; don't guess.
3. **Check recent changes** — git diff, new dependencies, config changes, environmental differences.
4. **Gather evidence in multi-component systems** — add diagnostic instrumentation at each component boundary; log what enters and exits each layer; run once to find WHERE it breaks before investigating WHY.
5. **Trace data flow** — where does the bad value originate? What called this with the bad value? Keep tracing up until you find the source. See `root-cause-tracing.md` for the full backward-tracing technique.

### Phase 2: Pattern Analysis

1. Find working examples of similar code in the same codebase.
2. Compare against references — read the reference implementation completely, don't skim.
3. List every difference between working and broken, however small.
4. Identify dependencies: settings, config, environment assumptions.

### Phase 3: Hypothesis and Testing

1. Form a single hypothesis: "I think X is the root cause because Y." Be specific.
2. Make the SMALLEST possible change to test it — one variable at a time.
3. Verify: worked → Phase 4. Didn't work → form a NEW hypothesis. Don't add more fixes on top.
4. If you don't understand something, say so. Don't pretend.

### Phase 4: Implementation

1. **Create a failing test case** first -- simplest possible reproduction. Use the `build` skill's RED then GREEN gates for the mechanics.
2. **Implement a single fix** — address the root cause only. No "while I'm here" additions.
3. **Verify**: test passes, no regressions, issue resolved.
4. **If fix doesn't work**: STOP, return to Phase 1 with new information. After 2 failed attempts, stop and surface (the `build` skill's two-failed-attempts rule): the fix is upstream (scope, approach, understanding). No third patch.

## Red Flags — STOP and Return to Phase 1

Any of these means you're symptom-fixing, not debugging:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- Proposing solutions before tracing data flow
- "One more fix attempt" after 2 failures
- Each fix reveals a new problem in a different place

## Quick Reference

| Phase | Goal | Done When |
|-------|------|-----------|
| 1. Root Cause | Understand WHAT and WHY | Root cause identified, not guessed |
| 2. Pattern | Find working/broken differences | Differences listed |
| 3. Hypothesis | Test one theory minimally | Confirmed or new hypothesis formed |
| 4. Implementation | Fix root cause, verify | Tests pass, no regressions |

## Reference docs in this directory

- `root-cause-tracing.md` — backward tracing through call stack
- `defense-in-depth.md` — validation at multiple layers after finding root cause
- `condition-based-waiting.md` — replace arbitrary timeouts with condition polling
