// RED test for pipeline-meritocracy chunk 2: rewire the per-chunk pipeline from
// the mechanical fix-loop (severity-floor controller + fixer-REJECT-adjudication +
// re-review-deadlock-escalation) to REVIEW -> JUDGE -> FIX -> RE-CHECK, where a
// single opus meritocracy-judge adjudicates each finding TRUE/FAULTY by evidence,
// fixes EVERY TRUE finding regardless of severity (NO floor), and persists a
// crash-survivable issue log.
//
// Pins the FULL acceptance contract:
//   AC1 review dispatch     : REVIEW dispatches [sonnet, Codex] on both tiers;
//                             heavy adds the opus adversarial reviewer (re-gated
//                             from the legacy tier === 'S' to `heavy`).
//   AC2 judge-then-fixer     : the pipeline dispatches the meritocracy-judge AFTER
//                             the reviewers and the fixer AFTER the judge (order +
//                             the new agents/meritocracy-judge.md file exists).
//   AC3 FAULTY dropped       : judgeDecision on a CLEAN verdict (no TRUE finding)
//                             -> 'clean'; a FAULTY no-repro finding is judge-dropped
//                             and never reaches the fixer.
//   AC4 TRUE blocks          : a non-empty fixList (any TRUE finding) -> 'fix';
//                             a P2/P3 (non-P1) TRUE finding ALSO fires the fixer --
//                             NO severity floor (a present TRUE finding never CLEAN).
//   AC5 issue-log durable    : the judge prompt persists the issueLog to a per-chunk
//                             durable sidecar (atomic tmp+rename) at post-judge +
//                             each fixer round + terminal; the JUDGE_RESULT schema
//                             carries issueLog + the persisted path.
//   AC6 deleted machinery    : worker-pipeline.js no longer defines fixLoopController
//                             (severity-floor) nor the fixer-REJECT-adjudication path
//                             nor the re-review-deadlock-escalation they replace.
//   AC7 fail-closed          : judgeDecision on a judge error/unreachable verdict
//                             -> a verification GAP (never silent 'clean').
//   AC8 2-pass cap           : after JUDGE_MAX_PASSES unresolved fixer rounds the
//                             decision escalates (carries both repros), never a 3rd patch.
//   AC9 unreproducible-back  : the fixer prompt routes a confirmed-then-unreproducible
//                             finding BACK to the judge, not a silent skip.
//
// Test strategy (mirrors fix-loop.mjs / tier-dispatch.mjs proof-pattern): the
// judge DECISION CORE is extracted as a PURE, import-safe lib
// (workflows/meritocracy-judge.mjs) -- no top-level side effects, no Workflow
// globals -- so it imports cleanly and the truth-routing is unit-tested directly.
// worker-pipeline.js runs the pipeline at top level on import (top-level await +
// Workflow host globals), so its rewire is asserted at SOURCE level against the
// inlined lockstep copy + the dispatch order, the same as the c1/llr tests.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  judgeDecision,
  collectReviewerFindings,
  JUDGE_MAX_PASSES,
} from './meritocracy-judge.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const PIPE = 'workflows/worker-pipeline.js'
const PIPE_SRC = read(PIPE)

// A contract-format reviewer finding line carrying a P-level + a repro.
const finding = (p, title = 'x') => `- [BUG][P${p}] ${title} -- a.js:1 -- worker -- why`

// --- AC1: REVIEW dispatches [sonnet, Codex] on both tiers; heavy adds adversarial ---

test('AC1: both reviewer lenses (Codex + Sonnet chunk-reviewer) are dispatched in REVIEW', () => {
  assert.match(PIPE_SRC, /codexLensPrompt\(/, `${PIPE} must dispatch the Codex lens.`)
  assert.match(PIPE_SRC, /sonnetLensPrompt\(/, `${PIPE} must dispatch the Sonnet chunk-reviewer lens.`)
})

test('AC1: the adversarial lens is gated on `heavy`, NOT the legacy tier === "S"', () => {
  // The adversarial 3rd reviewer must fire on heavy (re-gated from the deleted Tier S).
  assert.ok(
    /normalizeTier\(\s*tier\s*\)\s*===\s*'heavy'/.test(PIPE_SRC),
    `${PIPE} must gate the adversarial reviewer on normalizeTier(tier) === 'heavy'.`,
  )
  // The old literal `tier === 'S'` gate for the adversarial spawn must be gone.
  assert.ok(
    !/tier\s*===\s*'S'/.test(PIPE_SRC),
    `${PIPE} must NOT keep the legacy adversarial gate \`tier === 'S'\` (re-gated to heavy).`,
  )
})

// --- AC2: REVIEW -> JUDGE -> FIX order + the new judge agent file exists ---

test('AC2: agents/meritocracy-judge.md exists (the new opus judge agent)', () => {
  assert.ok(existsSync(join(ROOT, 'agents/meritocracy-judge.md')),
    'agents/meritocracy-judge.md must exist (the opus meritocracy-judge agent).')
})

test('AC2: the pipeline dispatches the meritocracy-judge agent', () => {
  assert.match(PIPE_SRC, /agentType:\s*'meritocracy-judge'/,
    `${PIPE} must dispatch agentType 'meritocracy-judge'.`)
})

test('AC2: REVIEW precedes JUDGE precedes FIX (dispatch order in the source)', () => {
  // Anchor on the CALL/dispatch sites, not the function DEFINITIONS (which are
  // hoisted above): the reviewer dispatch is the `await parallel([` REVIEW block,
  // the judge dispatch is the first `agentType: judgeFor(tier).agentType` agent()
  // call (chunk 9 routed the judge through judgeFor; the bare 'meritocracy-judge'
  // literal now lives only inside the hoisted judgeFor definition, not at the call
  // site), and the fixer dispatch is the `fixerPrompt(currentSha` call inside the loop.
  const iReview = PIPE_SRC.indexOf("sonnetLensPrompt('drift-slop')")     // the initial REVIEW dispatch
  const iJudge = PIPE_SRC.indexOf("agentType: judgeFor(tier).agentType") // the JUDGE dispatch
  const iFixer = PIPE_SRC.indexOf('fixerPrompt(currentSha')              // the FIX dispatch (call, not the def)
  assert.ok(iReview > -1 && iJudge > -1 && iFixer > -1, 'review, judge, and fixer dispatch sites must all be present')
  assert.ok(iReview < iJudge, 'the reviewers must be dispatched BEFORE the judge')
  assert.ok(iJudge < iFixer, 'the judge must be dispatched BEFORE the fixer')
})

// --- AC3: a FAULTY no-repro finding is judge-dropped and never reaches the fixer ---

test('AC3: judgeDecision on a CLEAN verdict (judge dropped every finding) -> clean', () => {
  const d = judgeDecision({ verdict: 'CLEAN', fixList: [] }, 0)
  assert.equal(d.action, 'clean', 'an empty fixList (every finding adjudicated FAULTY) -> clean, no fixer dispatch')
})

test('AC3: empty reviewer findings -> judge CLEAN -> no fixer', () => {
  // collectReviewerFindings over clean lenses yields nothing for the judge to weigh.
  const open = collectReviewerFindings(
    { ran: true, clean: true, findings: [] },
    { ran: true, clean: true, findings: [] },
  )
  assert.deepEqual(open, [], 'no reviewer findings -> nothing handed to the judge')
})

// --- AC4: a TRUE finding (any severity) fires the fixer -- NO severity floor ---

test('AC4: judgeDecision on a non-empty fixList -> fix (TRUE finding blocks)', () => {
  const d = judgeDecision({ verdict: 'FIX', fixList: [finding(1)] }, 0)
  assert.equal(d.action, 'fix', 'a TRUE finding on the fixList must fire the fixer')
})

test('AC4: a TRUE P2/P3 (non-P1) finding ALSO fires the fixer -- NO severity floor', () => {
  // This is the live-defect fix: the old severity-floor returned CLEAN on an
  // all-P2/P3 list. The judge has NO floor -- any TRUE finding fires the fixer.
  for (const p of [2, 3]) {
    const d = judgeDecision({ verdict: 'FIX', fixList: [finding(p)] }, 0)
    assert.equal(d.action, 'fix',
      `a TRUE P${p} finding must STILL fire the fixer (no severity floor; a present TRUE finding is never CLEAN)`)
  }
})

test('AC4: a present TRUE finding never returns clean regardless of severity mix', () => {
  const d = judgeDecision({ verdict: 'FIX', fixList: [finding(2), finding(3)] }, 0)
  assert.notEqual(d.action, 'clean', 'an all-P2/P3 TRUE fixList must NOT clear (the live worker-pipeline.js defect this chunk fixes)')
})

// --- AC5: the issue log is persisted durably at each boundary ---

test('AC5: the JUDGE_RESULT schema carries fixList + issueLog + verdict + the persisted path', () => {
  // The judge returns the structured result the pipeline routes on.
  assert.match(PIPE_SRC, /const\s+JUDGE_RESULT\s*=/, `${PIPE} must define a JUDGE_RESULT schema for the judge dispatch.`)
  for (const field of ['fixList', 'issueLog', 'verdict']) {
    assert.ok(PIPE_SRC.includes(`${field}:`), `${PIPE} JUDGE_RESULT must carry the '${field}' field.`)
  }
  // issueLogPath: the durable sidecar path the judge persisted to (so the pipeline
  // records the persisted location, and a crash leaves a readable log on disk).
  assert.ok(/issueLogPath/.test(PIPE_SRC), `${PIPE} JUDGE_RESULT must carry the persisted issueLogPath.`)
})

test('AC5: the judge agent prompt instructs durable issue-log persistence at each boundary', () => {
  const judge = read('agents/meritocracy-judge.md')
  // It persists the issue log to a per-chunk durable sidecar via an atomic write
  // (tmp + rename, the cockpit-sidecar durability pattern) so a crash-after-judge
  // leaves a readable log.
  assert.match(judge, /issue ?log/i, 'the judge agent must describe the issue log it emits')
  assert.match(judge, /atomic|tmp|rename|fsync/i, 'the judge must persist the issue log durably (atomic tmp+rename, crash-survivable)')
  assert.match(judge, /post-?judge|each (fixer )?round|terminal/i,
    'the judge must persist at the post-judge + per-round + terminal boundaries')
})

test('AC5: the pipeline threads a per-chunk issue-log sidecar path into the judge dispatch', () => {
  assert.ok(/issueLog(Path|Sidecar)/.test(PIPE_SRC),
    `${PIPE} must thread a per-chunk issue-log sidecar path to the judge.`)
})

// --- AC6: the old fix-loop machinery is DELETED from worker-pipeline.js ---

test('AC6: fixLoopController (the severity-floor controller) is absent from worker-pipeline.js', () => {
  assert.ok(!/function fixLoopController/.test(PIPE_SRC),
    `${PIPE} must NOT keep the fixLoopController severity-floor (replaced by the judge decision).`)
  assert.ok(!/fixLoopController\s*\(/.test(PIPE_SRC),
    `${PIPE} must NOT call fixLoopController anywhere (the judge owns fix-or-clean now).`)
})

test('AC6: the inlined findingSeverity severity-floor helper is absent (only the floor used it)', () => {
  assert.ok(!/function findingSeverity/.test(PIPE_SRC),
    `${PIPE} must NOT keep findingSeverity -- the severity floor it served is deleted (the judge has no floor).`)
})

test('AC6: the fixer-REJECT-adjudication path is gone (the judge owns truth, not the fixer)', () => {
  // The old re-review adjudicated fixer REJECTions; the judge now owns truth.
  assert.ok(!/REJECT/.test(PIPE_SRC),
    `${PIPE} must NOT keep the fixer-REJECT-adjudication path -- the judge adjudicates truth, the fixer fixes confirmed-only.`)
  assert.ok(!/settledRejectKeys|reReviewPrompt/.test(PIPE_SRC),
    `${PIPE} must NOT keep the REJECT-dedup / re-review-adjudication machinery.`)
})

test('AC6: the re-review-deadlock escalation (escalate action) is replaced by the judge re-check cap', () => {
  // The old fixLoopController returned action 'escalate' on an N=2 deadlock of the
  // fixer-vs-reviewer loop. The judge decision owns the cap now; the old controller's
  // escalation branch must be gone from the inlined copy.
  assert.ok(!/action:\s*'escalate',\s*\n\s*escalation:\s*\{\s*\n\s*reviewerFindings/.test(PIPE_SRC),
    `${PIPE} must NOT keep the fixLoopController deadlock-escalation block.`)
})

// --- AC7: judge unreachable / errors -> fail-closed (a verification gap, never CLEAN) ---

test('AC7: judgeDecision on a judge ERROR verdict -> gap (never silent clean)', () => {
  const d = judgeDecision({ verdict: 'ERROR', fixList: [], error: 'judge unreachable' }, 0)
  assert.notEqual(d.action, 'clean', 'a judge error must NEVER resolve to a silent CLEAN (fail-closed)')
  assert.equal(d.action, 'gap', 'a judge error is a verification GAP')
})

test('AC7: judgeDecision on a missing/null verdict -> gap (fail-closed default)', () => {
  assert.notEqual(judgeDecision(null, 0).action, 'clean', 'a null judge result must NOT be CLEAN (fail-closed)')
  assert.notEqual(judgeDecision({ fixList: [] }, 0).action, 'clean', 'a missing verdict must NOT be CLEAN (fail-closed)')
})

// --- AC8: 2-pass cap -> escalate with both repros, never a 3rd patch ---

test('AC8: a still-FIX verdict after JUDGE_MAX_PASSES rounds -> escalate (not a 3rd fix)', () => {
  assert.equal(JUDGE_MAX_PASSES, 2, 'the judge re-check cap is 2 passes (the two-failed-attempts reset rule)')
  const d = judgeDecision({ verdict: 'FIX', fixList: [finding(1)] }, JUDGE_MAX_PASSES)
  assert.equal(d.action, 'escalate', 'after the 2-pass cap an unresolved TRUE finding escalates, never a 3rd patch')
})

test('AC8: the escalation carries the open fixList (the repros) for the COO', () => {
  const d = judgeDecision({ verdict: 'FIX', fixList: [finding(1, 'unresolved')] }, JUDGE_MAX_PASSES)
  assert.ok(d.escalation && Array.isArray(d.escalation.openFindings), 'the escalation must carry the open findings')
  assert.ok(d.escalation.openFindings.length > 0, 'the escalation must carry the unresolved repros, not an empty list')
})

test('AC8: below the cap, a still-FIX verdict keeps fixing (fix, not escalate)', () => {
  const d = judgeDecision({ verdict: 'FIX', fixList: [finding(1)] }, 1)
  assert.equal(d.action, 'fix', 'one pass in, an unresolved finding gets one more fixer round before the cap')
})

// --- AC9: a confirmed-then-unreproducible finding routes BACK to the judge ---

test('AC9: the fixer prompt routes a confirmed-then-unreproducible finding BACK to the judge', () => {
  // The fixer fixes judge-confirmed only (P4); if a confirmed finding turns out
  // unreproducible WHEN the fixer fixes it, it reports back to the judge -- not a
  // silent skip.
  assert.ok(/judge/i.test(PIPE_SRC), `${PIPE} fixer prompt must reference the judge as the truth-owner.`)
  assert.match(PIPE_SRC, /unreproducible|report (it )?back to the judge|counter-?repro/i,
    `${PIPE} fixer prompt must route a confirmed-then-unreproducible finding back to the judge, not silently skip it.`)
})

// --- Lockstep: the inlined judge decision core is byte-identical to the lib ---

function fnBlock(src, decl) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.includes(decl))
  assert.notEqual(start, -1, `could not find "${decl}" in source`)
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n')
  }
  throw new Error(`no closing brace found for ${decl}`)
}

test('lockstep: worker-pipeline judgeDecision is byte-identical to the lib (minus export)', () => {
  const LIB_SRC = read('workflows/meritocracy-judge.mjs')
  const lib = fnBlock(LIB_SRC, 'function judgeDecision').replace(/^export\s+/, '')
  const inline = fnBlock(PIPE_SRC, 'function judgeDecision').replace(/^export\s+/, '')
  assert.equal(inline, lib, 'the inlined judgeDecision must be byte-identical to the meritocracy-judge.mjs lib (minus export)')
})

test('lockstep: worker-pipeline collectReviewerFindings is byte-identical to the lib (minus export)', () => {
  const LIB_SRC = read('workflows/meritocracy-judge.mjs')
  const lib = fnBlock(LIB_SRC, 'function collectReviewerFindings').replace(/^export\s+/, '')
  const inline = fnBlock(PIPE_SRC, 'function collectReviewerFindings').replace(/^export\s+/, '')
  assert.equal(inline, lib, 'the inlined collectReviewerFindings must be byte-identical to the lib (minus export)')
})
