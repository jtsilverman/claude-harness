// RED test for chunk 9: Spec-grounded review + B-Codex gate (+ meta.phases fix).
//
// SUPERSESSION NOTE (three-loop-rebuild chunk 5): two of this file's original
// chunk-9 behavior shifts pinned the OLD five-context relay's pipeline structure
// and were obsoleted when chunk 5 collapsed that relay into one build-agent:
//   - (C2c) the `codexGated` cost-gate variable (B fires / C skips) -- three-loop
//     chunk 5 once flipped the gate to fire on EVERY tier, but the operator 2026-06-13
//     REVERTED that flip: the gate is back to {A,S,B} fire / C+absent skip, now as a
//     `codexFires` variable positively pinned by the chunk-5 AC5 cost-gate test.
//   - (C3) the meta.phases RED/GREEN/RECALL per-stage model labels -- chunk 5
//     replaces those phases with BUILD -> REVIEW; the new phase shape is pinned by
//     the chunk-5 RED test (AC3/AC4).
// Both were removed from this file in chunk 5's REFACTOR. C1 (per-criterion
// reviewer prompts) and C2a/C2b (codex-review.sh tier_config) survive UNCHANGED --
// chunk 5 preserves the criteria-decomposed reviewer prompts and does not touch
// the codex script. The surviving behavior shifts pinned here:
//
//  (C1) SCOPED, criteria-decomposed review. BOTH reviewer prompts inside
//       workflows/worker-pipeline.js (the Codex lens AND the Sonnet
//       spec-drift-slop reviewer) must thread the chunk's ACCEPTANCE CRITERIA
//       in and instruct a PER-CRITERION satisfied-vs-MISSING(omission) check --
//       NOT one open-ended pass -- ALONGSIDE (not replacing) the existing
//       bug/security hunt (Codex) and drift/slop hunt (Sonnet). This is the
//       omission-defect countermeasure: review is structurally blind to what was
//       omitted unless each criterion is enumerated and checked explicitly.
//
//  (C2) B-Codex cost-gate flip in scripts/codex-review.sh:
//        (C2a) scripts/codex-review.sh tier_config: Tier B -> gpt-5.4-mini +
//              medium (the cheap cross-model lens), where it was medium with NO
//              model override. C unchanged (gpt-5.4-mini + low), A/S unchanged
//              (gpt-5.5 + high / xhigh).
//        (C2b) the no-tier / absent path stays byte-identical to the pre-tier
//              default (medium, NO model override), so Tier B and the empty tier
//              now DIVERGE -- the existing no-tier chunk-checkpoint caller is
//              unaffected, and "absent still skips" holds (no model override
//              means the absent path is not the cheap-lens path).
//
// Test strategy mirrors the established sibling pattern (merge-robustness.test.mjs):
// worker-pipeline.js executes the pipeline at top-level on import (no import.meta
// guard), so it CANNOT be imported -- its prompts are asserted as STATIC SOURCE
// TEXT. codex-review.sh's tier_config is the pure half of the tier knob, so it is
// exercised by SOURCING the script and calling tier_config in isolation (no
// codex/network call) -- exactly the harness scripts/codex_review_test.py uses,
// ported to child_process.
//
// No tautology: every expected value (the gpt-5.4-mini model for B, the per-
// criterion SATISFIED/MISSING labels) is fixed from the spec's chunk-9 contract
// BEFORE any code is written, never read back from the implementation.
//
// Run: node --test workflows/spec-grounded-review.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const PIPELINE = 'workflows/worker-pipeline.js'
const CODEX_SH = 'scripts/codex-review.sh'

// --- helpers ---------------------------------------------------------------

// Source codex-review.sh and call tier_config TIER in isolation. Sourcing does
// NOT run main() (guarded behind BASH_SOURCE==$0, false when sourced), so this
// exercises the pure tier_config function with no codex call -- same trick as
// scripts/codex_review_test.py, ported to Node. The tier is a positional ($1)
// so an empty-string tier is a real, distinct argument (not "no argument").
function tierConfig(tier) {
  return execFileSync(
    'bash',
    ['-c', `source ${CODEX_SH}; tier_config "$1"`, '_', tier],
    { cwd: root, encoding: 'utf8' },
  )
}

// Slice the prompt-building array of one agent() spawn out of the pipeline
// source by a unique opening marker, up to its `schema: REVIEW_RESULT }` close.
// The reviewer prompts build their own string arrays (they do NOT include the
// shared chunkContext), so the acceptance-criteria threading must appear inside
// THIS block, not merely somewhere else in the file.
function reviewerBlock(body, startMarker) {
  const start = body.indexOf(startMarker)
  assert.ok(start !== -1, `could not locate reviewer prompt by marker: ${startMarker}`)
  const end = body.indexOf('schema: REVIEW_RESULT }', start)
  assert.ok(end !== -1, `could not locate end of reviewer block for marker: ${startMarker}`)
  return body.slice(start, end)
}

// =====================================================================
// C1 -- SCOPED, criteria-decomposed reviewer prompts (BOTH lenses)
// =====================================================================

// The two reviewer lenses, each identified by a unique opening line in the
// pipeline source, plus the existing hunt each must KEEP (added-to, not
// replaced) so the criteria-check augments rather than supplants the lens.
const REVIEWERS = [
  {
    name: 'Codex lens',
    marker: 'You are the CODEX lens',
    keepHunt: /bug|security|correctness/i,
    keepHuntDesc: 'the existing correctness/security bug hunt',
  },
  {
    name: 'Sonnet spec-drift-slop lens',
    marker: "Review this chunk's committed change for spec-drift",
    keepHunt: /drift|slop/i,
    keepHuntDesc: 'the existing spec-drift / AI-slop hunt',
  },
]

for (const { name, marker, keepHunt, keepHuntDesc } of REVIEWERS) {
  test(`C1(${name}): prompt threads the acceptance criteria in (a.acceptanceCriteria)`, () => {
    const block = reviewerBlock(read(PIPELINE), marker)
    // The reviewer cannot do a per-criterion check unless the criteria are
    // actually in its prompt. The criteria value is dynamic (a.acceptanceCriteria),
    // so the threading shows up as the variable interpolated into THIS prompt's
    // string array -- it is NOT enough that the criteria live in chunkContext,
    // which the reviewer prompts deliberately do not include.
    assert.match(
      block,
      /acceptanceCriteria/,
      `The ${name} prompt never references 'acceptanceCriteria'. Chunk 9 requires BOTH reviewer ` +
        `prompts to thread the chunk's acceptance contract (a.acceptanceCriteria) INTO the prompt ` +
        `so the reviewer can check each criterion. The reviewer prompts build their own string ` +
        `arrays without chunkContext, so the criteria must be added to this block specifically.`,
    )
  })

  test(`C1(${name}): prompt instructs a per-criterion SATISFIED-vs-MISSING(omission) check`, () => {
    const block = reviewerBlock(read(PIPELINE), marker)
    // Per-criterion verdict, not one open-ended pass: for EACH acceptance
    // criterion the reviewer reports satisfied vs missing/omitted. Pin both
    // verdict poles and the omission framing -- the omission-defect countermeasure
    // is exactly the explicit "did the diff NOT satisfy this criterion" hunt.
    assert.match(
      block,
      /satisf/i,
      `The ${name} prompt does not instruct a per-criterion SATISFIED verdict. Chunk 9 requires a ` +
        `per-criterion check (for each acceptance criterion, report SATISFIED vs MISSING), not one ` +
        `open-ended pass -- the 'satisfied' pole of that verdict must appear in the prompt.`,
    )
    assert.match(
      block,
      /missing|omit/i,
      `The ${name} prompt does not instruct the MISSING / omission pole of the per-criterion check. ` +
        `Chunk 9's omission-defect countermeasure is the explicit hunt for acceptance criteria the diff ` +
        `did NOT satisfy (MISSING/omitted); review is structurally blind to omissions without it.`,
    )
    assert.match(
      block,
      /each|per[- ]criterion|every (acceptance )?criteri/i,
      `The ${name} prompt does not scope the check PER CRITERION (each / every / per-criterion). The ` +
        `whole point of chunk 9 is replacing the open-ended pass with an enumerate-and-check-each-criterion ` +
        `instruction so omissions cannot hide in an aggregate "looks fine".`,
    )
  })

  test(`C1(${name}): the criteria check is ADDED ALONGSIDE ${keepHuntDesc}, not replacing it`, () => {
    const block = reviewerBlock(read(PIPELINE), marker)
    // The per-criterion check augments the existing lens; it must not delete the
    // bug/security (Codex) or drift/slop (Sonnet) hunt that is the lens's reason
    // to exist. Pin that the original hunt vocabulary survives in the prompt.
    assert.match(
      block,
      keepHunt,
      `The ${name} prompt lost ${keepHuntDesc} (${keepHunt}). Chunk 9 adds the per-criterion ` +
        `acceptance check ALONGSIDE the existing hunt, not in place of it -- the lens must still do its ` +
        `original job plus the omission check.`,
    )
  })
}

// =====================================================================
// C2a/C2b -- codex-review.sh tier_config: B fires on the cheap lens; absent stays default
// =====================================================================

test('C2a: tier_config B -> gpt-5.4-mini + medium (the cheap cross-model lens fires on B)', () => {
  const out = tierConfig('B')
  assert.match(
    out,
    /model=gpt-5\.4-mini/,
    `tier_config B must map Tier B to the lightest model 'gpt-5.4-mini' (was: no model override). ` +
      `Chunk 9 flips B to fire Codex on the cheap cross-model lens. Got: ${JSON.stringify(out)}`,
  )
  assert.match(
    out,
    /model_reasoning_effort=medium/,
    `tier_config B must keep medium reasoning effort. Chunk 9 changes only the model (adds ` +
      `gpt-5.4-mini); the effort stays medium. Got: ${JSON.stringify(out)}`,
  )
})

test('C2a: tier_config B model goes via -c model=... (codex review has no -m/--model flag)', () => {
  // codex review takes the model only as `-c model=<id>`; assert the model id is
  // preceded by a `-c` token, the same well-formed-pairs invariant the existing
  // suite pins for the other tiers.
  const args = tierConfig('B').split('\n').map((s) => s.trim()).filter(Boolean)
  const i = args.findIndex((t) => t.startsWith('model=gpt-5.4-mini'))
  assert.ok(i > 0, `tier_config B must emit a 'model=gpt-5.4-mini' token: ${JSON.stringify(args)}`)
  assert.equal(
    args[i - 1],
    '-c',
    `tier_config B's model token must be preceded by '-c' (codex review has no -m flag; model goes ` +
      `via -c model=<id>). Got args: ${JSON.stringify(args)}`,
  )
})

test('C2b: absent/empty tier stays the pre-tier default (medium, NO model override)', () => {
  // The no-tier chunk-checkpoint caller invokes codex-review.sh with no --tier;
  // that path must stay byte-identical to the pre-tier default (medium effort,
  // NO model override) so the existing caller is unaffected. "Absent still skips"
  // = the absent path is NOT the cheap-lens path, so it carries no model override.
  const out = tierConfig('')
  assert.match(
    out,
    /model_reasoning_effort=medium/,
    `Empty/absent tier must keep medium effort: ${JSON.stringify(out)}`,
  )
  assert.doesNotMatch(
    out,
    /model=/,
    `Empty/absent tier must NOT override the model -- it stays byte-identical to the pre-tier default ` +
      `(medium, no model) so the existing no-tier chunk-checkpoint caller is unaffected. Got: ${JSON.stringify(out)}`,
  )
})

test('C2b: Tier B and the absent tier now DIVERGE (B fires on a model, absent does not)', () => {
  // Before chunk 9, B and '' shared one branch (both medium, no model). After the
  // flip they must differ: B carries the gpt-5.4-mini model, absent does not. If
  // they are still equal, the B->cheap-lens flip did not land (or it wrongly
  // changed the absent path too).
  const b = tierConfig('B').trim()
  const empty = tierConfig('').trim()
  assert.notEqual(
    b,
    empty,
    `Tier B and the absent tier still produce identical args (${JSON.stringify(b)}). Chunk 9 splits ` +
      `them: B -> gpt-5.4-mini + medium (Codex fires on B), absent -> medium with no model override ` +
      `(unchanged). They must diverge.`,
  )
})

test('C2: C, A, S tier_config mappings are UNCHANGED (regression guard)', () => {
  // The flip touches only B (and leaves absent alone). C/A/S must stay exactly as
  // they were, so the rest of the cost dial is not disturbed.
  assert.match(tierConfig('C'), /model=gpt-5\.4-mini/, 'Tier C must stay gpt-5.4-mini')
  assert.match(tierConfig('C'), /model_reasoning_effort=low/, 'Tier C must stay low effort')
  assert.match(tierConfig('A'), /model=gpt-5\.5/, 'Tier A must stay gpt-5.5')
  assert.match(tierConfig('A'), /model_reasoning_effort=high/, 'Tier A must stay high effort')
  assert.match(tierConfig('S'), /model=gpt-5\.5/, 'Tier S must stay gpt-5.5')
  assert.match(tierConfig('S'), /model_reasoning_effort=xhigh/, 'Tier S must stay xhigh effort')
})

// =====================================================================
// C2c -- worker-pipeline.js: the tier variable is normalized before review
// =====================================================================
//
// NOTE (three-loop-rebuild chunk 5, REVERTED 2026-06-13): the original chunk-9 C2c
// test asserted a `codexGated` cost-gate variable that FIRED on Tier B but SKIPPED
// Tier C. Three-loop chunk 5 once flipped that gate so Codex fired on EVERY tier;
// the operator 2026-06-13 REVERTED the flip (cost call), so the gate is back to {A,S,B} fire
// / C+absent skip -- now a `codexFires` variable in worker-pipeline.js, positively
// pinned by the chunk-5 AC5 cost-gate test (which asserts the {A,S,B} allow-set gates
// the Codex dispatch). The tier-normalization assertion below survives unchanged --
// the pipeline keeps `String(a.tier||'').toUpperCase()`.

test('C2c: the tier variable is NORMALIZED (toUpperCase on a.tier) before the REVIEW stage', () => {
  const body = read(PIPELINE)
  // The REVIEW stage threads `tier` into codex-review.sh's --tier, which expects
  // uppercase S/A/B/C -- so `tier` must be normalized at its single definition.
  // Otherwise a lowercase launch tier (e.g. 'b') gets Tier-B model/effort from
  // tierConfig (it uppercases internally) yet passes a lowercase --tier downstream
  // -- a silent inconsistency. Pin that the `tier` definition uppercases a.tier; a
  // regression that reverts to `const tier = a.tier || ''` (no normalization) fails here.
  const tierDef = (body.match(/const\s+tier\s*=\s*.*/) || [])[0] || ''
  assert.ok(tierDef, `${PIPELINE} no longer defines the 'tier' variable for the REVIEW stage.`)
  assert.match(
    tierDef,
    /a\.tier[\s\S]*\.toUpperCase\(\)|String\(\s*a\.tier[\s\S]*\)\s*\.toUpperCase\(\)/,
    `The REVIEW-stage 'tier' definition must NORMALIZE a.tier via .toUpperCase() so the downstream ` +
      `--tier shell arg (codex-review.sh expects uppercase S/A/B/C) agrees with tierConfig (which ` +
      `uppercases internally). Without it, a lowercase tier gets Tier-B config but passes a lowercase ` +
      `--tier downstream. Got: ${JSON.stringify(tierDef)}`,
  )
})

// =====================================================================
// C3 -- meta.phases model labels (REMOVED in three-loop-rebuild chunk 5)
// =====================================================================
//
// NOTE (three-loop-rebuild chunk 5): the original chunk-9 C3 tests asserted the
// meta.phases RED / GREEN / RECALL entries carried per-stage model labels matching
// the old five-context relay's per-stage agent() spawns. Chunk 5 collapses that
// relay into ONE build-agent, so worker-pipeline.js's meta.phases is now BUILD ->
// REVIEW -- the RED / GREEN / RECALL phase entries (and their per-stage model
// labels) no longer exist. The new phase shape (one build dispatch + a separate
// fresh-context review net) is positively pinned by the chunk-5 RED test
// (workflows/three-loop-c5-single-agent-dispatch.test.mjs, AC3 / AC4). The three
// C3 meta.phases label tests were therefore obsoleted by chunk 5 and removed in
// its REFACTOR. The `phaseModelLabel` helper they used is removed alongside them.
