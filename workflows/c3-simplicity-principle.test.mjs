// RED test for chunk 3 (system-hardening-v2): "radical simplicity as a standing principle"
//
// Spec (specs/current.md chunk 3):
//   Create rules/simplicity.md holding the validated definition (simple = one role
//   per part, one fact per place, one reason to change; un-braided not small;
//   interface smaller than implementation; everything traces to a named failure
//   mode) + the 7-step generative procedure. Add a one-line Pointers entry in
//   CLAUDE.md naming rules/simplicity.md as auto-inherited. Add one criterion line
//   to the review-contract SLOP dimension pointing the slop lens at the simplicity
//   definition.
//
// This test pins the FULL acceptance contract across all three criteria:
//
//   AC1: rules/simplicity.md exists, holds the validated definition + all 7
//        procedure steps, has 0 em-dashes (kernel rule), and stays short
//        (under ~40 lines -- a long simplicity doc is self-refuting).
//   AC2: CLAUDE.md Pointers section names rules/simplicity.md as auto-inherited.
//   AC3: disciplines/review-contract.md SLOP dimension (#2, AI-slop) references
//        simplicity -- the slop lens is pointed at the simplicity definition.
//
// Test strategy: source-inspection idiom (same approach as c6-builder-logging.test.mjs
// and subagent-self-sufficiency.test.mjs). All three docs are plain text, read and
// asserted for required content. Each expected concept is a SEMANTIC marker fixed
// from the acceptance criteria ABOVE, before any implementation prose is written --
// not a keyword copied from the doc-to-be (no tautology).
//
// Run:        node --test workflows/c3-simplicity-principle.test.mjs
// Full suite: node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const path = (rel) => join(root, rel)

const SIMPLICITY = 'rules/simplicity.md'
const KERNEL     = 'CLAUDE.md'
const CONTRACT   = 'disciplines/review-contract.md'

const EM_DASH = '—' // the em-dash character the kernel rule forbids

// === AC1: rules/simplicity.md exists ===

test('AC1(exists): rules/simplicity.md is present', () => {
  assert.ok(
    existsSync(path(SIMPLICITY)),
    `${SIMPLICITY} does not exist. AC1 requires the validated simplicity ` +
      `definition + 7-step procedure to live in this new rules doc.`,
  )
})

// === AC1: the validated definition is present ===

test('AC1(definition): rules/simplicity.md states the validated simplicity definition', () => {
  const body = read(SIMPLICITY)

  // simple = one role per part
  assert.match(
    body, /one\s+role\s+per\s+part/i,
    `${SIMPLICITY} must state "one role per part" (a thing does one job).`,
  )
  // one fact per place
  assert.match(
    body, /one\s+fact\s+per\s+place/i,
    `${SIMPLICITY} must state "one fact per place" (no restating a fact in two files).`,
  )
  // one reason to change
  assert.match(
    body, /one\s+reason\s+to\s+change/i,
    `${SIMPLICITY} must state "one reason to change" (a part changes for one reason).`,
  )
  // un-braided (Hickey), explicitly NOT "small"
  assert.match(
    body, /un-?braided/i,
    `${SIMPLICITY} must frame simple as un-braided (disentangled), the Hickey sense.`,
  )
  assert.match(
    body, /\bnot\s+small\b/i,
    `${SIMPLICITY} must say simple is NOT the same as small -- un-braided, not minimal.`,
  )
  // interface smaller than implementation (Ousterhout deep modules)
  assert.match(
    body, /interface\s+smaller\s+than\s+(its\s+)?implementation/i,
    `${SIMPLICITY} must state "interface smaller than implementation" (deep modules).`,
  )
  // everything traces to a named failure mode
  assert.match(
    body, /trace[sd]?\b[\s\S]{0,40}?failure\s+mode/i,
    `${SIMPLICITY} must require every element to trace to a named failure mode.`,
  )
})

// === AC1: all 7 generative procedure steps are present ===

test('AC1(procedure): rules/simplicity.md holds all 7 generative procedure steps', () => {
  const body = read(SIMPLICITY)

  // Step 1: question the requirement (Musk -- delete it first)
  assert.match(
    body, /question[\s\S]{0,30}?requirement/i,
    'procedure step 1 missing: question the requirement.',
  )
  // Step 2: one sentence, no "and"
  assert.match(
    body, /one[\s-]sentence[\s\S]{0,40}?\bno\b[\s\S]{0,12}?["'‘“]?and/i,
    `procedure step 2 missing: state the part in one sentence with no "and".`,
  )
  // Step 3: count concepts, not lines
  assert.match(
    body, /count[\s\S]{0,20}?concepts[\s\S]{0,20}?not[\s\S]{0,12}?lines/i,
    'procedure step 3 missing: count concepts, not lines.',
  )
  // Step 4: map dependencies / obscurity
  assert.match(
    body, /map[\s\S]{0,30}?(dependenc|obscurit)/i,
    'procedure step 4 missing: map dependencies / obscurity.',
  )
  // Step 5: trace each non-obvious element to a failure mode
  assert.match(
    body, /(non-?obvious|each\s+element)[\s\S]{0,40}?failure\s+mode/i,
    'procedure step 5 missing: trace each non-obvious element to a failure mode.',
  )
  // Step 6: check the seams
  assert.match(
    body, /\bseams?\b/i,
    'procedure step 6 missing: check the seams.',
  )
  // Step 7: grow from the last working version
  assert.match(
    body, /grow[\s\S]{0,30}?(last[\s-]working|working)/i,
    'procedure step 7 missing: grow from the last working version.',
  )

  // The 7 steps must be enumerated as 7 distinct ordered items (1..7).
  const stepMarkers = body.match(/^\s*(\d+)[.)]\s/gm) || []
  const numbers = stepMarkers.map((m) => parseInt(m, 10))
  for (let n = 1; n <= 7; n++) {
    assert.ok(
      numbers.includes(n),
      `procedure must be enumerated 1..7 as ordered list items; step ${n} not found ` +
        `(saw markers: ${numbers.join(',') || 'none'}).`,
    )
  }
})

// === AC1 (edge case): 0 em-dashes -- kernel rule ===

test('AC1(no-em-dash): rules/simplicity.md contains zero em-dash characters', () => {
  const body = read(SIMPLICITY)
  const count = (body.match(new RegExp(EM_DASH, 'g')) || []).length
  assert.equal(
    count, 0,
    `${SIMPLICITY} contains ${count} em-dash (U+2014) character(s); the kernel ` +
      `rule forbids em-dashes. Use " -- " or restructure.`,
  )
})

// === AC1 (edge case): the doc stays short (a long simplicity doc is self-refuting) ===

test('AC1(short): rules/simplicity.md stays short (under ~40 lines of content)', () => {
  const body = read(SIMPLICITY)
  const nonEmpty = body.split('\n').filter((l) => l.trim().length > 0).length
  assert.ok(
    nonEmpty <= 40,
    `${SIMPLICITY} has ${nonEmpty} non-empty lines; edge case caps it at ~40 ` +
      `(a long simplicity doc is self-refuting).`,
  )
})

// === AC2: CLAUDE.md Pointers section names rules/simplicity.md as auto-inherited ===

test('AC2(pointer): CLAUDE.md Pointers section names rules/simplicity.md as auto-inherited', () => {
  const body = read(KERNEL)

  // Isolate the "## Pointers" section so the assertion is scoped, not file-wide.
  const lines = body.split('\n')
  const start = lines.findIndex((l) => /^##\s+Pointers\b/.test(l))
  assert.ok(start !== -1, 'CLAUDE.md has no "## Pointers" section.')
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end === -1) end = lines.length
  const pointers = lines.slice(start, end).join('\n')

  assert.match(
    pointers, /rules\/simplicity\.md/,
    'CLAUDE.md Pointers section does not name rules/simplicity.md.',
  )
  // The entry must mark it auto-inherited (the chunk's mechanism: reaches producing
  // agents via rules/ placement, not per-prompt copying).
  const entryLine = pointers
    .split('\n')
    .find((l) => /rules\/simplicity\.md/.test(l)) || ''
  assert.match(
    entryLine, /auto-?inherit/i,
    `the rules/simplicity.md Pointers entry must mark it auto-inherited; got: "${entryLine.trim()}"`,
  )
})

// === AC3: review-contract SLOP dimension references simplicity ===

test('AC3(slop-lens): review-contract.md SLOP/AI-slop dimension references simplicity', () => {
  const body = read(CONTRACT)
  const lines = body.split('\n')

  // The AI-slop dimension is the numbered "2. **AI-slop**" item; scope the
  // assertion to that dimension (criterion 3 says the SLOP dimension references it,
  // not merely the file somewhere).
  const start = lines.findIndex((l) => /^\s*2\.\s+\*\*AI-?slop\*\*/i.test(l))
  assert.ok(
    start !== -1,
    'review-contract.md has no "2. **AI-slop**" dimension to point at simplicity.',
  )
  // The dimension runs until the next top-level numbered dimension (3.) or EOF.
  let end = lines.findIndex((l, i) => i > start && /^\s*3\.\s+\*\*/.test(l))
  if (end === -1) end = lines.length
  const slopDim = lines.slice(start, end).join('\n')

  assert.match(
    slopDim, /simplicity/i,
    'review-contract.md SLOP (AI-slop) dimension does not reference simplicity; ' +
      'AC3 requires a criterion line pointing the slop lens at the simplicity definition.',
  )
  // Must point at the actual rules doc, so the lens has a concrete referent.
  assert.match(
    slopDim, /rules\/simplicity\.md/,
    'review-contract.md SLOP dimension references "simplicity" but not the ' +
      'rules/simplicity.md doc; the slop lens must name the definition it enforces.',
  )
})
