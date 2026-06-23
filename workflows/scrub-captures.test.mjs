// RED test for chunk scrub-captures:
//   Remove the stale OLD-model `captures` (capture-learning DRAFT output) field
//   and its dispatch instruction from workflows/worker-pipeline.js so the harness
//   matches the RAW-only design already in build-agent.md and merge-chunk-lib.mjs.
//
// Acceptance criteria pinned here (all 5):
//
//   AC1: BUILD_RESULT.required does NOT include 'captures'.
//   AC2: the dispatch prompt does NOT instruct the builder to run capture-learning
//        or DRAFT routed captures (the "Run capture-learning's routing/judgment and
//        DRAFT each capture" language at ~:408-409 is gone); it asks only for RAW
//        lessonCandidates.
//   AC3: the builder bundle still carries RAW lessonCandidates + recallVerify
//        unchanged, and merge-chunk-lib.mjs still consumes them (no regression
//        to the real memory path).
//   AC4: no `captures` field remains required or returned that no consumer reads
//        (grep worker-pipeline.js for `captures` shows only removal; the SEPARATE
//        `drafted`/specUpdateSummary/diagram/wiki fields are UNTOUCHED).
//   AC5: the existing test that previously ASSERTED captures-required (AC7(captures)
//        in three-loop-c5-single-agent-dispatch.test.mjs) has been co-updated to
//        assert its ABSENCE.
//
// Test strategy: static source inspection, identical to the established idiom in
// three-loop-c5-single-agent-dispatch.test.mjs and worker-return-quality.test.mjs.
// worker-pipeline.js cannot be imported (top-level `await agent(...)` crashes on
// load outside the Workflow host); assertions are on source text. merge-chunk-lib.mjs
// IS import-safe: it is asserted via import.
//
// Run: node --test workflows/scrub-captures.test.mjs
// Full suite: node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const PIPELINE = 'workflows/worker-pipeline.js'
const MERGE_LIB = 'workflows/merge-chunk-lib.mjs'
const C5_TEST   = 'workflows/three-loop-c5-single-agent-dispatch.test.mjs'

// ── AC1: 'captures' is NOT in BUILD_RESULT.required ────────────────────────

test('AC1: BUILD_RESULT.required does NOT include "captures"', () => {
  const body = read(PIPELINE)
  // The required array lives on one line:
  //   required: ['branch', 'summary', 'green', 'redStateRecord', 'explanation',
  //              'proof', 'specUpdateSummary', 'captures', 'recallEvidence'],
  // After the fix `captures` must not appear inside any `required:` array.
  // We assert the pattern "required: [...]" containing 'captures' is gone.
  assert.doesNotMatch(
    body,
    /required:\s*\[[^\]]*['"]captures['"]/,
    `${PIPELINE} still lists 'captures' inside a required: [...] array. ` +
      `AC1 requires that BUILD_RESULT.required does NOT include 'captures'. ` +
      `The builder emits only RAW lessonCandidates (+ recallVerify); the OLD ` +
      `draft-captures field must be removed from the required list.`,
  )
})

// ── AC2: dispatch prompt has no draft-capture / run-capture-learning language ─

test('AC2: dispatch prompt does NOT instruct the builder to run capture-learning or DRAFT captures', () => {
  const body = read(PIPELINE)
  // The stale instruction currently reads:
  //   "Run capture-learning's routing/judgment and DRAFT each capture in its
  //    destination voice (tactical rule -> memory, concept -> wiki)"
  // After the fix, this language must be gone from the dispatch prompt.
  assert.doesNotMatch(
    body,
    /Run\s+capture-learning['']?s\s+routing/i,
    `${PIPELINE} still contains the stale "Run capture-learning's routing/judgment" ` +
      `dispatch instruction. AC2 requires this language to be replaced with a RAW ` +
      `lessonCandidates-only instruction (emit RAW lesson candidates; do NOT run ` +
      `capture-learning or draft -- the memory-agent reconciles downstream).`,
  )
  assert.doesNotMatch(
    body,
    /DRAFT each capture in its destination voice/i,
    `${PIPELINE} still contains "DRAFT each capture in its destination voice". ` +
      `AC2 requires this entire draft-capture instruction to be removed from the ` +
      `dispatch prompt. The builder emits only RAW lessonCandidates.`,
  )
})

test('AC2: dispatch prompt asks for RAW lessonCandidates (not drafted captures)', () => {
  const body = read(PIPELINE)
  // The replacement instruction must mention RAW lesson candidates without
  // referencing the capture-learning drafting step. We assert the RAW-only
  // language (or equivalent) is present in the dispatch section.
  assert.match(
    body,
    /RAW\s+lesson\s+candidates?/i,
    `${PIPELINE} dispatch prompt does not mention "RAW lesson candidates". ` +
      `AC2 requires the dispatch prompt to ask ONLY for RAW lessonCandidates ` +
      `(no capture-learning, no drafting) -- matching build-agent.md:29 which ` +
      `says "you do not run capture-learning, do not draft routed captures".`,
  )
})

// ── AC3: lessonCandidates + recallVerify survive in BUILD_RESULT ─────────────

test('AC3: BUILD_RESULT schema still declares lessonCandidates (RAW path unchanged)', () => {
  const body = read(PIPELINE)
  assert.match(
    body,
    /lessonCandidates\s*:/,
    `${PIPELINE} no longer declares the 'lessonCandidates' property in BUILD_RESULT. ` +
      `AC3 requires the RAW lessonCandidates field to remain untouched -- only the ` +
      `OLD 'captures' draft field is removed. The RAW lesson path must be preserved.`,
  )
})

test('AC3: BUILD_RESULT schema still declares recallVerify (RAW path unchanged)', () => {
  const body = read(PIPELINE)
  assert.match(
    body,
    /recallVerify\s*:/,
    `${PIPELINE} no longer declares the 'recallVerify' property in BUILD_RESULT. ` +
      `AC3 requires recallVerify to remain untouched. Only the OLD draft 'captures' ` +
      `field is removed; recallVerify is a legitimate required field and must survive.`,
  )
})

test('AC3: merge-chunk-lib.mjs still consumes lessonCandidates (no regression to memory path)', async () => {
  // merge-chunk-lib.mjs IS import-safe (no top-level agent() calls).
  // Verify via source text that it still reads lessonCandidates from the bundle.
  const body = read(MERGE_LIB)
  assert.match(
    body,
    /lessonCandidates/,
    `${MERGE_LIB} no longer references 'lessonCandidates'. AC3 requires that ` +
      `merge-chunk-lib.mjs still consumes the RAW lessonCandidates from the ` +
      `build bundle (the memory path). This chunk must NOT regress the consumer.`,
  )
})

// ── AC4: no stale `captures` property / return in worker-pipeline.js ─────────

test('AC4: BUILD_RESULT schema does NOT declare a captures property', () => {
  const body = read(PIPELINE)
  // The property block:
  //   captures: { type: 'string', description: 'REQUIRED. The DRAFT-ONLY ...' }
  // must be gone.
  assert.doesNotMatch(
    body,
    /^\s*captures\s*:\s*\{/m,
    `${PIPELINE} still declares a 'captures' property in the BUILD_RESULT schema. ` +
      `AC4 requires this property to be removed entirely -- no consumer reads it ` +
      `(merge-chunk-lib.mjs consumes only lessonCandidates + recallVerify). The ` +
      `'drafted' object and its specUpdateSummary/diagram/wiki sub-fields are ` +
      `UNTOUCHED; only the capture-learning 'captures' string goes.`,
  )
})

test('AC4: bundle return does NOT surface build.captures', () => {
  const body = read(PIPELINE)
  // The stale return line:
  //   captures: build.captures,
  // inside the drafted block must be gone.
  assert.doesNotMatch(
    body,
    /captures\s*:\s*build\.captures/,
    `${PIPELINE} still returns 'captures: build.captures' in its bundle. ` +
      `AC4 requires this stale return to be removed -- no cockpit consumer reads ` +
      `the captures field; it was dead output the OLD model produced but nothing ` +
      `downstream consumed (merge-chunk-lib.mjs verifiably reads only lessonCandidates).`,
  )
})

test('AC4: the drafted block still carries specUpdateSummary, diagram, wiki (UNTOUCHED)', () => {
  const body = read(PIPELINE)
  // SCOPE GUARD: the drafted object and its specUpdateSummary/diagram/wiki
  // sub-fields are untouched by this chunk. Assert all three survive.
  for (const key of ['specUpdateSummary', 'diagram', 'wiki']) {
    assert.match(
      body,
      new RegExp(`\\b${key}\\b`),
      `${PIPELINE} no longer contains '${key}'. AC4's scope guard: only the ` +
        `capture-learning 'captures' string is removed; specUpdateSummary, ` +
        `diagram, and wiki are SEPARATE, legitimate fields and must be UNTOUCHED.`,
    )
  }
})

// ── AC5: the old AC7(captures) test in c5 file is co-updated to assert ABSENCE ─

test('AC5: three-loop-c5 test no longer asserts captures IS present (co-updated to assert ABSENCE)', () => {
  const body = read(C5_TEST)
  // The old test asserted /captures?\b/i was present in the pipeline source.
  // After co-update, that affirmative assertion must be gone (replaced by an
  // assertion that captures is ABSENT). We assert the OLD positive-match pattern
  // is no longer the load-bearing assertion for the captures test.
  assert.doesNotMatch(
    body,
    /assert\.match\s*\(\s*\n?\s*body\s*,\s*\n?\s*\/captures\?\\b\/i/,
    `${C5_TEST} still contains the OLD AC7(captures) affirmative match ` +
      `(assert.match(body, /captures?\\b/i)). AC5 requires this test to be ` +
      `co-updated: replace the POSITIVE assertion (captures IS present) with a ` +
      `NEGATIVE assertion (captures draft field is ABSENT), matching the new ` +
      `RAW-only design where the pipeline no longer surfaces drafted captures.`,
  )
})
