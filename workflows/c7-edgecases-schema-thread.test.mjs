// c7-edgecases-schema-thread.test.mjs -- RED for chunk 7 (employed-system-tuning):
// add `edgeCases` as the 11th per-chunk entry schema field, END-TO-END (doc + code
// dispatch path), so it flows spec-author -> cockpit -> worker-pipeline chunkContext
// -> build-agent prompt and the pre-lock self-check enforces its presence.
//
// CONTRACT under test (from the chunk-7 acceptance criteria + requirements):
//   (AC1) edgeCases is the 11th field in the doc schema + spec-template (with a
//         POPULATED sample, not an empty placeholder).
//   (AC2) grep finds NO surviving 'ten schema fields' / 'all ten schema fields'
//         string in spec-collaboration or cockpit (flipped ten -> eleven, and the
//         parenthesized field list now lists edgeCases at BOTH self-check sites
//         + cockpit).
//   (AC3) a worker-pipeline test asserts the dispatched chunkContext includes
//         edgeCases -- this file IS that test (the threading assertion below).
//   (AC4) build-agent{,-light,-heavy,-max}.md list edgeCases as a received field.
//   (AC5) the pre-lock self-check asserts edgeCases presence on a sample entry
//         (a dedicated presence line / clause in the schema-presence check).
//
// All expected tokens come from the chunk's acceptance criteria + requirements
// ABOVE, before any implementation -- no output-fitted assertions.
//
// Strategy mirrors llr-c4-recall-fold.test.mjs / c8-reviewer-split-rename.test.mjs:
// worker-pipeline.js runs at import-time (top-level await agent), so it cannot be
// imported; its wiring is asserted as STATIC SOURCE TEXT.
//
// Run: node --test workflows/c7-edgecases-schema-thread.test.mjs
// Full suite (GLOB form -- bare `node --test workflows/` errors MODULE_NOT_FOUND on Node v25):
//   node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const abs = (rel) => join(root, rel)
const read = (rel) => readFileSync(abs(rel), 'utf8')

const PIPELINE = 'workflows/worker-pipeline.js'
const SPEC_SKILL = 'skills/spec-collaboration/SKILL.md'
const SPEC_TEMPLATE = 'skills/spec-collaboration/references/spec-template.md'
const COCKPIT = 'skills/cockpit/SKILL.md'
// pipeline-meritocracy c1 collapsed the 4-tier quartet to 2: default + heavy.
const BUILD_AGENTS = [
  'agents/build-agent.md',
  'agents/build-agent-heavy.md',
]

// ---------------------------------------------------------------------------
// AC3: worker-pipeline threads edgeCases into the builder's chunkContext / prompt
// (the worker-pipeline test the criterion calls for). Same shape as the AC6
// currentState/requirements/endState/nonGoals threading assertions in
// llr-c4-recall-fold.test.mjs.
// ---------------------------------------------------------------------------

test('AC3(edgeCases-threaded): chunkContext includes edgeCases (from dispatch args)', () => {
  const src = read(PIPELINE)
  assert.match(
    src,
    /a\.edgeCases/,
    `${PIPELINE} must thread a.edgeCases into chunkContext / the builder prompt ` +
      `(AC3: edgeCases is the 11th field and must reach the build-agent prompt, ` +
      `the same way currentState/requirements/endState/nonGoals are threaded).`,
  )
})

test('AC3(edgeCases-in-chunkContext-block): a.edgeCases sits inside the chunkContext array', () => {
  const src = read(PIPELINE)
  // Scope the assertion to the chunkContext declaration block so a stray mention
  // elsewhere cannot satisfy it -- the field must be threaded where the builder
  // prompt is assembled.
  const ctxStart = src.indexOf('const chunkContext')
  assert.notEqual(ctxStart, -1, `${PIPELINE} must declare chunkContext.`)
  const ctxEnd = src.indexOf(".join('\\n')", ctxStart)
  assert.notEqual(ctxEnd, -1, `${PIPELINE}: chunkContext block must end with .join('\\n').`)
  const block = src.slice(ctxStart, ctxEnd)
  assert.match(
    block,
    /a\.edgeCases/,
    `${PIPELINE}'s chunkContext block must reference a.edgeCases so it reaches the build-agent prompt (AC3).`,
  )
})

// ---------------------------------------------------------------------------
// AC1: edgeCases is the 11th field in the doc schema (spec-collaboration §Chunk
// decomposition format) AND the spec-template, with a POPULATED sample.
// ---------------------------------------------------------------------------

test('AC1(doc-schema-field): spec-collaboration §Chunk decomposition format names edgeCases', () => {
  const src = read(SPEC_SKILL)
  // The wire-shape schema block lists the fields; edgeCases must be one of them.
  assert.match(
    src,
    /edgeCases/,
    `${SPEC_SKILL} must add edgeCases to the per-chunk entry schema + field-by-field list (AC1).`,
  )
  // The field-by-field bullet describing it (boundary/error/invariant/integration).
  assert.match(
    src,
    /\*\*edgeCases\*\*/,
    `${SPEC_SKILL} must carry a field-by-field **edgeCases** bullet (AC1).`,
  )
})

test('AC1(spec-template-schema): spec-template names edgeCases in the schema block', () => {
  const src = read(SPEC_TEMPLATE)
  assert.match(
    src,
    /edgeCases/,
    `${SPEC_TEMPLATE} must add edgeCases to the per-chunk entry schema (AC1).`,
  )
})

test('AC1(spec-template-populated-sample): the worked example carries a populated edgeCases value', () => {
  const src = read(SPEC_TEMPLATE)
  // POPULATED sample: edgeCases in the worked example must have a non-empty array
  // value (at least one quoted entry), not a bare `edgeCases: []` placeholder.
  assert.match(
    src,
    /edgeCases:\s*\[\s*"[^"]+"/,
    `${SPEC_TEMPLATE}'s worked example must show edgeCases populated with at least ` +
      `one sample entry (AC1: "with a populated sample"), not an empty [].`,
  )
})

// ---------------------------------------------------------------------------
// AC2: no surviving 'ten schema fields' / 'all ten schema fields' string in
// spec-collaboration or cockpit (flipped to eleven; field list now lists edgeCases).
// ---------------------------------------------------------------------------

test('AC2(no-ten-schema-fields): spec-collaboration + cockpit carry no surviving "ten schema fields" string', () => {
  for (const rel of [SPEC_SKILL, SPEC_TEMPLATE, COCKPIT]) {
    const src = read(rel)
    assert.doesNotMatch(
      src,
      /ten schema fields/i,
      `${rel} must not contain "ten schema fields" (AC2: flip ten -> eleven now that ` +
        `edgeCases is the 11th field).`,
    )
  }
})

test('AC2(eleven-field-list-includes-edgeCases): the self-check + spec-review + cockpit field lists name edgeCases', () => {
  // The three sites that enumerated the 10 fields parenthetically must now list
  // edgeCases (so the enumerated list matches the eleven-field reality).
  // spec-collaboration §Pre-lock self-check (schema-presence) AND §Pre-lock spec
  // review (schema-completeness) live in SPEC_SKILL; cockpit lists them too.
  for (const rel of [SPEC_SKILL, COCKPIT]) {
    const src = read(rel)
    assert.match(
      src,
      /edgeCases/,
      `${rel} must list edgeCases in its enumerated field list (AC2).`,
    )
  }
})

// ---------------------------------------------------------------------------
// AC4: build-agent{,-heavy}.md list edgeCases as a received field.
// ---------------------------------------------------------------------------

test('AC4(build-agent-received-field): both build-agent files list edgeCases as a received field', () => {
  for (const rel of BUILD_AGENTS) {
    const src = read(rel)
    // The "spec entry verbatim" received-fields line must enumerate edgeCases.
    const lineIdx = src.indexOf('spec entry verbatim')
    assert.notEqual(lineIdx, -1, `${rel} must carry the "spec entry verbatim" received-fields line.`)
    const line = src.slice(lineIdx, src.indexOf('\n', lineIdx))
    assert.match(
      line,
      /edgeCases/,
      `${rel}'s received-fields line must list \`edgeCases\` (AC4).`,
    )
  }
})

// ---------------------------------------------------------------------------
// AC5: the pre-lock self-check asserts edgeCases presence (a dedicated presence
// line / clause added to the schema-presence check).
// ---------------------------------------------------------------------------

test('AC5(self-check-edgeCases-presence): the pre-lock self-check enforces edgeCases presence', () => {
  const src = read(SPEC_SKILL)
  // Locate the Pre-lock self-check section and assert it requires edgeCases on a
  // sample/every entry -- the new presence enforcement line.
  const scStart = src.indexOf('## Pre-lock self-check')
  assert.notEqual(scStart, -1, `${SPEC_SKILL} must carry a ## Pre-lock self-check section.`)
  const scEnd = src.indexOf('## Pre-lock teaching synopsis', scStart)
  const section = scEnd === -1 ? src.slice(scStart) : src.slice(scStart, scEnd)
  assert.match(
    section,
    /edgeCases/,
    `${SPEC_SKILL}'s ## Pre-lock self-check must assert edgeCases presence (AC5).`,
  )
})

// ---------------------------------------------------------------------------
// FINDING: edgeCases must be included in review prompts so reviewers can check
// edge-case coverage (not just acceptanceCriteria). The sonnetLensPrompt,
// reReviewPrompt, and adversarialLensPrompt all expose acceptanceCriteria but
// omit edgeCases -- a reviewer cannot audit edge-case coverage it cannot see.
// ---------------------------------------------------------------------------

test('FINDING(edgeCases-in-sonnetLensPrompt): sonnetLensPrompt references a.edgeCases', () => {
  const src = read(PIPELINE)
  // Scope to the sonnetLensPrompt function body.
  const fnStart = src.indexOf('function sonnetLensPrompt(')
  assert.notEqual(fnStart, -1, `${PIPELINE} must define sonnetLensPrompt.`)
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1)
  const fn = fnEnd === -1 ? src.slice(fnStart) : src.slice(fnStart, fnEnd)
  assert.match(
    fn,
    /a\.edgeCases/,
    `${PIPELINE}'s sonnetLensPrompt must include a.edgeCases so the reviewer can ` +
      `check edge-case coverage (finding: edgeCases not in review prompts).`,
  )
})

test('FINDING(edgeCases-in-judgeLensPrompt): the judge prompt threads a.edgeCases (via chunkContext)', () => {
  // pipeline-meritocracy chunk 2: reReviewPrompt is DELETED; the judge re-check
  // (judgeLensPrompt) replaces it. The judge must still see the chunk's edge cases so
  // its re-check can confirm edge-case coverage -- it gets them via chunkContext, which
  // includes `a.edgeCases`. Assert chunkContext threads edgeCases AND the judge prompt
  // embeds chunkContext.
  const src = read(PIPELINE)
  // chunkContext (the shared chunk payload) carries edgeCases.
  const ctxStart = src.indexOf('const chunkContext = [')
  assert.notEqual(ctxStart, -1, `${PIPELINE} must build chunkContext.`)
  const ctxEnd = src.indexOf('].join(', ctxStart)
  const ctx = src.slice(ctxStart, ctxEnd)
  assert.match(ctx, /a\.edgeCases/, `${PIPELINE}'s chunkContext must include a.edgeCases.`)
  // The judge prompt embeds chunkContext, so the judge re-check sees edge cases.
  const fnStart = src.indexOf('function judgeLensPrompt(')
  assert.notEqual(fnStart, -1, `${PIPELINE} must define judgeLensPrompt (the judge dispatch + re-check).`)
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1)
  const fn = fnEnd === -1 ? src.slice(fnStart) : src.slice(fnStart, fnEnd)
  assert.match(
    fn,
    /chunkContext/,
    `${PIPELINE}'s judgeLensPrompt must embed chunkContext so the judge re-check sees ` +
      `the chunk's edge cases (replacing the deleted reReviewPrompt edge-case threading).`,
  )
})

test('FINDING(edgeCases-in-adversarialLensPrompt): adversarialLensPrompt references a.edgeCases', () => {
  const src = read(PIPELINE)
  const fnStart = src.indexOf('function adversarialLensPrompt(')
  assert.notEqual(fnStart, -1, `${PIPELINE} must define adversarialLensPrompt.`)
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1)
  const fn = fnEnd === -1 ? src.slice(fnStart) : src.slice(fnStart, fnEnd)
  assert.match(
    fn,
    /a\.edgeCases/,
    `${PIPELINE}'s adversarialLensPrompt must include a.edgeCases so the adversarial ` +
      `reviewer can hunt unhandled edge cases (finding: edgeCases not in review prompts).`,
  )
})
