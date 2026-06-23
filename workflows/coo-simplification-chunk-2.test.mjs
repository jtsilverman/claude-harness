// coo-simplification chunk 2 -- the node-side acceptance net.
//
// Pins the node half of the chunk's contract (the python half lives in
// scripts/merge_engine_test.py):
//
//   AC2  actualFilesTouched is ABSENT from worker-pipeline.js BUILD_RESULT, while
//        the cockpit's git-diff-tree effective-touches reconciliation STAYS (the
//        authoritative path -- the deleted field was only ever a cross-check hint).
//   AC3  merge-chunk.js (the Workflow wrapper) is DELETED; extractCandidates AND
//        the memory-agent dispatch schema survive in the tested lib
//        (merge-chunk-lib.mjs); the cockpit merge step carries a DIRECT
//        memory-agent dispatch (the routing folded in, not a Workflow hop).
//
// Static-text + import assertions (the natural proof for a doc/schema/deletion
// chunk). No tautology: each assertion checks the requirement (a field removed, a
// file deleted, an export present, a doc line present), never a round-trip through
// code-to-be-written.
//
// Run: node --test workflows/coo-simplification-chunk-2.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const abs = (rel) => join(root, rel)

const PIPELINE = 'workflows/worker-pipeline.js'
const COCKPIT = 'skills/cockpit/SKILL.md'
const LIB = 'workflows/merge-chunk-lib.mjs'
const WRAPPER = 'workflows/merge-chunk.js'

// ===========================================================================
// AC2 -- actualFilesTouched deleted from BUILD_RESULT; git diff-tree stays.
// ===========================================================================

test('AC2: worker-pipeline.js BUILD_RESULT no longer declares actualFilesTouched', () => {
  const body = read(PIPELINE)
  assert.doesNotMatch(
    body,
    /actualFilesTouched/,
    `${PIPELINE} still references 'actualFilesTouched'. The chunk deletes this ` +
      `BUILD_RESULT field AND its comment block -- the cockpit reconciles effective-touches ` +
      `via git diff-tree on finalCommitSha, never this self-reported hint.`,
  )
})

test('AC2: cockpit STILL reconciles effective-touches via git diff-tree on the commit sha', () => {
  const body = read(COCKPIT)
  // The authoritative path is KEPT: the cockpit computes actual-touches from the
  // commit via `git diff-tree --no-commit-id -r --name-only <sha>` and unions with
  // declared touches. Deleting the worker field must NOT regress this.
  assert.match(
    body,
    /git diff-tree/,
    `${COCKPIT} no longer names 'git diff-tree'. The chunk deletes the worker's ` +
      `actualFilesTouched hint but MUST keep the cockpit's authoritative git-diff-tree ` +
      `effective-touches reconciliation (declared touches[] UNION the diff-tree result).`,
  )
  assert.match(
    body,
    /effective[_ -]?touch|reconcil[\s\S]{0,60}touch|touch[\s\S]{0,60}reconcil/i,
    `${COCKPIT} no longer reconciles effective-touches; the diff-tree reconciliation must stay.`,
  )
})

// ===========================================================================
// AC3 -- merge-chunk.js wrapper deleted; lib keeps extractCandidates + schema;
// cockpit merge step carries the direct memory-agent dispatch.
// ===========================================================================

test('AC3: the merge-chunk.js Workflow wrapper is deleted', () => {
  assert.ok(
    !existsSync(abs(WRAPPER)),
    `${WRAPPER} still exists. The chunk folds its extract+dispatch into the cockpit ` +
      `merge step and DELETES the shallow Workflow wrapper (the extract logic and the ` +
      `memory schema move into the tested lib).`,
  )
})

test('AC3: merge-chunk-lib.mjs still exports extractCandidates (the tested extract lib)', async () => {
  const lib = await import(new URL('./merge-chunk-lib.mjs', import.meta.url))
  assert.equal(typeof lib.extractCandidates, 'function',
    'merge-chunk-lib.mjs must keep exporting extractCandidates (tested extract logic survives the wrapper deletion)')
  // It still does its job: builder + non-applies recallVerify ride the batch.
  const batch = lib.extractCandidates({
    green: {
      lessonCandidates: [{ raw_lesson: 'x', kind_hint: 'tactical-rule', provenance: 'c2' }],
      recallVerify: [
        { entry_id: 'patterns/a', verdict: 'stale', action: 'supersede' },
        { entry_id: 'patterns/b', verdict: 'applies' },
      ],
    },
  })
  assert.equal(batch.lessonCandidates.length, 1, 'builder lessonCandidate must ride the batch')
  assert.equal(batch.recallVerify.length, 1, "only the non-applies recallVerify routes")
  assert.equal(batch.recallVerify[0].entry_id, 'patterns/a')
})

test('AC3: merge-chunk-lib.mjs exports the memory-agent dispatch schema (the load-bearing MEMORY schema)', async () => {
  const lib = await import(new URL('./merge-chunk-lib.mjs', import.meta.url))
  const schema = lib.memoryAgentSchema
  assert.ok(schema && typeof schema === 'object',
    'merge-chunk-lib.mjs must export memoryAgentSchema -- the schema is load-bearing ' +
    '(without it dispositions silently become []) and moves WITH the dispatch into the tested lib')
  const items = schema.properties && schema.properties.dispositions && schema.properties.dispositions.items
  assert.ok(items, 'schema.properties.dispositions.items must exist')
  // The schema must allow BOTH the memory-ack and the wiki-route ack shapes (oneOf),
  // identical to the contract the deleted wrapper carried.
  assert.ok(Array.isArray(items.oneOf) && items.oneOf.length === 2,
    `schema items must be a oneOf of exactly 2 shapes (memory-ack + wiki-route ack); got ${JSON.stringify(Object.keys(items))}`)
  const requiredKeys = items.oneOf.flatMap((b) => b.required || [])
  assert.ok(requiredKeys.includes('disposition'), "one oneOf branch must require 'disposition' (memory-ack)")
  assert.ok(requiredKeys.includes('route'), "one oneOf branch must require 'route' (wiki-route ack)")
})

test('AC3: cockpit SKILL.md merge step carries a DIRECT memory-agent dispatch (no merge-chunk Workflow hop)', () => {
  const body = read(COCKPIT)
  // The routing is folded into the merge step as a direct memory-agent dispatch:
  // the merge step must name the memory-agent dispatch...
  assert.match(
    body,
    /memory-agent/,
    `${COCKPIT} no longer routes to the memory-agent in the merge step. The chunk folds ` +
      `the routing in as a DIRECT memory-agent dispatch (lessonCandidates -> memory-agent).`,
  )
  // ...and must NOT route through the deleted merge-chunk Workflow wrapper anymore.
  assert.doesNotMatch(
    body,
    /merge-chunk\.js|`merge-chunk`|merge-chunk Workflow/,
    `${COCKPIT} still references the merge-chunk Workflow wrapper, which the chunk DELETES. ` +
      `The merge step now dispatches the memory-agent directly.`,
  )
})

test('AC3: coo-sop.md no longer routes through the deleted merge-chunk Workflow', () => {
  const body = read('coo/coo-sop.md')
  assert.doesNotMatch(
    body,
    /merge-chunk\.js|`merge-chunk`/,
    `coo/coo-sop.md still references the merge-chunk Workflow wrapper (workflows/merge-chunk.js), ` +
      `which the chunk deletes. The merge sequence now routes candidates via a direct memory-agent dispatch.`,
  )
})

// ===========================================================================
// C9 fixer-round candidate collection -- silently-dropped fixer lessons is the
// named failure mode fixerRoundCandidates exists to prevent. A bundle that went
// through the internal fix-loop produces FIXER-round RAW lessons at
// bundle.review.fixRounds[*].fixer.lessonCandidates. Those MUST ride the batch
// alongside builder lessonCandidates; the old merge-chunk.test.mjs tested this
// (builder+fixer = 3 total) but was deleted in coo-simplification chunk 2.
// ===========================================================================

test('C9 fixer-round: extractCandidates collects BOTH builder AND fixer-round lessonCandidates', async () => {
  const lib = await import(new URL('./merge-chunk-lib.mjs', import.meta.url))
  const bundle = {
    green: {
      // 2 builder-level candidates
      lessonCandidates: [
        { raw_lesson: 'builder-lesson-1', kind_hint: 'tactical-rule', provenance: 'c2-build' },
        { raw_lesson: 'builder-lesson-2', kind_hint: 'pattern', provenance: 'c2-build' },
      ],
      recallVerify: [],
    },
    review: {
      fixRounds: [
        {
          fixer: {
            // 1 fixer-round candidate
            lessonCandidates: [
              { raw_lesson: 'fixer-lesson-1', kind_hint: 'failure', provenance: 'c2-fix' },
            ],
          },
        },
      ],
    },
  }
  const batch = lib.extractCandidates(bundle)
  // builder=2 + fixer=1 => 3 total; silently-dropped fixer lessons would give 2.
  assert.equal(
    batch.lessonCandidates.length,
    3,
    `extractCandidates must collect builder(2) + fixer-round(1) = 3 lessonCandidates; ` +
      `got ${batch.lessonCandidates.length}. fixerRoundCandidates exists specifically to ` +
      `prevent silent fixer-lesson drops (C9 motivation).`,
  )
  // Both origins are present
  const rawLessons = batch.lessonCandidates.map((c) => c.raw_lesson)
  assert.ok(rawLessons.includes('builder-lesson-1'), 'builder-lesson-1 must be in the batch')
  assert.ok(rawLessons.includes('builder-lesson-2'), 'builder-lesson-2 must be in the batch')
  assert.ok(rawLessons.includes('fixer-lesson-1'), 'fixer-lesson-1 (fixer round) must be in the batch')
})
