// RED test for employed-system-tuning chunk 11:
//   "log-only fixer disposition + fix-loop skip-re-review branch"
//
// C6's logging hard-gate means a reviewer can flag a silent new executable
// artifact and the fixer resolves it by ADDING logging. Adding logging is
// additive and non-behavioral, yet the fix-loop today re-reviews
// UNCONDITIONALLY after every fixer pass (worker-pipeline.js dispatches the
// reReview agent on every 'fix' round). This chunk teaches the loop a new
// `log-only` fixer disposition and a controller branch: when EVERY open
// finding's fix is `log-only`, run the suite (revert-on-red, which the fixer
// already enforces) but SKIP the re-review agent. Any non-log-only fix keeps
// the normal re-review. Non-goal: skipping the suite (the suite always runs).
//
// The chunk's FULL acceptance contract, pinned here as one suite so an
// implementation that satisfies only the first criterion (a plausible shadow)
// cannot pass:
//
//   (1) An all-log-only round skips the re-review agent but STILL runs the
//       suite -- a pure controller predicate (isLogOnlyRound) returns true on
//       an all-log-only round; the pipeline's loop body GUARDS the reReview
//       dispatch on it AND keeps the suite path (revert-on-red) unconditional.
//   (2) A MIXED batch (at least one non-log-only fix) -> re-review IS
//       dispatched: isLogOnlyRound returns false the moment any disposition is
//       not log-only, so the normal re-review path runs.
//   (3) The fixer disposition schema ACCEPTS log-only (FIXER_RESULT's
//       disposition description names it) AND both fixer agent files
//       (fixer, fixer-heavy) instruct returning it for a
//       logs-only fix. (pipeline-meritocracy c1 dropped fixer-light.)
//
// Test strategy (mirrors llr-c2-fix-loop.test.mjs):
//   - isLogOnlyRound is a PURE predicate exported from workflows/fix-loop.mjs
//     (no I/O, no Workflow globals), so it is IMPORTED and its return VALUES
//     asserted directly -- the authoritative proof for criteria 1, 2.
//   - worker-pipeline.js executes the pipeline at top level on import (top-level
//     `await agent(...)`, Workflow globals), so it CANNOT be imported; its
//     WIRING (the lockstep inline isLogOnlyRound, the reReview-skip guard, the
//     unconditional suite path, the FIXER_RESULT log-only description) is
//     asserted as STATIC SOURCE TEXT, the same strategy as llr-c2.
//   - the three fixer agent .md files are asserted as static source text.
//
// No tautology: every expected value (the predicate's truth table, the schema
// enum string, the agent-doc instruction) is fixed from the chunk task
// statement + acceptance criteria ABOVE, before any implementation -- never
// read back from the implementation.
//
// Run: node --test workflows/c11-log-only-skip-rereview.test.mjs
// Full suite (GLOB form): node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { isLogOnlyRound } from './fix-loop.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const PIPELINE = 'workflows/worker-pipeline.js'

// Disposition fixtures in the fixer's bundle shape (one per received finding).
const logOnly = (f) => ({ finding: f, disposition: 'log-only', evidence: 'added stderr diagnostics behind --verbose', files: ['scripts/x.mjs'] })
const fixed = (f) => ({ finding: f, disposition: 'fixed', evidence: 'pinned + fix', files: ['scripts/x.mjs'] })
const reject = (f) => ({ finding: f, disposition: 'REJECT', evidence: 'file:line behaves correctly', files: [] })

// =====================================================================
// Criterion 1: an all-log-only round skips the re-review (suite still runs).
// =====================================================================

test('AC1(predicate): isLogOnlyRound is true when EVERY disposition is log-only', () => {
  const dispositions = [logOnly('[LOG][P2] scripts/x.mjs silent new artifact'), logOnly('[LOG][P2] scripts/y.mjs silent on error path')]
  assert.equal(
    isLogOnlyRound(dispositions),
    true,
    `isLogOnlyRound must be true when every fixer disposition is 'log-only' (the round added only logging -- skip re-review). Got ${JSON.stringify(isLogOnlyRound(dispositions))}`,
  )
})

test('AC1(predicate empty): isLogOnlyRound is false on an empty/missing dispositions list (no round to skip)', () => {
  // A round with no dispositions is not a log-only round -- there is nothing
  // additive to vouch for. Skipping re-review off an empty list would be a
  // false skip (e.g. a fixer that REJECTed everything and changed nothing).
  assert.equal(isLogOnlyRound([]), false, `isLogOnlyRound([]) must be false -- an empty round is not an all-log-only round.`)
  assert.equal(isLogOnlyRound(null), false, `isLogOnlyRound(null) must be false -- a missing dispositions list is not an all-log-only round.`)
  assert.equal(isLogOnlyRound(undefined), false, `isLogOnlyRound(undefined) must be false.`)
})

test('AC1(predicate retained in lib): isLogOnlyRound stays a pure exported predicate in fix-loop.mjs', () => {
  // pipeline-meritocracy chunk 2 replaced the OLD fix-loop (the separate Sonnet
  // re-review the log-only optimization skipped) with the JUDGE re-check. The judge
  // owns the re-check, so there is no separate re-review pass for an all-log-only round
  // to skip -- the worker-pipeline.js wiring of isLogOnlyRound is obsoleted. The PURE
  // predicate itself stays in fix-loop.mjs (still a valid additive-fix classifier the
  // log-only fixer disposition maps to); only its re-review-skip wiring is removed.
  const lib = read('workflows/fix-loop.mjs')
  assert.match(
    lib,
    /export function isLogOnlyRound/,
    `fix-loop.mjs must keep exporting isLogOnlyRound (the predicate is retained; only its re-review-skip wiring in worker-pipeline.js is obsoleted by the judge re-check).`,
  )
})

test('AC1(suite-red guard retained): the judge loop still honors fixer.suiteGreen (revert-on-red)', () => {
  const body = read(PIPELINE)
  // The SUITE-RED guard survives the rewire: a fixer round that left the suite red must
  // still keep the round open (force the judge verdict to FIX), never declare CLEAN off
  // a red suite. This proves the suite path is NOT bypassed under the judge architecture.
  assert.match(
    body,
    /fixer\.suiteGreen\s*===\s*false/,
    `${PIPELINE} must KEEP honoring fixer.suiteGreen (revert-on-red / SUITE-RED guard) under the judge re-check loop.`,
  )
})

// =====================================================================
// Criterion 2: a MIXED batch keeps the normal re-review.
// =====================================================================

test('AC2(predicate mixed): isLogOnlyRound is false when ANY disposition is not log-only', () => {
  const f1 = '[LOG][P2] scripts/x.mjs silent new artifact'
  const f2 = '[BUG][P1] scripts/y.mjs null deref'
  assert.equal(
    isLogOnlyRound([logOnly(f1), fixed(f2)]),
    false,
    `isLogOnlyRound must be false when any disposition is not log-only (a mixed batch keeps the normal re-review). Got true.`,
  )
})

test('AC2(predicate non-log dispositions): a round of fixed/REJECT dispositions is not log-only', () => {
  assert.equal(isLogOnlyRound([fixed('a'), reject('b')]), false, `a fixed+REJECT round must not be treated as log-only.`)
  assert.equal(isLogOnlyRound([fixed('a')]), false, `a single fixed round must not be treated as log-only.`)
})

// =====================================================================
// Criterion 3: the schema accepts log-only + the fixer docs instruct it.
// =====================================================================

test('AC3(schema): FIXER_RESULT disposition description names log-only', () => {
  const body = read(PIPELINE)
  // The disposition enum is described in FIXER_RESULT (worker-pipeline.js). pipeline-
  // meritocracy chunk 2 dropped the REJECT disposition (the judge owns truth, not the
  // fixer) and added `unreproducible` (a confirmed finding that does not reproduce
  // routes BACK to the judge). The accepted values now read fixed | log-only | stuck |
  // unreproducible -- log-only is still in the set.
  assert.match(
    body,
    /fixed \| log-only \| stuck \| unreproducible/,
    `${PIPELINE}'s FIXER_RESULT disposition description must accept log-only (read 'fixed | log-only | stuck | unreproducible').`,
  )
})

for (const f of ['agents/fixer.md', 'agents/fixer-heavy.md']) {
  test(`AC3(agent-doc ${f}): instructs returning log-only when the ONLY change is added logging`, () => {
    const body = read(f)
    assert.match(
      body,
      /log-only/,
      `${f} must instruct the fixer to return the log-only disposition when the ONLY change is added logging.`,
    )
    // The return-bundle disposition union in the agent doc must list log-only.
    // pipeline-meritocracy chunk 3 installed P4 (the fixer fixes judge-confirmed only,
    // no arbitration), dropping the REJECT disposition and adding `unreproducible`
    // (a confirmed finding that does not reproduce routes BACK to the judge) to match
    // the chunk-2 pipeline FIXER_RESULT. The union now reads fixed | unreproducible | stuck | log-only.
    assert.match(
      body,
      /"fixed" \| "unreproducible" \| "stuck" \| "log-only"/,
      `${f}'s return-bundle disposition union must include "log-only" (fixed | unreproducible | stuck | log-only).`,
    )
  })
}
