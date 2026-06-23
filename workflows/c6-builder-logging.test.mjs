// RED test for chunk 6 (employed-system-tuning): "builder logging hard-gate"
//
// Spec (specs/current.md chunk 6):
//   E1/E2: add to disciplines/worker-discipline.md a terse rule -- every NEW
//   executable artifact (script/CLI/workflow/non-trivial module; NOT test files or
//   trivial pure helpers) carries liberal diagnostic logging at branch points +
//   every error path, to stderr/language-idiom behind a verbosity flag; no mandated
//   logger framework.
//   E3: add to disciplines/review-contract.md a HARD-GATE finding class -- a silent
//   new executable artifact blocks.
//
// This test pins the FULL acceptance contract across both criteria:
//
//   AC1: disciplines/worker-discipline.md states the every-new-executable-artifact
//        logging bar with the test/pure-helper exclusion. It must name:
//          - the scope: every NEW executable artifact (script / CLI / workflow / module)
//          - liberal diagnostic logging at branch points AND every error path
//          - destination: stderr / language idiom behind a verbosity flag
//          - no mandated logger framework
//          - the exclusion: NOT test files, NOT trivial pure helpers
//
//   AC2: disciplines/review-contract.md lists a silent new executable artifact as a
//        HARD-GATE (blocking) finding -- it names the silent-new-executable-artifact
//        finding class AND marks it blocking (P1 / blocks merge).
//
// Test strategy: source-inspection idiom (same approach as builder-error-log.test.mjs).
// Both docs are plain text, read and asserted for required content.
//
// No tautology: every expected string/pattern is fixed from the chunk's acceptance
// criteria ABOVE, before any implementation is written.
//
// Run: node --test workflows/c6-builder-logging.test.mjs
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
const CONTRACT   = 'disciplines/review-contract.md'

// === AC1: worker-discipline.md states the logging bar + the exclusion ===

test('AC1(logging-section): worker-discipline.md has a logging requirement for new executable artifacts', () => {
  const body = read(DISCIPLINE)
  // Must name the concept: every new executable artifact carries logging.
  assert.match(
    body,
    /executable\s+artifact/i,
    `${DISCIPLINE} has no "executable artifact" logging rule. AC1 requires the doc to ` +
      `state that every NEW executable artifact carries diagnostic logging.`,
  )
  assert.match(
    body,
    /log(ging|s)?/i,
    `${DISCIPLINE} does not mention logging. AC1 requires a diagnostic-logging rule.`,
  )
})

test('AC1(artifact-kinds): worker-discipline.md names the artifact kinds (script/CLI/workflow/module)', () => {
  const body = read(DISCIPLINE)
  // The rule scope spans script, CLI, workflow, and non-trivial module.
  for (const kind of [/script/i, /CLI/, /workflow/i, /module/i]) {
    assert.match(
      body,
      kind,
      `${DISCIPLINE} does not name the artifact kind matching ${kind}. AC1 requires the ` +
        `scope (script / CLI / workflow / non-trivial module) to be stated.`,
    )
  }
})

test('AC1(liberal-at-branch-and-error): worker-discipline.md says log liberally at branch points AND every error path', () => {
  const body = read(DISCIPLINE)
  assert.match(
    body,
    /liberal/i,
    `${DISCIPLINE} does not say to log LIBERALLY. AC1 requires "liberal diagnostic logging".`,
  )
  assert.match(
    body,
    /branch/i,
    `${DISCIPLINE} does not name "branch points" as a logging site. AC1 requires logging at branch points.`,
  )
  assert.match(
    body,
    /error\s*path/i,
    `${DISCIPLINE} does not name "error path" as a logging site. AC1 requires logging at every error path.`,
  )
})

test('AC1(stderr-verbosity-flag): worker-discipline.md says stderr/idiom behind a verbosity flag', () => {
  const body = read(DISCIPLINE)
  assert.match(
    body,
    /stderr/i,
    `${DISCIPLINE} does not name stderr (the language-idiom diagnostic stream). AC1 requires ` +
      `"to stderr / language-idiom".`,
  )
  assert.match(
    body,
    /verbosity\s+flag|verbose\s+flag|behind\s+a\s+\w*\s*flag/i,
    `${DISCIPLINE} does not name a verbosity flag. AC1 requires the logging to sit behind a verbosity flag.`,
  )
})

test('AC1(no-mandated-framework): worker-discipline.md states no logger framework is mandated', () => {
  const body = read(DISCIPLINE)
  // The non-goal is explicit: no mandated logger framework.
  assert.match(
    body,
    /no\s+(mandated\s+)?(logger\s+)?framework|framework[^.]{0,40}not\s+mandated|no\s+mandated\s+\w+/i,
    `${DISCIPLINE} does not state that no logger framework is mandated. AC1 requires this so ` +
      `builders are free to use the language idiom, not a forced library.`,
  )
})

test('AC1(exclusion): worker-discipline.md excludes test files and trivial pure helpers', () => {
  const body = read(DISCIPLINE)
  assert.match(
    body,
    /test\s+files?/i,
    `${DISCIPLINE} does not name the test-file exclusion. AC1 requires the rule to exclude test files.`,
  )
  assert.match(
    body,
    /pure\s+helper/i,
    `${DISCIPLINE} does not name the "trivial pure helper" exclusion. AC1 requires it.`,
  )
  assert.match(
    body,
    /trivial/i,
    `${DISCIPLINE} does not qualify the helper exclusion as "trivial". AC1 requires the exclusion ` +
      `to be "trivial pure helpers", not all helpers.`,
  )
})

// === AC2: review-contract.md lists silent-new-executable-artifact as a hard-gate (blocking) finding ===

test('AC2(finding-named): review-contract.md names the silent-new-executable-artifact finding', () => {
  const body = read(CONTRACT)
  // The finding class must be present and refer to a silent new executable artifact / script.
  assert.match(
    body,
    /silent[\s\S]{0,60}(executable\s+artifact|new\s+(script|executable)|script)/i,
    `${CONTRACT} does not name a "silent new executable artifact" finding class. AC2 requires the ` +
      `review net to list it so a builder shipping a silent script is caught.`,
  )
})

test('AC2(hard-gate-blocking): the silent-new-executable-artifact finding is marked HARD-GATE / blocking', () => {
  const body = read(CONTRACT)
  // Scope to the region around the silent-artifact mention and assert it is blocking.
  const idx = body.search(/silent[\s\S]{0,60}(executable\s+artifact|new\s+(script|executable)|script)/i)
  assert.ok(
    idx !== -1,
    `${CONTRACT} has no silent-new-executable-artifact mention to qualify (prerequisite for this test).`,
  )
  // Grab a window spanning the surrounding sentence/bullet (300 chars each side).
  const start = Math.max(0, idx - 300)
  const snippet = body.slice(start, idx + 300)
  assert.match(
    snippet,
    /hard.?gate|block(s|ing)?\s+(merge|the\s+chunk)?|P1/i,
    `${CONTRACT} mentions a silent new executable artifact but does not mark it HARD-GATE / blocking ` +
      `(P1 / blocks merge). AC2 requires it to be a hard-gate finding that blocks.`,
  )
})
