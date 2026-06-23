// RED test for pipeline-meritocracy chunk 7: fix the 5 ship-gate findings the
// Stage-2 ship review surfaced against the as-built feat branch.
//
// THE LIVE DEFECT THIS PINS (Codex P1, finding a): the judge decision core's clean
// branch is `if (verdict === 'CLEAN' || fixList.length === 0) return {action:'clean'}`.
// The `||` short-circuits on an empty fixList REGARDLESS of the verdict, so an
// INCONSISTENT judge result `{verdict:'FIX', fixList:[]}` resolves to CLEAN -- a
// silent-CLEAN fail-OPEN on the merge gate, the exact failure this spec exists to
// kill. The mirror inconsistency `{verdict:'CLEAN', fixList:[finding]}` (a CLEAN
// verdict carrying a non-empty fixList) currently passes the gap guard (verdict is
// CLEAN) and then returns clean via the `verdict === 'CLEAN'` arm, dropping the
// findings silently -- also a fail-open. Both inconsistent pairs must route to
// action:'gap' (fail-closed), never clean.
//
// Pins the FULL acceptance contract (dispatch payload chunk 7):
//   (a) [Codex P1 BUG] judgeDecision fails CLOSED on an inconsistent verdict/fixList:
//       {verdict:'FIX',fixList:[]} -> gap AND {verdict:'CLEAN',fixList:[finding]} -> gap.
//       Consistent {CLEAN,[]} -> clean and {FIX,[finding]} -> fix STAY unchanged (do
//       not over-correct). lib (meritocracy-judge.mjs) <-> inline (worker-pipeline.js)
//       judgeDecision stay byte-identical (the existing lockstep test still passes).
//   (b) [low] the inline agentUnavailableBundle in worker-pipeline.js is byte-identical
//       (minus the `export` keyword) to the agenttype-precheck.mjs lib -- including the
//       `// buildOutcome PRESERVED verbatim ...` comment currently missing inline.
//   (c) [medium x2] coo-sop.md §5 names the as-built meritocracy-judge net and carries
//       NO residue of the deleted pre-judge net (REJECT-adjudication, cumulative
//       re-review, cost-gated A/S/B Codex lens).
//   (d) [medium] review-contract.md §3.1 + the §3 [FIX:] bullet scale ONLY the fixer
//       model/effort -- the deleted 're-review effort' + 'Codex re-fire' clauses are gone.
//   0 em-dashes across every touched file; node --test green; anti-tautology.
//
// Test strategy (mirrors the c2/c6 proof-pattern): the judge DECISION CORE is a PURE,
// import-safe lib (workflows/meritocracy-judge.mjs) -- imported and unit-tested
// directly. worker-pipeline.js runs at top level on import (top-level await + Workflow
// host globals), so its inline lockstep copy is asserted at SOURCE level via the same
// fnBlock byte-match the c2 test uses. The doc surfaces are asserted at SOURCE level,
// section-scoped so a residue in §5 fails while the legitimate tier-dial prose in §6
// (re-review/Codex re-fire, a non-goal to change) is left untouched.
//
// Run:        node --test workflows/pipeline-meritocracy-c7.test.mjs
// Full suite (GLOB form -- bare `node --test workflows/` errors MODULE_NOT_FOUND on Node v25):
//   node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { judgeDecision } from './meritocracy-judge.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const PIPE = 'workflows/worker-pipeline.js'
const PIPE_SRC = read(PIPE)

// A contract-format reviewer finding line carrying a P-level + a repro.
const finding = (p, title = 'x') => `- [BUG][P${p}] ${title} -- a.js:1 -- worker -- why`

// The em-dash character the kernel style rule forbids (U+2014). Built from bytes so
// THIS test file's own source never carries the literal char it sweeps for.
const EM_DASH = Buffer.from([0xe2, 0x80, 0x94]).toString('utf8')

// Extract a ## <n>. ... section body by flag-toggle (NOT awk-range / regex-range,
// which self-terminates when the start pattern can match the end pattern). Returns the
// lines from the `## <num>.` header (inclusive) up to but excluding the next `## ` header.
function sectionBody(src, num) {
  const lines = src.split('\n')
  const startRe = new RegExp(`^##\\s+${num}\\.\\s`)
  const nextRe = /^##\s/
  let inSection = false
  const out = []
  for (const line of lines) {
    if (!inSection) {
      if (startRe.test(line)) { inSection = true; out.push(line) }
      continue
    }
    if (nextRe.test(line)) break
    out.push(line)
  }
  assert.notEqual(out.length, 0, `could not find section ## ${num}. in source`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// (a) [Codex P1 BUG] judgeDecision fails CLOSED on an inconsistent verdict/fixList pair
// ---------------------------------------------------------------------------

test('(a) BUG: {verdict:FIX, fixList:[]} (FIX with no findings) -> gap, NEVER silent clean', () => {
  // The exact fail-OPEN: a FIX verdict with an EMPTY fixList is inconsistent. The old
  // `|| fixList.length === 0` clean branch returned clean on it -- a silent CLEAN on
  // the merge gate. It must fail CLOSED to a verification gap.
  const d = judgeDecision({ verdict: 'FIX', fixList: [] }, 0)
  assert.notEqual(d.action, 'clean', 'a FIX verdict with an empty fixList must NEVER be a silent CLEAN (fail-OPEN)')
  assert.equal(d.action, 'gap', 'an inconsistent {FIX,[]} pair is a verification gap (fail-closed)')
})

test('(a) BUG: {verdict:CLEAN, fixList:[finding]} (CLEAN carrying findings) -> gap, NEVER silent clean', () => {
  // The mirror inconsistency: a CLEAN verdict that still carries a non-empty fixList.
  // The old `verdict === 'CLEAN'` clean arm dropped those findings silently. Fail closed.
  const d = judgeDecision({ verdict: 'CLEAN', fixList: [finding(1)] }, 0)
  assert.notEqual(d.action, 'clean', 'a CLEAN verdict carrying findings must NOT silently drop them as clean')
  assert.equal(d.action, 'gap', 'an inconsistent {CLEAN,[finding]} pair is a verification gap (fail-closed)')
})

test('(a) edge: a CONSISTENT clean {CLEAN, []} STILL returns clean (do not over-correct to gap)', () => {
  const d = judgeDecision({ verdict: 'CLEAN', fixList: [] }, 0)
  assert.equal(d.action, 'clean', 'a consistent CLEAN (CLEAN verdict + empty fixList) must still resolve clean')
})

test('(a) edge: a CONSISTENT fix {FIX, [finding]} STILL returns fix (unchanged)', () => {
  const d = judgeDecision({ verdict: 'FIX', fixList: [finding(1)] }, 0)
  assert.equal(d.action, 'fix', 'a consistent FIX (FIX verdict + non-empty fixList) must still fire the fixer')
})

test('(a) edge: the escalate-at-cap path is unchanged (FIX + cap -> escalate, carrying repros)', () => {
  const d = judgeDecision({ verdict: 'FIX', fixList: [finding(1, 'unresolved')] }, 2)
  assert.equal(d.action, 'escalate', 'a consistent FIX still open at the 2-pass cap must escalate, not gap')
  assert.ok(d.escalation && Array.isArray(d.escalation.openFindings) && d.escalation.openFindings.length > 0,
    'the escalation must still carry the open repros')
})

test('(a) edge: a missing/error verdict still gaps (fail-closed default preserved)', () => {
  assert.equal(judgeDecision(null, 0).action, 'gap', 'a null judge result still gaps')
  assert.equal(judgeDecision({ verdict: 'ERROR', fixList: [] }, 0).action, 'gap', 'an ERROR verdict still gaps')
})

// ---------------------------------------------------------------------------
// (a) lockstep: the inline judgeDecision stays byte-identical to the lib
// ---------------------------------------------------------------------------

function fnBlock(src, decl) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.includes(decl))
  assert.notEqual(start, -1, `could not find "${decl}" in source`)
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n')
  }
  throw new Error(`no closing brace found for ${decl}`)
}

test('(a) lockstep: worker-pipeline judgeDecision is byte-identical to the lib (minus export)', () => {
  const LIB_SRC = read('workflows/meritocracy-judge.mjs')
  const lib = fnBlock(LIB_SRC, 'function judgeDecision').replace(/^export\s+/, '')
  const inline = fnBlock(PIPE_SRC, 'function judgeDecision').replace(/^export\s+/, '')
  assert.equal(inline, lib, 'the inlined judgeDecision must stay byte-identical to meritocracy-judge.mjs (minus export)')
})

// ---------------------------------------------------------------------------
// (b) [low] the inline agentUnavailableBundle == the lib, byte-for-byte (minus export)
// ---------------------------------------------------------------------------

test('(b) lockstep: inline agentUnavailableBundle is byte-identical to the agenttype-precheck.mjs lib (minus export)', () => {
  const LIB_SRC = read('workflows/agenttype-precheck.mjs')
  const lib = fnBlock(LIB_SRC, 'function agentUnavailableBundle').replace(/^export\s+/, '')
  const inline = fnBlock(PIPE_SRC, 'function agentUnavailableBundle').replace(/^export\s+/, '')
  assert.equal(inline, lib,
    'the inlined agentUnavailableBundle must be byte-identical to the lib (minus export) -- incl the buildOutcome PRESERVED comment')
})

test('(b) the inline agentUnavailableBundle carries the buildOutcome PRESERVED comment', () => {
  const inline = fnBlock(PIPE_SRC, 'function agentUnavailableBundle')
  assert.match(inline, /\/\/ buildOutcome PRESERVED verbatim/,
    'the inline copy must carry the `// buildOutcome PRESERVED verbatim ...` comment the lib has')
})

// ---------------------------------------------------------------------------
// (c) [medium x2] coo-sop.md §5 names the as-built meritocracy-judge net; no deleted-net residue
// ---------------------------------------------------------------------------

const COO_SOP = 'coo/coo-sop.md'
const COO_SRC = read(COO_SOP)
const SEC5 = sectionBody(COO_SRC, 5)

test('(c) coo-sop §5 NAMES the meritocracy-judge net (judge owns truth, adjudicates by evidence)', () => {
  assert.match(SEC5, /meritocracy-judge/, '§5 must name the meritocracy-judge')
  assert.match(SEC5, /adjudicat/i, '§5 must describe the judge ADJUDICATING findings')
})

test('(c) coo-sop §5 names the as-built net pieces (2 reviewers -> judge -> fixer -> re-check, 2-pass cap)', () => {
  // The judge re-checks each fixer round (P5) and the fixer fixes judge-confirmed only.
  assert.match(SEC5, /re-?check/i, '§5 must describe the judge RE-CHECK after each fixer round')
  assert.match(SEC5, /confirmed/i, '§5 must describe the fixer fixing judge-CONFIRMED findings only')
})

test('(c) coo-sop §5 carries NO residue of the DELETED pre-judge net (REJECT, cumulative re-review, cost-gated A/S/B)', () => {
  // The deleted net: a Codex 'cost-gated A/S/B' lens, a fixer-REJECT-adjudication path,
  // a Sonnet 'cumulative re-review'. None may survive in §5. (§6's tier-dial prose and
  // §15's codex-review.sh cost-gate are out of scope -- this assertion is §5-scoped.)
  assert.ok(!/REJECT/.test(SEC5),
    'coo-sop §5 must NOT keep the fixer-REJECT-adjudication path (the judge owns truth; the fixer fixes confirmed-only, no REJECT)')
  assert.ok(!/cumulative re-review/i.test(SEC5),
    'coo-sop §5 must NOT keep the Sonnet cumulative re-review (the judge re-checks now)')
  assert.ok(!/cost-gated A\/S\/B/i.test(SEC5),
    'coo-sop §5 must NOT describe the Codex lens as cost-gated A/S/B (it fires on BOTH tiers now)')
})

// ---------------------------------------------------------------------------
// (d) [medium] review-contract §3.1 + the §3 [FIX:] bullet scale ONLY the fixer
// ---------------------------------------------------------------------------

const REVIEW_CONTRACT = 'disciplines/review-contract.md'
const RC_SRC = read(REVIEW_CONTRACT)

// §3.1 is a `### 3.1 Rate the fix` subsection (### header, no trailing dot); slice from
// its header up to the next `## ` or `### ` header by flag-toggle.
function subsection31(src) {
  const lines = src.split('\n')
  const startRe = /^###\s+3\.1\s/
  const nextRe = /^#{2,3}\s/
  let inSection = false
  const out = []
  for (const line of lines) {
    if (!inSection) {
      if (startRe.test(line)) { inSection = true; out.push(line) }
      continue
    }
    if (nextRe.test(line)) break
    out.push(line)
  }
  assert.notEqual(out.length, 0, 'could not find subsection ### 3.1 in source')
  return out.join('\n')
}
const RC_SEC31 = subsection31(RC_SRC)

// The §3 [FIX:] bullet lives in §3 (before §3.1). Slice §3 up to the §3.1 header.
function section3FixBullet(src) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => /^##\s+3\.\s/.test(l))
  assert.notEqual(start, -1, 'could not find ## 3. header')
  const end = lines.findIndex((l, i) => i > start && /^###\s+3\.1\s/.test(l))
  assert.notEqual(end, -1, 'could not find ### 3.1 header')
  return lines.slice(start, end).join('\n')
}
const RC_SEC3 = section3FixBullet(RC_SRC)

test('(d) review-contract §3 [FIX:] bullet + §3.1 scale ONLY the fixer model/effort (no re-review effort, no Codex re-fire)', () => {
  for (const [label, body] of [['§3 [FIX:] bullet', RC_SEC3], ['§3.1 Rate the fix', RC_SEC31]]) {
    // The deleted clauses: the [FIX:] tag no longer scales the re-review effort or the
    // Codex re-fire (the judge re-checks now; the re-fire dial was deleted in chunk 9).
    assert.ok(!/re-?review/i.test(body),
      `review-contract ${label} must NOT keep the 're-review' scaling clause (the judge re-checks; the [FIX:] tier scales the fixer only)`)
    assert.ok(!/Codex re-?fire/i.test(body),
      `review-contract ${label} must NOT keep the 'Codex re-fire' clause (the re-fire dial was deleted, not re-fired by the tag)`)
    // Positive: it still scales the FIXER.
    assert.match(body, /fixer/i, `review-contract ${label} must still name the FIXER the [FIX:] tier scales`)
  }
})

// ---------------------------------------------------------------------------
// 0 em-dashes across every touched file
// ---------------------------------------------------------------------------

test('0 em-dashes across all touched files', () => {
  for (const rel of [
    'workflows/meritocracy-judge.mjs',
    PIPE,
    COO_SOP,
    REVIEW_CONTRACT,
    'workflows/pipeline-meritocracy-c7.test.mjs',
  ]) {
    assert.ok(!read(rel).includes(EM_DASH), `${rel} must carry 0 em-dashes`)
  }
})
