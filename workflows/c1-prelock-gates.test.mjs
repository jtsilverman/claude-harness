// RED test for chunk 1 (build-loop-quality): "pre-lock gates -- endState-coverage
// + decomposition-cut + pre-mortem"
//
// Spec (specs/current.md chunk 1):
//   In skills/spec-collaboration/SKILL.md:
//   (a) add a pre-lock self-check item installing the ENDSTATE-COVERAGE CHECK verbatim block;
//   (b) add a pre-lock self-check item installing the DECOMPOSITION-CUT CHECK verbatim block
//       AND add its four cut flags to the §Pre-lock spec review 'What the reviewer looks for' bullets;
//   (c) add the Pre-mortem row to the grill-spine table in §Interrogation workflow.
//   Additive only; renumber the self-check 'all N must hold' count line accordingly.
//
// This test pins the FULL acceptance contract across all five criteria:
//
//   AC1: the ENDSTATE-COVERAGE CHECK verbatim block is present in the pre-lock
//        self-check section (skills/spec-collaboration/SKILL.md § Pre-lock self-check).
//   AC2: the DECOMPOSITION-CUT CHECK verbatim block is present in the self-check
//        AND its four cut flags (VACUOUS-UNTIL-LATER, HIDDEN COUPLING, WRONG DEP EDGE,
//        OVER-CUT) are referenced in the §Pre-lock spec review 'What the reviewer
//        looks for' bullet list.
//   AC3: the Pre-mortem row is present in the grill-spine table in §Interrogation
//        workflow, and it states the product-specs-only / skippable scope in the row.
//   AC4: the self-check 'all N must hold' count line matches the NEW item count
//        (9 existing + 2 new = 11). The count line must not still say "nine".
//   AC5 (worked example, mechanically encodable half): the two new self-check blocks
//        carry the operative text that makes the worked-example flag fire -- the
//        endState-coverage block names "UNCOVERED endState" for an uncovered clause,
//        and the cut block names "VACUOUS-UNTIL-LATER" for a chunk whose hook needs a
//        later chunk. (The full judgment-run worked example is reported as proof in
//        the chunk return; this test pins the text those judgments key on.)
//
// Test strategy: source-inspection idiom (same approach as c3-simplicity-principle.test.mjs
// and c6-builder-logging.test.mjs). The target is a plain-text skill doc; read and assert
// the required verbatim blocks and renumber. The expected strings are the canonical VERBATIM
// blocks fixed in specs/current.md § Interfaces BEFORE any edit to the skill -- not keywords
// copied from the doc-to-be (no tautology).
//
// Run:        node --test workflows/c1-prelock-gates.test.mjs
// Full suite: node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const SKILL = 'skills/spec-collaboration/SKILL.md'

// Normalize whitespace so a verbatim block matches regardless of how line wraps /
// indentation land inside the markdown (the block ships inside a fenced ``` region).
const squash = (s) => s.replace(/\s+/g, ' ').trim()

// --- Canonical VERBATIM blocks (from specs/current.md § Interfaces, fixed pre-edit) ---

const ENDSTATE_COVERAGE_BLOCK = `ENDSTATE-COVERAGE CHECK: the chunk's acceptanceCriteria must COLLECTIVELY cover every
behavioral clause of its endState. Walk the endState clause by clause; for each, name the
acceptanceCriterion that would FAIL if that clause were left unimplemented. A clause with no
such criterion is an UNCOVERED endState -- a half-landed chunk would pass its own gate. Add a
criterion (or cut the clause) before lock.`

const DECOMPOSITION_CUT_BLOCK = `DECOMPOSITION-CUT CHECK (pre-lock): review the cut BETWEEN chunks, not just each chunk. Flag:
  - VACUOUS-UNTIL-LATER: a chunk whose acceptance hook cannot pass until a later chunk lands.
  - HIDDEN COUPLING: two "file-disjoint" chunks sharing an implicit contract (a schema, a
    format, a constant) so they cannot truly build independently.
  - WRONG DEP EDGE: a dependsOn missing (a real ordering need unstated) or spurious (a stated
    edge with no real dependency, serializing parallelizable work).
  - OVER-CUT: N chunks where fewer cohere; a chunk that does not stand alone as a shippable unit.`

const PREMORTEM_ROW = `| **Pre-mortem** (product specs only) | Assume this ships exactly as specced -- what is the most likely way the result still disappoints? (advisory, never gates lock; skip for pure config / process / self-improvement specs) |`

const CUT_FLAGS = ['VACUOUS-UNTIL-LATER', 'HIDDEN COUPLING', 'WRONG DEP EDGE', 'OVER-CUT']

// --- Section slicing helpers ---

// Slice the body of a "## <Heading>" section: from the heading to the next "## " or EOF.
function section(body, headingRe) {
  const lines = body.split('\n')
  const start = lines.findIndex((l) => headingRe.test(l))
  if (start === -1) return null
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end === -1) end = lines.length
  return lines.slice(start, end).join('\n')
}

// === AC1: ENDSTATE-COVERAGE CHECK is installed in the pre-lock self-check section ===

test('AC1(endstate-coverage): the ENDSTATE-COVERAGE CHECK verbatim block is in the pre-lock self-check', () => {
  const sec = section(read(SKILL), /^##\s+Pre-lock self-check\b/)
  assert.ok(sec, `${SKILL} has no "## Pre-lock self-check" section.`)
  assert.ok(
    squash(sec).includes(squash(ENDSTATE_COVERAGE_BLOCK)),
    'the ENDSTATE-COVERAGE CHECK verbatim block is absent from the pre-lock ' +
      'self-check section. Install the canonical block from specs § Interfaces.',
  )
})

// === AC2a: DECOMPOSITION-CUT CHECK is installed in the pre-lock self-check section ===

test('AC2a(cut-check): the DECOMPOSITION-CUT CHECK verbatim block is in the pre-lock self-check', () => {
  const sec = section(read(SKILL), /^##\s+Pre-lock self-check\b/)
  assert.ok(sec, `${SKILL} has no "## Pre-lock self-check" section.`)
  assert.ok(
    squash(sec).includes(squash(DECOMPOSITION_CUT_BLOCK)),
    'the DECOMPOSITION-CUT CHECK verbatim block is absent from the pre-lock ' +
      'self-check section. Install the canonical block from specs § Interfaces.',
  )
})

// === AC2b: the four cut flags appear in the §Pre-lock spec review reviewer list ===

test('AC2b(reviewer-list): the four cut flags are in §Pre-lock spec review "What the reviewer looks for"', () => {
  const sec = section(read(SKILL), /^##\s+Pre-lock spec review\b/)
  assert.ok(sec, `${SKILL} has no "## Pre-lock spec review" section.`)

  // Scope to the "What the reviewer looks for" bullet list, not the whole section,
  // so the flags land in the reviewer's redline list specifically (per the requirement).
  const idx = sec.indexOf('What the reviewer looks for')
  assert.ok(
    idx !== -1,
    '§Pre-lock spec review has no "What the reviewer looks for" list to extend.',
  )
  const lookFor = sec.slice(idx)

  for (const flag of CUT_FLAGS) {
    assert.ok(
      lookFor.includes(flag),
      `the cut flag "${flag}" is not referenced in the §Pre-lock spec review ` +
        `"What the reviewer looks for" list. All four cut flags must appear there.`,
    )
  }
})

// === AC3: the Pre-mortem row is in the grill-spine table (§Interrogation workflow) ===

test('AC3(premortem-row): the Pre-mortem row is in the grill-spine table', () => {
  const sec = section(read(SKILL), /^##\s+Interrogation workflow\b/)
  assert.ok(sec, `${SKILL} has no "## Interrogation workflow" section.`)
  assert.ok(
    squash(sec).includes(squash(PREMORTEM_ROW)),
    'the Pre-mortem grill row is absent from the grill-spine table in ' +
      '§Interrogation workflow. Install the canonical row from specs § Interfaces.',
  )
  // Edge case: the row itself must state it is skippable for non-product specs.
  assert.match(
    sec, /Pre-mortem[\s\S]{0,260}?skip[\s\S]{0,80}?(process|self-improvement)/i,
    'the Pre-mortem row must state, in the row itself, that it is skippable for ' +
      'process / self-improvement specs (edge case: non-product spec).',
  )
})

// === AC4: the self-check count line matches the new item count (11, not "nine") ===

test('AC4(count-line): the self-check "all N must hold" count line is renumbered to the new item count', () => {
  const sec = section(read(SKILL), /^##\s+Pre-lock self-check\b/)
  assert.ok(sec, `${SKILL} has no "## Pre-lock self-check" section.`)

  // The count line is the "... must hold:" sentence introducing the numbered list.
  const countLine = sec.split('\n').find((l) => /must hold:/.test(l)) || ''
  assert.ok(countLine, 'the pre-lock self-check has no "... must hold:" count line.')

  // It must NOT still say "nine" (the pre-edit count).
  assert.ok(
    !/\bnine\b/i.test(countLine),
    `the count line still says "nine"; two items were added, so it must be ` +
      `renumbered. Got: "${countLine.trim()}"`,
  )

  // It must name the NEW count: 9 existing + 2 new = 11 (as a word or a digit).
  assert.match(
    countLine, /\b(eleven|11)\b/i,
    `the count line must name the new item count (11 = 9 existing + 2 new). ` +
      `Got: "${countLine.trim()}"`,
  )

  // Cross-check: the numbered list actually enumerates 1..11 as ordered items.
  const numbers = (sec.match(/^\s*(\d+)\.\s+\*\*/gm) || []).map((m) => parseInt(m, 10))
  for (let n = 1; n <= 11; n++) {
    assert.ok(
      numbers.includes(n),
      `the self-check must enumerate items 1..11 (bolded ordered items); item ${n} ` +
        `not found (saw: ${numbers.join(',') || 'none'}).`,
    )
  }
})

// === AC5: the worked-example trigger text is present in the two new blocks ===
//
// The full worked example (run the two checks on a planted-flawed mini-spec, observe
// both flag; on a clean mini-spec, observe neither) is a JUDGMENT run reported as proof
// in the chunk return. This test pins the operative text those judgments key on, so the
// installed blocks could actually produce the two flags the worked example demands.

test('AC5(worked-example-keys): the new blocks carry the operative flag text the worked example fires on', () => {
  const body = read(SKILL)

  // (i) a chunk whose acceptance hook needs a later chunk -> VACUOUS-UNTIL-LATER
  //     (the cut check names this exact failure with its trigger condition).
  assert.match(
    body, /VACUOUS-UNTIL-LATER:\s*a chunk whose acceptance hook cannot pass until a later chunk lands/,
    'the DECOMPOSITION-CUT CHECK must name VACUOUS-UNTIL-LATER with its trigger ' +
      '(a chunk whose acceptance hook cannot pass until a later chunk lands) so the ' +
      'worked example can flag the later-chunk-dependent chunk.',
  )

  // (ii) a chunk whose endState has a clause no criterion covers -> UNCOVERED endState
  assert.match(
    body, /A clause with no\s+such criterion is an UNCOVERED endState/,
    'the ENDSTATE-COVERAGE CHECK must name the UNCOVERED-endState outcome for a ' +
      'clause with no covering criterion, so the worked example can flag the ' +
      'uncovered-clause chunk.',
  )
})
