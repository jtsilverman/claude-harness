---
name: build
description: Use to implement a signed-off spec -- the GREEN-producing build loop. Takes intent + acceptance criteria + non-goals and produces working, reviewed-ready code through eight gates (orient, RED-commit, GREEN, refactor, verify, live-verify, anti-slop, commit). Consolidates RED and GREEN and the build discipline into one compact skill. For behavioral code; mechanical/doc/config changes get verify-don't-prove instead. Fold no ceremony in: the gates are checks with visible output, not a walkthrough.
---

# Build

Implement the current spec, nothing else. Ethos: prove it before you say it; treat your own output as code from someone overconfident who just learned to code. A fresh-context `reviewer` judges after you return; your self-check is mechanical, not the quality gate. Make the reviewer's verdict boring.

## The eight gates

Each gate produces visible output. A skipped gate without a stated reason is a failed build.

1. **Orient.** Read the spec's orientation map (or run an `Explore` subagent for a compact one), the relevant code, and `MEMORY.md`. Write down the constraints/invariants (schemas, uniqueness, idempotency, allowed shapes) and pick the one primary verification hook (the single proof this works). Localization is the largest correctness signal; do not skip it.

2. **RED (author, observe, COMMIT).** Write ONE failing test for a single behavior the spec names (skill discipline below). Run it; confirm it fails **for the right reason** (the missing behavior, not a typo/import error). Record the test name + literal failing output. **Commit the failing test before any implementation** -- the RED gate is a git-state check; a committed-first test cannot be silently corrupted to ratify the code. One behavior per test; an "and" in the name means split.

3. **GREEN (minimum to pass).** Write the minimum code to pass the committed test. No speculative parameters, no abstraction without a second caller, no handling of inputs that cannot occur. If GREEN reveals the test was wrong, fix the test, watch it fail again, then implement.

4. **REFACTOR (delete what you made dead).** Scan for code your change made unreachable/unused/redundant. Delete it, re-run the suite, confirm green (a deletion that turns the suite red was not dead: revert that one, note the dependency). **Report the scan result even when empty** -- "nothing was made dead" is a result you state, never a step you omit.

5. **Verify ladder (evidence before claims).** In order: (a) acceptance test passes for the right reason; (b) run the code on real input, look at the output; (c) linter/typecheck; (d) read the diff; (e) probe the 2-3 edge cases you picked. Skipping a step needs a stated reason; "pretty sure" and "takes longer" are not reasons.

6. **Live-verify (gated by change shape).** Runnable surface -- endpoint, UI, CLI, hook, external system -- gets at least one live end-to-end invocation: spawn a live-verify subagent (the `verify` skill) that drives the REAL thing and observes the actual side effect (email sent, branch blocked, row written). Crafted-payload green does NOT imply live green. Pure logic -> pytest only, skip this gate.

7. **Anti-slop self-check.** Run on your own output: (1) satisfies the real requirement or a plausible shadow? (2) files changed outside scope? (3) tests meaningful or do they ratify your assumptions? (4) duplication / naming / architecture drift? (5) complexity beyond the task? (6) dead code, defensive theater, abstraction with no use? A yes on 2/4/5/6 is undo-and-rethink, not fix-later.

8. **Commit.** Deliberate staging (`git add <file>`, never `-A`/`.`), one imperative-subject message naming the file/interface + the behavior shift. Hand the diff + spec to the `reviewer`.

## RED discipline (the load-bearing details)

- **Test externally visible behavior, never implementation steps.** Assert "input X -> output Y", not "calls F three times".
- **Anti-tautology** (a test that ratifies the code-to-be proves nothing): no round-trip through the buggy pair (`serialize(deserialize(x))==x`), no output-fitted assertions (keywords chosen after seeing output), no mock-shaped expectations. Recompute the expected value a simpler, independent way.
- **Real code over mocks.** Mock only a true external edge (network, clock, paid API); never the thing under test. Over-mocking passes while the real thing is broken.
- **Edge cases (pick 2-3 by cost-if-broken):** prioritize silent (wrong data, no error), confusing, or expensive (data loss, double-send) failures; skip loud-and-cheap. Empty/single/duplicate/boundary/null/already-exists; auth-fail/rate-limit/timeout/4xx-5xx for APIs.
- **PBT (shape-gated):** a property-rich chunk (pure function, parser, serializer, algebraic invariants) gets at least one property-based test alongside examples. CRUD/UI exempt.
- **Half-landed fails:** if any behavioral clause of the spec is left unimplemented, at least one test is red.

## Diagnostics + bounds

- **Every new executable artifact ships debuggable:** liberal diagnostic logging at branch points and error paths, to stderr behind a verbosity flag (default quiet, `--verbose` opens the trace). Language idiom, no framework. Test files and trivial pure helpers exempt.
- **Bug mid-build -> `systematic-debugging` first** (root cause, no symptom patch). **Side quest outside scope -> stop and surface** to the user (a precondition, a dependency that needs its own task, or live-discovered scope), never a silent patch and never silent absorption into this task.
- **Two failed attempts = stop.** A failed attempt = test still fails, OR verification surfaced a wrong-in-scope result, OR the approach collapsed on edges. Two on the same task: stop, no third patch. The fix is upstream (scope, approach, understanding). Surface what you tried, why each failed, your read on what is actually wrong, and a lesson candidate.

## Mirror-surface

When the change touches a value restated across files (a dial, a name, a constant in both code and docs), grep the OLD value across the whole repo first, then assert it is gone from every mirror. A check scoped to named files passes while a sibling keeps the stale value.
