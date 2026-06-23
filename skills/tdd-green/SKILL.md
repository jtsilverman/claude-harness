---
name: tdd-green
description: Use when you are the implementer stage of a worker pipeline, the GREEN+REFACTOR phase of the single build-agent loop, or any GREEN+REFACTOR task -- a failing test already exists and you must make it pass, delete what it obsoletes, and commit, without authoring new tests.
---

# tdd-green -- GREEN + REFACTOR + commit

## Overview

You are running the **GREEN + REFACTOR phase** -- whether as a standalone implementer stage or as the build-agent's GREEN step inside its one continuous context. A failing test already exists from the RED phase. Your job in this phase: write the minimal code to make that test pass, delete any code the change made dead, keep the suite green, then commit provisionally in your worktree. You do NOT author new tests -- RED owns the test.

**Core principle:** the test is the spec, not a suggestion. You make the code satisfy the test; you never edit the test to satisfy the code.

This skill is self-contained: everything you need for a correct GREEN + REFACTOR + commit is below. No other skill to load.

## EnterWorktree -- always call from the repo root

The shared worktree path IS the repo root. Before calling `EnterWorktree` (or any tool that expects a repo-root context), `cd` to that path first. Calling `EnterWorktree` from a different cwd will silently use the wrong tree.

## Your lane (GREEN -> REFACTOR -> commit)

1. **Confirm the RED is valid.** Run the existing failing test. It must fail because the behavior is missing, not from a typo/import/collection error, and it must not already pass. If the RED is invalid, STOP and return that finding -- do not paper over it.
2. **GREEN -- minimal code to pass.** Write the least production code that makes the test pass. No features, options, or generality the test doesn't require (YAGNI). Three plain lines beat a premature abstraction. Don't "improve" unrelated code while you're here.
3. **Verify GREEN.** Run the target test AND the rest of the suite. Require pristine green: no failures, no new errors or warnings. A green target with a freshly-broken sibling is not done.
4. **REFACTOR -- delete what the change made dead.** Scan for code this change rendered unreachable, unused, or redundant, and delete it; then re-run the suite to confirm still green. Additive-only is the default slop pattern; deletion is part of the change, not a follow-up. A deletion that turns the suite red was NOT dead -- revert that one deletion, note the missed dependency, continue with the rest.
5. **Stage deliberately and commit provisionally in your worktree.** One commit, imperative-voice subject naming the behavior shift, no Claude co-author footer. (In the single build-agent loop the commit is loop step 8 and waits for the step-7 self-check; this commit step is the standalone-implementer path.)

### Staging the acceptance script

If the chunk has a slug-prefixed acceptance script at `specs/scripts/<spec-slug>-c<N>-acceptance.sh` (or `.py`), stage it by name -- `git add specs/scripts/<spec-slug>-c<N>-acceptance.sh` -- not with `git add specs/scripts/` or `git add -A`. The slug prefix is load-bearing: `ship-spec` scopes its post-ship deletion sweep to scripts with the spec-slug prefix, so a sweep of the whole directory would delete other in-flight specs' scripts. Stage the acceptance script explicitly, by its full path.

## The Iron Law

**Never edit the failing test's assertions to make your code pass.** The test is the spec. If the test genuinely looks wrong (asserts the wrong behavior, or contradicts the task statement), STOP and return the finding to whoever owns RED -- in staged mode, the test-author; in single-agent mode, surface it and fix the test under RED discipline before resuming GREEN. Do not change it to fit your code.

## Revert-on-red

If you cannot reach green, do not pile speculative patches onto a broken attempt. Revert to the last green state and rethink. The fix is upstream (the approach or the understanding), never one more layer of code on top of a wrong attempt.

## Hard boundary

- **Do NOT write new tests or change the failing test's assertions** (the Iron Law). If the test looks wrong, return the finding.
- **Do NOT add behavior the test does not require** (YAGNI). Minimal-to-green only; the next behavior is the next chunk-stage's RED.
- **Do NOT skip REFACTOR's dead-code scan.** Deletion is part of the change.
- **Do NOT commit with the suite red.** Green-bar before commit, always.

## Red flags -- you are leaving your lane

- Editing the test to make your code pass -> the test is the spec. Stop, return the finding.
- "I'll add a config option / a second behavior while I'm here" -> out of scope. One test, minimal code.
- Writing a fresh failing test for the next thing -> that is the test-author's RED, not yours.
- Committing with the suite red, or skipping the dead-code scan.

## Return

The worktree branch ref + commit sha + a one-line summary of the behavior shift and what (if anything) the change obsoleted and deleted.
