// RED test for pipeline-meritocracy chunk 5: the concrete spec phase --
// install the literal P7 (heavy-trigger + tier-fit + outcome-escalation),
// P8 (contract-completeness), and P10 (agent-contract) walks VERBATIM into
// the three spec-flow skills, and ship a standalone acceptance script.
//
// Pins the FULL acceptance contract (specs/current.md chunk 5):
//   AC1 spec-collaboration Tier section installs the P7 heavy-trigger walk verbatim
//       (binary heavy-or-default yes/no, NOT 4-tier dual-axis prose)
//   AC2 chunk-kickoff confirms the two P7 answers (blast-radius + complexity)
//   AC3 spec-collaboration pre-lock self-check includes the P7 TIER-FIT CHECK
//       + the P8 contract-completeness check + the P10 agent-contract check
//   AC4 reset-or-decompose installs the P7 OUTCOME ESCALATION (default reset -> heavy retry)
//   AC5 the c5 acceptance script exists, is executable, greps P7+P8+P10, and PASSES
//   AC6 0 em-dashes in the three touched skill files + the acceptance script;
//       each P7/P8/P10 walk-anchor appears exactly once per file (no double-install)
//   Edge: a chunk answering yes to NEITHER axis is DEFAULT (the walk says so explicitly)
//   Edge: the fit-check FLAGS under-tiering but never silently re-tiers (surfaces a flag)
//
// Test strategy: source-inspection idiom (same as c3-simplicity-principle.test.mjs
// and c8-reviewer-split-rename.test.mjs). The skill docs are plain text; we read and
// assert required VERBATIM substrings drawn from specs/current.md ## Literal processes
// (P7/P8/P10), fixed from the spec BEFORE the install prose is written (no tautology --
// the expected strings are the spec's own walk text, not keywords copied from the doc).
// AC5 actually RUNS the acceptance script via execFileSync and asserts exit 0.
//
// Run:        node --test workflows/pipeline-meritocracy-c5.test.mjs
// Full suite (GLOB form -- bare `node --test workflows/` errors MODULE_NOT_FOUND on Node v25):
//   node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const abs = (rel) => join(root, rel)

const SPEC_COLLAB = 'skills/spec-collaboration/SKILL.md'
const CHUNK_KICKOFF = 'skills/chunk-kickoff/SKILL.md'
const RESET_DECOMPOSE = 'skills/reset-or-decompose/SKILL.md'
const ACCEPT_SCRIPT = 'specs/scripts/pipeline-meritocracy-c5-acceptance.sh'

// The em-dash character the kernel style rule forbids (U+2014). Built from bytes so
// THIS test file's own source never carries the literal char it sweeps for.
const EM_DASH = Buffer.from([0xe2, 0x80, 0x94]).toString('utf8')

// VERBATIM P7 walk anchors (from specs/current.md ## Literal processes, P7).
// Each is a distinctive multi-word phrase that only the verbatim walk would contain.
const P7_TRIGGER_HEADER = 'A chunk is HEAVY iff EITHER answer is yes (write both answers on the tier line):'
const P7_BLAST = 'Blast-radius: does a failure corrupt state with no clean rollback, or touch'
const P7_COMPLEXITY = 'Complexity: does it introduce a new concurrency seam, a new architecture / abstraction,'
const P7_NEITHER = 'If NEITHER is yes -> DEFAULT. The two answers, not a vibe, set the tier.'
const P7_FITCHECK = 'TIER-FIT CHECK (pre-lock): an independent read confirms each chunk\'s declared tier matches its'
const P7_FITCHECK_FLAG = 'requirements describe a new concurrency seam, is flagged UNDER-TIERED -- re-tier before lock.'
const P7_ESCALATION = 'OUTCOME ESCALATION: a DEFAULT chunk that hits reset-or-decompose (2 failed attempts) or 2 judge'
const P7_ESCALATION_2 = 'fix-rounds was mis-tiered -- it escalates to HEAVY on the retry.'

// VERBATIM P8 walk anchors (P8).
const P8_HEADER = 'For each chunk, the requirements must pin EXACT completeness, not a loose pass-through. Flag before lock:'
const P8_PASSTHROUGH = 'any "pass through / handle / the cols / the data" with no exact set or "FULL/ALL" qualifier;'
const P8_FAILLOUD = 'any transform with no stated FAIL-LOUD condition for the empty / null / missing / zero-row case.'

// VERBATIM P10 walk anchors (P10).
const P10_HEADER = 'For any chunk that CREATES or MODIFIES an agent, the chunk must specify that agent\'s LITERAL contract'
const P10_PROMPT = 'the exact prompt walk it runs (a step list, like P2/P4 here -- not "it adjudicates findings");'
const P10_RECEIVES = 'exactly what it RECEIVES (every input field by name);'
const P10_EMITS = 'exactly what it EMITS (the output shape by field).'

// Count non-overlapping occurrences of needle in haystack.
const countOf = (hay, needle) => hay.split(needle).length - 1

// === AC1: spec-collaboration Tier section installs the P7 heavy-trigger walk verbatim ===

test('AC1: spec-collaboration installs the P7 heavy-trigger header verbatim', () => {
  const src = read(SPEC_COLLAB)
  assert.ok(src.includes(P7_TRIGGER_HEADER), 'P7 trigger header missing from spec-collaboration')
})
test('AC1: spec-collaboration installs the P7 blast-radius axis verbatim', () => {
  assert.ok(read(SPEC_COLLAB).includes(P7_BLAST), 'P7 blast-radius axis missing')
})
test('AC1: spec-collaboration installs the P7 complexity axis verbatim', () => {
  assert.ok(read(SPEC_COLLAB).includes(P7_COMPLEXITY), 'P7 complexity axis missing')
})
test('AC1 (edge: neither-axis=DEFAULT): the binary NEITHER->DEFAULT line is installed', () => {
  assert.ok(read(SPEC_COLLAB).includes(P7_NEITHER), 'P7 neither->default line missing')
})
test('AC1: the OLD 4-tier dual-axis prose is GONE from spec-collaboration Tier section', () => {
  const src = read(SPEC_COLLAB)
  // The replaced 4-tier prose carried the "old A and the break-glass S" / "old B and C"
  // absorption sentences. The binary P7 walk does not. Their presence means the
  // 4-tier prose was appended-next-to rather than replaced.
  assert.ok(!src.includes('absorbs the old A and the break-glass S'),
    'stale 4-tier prose ("absorbs the old A and the break-glass S") still present -- P7 must REPLACE it')
  assert.ok(!src.includes('This absorbs the old B and C'),
    'stale 4-tier prose ("absorbs the old B and C") still present -- P7 must REPLACE it')
})

// === AC2: chunk-kickoff confirms the two P7 answers ===

test('AC2: chunk-kickoff installs the P7 heavy-trigger header verbatim', () => {
  assert.ok(read(CHUNK_KICKOFF).includes(P7_TRIGGER_HEADER), 'P7 trigger header missing from chunk-kickoff')
})
test('AC2: chunk-kickoff carries both P7 axes (blast-radius + complexity)', () => {
  const src = read(CHUNK_KICKOFF)
  assert.ok(src.includes(P7_BLAST), 'P7 blast-radius axis missing from chunk-kickoff')
  assert.ok(src.includes(P7_COMPLEXITY), 'P7 complexity axis missing from chunk-kickoff')
})

// === AC3: pre-lock self-check includes P7 tier-fit + P8 completeness + P10 agent-contract ===

test('AC3 (P7 fit-check): pre-lock self-check installs the TIER-FIT CHECK verbatim', () => {
  const src = read(SPEC_COLLAB)
  assert.ok(src.includes(P7_FITCHECK), 'P7 TIER-FIT CHECK header missing')
})
test('AC3 (edge: flags, never silently re-tiers): the UNDER-TIERED re-tier-before-lock flag is installed', () => {
  assert.ok(read(SPEC_COLLAB).includes(P7_FITCHECK_FLAG),
    'P7 fit-check UNDER-TIERED flag line missing -- the check must SURFACE a flag, not auto-re-tier')
})
test('AC3 (P8): pre-lock self-check installs the contract-completeness check verbatim', () => {
  const src = read(SPEC_COLLAB)
  assert.ok(src.includes(P8_HEADER), 'P8 completeness header missing')
  assert.ok(src.includes(P8_PASSTHROUGH), 'P8 loose-passthrough flag line missing')
  assert.ok(src.includes(P8_FAILLOUD), 'P8 fail-loud-condition flag line missing')
})
test('AC3 (P10): pre-lock self-check + decomposition install the agent-contract step verbatim', () => {
  const src = read(SPEC_COLLAB)
  assert.ok(src.includes(P10_HEADER), 'P10 agent-contract header missing')
  assert.ok(src.includes(P10_PROMPT), 'P10 prompt-walk line missing')
  assert.ok(src.includes(P10_RECEIVES), 'P10 RECEIVES line missing')
  assert.ok(src.includes(P10_EMITS), 'P10 EMITS line missing')
})

// === AC4: reset-or-decompose installs the P7 outcome escalation ===

test('AC4: reset-or-decompose installs the P7 OUTCOME ESCALATION verbatim', () => {
  const src = read(RESET_DECOMPOSE)
  assert.ok(src.includes(P7_ESCALATION), 'P7 OUTCOME ESCALATION header missing from reset-or-decompose')
  assert.ok(src.includes(P7_ESCALATION_2), 'P7 escalation "escalates to HEAVY on the retry" line missing')
})

// === AC5: the c5 acceptance script exists, is executable, greps P7+P8+P10, and PASSES ===

test('AC5: the c5 acceptance script exists and is executable', () => {
  assert.ok(existsSync(abs(ACCEPT_SCRIPT)), `${ACCEPT_SCRIPT} does not exist`)
  const mode = statSync(abs(ACCEPT_SCRIPT)).mode
  assert.ok((mode & 0o111) !== 0, 'acceptance script is not executable (chmod +x)')
})
test('AC5: the c5 acceptance script RUNS and exits 0 (all P7+P8+P10 greps pass)', () => {
  // execFileSync throws on non-zero exit; a clean run returns stdout.
  const out = execFileSync('bash', [abs(ACCEPT_SCRIPT)], { encoding: 'utf8' })
  assert.ok(/PASS/.test(out), 'acceptance script produced no PASS lines')
  assert.ok(!/FAIL/.test(out), `acceptance script reported a FAIL:\n${out}`)
})

// === AC6: 0 em-dashes + each walk-anchor appears exactly once per file ===

for (const f of [SPEC_COLLAB, CHUNK_KICKOFF, RESET_DECOMPOSE, ACCEPT_SCRIPT]) {
  test(`AC6 (0 em-dashes): ${f} carries no em-dash`, () => {
    assert.ok(!read(f).includes(EM_DASH), `${f} contains an em-dash (kernel style rule)`)
  })
}

test('AC6 (appears once): the P7 trigger header appears exactly once in spec-collaboration', () => {
  assert.equal(countOf(read(SPEC_COLLAB), P7_TRIGGER_HEADER), 1,
    'P7 trigger header must appear exactly once in spec-collaboration (double-install)')
})
test('AC6 (appears once): the P7 trigger header appears exactly once in chunk-kickoff', () => {
  assert.equal(countOf(read(CHUNK_KICKOFF), P7_TRIGGER_HEADER), 1,
    'P7 trigger header must appear exactly once in chunk-kickoff')
})
test('AC6 (appears once): the P7 fit-check, P8, P10 each appear exactly once in spec-collaboration', () => {
  const src = read(SPEC_COLLAB)
  assert.equal(countOf(src, P7_FITCHECK), 1, 'P7 fit-check header must appear exactly once')
  assert.equal(countOf(src, P8_HEADER), 1, 'P8 header must appear exactly once')
  assert.equal(countOf(src, P10_HEADER), 1, 'P10 header must appear exactly once')
})
test('AC6 (appears once): the P7 outcome escalation appears exactly once in reset-or-decompose', () => {
  assert.equal(countOf(read(RESET_DECOMPOSE), P7_ESCALATION), 1,
    'P7 outcome escalation must appear exactly once in reset-or-decompose')
})
