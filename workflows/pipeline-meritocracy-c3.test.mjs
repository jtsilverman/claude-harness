// RED test for pipeline-meritocracy chunk 3: install the literal walks
// (P1 reviewer template, P2 + P5 judge walks, P9 real-context grounding, P4 fixer
// duty) VERBATIM at each agent's prompt, and DROP the old self-as-quality-gate /
// fixer-REJECT-arbitration framing (chunk 2 made the judge the truth-owner; the
// agent docs lagged).
//
// Pins the FULL acceptance contract (specs/current.md chunk 3):
//   AC1 review-contract.md installs the P1 finding template verbatim + the
//       suspicion->NOTES + CLEAN-is-expected sentence + names the JUDGE as
//       truth-owner (reviewers flag, do not decide) + documents the heavy
//       adversarial reviewer (kept assume-a-hole, grain-of-salted by the judge).
//   AC2 meritocracy-judge.md installs the P2 adjudication walk + the P5 re-check
//       walk + the P9 real-context grounding VERBATIM (chunk 2 created the file;
//       this chunk pins the walks are present and verbatim).
//   AC3 chunk-reviewer.md (+ -heavy) installs the P1 template + P9 grounding +
//       flag-only-with-repro + CLEAN-default, and DROPS the old
//       self-as-quality-gate + fixer-REJECT re-review-arbitration framing
//       (the judge is the gate now).
//   AC4 fixer.md (+ -heavy) installs the P4 duty (fix judge-confirmed-TRUE only,
//       no arbitration) and DROPS the REJECT-adjudication disposition; the
//       return-bundle union now reads fixed | unreproducible | stuck | log-only
//       (matching the chunk-2 pipeline FIXER_RESULT), REJECT gone.
//   AC5 0 em-dashes across the touched files; each verbatim walk-anchor appears
//       exactly once per file (no double-install).
//   Edge: no review dimension is dropped from the reviewer (all four named).
//   Edge: the heavy reviewer keeps its domain-paranoia / assume-a-hole section.
//   Edge: the contract points at the calibration by reference, not re-inlined
//         in three places (review-contract still says cite-it-do-not-restate).
//
// Test strategy: source-inspection idiom (same as pipeline-meritocracy-c5.test.mjs
// and c8-reviewer-split-rename.test.mjs). The agent/contract docs are plain text;
// we read and assert required VERBATIM substrings drawn from specs/current.md
// ## Literal processes (P1/P2/P4/P5/P9), fixed from the spec BEFORE the install
// prose is written (no tautology -- the expected strings are the spec's own walk
// text, not keywords copied from the doc), plus ABSENCE assertions for the dropped
// framing (the anti-tautology direction: the old phrasing must be gone).
//
// Run:        node --test workflows/pipeline-meritocracy-c3.test.mjs
// Full suite (GLOB form -- bare `node --test workflows/` errors MODULE_NOT_FOUND on Node v25):
//   node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const CONTRACT = 'disciplines/review-contract.md'
const JUDGE = 'agents/meritocracy-judge.md'
const REVIEWER = 'agents/chunk-reviewer.md'
const REVIEWER_HEAVY = 'agents/chunk-reviewer-heavy.md'
const FIXER = 'agents/fixer.md'
const FIXER_HEAVY = 'agents/fixer-heavy.md'

// The em-dash character the kernel style rule forbids (U+2014). Built from bytes so
// THIS test file's own source never carries the literal char it sweeps for
// (em-dash-sweep-self-collision pattern).
const EM_DASH = Buffer.from([0xe2, 0x80, 0x94]).toString('utf8')

// Count non-overlapping occurrences of needle in haystack.
const countOf = (hay, needle) => hay.split(needle).length - 1

// === VERBATIM walk anchors (from specs/current.md ## Literal processes) ===

// P1 -- reviewer finding template + the suspicion/CLEAN sentence.
const P1_TEMPLATE_LINE = '[<DIM>][P<n>] <title> -- <file>:<lines>'
const P1_REPRO = 'repro:    <the exact command or input that triggers it>'
const P1_EXPECTED = 'expected: <what a correct build does>'
const P1_ACTUAL = 'actual:   <what THIS build does>'
const P1_SUSPICION = 'If you cannot fill repro / expected / actual concretely, you have a suspicion, not a finding -- put it under NOTES. Notes never block a merge. CLEAN is the common, expected result.'

// P2 -- judge adjudication walk anchors.
const P2_HEADER = 'You receive both reviewers\' findings, the chunk diff, and the chunk spec. For EACH finding:'
const P2_REPRODUCE = 'Read its repro / expected / actual. Reproduce it against the diff (run it, or trace it in the code).'
const P2_TRUE = 'YES -> verdict TRUE. Add to the fix-list.'
const P2_FAULTY = 'NO  -> verdict FAULTY. Write why (counter-repro: what you ran/traced -> what you observed). Drop it.'
const P2_LENS = 'The lens that raised a finding is IRRELEVANT -- only repro vs counter-repro decides. A confident'
const P2_CLEAN = 'If the fix-list is empty, verdict CLEAN (merge). Otherwise emit the fix-list + the issue log.'

// P5 -- judge re-check walk anchors.
const P5_HEADER = 'After the fixer runs, re-check ONLY: (a) is each TRUE finding now resolved (its repro no longer'
const P5_NEWFIND = 'reproduces)? (b) did the fix introduce any NEW finding that reproduces? If both clear -> CLEAN, merge.'
const P5_ESCALATE = 'If a TRUE finding is unresolved after 2 fixer passes, escalate to the COO with both repros.'

// P9 -- real-context grounding walk anchors.
const P9_NODIFF = 'Do NOT judge from the diff alone.'
const P9_PROJECT = 'Read the PROJECT the diff sits in -- the existing code/modules it calls, the conventions already there.'
const P9_REALDATA = 'inspect the REAL output / checkpoint (not the tiny'
const P9_GROUND = 'Ground every finding in the chunk\'s TRUE context, not an assumption about it.'

// P4 -- fixer duty walk anchors.
const P4_CONFIRMED = 'You fix ONLY the judge-confirmed (TRUE) findings on the fix-list. You do NOT re-litigate a finding'
const P4_NOADJUDICATE = 'the judge dropped, and you do NOT adjudicate -- the judge already ruled. Fix each RED-first (pin with a'
const P4_UNREPRO = 'If a confirmed finding turns out unreproducible WHEN YOU FIX IT, report that'
const P4_BACK = 'back to the judge with your counter-repro; you do not silently skip it.'

// ===========================================================================
// AC1: review-contract.md installs P1 verbatim + names the judge as truth-owner
// ===========================================================================

test('AC1: review-contract installs the P1 finding-template verbatim', () => {
  const src = read(CONTRACT)
  for (const needle of [P1_TEMPLATE_LINE, P1_REPRO, P1_EXPECTED, P1_ACTUAL]) {
    assert.ok(src.includes(needle), `review-contract missing P1 template line: ${needle}`)
  }
})

test('AC1: review-contract installs the suspicion->NOTES + CLEAN-is-expected sentence verbatim', () => {
  const src = read(CONTRACT)
  assert.ok(src.includes(P1_SUSPICION), 'review-contract missing the P1 suspicion/NOTES/CLEAN sentence verbatim')
})

test('AC1: review-contract names the JUDGE as truth-owner (reviewers flag, do not decide)', () => {
  const src = read(CONTRACT)
  // The 2-reviewer -> judge -> fixer flow + the judge owns truth.
  assert.match(
    src,
    /reviewers flag/i,
    'review-contract must state that reviewers flag (do not decide)',
  )
  assert.match(
    src,
    /judge/i,
    'review-contract must name the meritocracy-judge as the truth-owner',
  )
  // The flow must name the judge owning the truth decision.
  assert.ok(
    /judge\b[^.]*\b(owns?|decides?)\b.*\btruth\b/i.test(src) ||
      /\btruth\b[^.]*\bjudge\b/i.test(src),
    'review-contract must say the judge owns/decides truth',
  )
})

test('AC1: review-contract documents the heavy adversarial reviewer (assume-a-hole, grain-of-salted by the judge)', () => {
  const src = read(CONTRACT)
  assert.match(
    src,
    /adversarial/i,
    'review-contract must document the heavy adversarial reviewer',
  )
  assert.match(
    src,
    /assume-a-hole/i,
    'review-contract must note the adversarial reviewer keeps assume-a-hole',
  )
  assert.match(
    src,
    /grain[- ]of[- ]salt/i,
    'review-contract must note the adversarial reviewer is grain-of-salted by the judge',
  )
})

// ===========================================================================
// AC2: meritocracy-judge.md installs P2 + P5 + P9 verbatim
// ===========================================================================

test('AC2: meritocracy-judge installs the P2 adjudication walk verbatim', () => {
  const src = read(JUDGE)
  for (const needle of [P2_HEADER, P2_REPRODUCE, P2_TRUE, P2_FAULTY, P2_LENS, P2_CLEAN]) {
    assert.ok(src.includes(needle), `meritocracy-judge missing P2 anchor: ${needle}`)
  }
})

test('AC2: meritocracy-judge installs the P5 re-check walk verbatim', () => {
  const src = read(JUDGE)
  for (const needle of [P5_HEADER, P5_NEWFIND, P5_ESCALATE]) {
    assert.ok(src.includes(needle), `meritocracy-judge missing P5 anchor: ${needle}`)
  }
})

test('AC2: meritocracy-judge installs the P9 real-context grounding verbatim', () => {
  const src = read(JUDGE)
  for (const needle of [P9_NODIFF, P9_PROJECT, P9_REALDATA, P9_GROUND]) {
    assert.ok(src.includes(needle), `meritocracy-judge missing P9 anchor: ${needle}`)
  }
})

// ===========================================================================
// AC3: chunk-reviewer (+ -heavy) installs P1 + P9 + flag-with-repro + CLEAN-default,
//      and DROPS the self-as-quality-gate + fixer-REJECT re-review framing.
// ===========================================================================

for (const rel of [REVIEWER, REVIEWER_HEAVY]) {
  test(`AC3 (${rel}): installs the P1 finding-template verbatim`, () => {
    const src = read(rel)
    for (const needle of [P1_TEMPLATE_LINE, P1_REPRO, P1_EXPECTED, P1_ACTUAL]) {
      assert.ok(src.includes(needle), `${rel} missing P1 template line: ${needle}`)
    }
    assert.ok(src.includes(P1_SUSPICION), `${rel} missing the P1 suspicion/NOTES/CLEAN sentence verbatim`)
  })

  test(`AC3 (${rel}): installs the P9 real-context grounding verbatim`, () => {
    const src = read(rel)
    for (const needle of [P9_NODIFF, P9_PROJECT, P9_REALDATA, P9_GROUND]) {
      assert.ok(src.includes(needle), `${rel} missing P9 anchor: ${needle}`)
    }
  })

  test(`AC3 (${rel}): DROPS the self-as-quality-gate framing (the judge is the gate now)`, () => {
    const src = read(rel)
    assert.ok(
      !/you are the quality gate/i.test(src),
      `${rel} must drop the "you are the quality gate" self-as-gate framing (the judge is the gate now)`,
    )
  })

  test(`AC3 (${rel}): DROPS the fixer-REJECT re-review-arbitration section`, () => {
    const src = read(rel)
    // The old "Re-review rounds (fixer REJECTs)" section + the deadlock-escalation.
    assert.ok(
      !/Re-review rounds \(fixer REJECTs\)/i.test(src),
      `${rel} must drop the "Re-review rounds (fixer REJECTs)" section (the judge re-checks now, the reviewer does not re-adjudicate)`,
    )
    assert.ok(
      !/REJECT rationale/i.test(src),
      `${rel} must drop the fixer-REJECT-rationale re-review framing`,
    )
  })

  test(`AC3 (${rel}): names the judge as the truth-owner the reviewer flags TO`, () => {
    const src = read(rel)
    assert.match(src, /judge/i, `${rel} must name the meritocracy-judge (the reviewer flags, the judge decides)`)
  })

  test(`Edge (${rel}): no review dimension is dropped (all four named)`, () => {
    const src = read(rel)
    for (const dim of ['spec-drift', 'AI-slop', 'bug/security', 'test-correctness']) {
      assert.ok(src.includes(dim), `${rel} dropped review dimension: ${dim}`)
    }
  })
}

test('Edge: the heavy reviewer keeps its domain-paranoia / assume-a-hole section', () => {
  const src = read(REVIEWER_HEAVY)
  assert.match(
    src,
    /domain paranoia/i,
    'chunk-reviewer-heavy must keep its Tier A/S domain-paranoia section',
  )
})

// ===========================================================================
// AC4: fixer (+ -heavy) installs the P4 duty + drops REJECT-arbitration.
// ===========================================================================

for (const rel of [FIXER, FIXER_HEAVY]) {
  test(`AC4 (${rel}): installs the P4 fix-confirmed-only duty verbatim`, () => {
    const src = read(rel)
    for (const needle of [P4_CONFIRMED, P4_NOADJUDICATE, P4_UNREPRO, P4_BACK]) {
      assert.ok(src.includes(needle), `${rel} missing P4 anchor: ${needle}`)
    }
  })

  test(`AC4 (${rel}): DROPS the REJECT-adjudication disposition (judge owns truth, fixer does not arbitrate)`, () => {
    const src = read(rel)
    // The old union was "fixed" | "REJECT" | "stuck" | "log-only" with a REJECT
    // disposition #3 ("False positive: REJECT"). P4 drops arbitration; the union now
    // matches the chunk-2 pipeline FIXER_RESULT: fixed | unreproducible | stuck | log-only.
    assert.ok(
      !/"REJECT"/.test(src),
      `${rel} must drop the "REJECT" disposition string (the fixer does not arbitrate; the judge owns truth)`,
    )
    assert.ok(
      !/False positive: REJECT/i.test(src),
      `${rel} must drop the "False positive: REJECT" routing branch`,
    )
    // The new union is present and includes unreproducible (route-back-to-judge).
    assert.match(
      src,
      /"fixed" \| "unreproducible" \| "stuck" \| "log-only"/,
      `${rel} must carry the new disposition union "fixed" | "unreproducible" | "stuck" | "log-only" (REJECT replaced by unreproducible)`,
    )
  })
}

// ===========================================================================
// AC5: 0 em-dashes + each walk-anchor appears exactly once per file.
// ===========================================================================

for (const rel of [CONTRACT, JUDGE, REVIEWER, REVIEWER_HEAVY, FIXER, FIXER_HEAVY]) {
  test(`AC5 (${rel}): contains 0 em-dashes`, () => {
    const src = read(rel)
    assert.equal(countOf(src, EM_DASH), 0, `${rel} must contain 0 em-dashes (found ${countOf(src, EM_DASH)})`)
  })
}

test('AC5: the P1 suspicion sentence appears exactly once in review-contract (no double-install)', () => {
  assert.equal(countOf(read(CONTRACT), P1_SUSPICION), 1, 'P1 suspicion sentence must appear exactly once in review-contract')
})

test('AC5: the P2 header appears exactly once in meritocracy-judge (no double-install)', () => {
  assert.equal(countOf(read(JUDGE), P2_HEADER), 1, 'P2 header must appear exactly once in meritocracy-judge')
})

test('AC5: the P4 confirmed-only opener appears exactly once per fixer file', () => {
  assert.equal(countOf(read(FIXER), P4_CONFIRMED), 1, 'P4 opener must appear exactly once in fixer.md')
  assert.equal(countOf(read(FIXER_HEAVY), P4_CONFIRMED), 1, 'P4 opener must appear exactly once in fixer-heavy.md')
})

// ===========================================================================
// Edge: the contract points at calibration by reference (not re-inlined 3x).
// ===========================================================================

test('Edge: review-contract still says cite-it-do-not-restate (calibration not re-inlined in the reviewer prompts)', () => {
  const src = read(CONTRACT)
  assert.match(
    src,
    /do not restate/i,
    'review-contract must keep the one-fact-one-place "do not restate" rule so the reviewer prompts point by reference',
  )
})
