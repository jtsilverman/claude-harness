// apply-grade-side-effects.test.mjs -- RED for chunk 7 (watchdog spec):
//   "Workflow envelope unwrap + all-empty guard"
//
// CONTRACT under test (from chunk 7 acceptance criteria):
//
//   AC1 (envelope): a grade JSON wrapped as {result:{corpusAppend:[...],...}} applies
//         the same file writes as the unwrapped (raw) form.
//         Test asserts equal file output after running with enveloped vs raw grade.
//
//   AC2 (all-empty): a grade with all three keys empty/absent exits non-zero with a
//         stderr message. Edge: .result present but also empty still errors (all-empty).
//
//   AC3 (idempotent): a valid non-empty grade applied twice produces identical file
//         output (second run = no change / exit 0).
//
// Edge cases:
//   - .result present but all keys empty -> all-empty error (same as AC2)
//   - top-level keys present (raw form) -> no double-unwrap, unchanged behavior
//   - malformed JSON -> existing error path (non-zero exit, stderr message)
//
// Test strategy: spawn the CLI with real tmpdir fixture files.
// We do NOT mock applyCorpusAppend/applyReaderModelUpdates/applyLedgerLines;
// we exercise them end-to-end by comparing actual file content on disk.
//
// Run: node --test workflows/apply-grade-side-effects.test.mjs
// Full suite: node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, 'apply-grade-side-effects.mjs')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp dir with the three fixture files and return their paths. */
function makeTmpFixtures(prefix = 'apply-grade-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const corpus = join(dir, 'voice-corpus.md')
  const readerModel = join(dir, 'reader-model.md')
  const ledger = join(dir, 'ledger.md')
  const gradeFile = join(dir, 'grade.json')

  // Minimal corpus with Voice samples section
  writeFileSync(corpus, '## Voice samples\n\n<!-- grader-maintained -->\n', 'utf8')
  // Minimal reader model with Known + Frontier sections
  writeFileSync(readerModel, '## Known\n\n- existing-concept\n\n## Frontier\n\n', 'utf8')
  // Empty ledger
  writeFileSync(ledger, '', 'utf8')

  return { dir, corpus, readerModel, ledger, gradeFile }
}

/** Run the CLI and return { status, stdout, stderr }. */
function runCLI(gradeFile, corpus, readerModel, ledger, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--grade', gradeFile, '--corpus', corpus, '--reader-model', readerModel, '--ledger', ledger, ...extraArgs],
    { encoding: 'utf8' },
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// A non-empty grade payload that touches all three transforms.
const NON_EMPTY_GRADE = {
  corpusAppend: [{ quote: 'test is not time cost', context: 'chunk-7-test' }],
  readerModelUpdates: [{ concept: 'workflow-envelope', move: 'Known', quote: 'known now' }],
  ledgerLines: ['chunk-7-ledger-entry'],
}

// ---------------------------------------------------------------------------
// AC1: Workflow envelope {result:{...}} applies the same writes as raw form
// ---------------------------------------------------------------------------

test('AC1(envelope-equals-raw): enveloped grade applies same file writes as raw grade', () => {
  // Run A: raw grade (keys at top level)
  const fixtureA = makeTmpFixtures('grade-raw-')
  writeFileSync(fixtureA.gradeFile, JSON.stringify(NON_EMPTY_GRADE), 'utf8')
  const resultA = runCLI(fixtureA.gradeFile, fixtureA.corpus, fixtureA.readerModel, fixtureA.ledger)
  assert.strictEqual(resultA.status, 0, `raw grade should exit 0; stderr: ${resultA.stderr}`)

  const corpusAfterRaw = readFileSync(fixtureA.corpus, 'utf8')
  const readerAfterRaw = readFileSync(fixtureA.readerModel, 'utf8')
  const ledgerAfterRaw = readFileSync(fixtureA.ledger, 'utf8')

  // Run B: enveloped grade {summary, agentCount, logs, result:{...}}
  const envelopedGrade = {
    summary: 'grader run complete',
    agentCount: 5,
    logs: [],
    result: { ...NON_EMPTY_GRADE },
  }
  const fixtureB = makeTmpFixtures('grade-env-')
  writeFileSync(fixtureB.gradeFile, JSON.stringify(envelopedGrade), 'utf8')
  const resultB = runCLI(fixtureB.gradeFile, fixtureB.corpus, fixtureB.readerModel, fixtureB.ledger)
  assert.strictEqual(resultB.status, 0, `enveloped grade should exit 0; stderr: ${resultB.stderr}`)

  const corpusAfterEnv = readFileSync(fixtureB.corpus, 'utf8')
  const readerAfterEnv = readFileSync(fixtureB.readerModel, 'utf8')
  const ledgerAfterEnv = readFileSync(fixtureB.ledger, 'utf8')

  assert.strictEqual(
    corpusAfterEnv,
    corpusAfterRaw,
    'corpus file content must be identical whether grade is raw or enveloped',
  )
  assert.strictEqual(
    readerAfterEnv,
    readerAfterRaw,
    'reader-model file content must be identical whether grade is raw or enveloped',
  )
  assert.strictEqual(
    ledgerAfterEnv,
    ledgerAfterRaw,
    'ledger file content must be identical whether grade is raw or enveloped',
  )
})

// AC1 edge: .result present but ALSO has top-level keys (raw form wins, no double-unwrap)
test('AC1(no-double-unwrap): raw form (top-level keys present) is not double-unwrapped', () => {
  // Grade has BOTH top-level keys and a .result key; top-level wins (raw form).
  const { gradeFile, corpus, readerModel, ledger } = makeTmpFixtures('grade-nodbl-')
  // Only the top-level keys should be applied; .result carries DIFFERENT data that must NOT be applied.
  const grade = {
    ...NON_EMPTY_GRADE,
    result: {
      corpusAppend: [{ quote: 'should-not-appear-if-raw-wins', context: 'collision' }],
      readerModelUpdates: [],
      ledgerLines: ['should-not-appear-in-ledger-if-raw-wins'],
    },
  }
  writeFileSync(gradeFile, JSON.stringify(grade), 'utf8')
  const r = runCLI(gradeFile, corpus, readerModel, ledger)
  assert.strictEqual(r.status, 0, `raw form with .result should exit 0; stderr: ${r.stderr}`)
  const ledgerContent = readFileSync(ledger, 'utf8')
  assert.ok(
    ledgerContent.includes('chunk-7-ledger-entry'),
    'top-level ledgerLines entry should be applied',
  )
  assert.ok(
    !ledgerContent.includes('should-not-appear-in-ledger-if-raw-wins'),
    '.result.ledgerLines must NOT be applied when top-level keys are present (no double-unwrap)',
  )
})

// ---------------------------------------------------------------------------
// AC2: All-empty grade exits non-zero with stderr message
// ---------------------------------------------------------------------------

test('AC2(all-empty-absent): grade with all three keys absent exits non-zero with stderr message', () => {
  const { gradeFile, corpus, readerModel, ledger } = makeTmpFixtures('grade-empty-')
  writeFileSync(gradeFile, JSON.stringify({}), 'utf8')
  const r = runCLI(gradeFile, corpus, readerModel, ledger)
  assert.notStrictEqual(r.status, 0, 'all-empty grade (all three keys absent) must exit non-zero')
  assert.ok(r.stderr.length > 0, 'all-empty grade must emit a message to stderr')
})

test('AC2(all-empty-empty-arrays): grade with all three keys as empty arrays exits non-zero', () => {
  const { gradeFile, corpus, readerModel, ledger } = makeTmpFixtures('grade-emptyarr-')
  writeFileSync(
    gradeFile,
    JSON.stringify({ corpusAppend: [], readerModelUpdates: [], ledgerLines: [] }),
    'utf8',
  )
  const r = runCLI(gradeFile, corpus, readerModel, ledger)
  assert.notStrictEqual(r.status, 0, 'all-empty-arrays grade must exit non-zero')
  assert.ok(r.stderr.length > 0, 'all-empty-arrays grade must emit a message to stderr')
})

test('AC2(result-present-but-empty): .result present but all keys empty still errors', () => {
  // Edge case from the spec: .result present but also empty -> still errors all-empty.
  const { gradeFile, corpus, readerModel, ledger } = makeTmpFixtures('grade-resempty-')
  const enveloped = {
    summary: 'run',
    result: { corpusAppend: [], readerModelUpdates: [], ledgerLines: [] },
  }
  writeFileSync(gradeFile, JSON.stringify(enveloped), 'utf8')
  const r = runCLI(gradeFile, corpus, readerModel, ledger)
  assert.notStrictEqual(r.status, 0, '.result present but empty should still exit non-zero')
  assert.ok(r.stderr.length > 0, '.result present but empty must emit a message to stderr')
})

// ---------------------------------------------------------------------------
// AC3: Idempotency -- second run produces identical file content
// ---------------------------------------------------------------------------

test('AC3(idempotent): second run with same grade produces no file change and exits 0', () => {
  const { gradeFile, corpus, readerModel, ledger } = makeTmpFixtures('grade-idem-')
  writeFileSync(gradeFile, JSON.stringify(NON_EMPTY_GRADE), 'utf8')

  // First run
  const r1 = runCLI(gradeFile, corpus, readerModel, ledger)
  assert.strictEqual(r1.status, 0, `first run should exit 0; stderr: ${r1.stderr}`)

  const corpusAfter1 = readFileSync(corpus, 'utf8')
  const readerAfter1 = readFileSync(readerModel, 'utf8')
  const ledgerAfter1 = readFileSync(ledger, 'utf8')

  // Second run (same grade, same files)
  const r2 = runCLI(gradeFile, corpus, readerModel, ledger)
  assert.strictEqual(r2.status, 0, `second run should exit 0; stderr: ${r2.stderr}`)

  assert.strictEqual(readFileSync(corpus, 'utf8'), corpusAfter1, 'corpus must be unchanged on second run')
  assert.strictEqual(readFileSync(readerModel, 'utf8'), readerAfter1, 'reader-model must be unchanged on second run')
  assert.strictEqual(readFileSync(ledger, 'utf8'), ledgerAfter1, 'ledger must be unchanged on second run')
})

// ---------------------------------------------------------------------------
// Edge case: malformed JSON -> existing read-error path (non-zero exit + stderr)
// ---------------------------------------------------------------------------

test('edge(malformed-json): non-JSON bytes in grade file exit non-zero with stderr message', () => {
  const { gradeFile, corpus, readerModel, ledger } = makeTmpFixtures('grade-malformed-')
  writeFileSync(gradeFile, 'not valid json {{{ garbled bytes', 'utf8')
  const r = runCLI(gradeFile, corpus, readerModel, ledger)
  assert.notStrictEqual(r.status, 0, 'malformed JSON grade file must exit non-zero')
  assert.ok(r.stderr.length > 0, 'malformed JSON grade file must emit a message to stderr')
})

// AC3 edge: enveloped grade is also idempotent
test('AC3(envelope-idempotent): enveloped grade is idempotent on second run', () => {
  const { gradeFile, corpus, readerModel, ledger } = makeTmpFixtures('grade-envidm-')
  const enveloped = { summary: 'done', result: { ...NON_EMPTY_GRADE } }
  writeFileSync(gradeFile, JSON.stringify(enveloped), 'utf8')

  const r1 = runCLI(gradeFile, corpus, readerModel, ledger)
  assert.strictEqual(r1.status, 0, `first enveloped run should exit 0; stderr: ${r1.stderr}`)
  const corpusAfter1 = readFileSync(corpus, 'utf8')
  const readerAfter1 = readFileSync(readerModel, 'utf8')
  const ledgerAfter1 = readFileSync(ledger, 'utf8')

  const r2 = runCLI(gradeFile, corpus, readerModel, ledger)
  assert.strictEqual(r2.status, 0, `second enveloped run should exit 0; stderr: ${r2.stderr}`)
  assert.strictEqual(readFileSync(corpus, 'utf8'), corpusAfter1, 'corpus unchanged on second enveloped run')
  assert.strictEqual(readFileSync(readerModel, 'utf8'), readerAfter1, 'reader-model unchanged on second enveloped run')
  assert.strictEqual(readFileSync(ledger, 'utf8'), ledgerAfter1, 'ledger unchanged on second enveloped run')
})
