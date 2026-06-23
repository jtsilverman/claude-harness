// build-loop-quality chunk 3: builder-RED half-landed-endState line + §Tier vocab cleanup.
//
// Pins the chunk-3 contract against disciplines/worker-discipline.md:
//   C1 (builder-RED line): the RED section requires a test that goes red on a HALF-LANDED
//        endState -- not merely each criterion in isolation; if any behavioral clause of the
//        endState is unimplemented, at least one test is red. This is the "worked example"
//        (two-clause endState, RED exercises only one -> incomplete RED).
//   C2 (no S/A/B/C-as-live): §Tier carries no live S/A/B/C tier vocabulary --
//        neither `Tier [SABC]` nor the `**X** (` bullet form.
//   C3 (default/heavy gloss): §Tier names exactly `default` and `heavy`, with the
//        two-axis trigger gloss (complexity + blast radius).
//
// Assertions read the SECTION, not the whole file: "default"/"heavy" appear elsewhere in the
// doc body, and the recalled substring-trap (red-phase-false-pass-substring-match-trap) warns a
// whole-file grep would false-pass. The §Tier slice is the unit under test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DISCIPLINE = join(__dirname, '..', 'disciplines', 'worker-discipline.md')
const DOC = readFileSync(DISCIPLINE, 'utf8')

// Slice a `## Heading`-delimited section by flag-toggle (NOT an awk-style range, which would
// self-terminate when the start line also matches the end pattern -- see tdd-red footguns).
function sectionBody(doc, headingNeedle) {
  const lines = doc.split('\n')
  const out = []
  let inSection = false
  for (const line of lines) {
    const isHeading = line.startsWith('## ')
    if (isHeading && line.includes(headingNeedle)) { inSection = true; continue }
    if (isHeading && inSection) break // next ## heading ends the section
    if (inSection) out.push(line)
  }
  return out.join('\n')
}

const RED_SECTION = sectionBody(DOC, 'RED: the failing test')
const TIER_SECTION = sectionBody(DOC, 'Tier (')

// --- C1: builder-RED half-landed-endState line (the worked example) ---

test('C1: RED section requires a test that fails on a half-landed endState', () => {
  assert.notEqual(RED_SECTION, '', 'could not locate the RED section')
  assert.match(
    RED_SECTION,
    /half-landed endState/i,
    'RED section must contain the builder-RED variant line naming a HALF-LANDED endState'
  )
})

test('C1: the builder-RED line frames the worked example -- one clause unimplemented -> a test is red', () => {
  // The clause must say: not merely each criterion in isolation, and if any behavioral clause
  // of the endState is left unimplemented, at least one test is red. This is precisely the
  // "endState has two clauses but RED exercises one -> incomplete RED" worked example.
  assert.match(RED_SECTION, /not merely (on )?each criterion in isolation/i,
    'the line must contrast half-landed-endState failure against per-criterion-in-isolation')
  assert.match(RED_SECTION, /behavioral clause of the endState is left unimplemented/i,
    'the line must name a behavioral clause of the endState being left unimplemented')
  assert.match(RED_SECTION, /at least one test is red/i,
    'the line must require at least one test goes red on the uncovered clause')
})

// --- C2: §Tier carries no live S/A/B/C tier vocabulary ---

test('C2: §Tier names no live S/A/B/C tier vocabulary', () => {
  assert.notEqual(TIER_SECTION, '', 'could not locate the §Tier section')
  // The two live-vocab shapes the acceptance criterion greps for:
  //   `Tier [SABC]` (e.g. "Tier S") and the `**X** (` bullet form (e.g. "**S** (").
  assert.doesNotMatch(TIER_SECTION, /Tier [SABC]\b/,
    '§Tier must not carry a `Tier S/A/B/C` live label')
  assert.doesNotMatch(TIER_SECTION, /\*\*[SABC]\*\* \(/,
    '§Tier must not carry the `**S** (` / `**A** (` / `**B** (` / `**C** (` bullet form')
})

// --- C3: §Tier names exactly default and heavy with the two-axis trigger gloss ---

test('C3: §Tier names exactly default and heavy', () => {
  assert.match(TIER_SECTION, /\bdefault\b/i, '§Tier must name the `default` tier')
  assert.match(TIER_SECTION, /\bheavy\b/i, '§Tier must name the `heavy` tier')
})

test('C3: §Tier glosses heavy on the two axes -- complexity AND blast radius', () => {
  assert.match(TIER_SECTION, /complexity/i, '§Tier must name the complexity axis')
  assert.match(TIER_SECTION, /blast[ -]radius/i, '§Tier must name the blast-radius axis')
})
