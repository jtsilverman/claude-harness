// RED test for chunk builder-error-log:
//   "structured failure log for build debuggability"
//
// the operator 2026-06-13: 'have the builders make error logs and tables so debugging
// when errors hit becomes easy.'
//
// This test pins the FULL acceptance contract across all four criteria:
//
//   AC1: disciplines/worker-discipline.md states the failure-log requirement +
//        the row shape { phase, what_failed, error, repro_cmd, attempt, resolution },
//        fired on RED-for-wrong-reason / suite-red / fixer-stuck / unexpected-error.
//
//   AC2: agents/build-agent.md (all 4 variants share one body) instructs the
//        builder to emit the structured failure-table on failures and surface it
//        in the return bundle. Verified on all 4 files (build-agent, build-agent-light,
//        build-agent-heavy, build-agent-max) to confirm body identity.
//
//   AC3: BUILD_RESULT in workflows/worker-pipeline.js gains an OPTIONAL `failureLog`
//        field (array of row objects); NOT in BUILD_RESULT.required (absent/empty on
//        a clean build is valid); additionalProperties stays consistent.
//        Both a return WITHOUT failureLog and one WITH a failureLog array must validate.
//
// Test strategy: source-inspection idiom (same approach as three-loop-c5 + c8 tests).
// worker-pipeline.js cannot be imported (top-level await + Workflow globals), so
// BUILD_RESULT is asserted as static source text. worker-discipline.md and build-agent*.md
// are plain text, so they are read and asserted for required content.
//
// No tautology: all expected strings/patterns are fixed from the chunk's acceptance
// criteria ABOVE, before any implementation is written.
//
// Run: node --test workflows/builder-error-log.test.mjs
// Full suite: node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const DISCIPLINE = 'disciplines/worker-discipline.md'
const PIPELINE   = 'workflows/worker-pipeline.js'

// Both build-agent variant files share one identical body (differ only by frontmatter).
// (pipeline-meritocracy c1 collapsed the 4-tier quartet to 2: default + heavy.)
const BUILD_AGENT_FILES = [
  'agents/build-agent.md',
  'agents/build-agent-heavy.md',
]

// === AC1: worker-discipline.md carries the failure-log requirement + row shape ===

test('AC1(failure-log-section): worker-discipline.md contains a failure-log requirement', () => {
  const body = read(DISCIPLINE)
  // Must name the failure-log concept -- the section that says the builder maintains
  // a structured failure log across its run.
  assert.match(
    body,
    /failure.?log/i,
    `${DISCIPLINE} has no failure-log section. AC1 requires the doc to state the ` +
      `failure-log requirement so builders know to maintain it across their run.`,
  )
})

test('AC1(trigger-events): worker-discipline.md names the four trigger events for appending a row', () => {
  const body = read(DISCIPLINE)
  // The spec names four events that trigger a row append:
  // RED test failing for the wrong reason, full suite red, fixer round stuck, unexpected error/abort.
  assert.match(
    body,
    /wrong.?reason|red.for.the.wrong|failing.for.the.wrong/i,
    `${DISCIPLINE} does not name "RED failing for the wrong reason" as a failure-log trigger event. ` +
      `AC1 requires the four trigger events to be stated.`,
  )
  assert.match(
    body,
    /suite.?red|full.suite/i,
    `${DISCIPLINE} does not name "suite red" as a failure-log trigger event.`,
  )
  assert.match(
    body,
    /fixer.?(round|stuck|loop)|stuck.?(fixer|round)/i,
    `${DISCIPLINE} does not name "fixer round stuck" as a failure-log trigger event.`,
  )
  assert.match(
    body,
    /unexpected.?error|abort/i,
    `${DISCIPLINE} does not name "unexpected error/abort" as a failure-log trigger event.`,
  )
})

test('AC1(row-shape): worker-discipline.md names all six row keys { phase, what_failed, error, repro_cmd, attempt, resolution }', () => {
  const body = read(DISCIPLINE)
  // The spec mandates a specific row shape. All six keys must appear.
  for (const key of ['phase', 'what_failed', 'error', 'repro_cmd', 'attempt', 'resolution']) {
    assert.match(
      body,
      new RegExp(`\\b${key}\\b`),
      `${DISCIPLINE} is missing the row key '${key}' from the failure-log row shape. ` +
        `AC1 requires { phase, what_failed, error, repro_cmd, attempt, resolution } to be named.`,
    )
  }
})

test('AC1(debuggability-only): worker-discipline.md states the log is debuggability-only, never a gate', () => {
  const body = read(DISCIPLINE)
  // The spec is explicit: "Debuggability ONLY -- it is a trail, never a gate."
  assert.match(
    body,
    /never.a.gate|not.a.gate|debuggability.only|trail.+never|not.+gate/i,
    `${DISCIPLINE} does not state that the failure log is debuggability-only and never a gate. ` +
      `AC1 requires this caveat to prevent builders treating the log as a blocking mechanism.`,
  )
})

// === AC2: all 4 build-agent*.md files instruct emit + surface in return bundle ===

for (const rel of BUILD_AGENT_FILES) {
  test(`AC2(emit-instruction): ${rel} instructs the builder to emit a structured failure table on failure events`, () => {
    const body = read(rel)
    // Must tell the builder to maintain/emit the failure-log on failure events.
    assert.match(
      body,
      /failure.?log|failure.table|structured.failure/i,
      `${rel} does not instruct the builder to emit a structured failure log/table on failure events. ` +
        `AC2 requires all 4 build-agent variant files (which share one body) to carry this instruction.`,
    )
  })

  test(`AC2(surface-in-bundle): ${rel} instructs the builder to surface the failure table in the return bundle`, () => {
    const body = read(rel)
    // Must tell the builder to include the failure log in the returned bundle.
    assert.match(
      body,
      /(?:surface|return|include|bundle)[\s\S]{0,80}(?:failure.?log|failure.table)|failure.?log[\s\S]{0,80}(?:bundle|return)/i,
      `${rel} does not instruct the builder to surface the failure log in the return bundle. ` +
        `AC2 requires the instruction to emit AND surface it so the COO can debug from the table.`,
    )
  })
}

// === AC3: BUILD_RESULT gains an optional failureLog field (NOT in required) ===

test('AC3(field-exists): BUILD_RESULT.properties contains a failureLog field', () => {
  const body = read(PIPELINE)
  // The field must appear in the properties block of BUILD_RESULT.
  assert.match(
    body,
    /failureLog\s*:/,
    `${PIPELINE} BUILD_RESULT has no 'failureLog' property. AC3 requires an OPTIONAL failureLog ` +
      `field (array of row objects) to be added to BUILD_RESULT.properties.`,
  )
})

test('AC3(not-required): failureLog is NOT in BUILD_RESULT.required', () => {
  const body = read(PIPELINE)
  // Extract the required array from BUILD_RESULT (before the properties block).
  // The required array must not contain 'failureLog'.
  const requiredMatch = body.match(/required\s*:\s*\[([^\]]+)\]/)
  assert.ok(
    requiredMatch,
    `${PIPELINE} has no BUILD_RESULT required array to inspect.`,
  )
  assert.doesNotMatch(
    requiredMatch[1],
    /failureLog/,
    `${PIPELINE} BUILD_RESULT.required contains 'failureLog'. It must be OPTIONAL -- absent ` +
      `or empty on a clean build; only present (with rows) on a failed build.`,
  )
})

test('AC3(array-type): BUILD_RESULT.failureLog is typed as an array', () => {
  const body = read(PIPELINE)
  // The failureLog property must be typed as an array (type: 'array').
  // Match failureLog: { ... type: 'array' ... } with some content in between.
  assert.match(
    body,
    /failureLog[\s\S]{0,200}type\s*:\s*'array'/,
    `${PIPELINE} BUILD_RESULT.failureLog is not typed as an array. AC3 requires it to be ` +
      `an array of row objects (type: 'array', items: objects with the row keys).`,
  )
})

test('AC3(row-keys-in-items): BUILD_RESULT.failureLog.items names the row keys', () => {
  const body = read(PIPELINE)
  // The items definition must reference the key names from the row shape.
  // At minimum 'phase' and 'what_failed' must appear near the failureLog definition.
  const failureLogIdx = body.indexOf('failureLog')
  assert.ok(failureLogIdx !== -1, `${PIPELINE} has no 'failureLog' property (prerequisite for this test).`)
  // Grab 600 chars after the failureLog key to scope the check to that property block.
  const snippet = body.slice(failureLogIdx, failureLogIdx + 600)
  for (const key of ['phase', 'what_failed', 'repro_cmd']) {
    assert.match(
      snippet,
      new RegExp(key),
      `${PIPELINE} BUILD_RESULT.failureLog.items does not reference the row key '${key}'. ` +
        `AC3 requires the items to be objects with the { phase, what_failed, error, repro_cmd, ` +
        `attempt, resolution } shape (additionalProperties:true is acceptable).`,
    )
  }
})

test('AC3(items-required): BUILD_RESULT.failureLog.items has a required array for the row fields', () => {
  const body = read(PIPELINE)
  // The items schema must declare which row fields are required so that an item missing
  // e.g. 'phase' or 'what_failed' is rejected.  This mirrors the pattern used by
  // lessonCandidates (required: ['raw_lesson','kind_hint','provenance']) and
  // recallVerify (required: ['entry_id','verdict']).
  const failureLogIdx = body.indexOf('failureLog')
  assert.ok(failureLogIdx !== -1, `${PIPELINE} has no 'failureLog' property (prerequisite).`)
  // Grab enough chars to span the entire items block (up to ~800 chars).
  const snippet = body.slice(failureLogIdx, failureLogIdx + 800)
  // The items block must contain a 'required:' array (bracket-delimited).
  assert.match(
    snippet,
    /required\s*:\s*\[/,
    `${PIPELINE} BUILD_RESULT.failureLog.items has no 'required' array. ` +
      `Per the pattern used by lessonCandidates and recallVerify, the items object must ` +
      `declare its required row fields (at minimum phase and what_failed).`,
  )
  // The required array must reference at least the two most-critical row fields.
  assert.match(
    snippet,
    /required[\s\S]{0,80}phase/,
    `${PIPELINE} BUILD_RESULT.failureLog.items.required does not list 'phase'.`,
  )
  assert.match(
    snippet,
    /required[\s\S]{0,80}what_failed/,
    `${PIPELINE} BUILD_RESULT.failureLog.items.required does not list 'what_failed'.`,
  )
})

test('AC3(absent-is-valid): a BUILD_RESULT return WITHOUT failureLog passes the required-field check', () => {
  const body = read(PIPELINE)
  // Structural assertion: 'failureLog' is NOT in the required array.
  // (Duplicates the not-required test with a cleaner framing for the "absent = valid" criterion.)
  const requiredMatch = body.match(/required\s*:\s*\[([^\]]+)\]/)
  assert.ok(requiredMatch, `${PIPELINE} has no BUILD_RESULT required array.`)
  // If failureLog is not in required, a return without it satisfies the schema.
  assert.doesNotMatch(
    requiredMatch[1],
    /failureLog/,
    `'failureLog' appears in BUILD_RESULT.required -- this means a clean (no-failure) build ` +
      `that omits the field would FAIL schema validation, violating AC3.`,
  )
})
