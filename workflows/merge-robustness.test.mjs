// RED test for chunk C14: cockpit merge robustness — clean-tree protocol (F8)
// + actual-touches reconciliation (F11).
//
// Pins the chunk's three acceptance criteria as a static-text + schema check
// (the natural proof for a doc/schema chunk, matching the C1 harness next door):
//
//   (1) F8 — cockpit SKILL.md § Merge documents the clean-tree merge protocol:
//       the COO's board writes leave specs/current.md DIRTY, merge_engine's
//       rebase-ff refuses a dirty tree (returns the dirty_tree envelope), so the
//       COO must CLEAN the tree (stash-merge-pop, or commit-board-before-merge)
//       before each merge_chunk_branch call.
//   (2) F11 — cockpit SKILL.md prose reconciles effective-touches
//       (declared touches[] UNION actual-touched) before scheduling dependents,
//       so an under-declared touches[] cannot cause a silent same-file
//       parallel-edit conflict.
//
// It reads the two target files as TEXT and asserts each concept is present,
// matched loosely (case-insensitive, vocabulary-anchored) so the implementer
// keeps full wording freedom. It does NOT execute the pipeline and does NOT
// assert exact prose — only that the spec's named requirement exists. No
// tautology: each assertion checks the requirement (the protocol is documented /
// the schema field is declared), never a round-trip through code-to-be-written.
//
// Run: node --test workflows/merge-robustness.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const COCKPIT = 'skills/cockpit/SKILL.md'

// Isolate the § Merge section of the cockpit skill so the clean-tree protocol is
// asserted to live THERE (the spec says "cockpit § Merge"), not anywhere in the
// file. The section runs from the "## Merge" heading to the next top-level "## ".
function mergeSection(body) {
  const start = body.indexOf('\n## Merge')
  assert.notEqual(start, -1, `${COCKPIT} has no "## Merge" section heading`)
  const after = body.indexOf('\n## ', start + 1)
  return after === -1 ? body.slice(start) : body.slice(start, after)
}

test('(F8) cockpit § Merge documents the clean-tree protocol (board-write-leaves-dirty + clean-before-merge)', () => {
  const merge = mergeSection(read(COCKPIT))

  // The dirty-tree envelope merge_engine returns must be named as a handled case
  // in § Merge (today only `conflict: True` is handled there; `dirty_tree` is not).
  assert.match(
    merge,
    /dirty[_ -]?tree/i,
    `${COCKPIT} § Merge does not name the dirty_tree case. merge_engine.merge_chunk_branch ` +
      `returns a dirty_tree envelope when the worktree is dirty, but § Merge documents only ` +
      `conflict handling — the dirty-tree disposition (clean the tree and retry) is undocumented (F8).`,
  )

  // The CAUSE must be stated: the COO's own board write leaves current.md dirty.
  assert.match(
    merge,
    /board[\s\S]{0,80}dirty|dirty[\s\S]{0,80}board|current\.md[\s\S]{0,80}dirty|dirty[\s\S]{0,80}current\.md/i,
    `${COCKPIT} § Merge does not state WHY the tree is dirty at merge time: the COO's board ` +
      `write (write_execution_state) leaves specs/current.md dirty, which is exactly the ` +
      `condition that trips merge_engine's dirty-tree refusal (F8).`,
  )

  // The REMEDY must be stated: clean the tree before merging (stash-merge-pop OR
  // commit-board-before-merge). Match either named option loosely.
  assert.match(
    merge,
    /stash[\s\S]{0,40}(?:merge|pop)|commit[\s\S]{0,40}board|clean[\s\S]{0,30}tree/i,
    `${COCKPIT} § Merge does not document the clean-before-merge remedy. The COO must clean the ` +
      `tree (stash-merge-pop, or commit the board write before merging) before each ` +
      `merge_chunk_branch call, or rebase-ff refuses the dirty tree (F8).`,
  )
})

// NOTE: the worker-reported actual-touched-files field (originally F11's
// worker-side half) was DELETED by coo-simplification chunk 2. The cockpit
// computes effective-touches authoritatively from the commit sha via git
// diff-tree (the cockpit-prose half below); the worker echo was at most a
// cross-check hint the cockpit never depended on, so it is gone. The single
// surviving F11 requirement is the cockpit-side reconciliation.

test('(F11) cockpit prose reconciles declared-vs-actual touches before scheduling dependents', () => {
  const body = read(COCKPIT)

  // The COO must union the chunk's DECLARED touches[] with the ACTUAL touched files
  // (from the merged bundle) into an effective-touches set before scheduling
  // dependents — otherwise an under-declared touches[] silently admits a same-file
  // parallel edit (the C1/C2 worker-pipeline.js conflict cause). Match the
  // reconciliation concept loosely: an "effective" touches set, or a declared-∪-actual
  // union, anchored on touch vocabulary.
  assert.match(
    body,
    /effective[_ -]?touch|reconcil[\s\S]{0,60}touch|touch[\s\S]{0,60}reconcil|(?:declared|actual)[\s\S]{0,60}(?:actual|declared)[\s\S]{0,60}touch|union[\s\S]{0,40}touch|touch[\s\S]{0,40}union/i,
    `${COCKPIT} prose does not reconcile declared-vs-actual touches before scheduling dependents. ` +
      `F11 requires the COO to compute effective-touches (declared touches[] UNION the bundle's ` +
      `actual-touched files) before scheduling a dependent, so an under-declared touches[] cannot ` +
      `cause a silent same-file parallel-edit conflict.`,
  )
})
