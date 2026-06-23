---
name: tdd-red
description: Use when you are the test-author stage of a worker pipeline, the RED phase of the single build-agent loop, or any RED-only task — write the one failing test for the chunk and stop before any implementation code.
---

# tdd-red — RED stage only

## Overview

You are running the **RED phase** — whether as a standalone test-author stage (a separate context) or as the build-agent's RED step inside its one continuous context. Your entire job in this phase is the RED step of the test-driven cycle: write one failing test that defines "done" for this chunk, watch it fail for the right reason, then STOP RED — do not write implementation code during this phase. GREEN is a separate phase (and, when staged, a separate context).

**Core principle:** the test is the spec. If you didn't watch the test fail, you don't know it tests the right thing. And if you write the code under the same assumptions that shaped the test, the test ratifies your intent instead of the requirement — so RED stops before any implementation, keeping the test grounded in the contract, not the code-to-be.

This skill is self-contained: everything you need for a correct RED is below. No other skill to load.

## Your lane (RED only)

1. Read the chunk's task statement + acceptance criteria + `edgeCases` field (threaded into your prompt).
   - The `edgeCases` field lists specific scenarios your test must cover alongside the happy path — use it as context for what to test, not as a separate TDD procedure step.
2. Write ONE minimal failing test for a single behavior the chunk must have:
   - **One behavior per test.** The smallest useful step, not the whole feature. An "and" in the test name means split it.
   - **Test externally visible behavior, not implementation steps.** Assert "given input X, the output is Y" — never "calls function F three times" or "uses an inner join."
   - **Real code over mocks.** Exercise the actual unit. Mock only a true external edge (network, wall-clock, a paid API); never mock the thing under test, and never mock so much that the test passes while the real code is broken.
   - **Clear name** that states the behavior: `test_rejects_expired_token`, not `test_auth_2`.
3. Run it. Confirm it FAILS **for the right reason** — the behavior is missing, NOT a typo, import error, or collection error. A test that errors before it reaches its assertion is not a valid RED; fix the test until it fails *on the assertion*. (Passes immediately? You tested existing behavior or the test is wrong — fix the test, do not write code.)
4. STOP RED. Return the test path + the literal observed failure message. Hand off to GREEN — a separate context when staged, or the build-agent's next loop step in single-agent mode.

## Anti-tautology — the trap that makes a RED worthless

A test that ratifies the code-to-be-written instead of the requirement proves nothing. Avoid:
- **Round-trip on the buggy pair:** `serialize(deserialize(x)) == x` using the very functions under test. Instead check against an independent, simpler computation or a hand-written expected value.
- **Output-fitted assertions:** running the code first, then asserting "output contains these keywords" picked after seeing the output. Decide the expected result from the requirement, before running anything.
- **Mock-shaped expectations:** asserting the code called a mock the way you wired it. Assert the observable result, not the call shape.

When unsure, recompute the expected value a different way than the implementation will.

## Hard boundary

- **Do NOT write implementation code.** Not "just a stub," not "so the import resolves," not "to check the test." All production code is written in the GREEN phase, from your test.
- **Do NOT make the test pass.** A passing test means you tested existing behavior or wrote the code — both are violations. Return it RED.
- **Do NOT write more than one behavior's test.** One RED per chunk-stage; GREEN drives it green before any next test.

## Red flags — you are leaving your lane

- Writing a function/class/module the test calls "so the import resolves" → that's implementation. Stop.
- "I'll just make it pass to save a round-trip" → no. Return RED.
- Editing any file other than the test file (and the minimal scaffolding a runner needs to *collect* the test, never to *pass* it).
- "This is too simple to need a separate GREEN phase" → still RED-only. RED stops before any implementation, even in single-agent mode; the phase split is the point.

## Both-ways acceptance-script validation

Every acceptance script you write must be verified in BOTH directions before you hand off:

1. **Fail-on-broken (RED confirmation):** run the script against the unmodified HEAD / broken state and confirm it exits non-zero, with an assertion failure message pointing at the missing behavior — NOT an error before the assertion. A script that errors before reaching its assertion is not a valid RED; fix it until it fails *on the assertion*.
2. **Pass-on-fixed (GREEN pre-check):** verify with a throwaway correct-deliverable copy that the script actually exits 0 when the behavior is present. A script that fails forever even with a correct deliverable is worthless and blocks the implementer. This is the c9/c10 failure mode — acceptance scripts that passed RED but could never turn green.

Both directions must be observed. "I think it would pass" is not evidence.

## Acceptance-script footgun guards

When writing bash acceptance scripts, avoid these traps (each has caused a real stuck-RED failure):

**awk-range collapse when endpoints match the same line.** BSD-awk's `/start/,/end/` range collapses to a single line when both patterns can match the same line (e.g. `/^## X/,/^## /` self-terminates on `## X` because `## X` matches both). Use a flag-toggle (`in_section=0; if match, toggle`) instead of awk range syntax.

**awk fenced-code range self-terminates on the opening fence.** `/^```yaml/,/^```/` matches the opening fence as both start and end, producing an empty range. Use flag-toggle or strip frontmatter in Python stdlib instead.

**`rg` is not on the subshell PATH.** Use `grep`, never `rg`. `rg` is a Claude Code shell function that only exists in the interactive session; in a subshell (bash script), `rg` is missing-command and `2>/dev/null` silently produces a false PASS (empty output treated as zero count).

**`grep -c ... || echo 0` double-counts.** `grep -c` always writes a number to stdout and exits 1 on no-match. The `|| echo 0` branch appends a second zero line, inflating counts. Use `$(grep -c ... || true)` and compare numerically, or use `grep -q` + a counter.

**Self-referential thresholds.** A count guard that counts the very file the chunk removes is off by one. Exclude the target file explicitly, or measure the delta against a fixed constant.

## Return

Test file path + the literal failure output. Nothing else — no implementation, no commit.
