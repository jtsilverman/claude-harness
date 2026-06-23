// RED test for pipeline-meritocracy chunk 10: widen the cleanResolvedFindings
// guard in workflows/worker-pipeline.js so a CLEAN terminal NEVER surfaces stale
// lens.findings -- including the zero-fixer-round case where the judge dropped the
// raised findings as FAULTY and returned CLEAN on the first pass (judgeRounds:[]).
//
// The bug: the guard is `(action === 'clean' && judgeRounds.length > 0)`. On a
// CLEAN with zero fixer rounds (a reviewer flags, the judge rules FAULTY, drops it,
// returns CLEAN, no fix round runs) the guard is FALSE, so resolvedLens surfaces the
// lens VERBATIM -- still listing the judge-dropped findings, contradicting the clean
// status. The fix widens the guard to ANY clean terminal (`action === 'clean'`); the
// audit trail of what was raised + the FAULTY verdict stays in review.issueLog +
// review.judgeRounds, never lost.
//
// Pins the FULL acceptance contract (specs/current.md chunk 10):
//   AC1 a zero-fixer-round CLEAN with a reviewer lens carrying a finding surfaces
//       that lens as {clean:true, findings:[]}  (the bug; RED fails here today).
//   AC2 a fixer-round CLEAN still resolves lenses (unchanged regression guard).
//   AC3 escalation / gap terminals still surface lenses VERBATIM (findings kept).
//   AC4 review.issueLog + judgeRounds preserve the dropped finding (audit not lost)
//       -- the return bundle wires the AUTHORITATIVE issueLog/judgeRounds from the
//       judge, NOT through resolvedLens (resolvedLens only touches the surfaced
//       lenses), so the audit fields are untouched by the guard widening.
//   Edge: a CLEAN with no findings ever raised is a no-op (lens already empty).
//   Edge: review.decision / judgeVerdict are wired straight from the judge, not via
//       resolvedLens, so the guard change leaves them unchanged.
//   AC5 0 em-dashes across the touched source; anti-tautology (behavioral eval of
//       the REAL source logic, not a keyword match on the patched text).
//
// Test strategy (behavioral source-eval, NOT a substring match -- the anti-tautology
// direction). worker-pipeline.js runs the pipeline at top level on import (top-level
// await + Workflow host globals), so it cannot be imported. Instead we EXTRACT the
// real `const cleanResolvedFindings = ...` guard line and the real `resolvedLens`
// function block VERBATIM from the source, wrap them in a Function factory that
// injects `judgeDecisionResult` + `judgeRounds` as parameters, and RUN the actual
// source logic against constructed lens inputs. The assertions are the OBSERVABLE
// resolvedLens output ({clean, findings}) decided from the requirement BEFORE the
// fix is written -- not keywords read back off the patched source. The bundle-wiring
// ACs (issueLog/judgeRounds/decision/judgeVerdict NOT routed through resolvedLens)
// are asserted at source level: those fields read straight from `judge` /
// `judgeDecisionResult`, never wrapped in resolvedLens(...).
//
// Run:        node --test workflows/pipeline-meritocracy-c10.test.mjs
// Full suite (GLOB form -- bare `node --test workflows/` errors MODULE_NOT_FOUND on Node v25):
//   node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const PIPE = 'workflows/worker-pipeline.js'
const PIPE_SRC = read(PIPE)

// The em-dash character the kernel style rule forbids (U+2014). Built from bytes so
// THIS test file's own source never carries the literal char it sweeps for.
const EM_DASH = Buffer.from([0xe2, 0x80, 0x94]).toString('utf8')

// === Extract the REAL guard + resolvedLens from source and make them runnable ===
// One line: `const cleanResolvedFindings = (...)`. One block: `function resolvedLens`.
function extractGuardAndLens(src) {
  const lines = src.split('\n')
  const ci = lines.findIndex((l) => l.includes('const cleanResolvedFindings ='))
  assert.notEqual(ci, -1, 'could not find the cleanResolvedFindings guard in source')
  const guardLine = lines[ci]
  const fi = lines.findIndex((l) => l.includes('function resolvedLens'))
  assert.notEqual(fi, -1, 'could not find function resolvedLens in source')
  const fnLines = []
  for (let i = fi; i < lines.length; i++) {
    fnLines.push(lines[i])
    if (lines[i] === '}') break
  }
  const fnSrc = fnLines.join('\n')
  // Inject judgeDecisionResult + judgeRounds as params so the real logic runs.
  return new Function(
    'judgeDecisionResult',
    'judgeRounds',
    `${guardLine}\n${fnSrc}\nreturn resolvedLens`,
  )
}
const makeResolvedLens = extractGuardAndLens(PIPE_SRC)

// A reviewer lens that flagged a finding the judge then dropped FAULTY.
const lensWithFinding = () => ({
  ran: true,
  clean: false,
  findings: [{ dim: 'P2', title: 'unreproducible-suspicion', repro: 'n/a' }],
})

// --- AC1: zero-fixer-round CLEAN clears the lens (the bug; RED fails here) ---
test('AC1: zero-fixer-round CLEAN surfaces a judge-FAULTY lens as {clean:true, findings:[]}', () => {
  const resolvedLens = makeResolvedLens({ action: 'clean' }, []) // judgeRounds: [] -- no fix round ran
  const out = resolvedLens(lensWithFinding())
  assert.equal(out.clean, true, 'a CLEAN terminal must surface the lens as clean:true')
  assert.deepEqual(out.findings, [], 'a CLEAN terminal must clear the judge-dropped findings')
})

// --- AC2: fixer-round CLEAN still resolves (unchanged regression guard) ---
test('AC2: fixer-round CLEAN still surfaces the lens as {clean:true, findings:[]}', () => {
  const resolvedLens = makeResolvedLens({ action: 'clean' }, [{ fixer: {}, reCheck: {} }])
  const out = resolvedLens(lensWithFinding())
  assert.equal(out.clean, true)
  assert.deepEqual(out.findings, [])
})

// --- AC3: escalation / gap terminals surface the lens VERBATIM (findings kept) ---
test('AC3: escalation terminal surfaces the lens verbatim (findings preserved)', () => {
  const lens = lensWithFinding()
  const out = makeResolvedLens({ action: 'escalate' }, [])(lens)
  assert.deepEqual(out, lens, 'escalation must surface the lens unchanged')
  assert.equal(out.findings.length, 1, 'escalation keeps the open findings visible')
})
test('AC3: gap terminal surfaces the lens verbatim (findings preserved)', () => {
  const lens = lensWithFinding()
  const out = makeResolvedLens({ action: 'gap' }, [])(lens)
  assert.deepEqual(out, lens, 'a verification gap must surface the lens unchanged')
  assert.equal(out.findings.length, 1, 'a gap keeps the open findings visible')
})

// --- Edge: CLEAN with no findings is a no-op (lens already empty) ---
test('Edge: CLEAN with an already-empty lens is a no-op', () => {
  const empty = { ran: true, clean: true, findings: [] }
  const out = makeResolvedLens({ action: 'clean' }, [])(empty)
  assert.equal(out.clean, true)
  assert.deepEqual(out.findings, [])
})
test('Edge: a null lens (off-tier) is passed through untouched on any terminal', () => {
  assert.equal(makeResolvedLens({ action: 'clean' }, [])(null), null)
  assert.equal(makeResolvedLens({ action: 'escalate' }, [])(null), null)
})

// --- AC4 + decision/judgeVerdict edge: the AUDIT fields are NOT routed through ---
// resolvedLens, so the guard widening cannot touch them. issueLog, judgeRounds,
// decision, and judgeVerdict read straight from `judge` / `judgeDecisionResult`.
test('AC4: review.issueLog + judgeRounds + decision + judgeVerdict are wired raw, not via resolvedLens', () => {
  for (const field of [
    'issueLog: judge ?',
    'judgeRounds,',
    'decision: judgeDecisionResult.action',
    'judgeVerdict: judge ?',
  ]) {
    assert.ok(PIPE_SRC.includes(field), `expected the raw audit wiring "${field}" in ${PIPE}`)
  }
  // None of the audit fields may be wrapped in resolvedLens(...).
  for (const wrapped of [
    'resolvedLens(judge',
    'resolvedLens(issueLog',
    'resolvedLens(judgeRounds',
    'resolvedLens(judgeDecisionResult',
  ]) {
    assert.ok(!PIPE_SRC.includes(wrapped), `audit field must NOT be routed through resolvedLens: "${wrapped}"`)
  }
})

// --- AC5: 0 em-dashes in the touched source ---
test('AC5: worker-pipeline.js carries no em-dash', () => {
  assert.ok(!PIPE_SRC.includes(EM_DASH), `${PIPE} must contain no em-dash (U+2014)`)
})
