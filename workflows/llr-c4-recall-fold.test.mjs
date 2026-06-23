// RED tests for lean-system-rebuild chunk C4:
//   "Fold recall into the builder's ONE continuous context"
//
// This chunk:
//   (AC1) Removes the separate RECALL harness stage from worker-pipeline.js
//   (AC2) Adds a required recallEvidence field to BUILD_RESULT (missing field
//         is rejected as malformed -- the new anti-skip)
//   (AC3) Scrubs the builder-prompt contradiction so it says ONLY "invoke recall
//         yourself" with no "harness already ran recall / READ that artifact"
//   (AC4) Drops tier-classification from chunk-kickoff/SKILL.md; tdd-red/tdd-green
//         carry no recall instruction
//   (AC6) Threads currentState/requirements/endState/nonGoals into the builder prompt
//
// Same strategy as llr-c3-recall-kickoff-harness.test.mjs: worker-pipeline.js runs
// at import-time (top-level await agent), so it cannot be imported; its wiring is
// asserted as STATIC SOURCE TEXT.
//
// All expected tokens come from the chunk's task statement + acceptance criteria
// ABOVE, before any implementation -- no output-fitted assertions.
//
// Run: node --test workflows/llr-c4-recall-fold.test.mjs
// Full suite: node --test 'workflows/*.test.mjs'

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
const KICKOFF  = 'skills/chunk-kickoff/SKILL.md'
const TDD_RED  = 'skills/tdd-red/SKILL.md'
const TDD_GREEN = 'skills/tdd-green/SKILL.md'

// ---------------------------------------------------------------------------
// AC1: The separate RECALL harness stage is REMOVED from worker-pipeline.js.
// All four: the phase('RECALL') marker, the RECALL_KICKOFF_RESULT schema, the
// recallArtifact const, and the recallKickoff bundle field must be absent.
// ---------------------------------------------------------------------------

test('AC1(phase-removed): worker-pipeline.js no longer contains a phase("RECALL") harness stage', () => {
  const src = read(PIPELINE)
  assert.doesNotMatch(
    src,
    /phase\(\s*['"]RECALL['"]\s*\)/,
    `${PIPELINE} must NOT have a phase('RECALL') block -- the separate RECALL harness ` +
      `stage has been removed (C4: recall folds into the builder's one continuous context).`,
  )
})

test('AC1(schema-removed): RECALL_KICKOFF_RESULT schema is removed from worker-pipeline.js', () => {
  const src = read(PIPELINE)
  assert.doesNotMatch(
    src,
    /RECALL_KICKOFF_RESULT/,
    `${PIPELINE} must NOT define RECALL_KICKOFF_RESULT -- the recall-kickoff schema ` +
      `for the now-removed RECALL stage must be deleted.`,
  )
})

test('AC1(recallArtifact-removed): the recallArtifact const is removed from worker-pipeline.js', () => {
  const src = read(PIPELINE)
  // The specific const recallArtifact = ... line that threaded the artifact path
  assert.doesNotMatch(
    src,
    /const\s+recallArtifact\s*=/,
    `${PIPELINE} must NOT declare \`const recallArtifact = ...\` -- the artifact-path ` +
      `constant for the now-removed RECALL stage must be deleted.`,
  )
})

test('AC1(bundle-field-removed): the recallKickoff field is removed from the return bundle', () => {
  const src = read(PIPELINE)
  const returnIdx = src.lastIndexOf('return {')
  assert.notEqual(returnIdx, -1, `${PIPELINE} has no return bundle.`)
  const bundle = src.slice(returnIdx)
  assert.doesNotMatch(
    bundle,
    /recallKickoff\s*:/,
    `${PIPELINE}'s return bundle must NOT carry a recallKickoff field -- the recall- ` +
      `kickoff stage result field is removed along with the RECALL stage (C4).`,
  )
})

test('AC1(agent-label-removed): no recall-kickoff: agent() label exists (the harness stage dispatch is gone)', () => {
  const src = read(PIPELINE)
  assert.doesNotMatch(
    src,
    /label:\s*[`'"]recall-kickoff:/,
    `${PIPELINE} must NOT spawn an agent with label 'recall-kickoff:' -- the separate ` +
      `harness-stage dispatch that produced that label is removed (C4).`,
  )
})

// ---------------------------------------------------------------------------
// AC2: BUILD_RESULT requires a recallEvidence field. A build return that lacks
// this field is rejected as malformed (the new anti-skip).
// recallEvidence must appear in the BUILD_RESULT required[] array AND in properties.
// ---------------------------------------------------------------------------

test('AC2(field-in-required): BUILD_RESULT required[] array includes recallEvidence', () => {
  const src = read(PIPELINE)

  // Locate the BUILD_RESULT block -- from `const BUILD_RESULT` to the closing `}`
  const bldIdx = src.indexOf('const BUILD_RESULT')
  assert.notEqual(bldIdx, -1, `${PIPELINE} must define BUILD_RESULT.`)
  // Grab a generous window: from BUILD_RESULT declaration to end of its `required:` array
  const window = src.slice(bldIdx, bldIdx + 4000)

  // The required array must list 'recallEvidence' (adjacent to other required fields)
  assert.match(
    window,
    /required\s*:\s*\[[^\]]*'recallEvidence'[^\]]*\]/,
    `${PIPELINE}'s BUILD_RESULT required[] array must include 'recallEvidence' so that ` +
      `a build return missing this field is rejected as malformed (the new anti-skip).`,
  )
})

test('AC2(field-in-properties): BUILD_RESULT properties contains a recallEvidence definition', () => {
  const src = read(PIPELINE)
  const bldIdx = src.indexOf('const BUILD_RESULT')
  assert.notEqual(bldIdx, -1, `${PIPELINE} must define BUILD_RESULT.`)
  // Window must be large enough to reach the recallEvidence property deep in properties.
  const window = src.slice(bldIdx, bldIdx + 12000)

  assert.match(
    window,
    /recallEvidence\s*:/,
    `${PIPELINE}'s BUILD_RESULT properties must define recallEvidence (the new ` +
      `required anti-skip field carrying search terms, surfaced entries, and ` +
      `per-entry read-verify lines).`,
  )
})

// AC2 RUNTIME-REJECTION: a mock build return missing recallEvidence is rejected.
// This is the literal AC2 acceptance criterion: "Add a test asserting a
// recall-evidence-less build return fails validation." The validator implements
// the same required-field check the harness enforces when the build-agent returns.
//
// Strategy: extract the BUILD_RESULT.required array from source text (same
// approach the existing AC2 tests use), implement a minimal required-field
// validator (what the harness does), then assert the missing-recallEvidence
// object fails it while a well-formed object passes.
test('AC2(runtime-rejection): a build return missing recallEvidence fails validation (the anti-skip enforcement)', () => {
  const src = read(PIPELINE)

  // 1. Extract the BUILD_RESULT.required array from source.
  //    It appears as: required: ['branch', 'summary', ..., 'recallEvidence']
  //    on a single line (the builder's required array is single-line in source).
  const bldIdx = src.indexOf('const BUILD_RESULT')
  assert.notEqual(bldIdx, -1, `${PIPELINE} must define BUILD_RESULT.`)
  const window = src.slice(bldIdx, bldIdx + 4000)
  const reqLineMatch = window.match(/required\s*:\s*(\[[^\]]*\])/)
  assert.ok(reqLineMatch, `BUILD_RESULT must declare a required[] array.`)

  // Parse the required array. The array uses single-quoted strings; convert to JSON.
  const requiredJson = reqLineMatch[1].replace(/'/g, '"')
  let requiredFields
  try {
    requiredFields = JSON.parse(requiredJson)
  } catch (e) {
    assert.fail(`BUILD_RESULT.required array could not be parsed as JSON: ${reqLineMatch[1]}`)
  }

  // 2. Minimal required-field validator (mirrors harness behavior: every field in
  //    required[] must be present as an own property in the return object).
  function meetsRequired(required, obj) {
    if (!obj || typeof obj !== 'object') return false
    return required.every((field) => Object.prototype.hasOwnProperty.call(obj, field))
  }

  // 3. Assert recallEvidence IS in the required array (double-check).
  assert.ok(
    requiredFields.includes('recallEvidence'),
    `BUILD_RESULT.required must include 'recallEvidence'. Got: ${JSON.stringify(requiredFields)}`,
  )

  // 4. A mock return that is otherwise valid BUT missing recallEvidence must FAIL.
  const withoutRecallEvidence = {
    branch: 'feat/test',
    summary: 'did stuff',
    green: true,
    redStateRecord: 'abc123',
    explanation: 'explanation text',
    proof: 'proof text',
    specUpdateSummary: 'spec update',
    captures: 'captures text',
    // recallEvidence deliberately ABSENT
  }
  assert.equal(
    meetsRequired(requiredFields, withoutRecallEvidence),
    false,
    `A build return missing recallEvidence must FAIL the required-field check ` +
      `(the anti-skip: the harness rejects a return without this field as malformed). ` +
      `Required fields: ${JSON.stringify(requiredFields)}`,
  )

  // 5. Adding recallEvidence makes it pass.
  const withRecallEvidence = {
    ...withoutRecallEvidence,
    recallEvidence: { searchTerms: 'recall worker pipeline', surfacedEntries: 'entry A' },
  }
  assert.equal(
    meetsRequired(requiredFields, withRecallEvidence),
    true,
    `A build return WITH recallEvidence must PASS the required-field check. ` +
      `Required fields: ${JSON.stringify(requiredFields)}`,
  )
})

// ---------------------------------------------------------------------------
// AC3: The builder-prompt contradiction is scrubbed.
// The BUILD prompt must NOT contain "already ran recall", "recall-kickoff artifact",
// or "harness ran" wording. These exact fragments are from the old contradictory
// wording that said BOTH "the pipeline already ran recall... READ that artifact"
// AND "invoke recall yourself".
// ---------------------------------------------------------------------------

test('AC3(no-contradiction-already-ran): the BUILD prompt contains no "already ran recall" wording', () => {
  const src = read(PIPELINE)
  const buildIdx = src.search(/phase\(\s*['"]BUILD['"]\s*\)/)
  assert.notEqual(buildIdx, -1, `${PIPELINE} is missing the BUILD phase marker.`)
  // Capture the full BUILD prompt region (generous window to cover the entire prompt)
  const buildRegion = src.slice(buildIdx, buildIdx + 3000)

  assert.doesNotMatch(
    buildRegion,
    /already ran recall|pipeline already ran recall/i,
    `${PIPELINE}'s BUILD prompt must NOT say "already ran recall" -- the old wording ` +
      `claimed the pipeline ran recall already (contradiction); C4 removes it so ONLY ` +
      `the "builder invokes recall itself" instruction survives.`,
  )
})

test('AC3(no-contradiction-read-artifact): the BUILD prompt contains no "READ that artifact" / recall-kickoff artifact wording', () => {
  const src = read(PIPELINE)
  const buildIdx = src.search(/phase\(\s*['"]BUILD['"]\s*\)/)
  assert.notEqual(buildIdx, -1, `${PIPELINE} is missing the BUILD phase marker.`)
  const buildRegion = src.slice(buildIdx, buildIdx + 3000)

  assert.doesNotMatch(
    buildRegion,
    /READ that artifact|recall.{0,30}artifact|recall-kickoff\.md/i,
    `${PIPELINE}'s BUILD prompt must NOT reference a recall-kickoff artifact for the ` +
      `builder to read -- the old wording told the builder to "READ that artifact" ` +
      `(the one the now-removed RECALL stage wrote). C4 scrubs this; only the ` +
      `"builder invokes recall itself" instruction survives.`,
  )
})

test('AC3(no-contradiction-harness-ran): the BUILD prompt contains no "harness ran" / "deterministic harness step" wording attributing recall to the harness', () => {
  const src = read(PIPELINE)
  const buildIdx = src.search(/phase\(\s*['"]BUILD['"]\s*\)/)
  assert.notEqual(buildIdx, -1, `${PIPELINE} is missing the BUILD phase marker.`)
  const buildRegion = src.slice(buildIdx, buildIdx + 3000)

  assert.doesNotMatch(
    buildRegion,
    /harness (?:step|stage|ran|enforced recall|already ran)|deterministic harness step/i,
    `${PIPELINE}'s BUILD prompt must NOT claim "the harness ran recall" -- C4 removes ` +
      `the separate RECALL harness stage so the builder now runs recall itself; telling ` +
      `it "the harness already did it" is the contradiction being scrubbed.`,
  )
})

// ---------------------------------------------------------------------------
// AC4: chunk-kickoff/SKILL.md no longer instructs the model to classify the tier
// (tier arrives from the dispatch payload; the self-orientation bullets stay).
// ---------------------------------------------------------------------------

test('AC4(kickoff-tier-drop): chunk-kickoff/SKILL.md no longer contains a Step 3 "Classify tier" section', () => {
  const src = read(KICKOFF)

  // The old Step 3 title was "## Step 3: Classify tier" with S/A/B/C decision rules.
  // After C4 it must be absent (tier comes from the dispatch payload, not derived here).
  assert.doesNotMatch(
    src,
    /##\s*Step\s*3[:\s].*[Cc]lassif[y|ied]?\s+tier/,
    `${KICKOFF} must NOT have a "Step 3: Classify tier" section -- tier is set at spec ` +
      `decomposition and arrives in the dispatch payload; chunk-kickoff must no longer ` +
      `instruct the model to derive or classify the tier.`,
  )
})

test('AC4(kickoff-tier-triggers-gone): chunk-kickoff/SKILL.md no longer lists tier-S/A/B/C trigger questions', () => {
  const src = read(KICKOFF)

  // The old Step 3 contained explicit "Tier S triggers" and "Tier A intrinsic-risk triggers"
  // decision trees. These must be removed.
  assert.doesNotMatch(
    src,
    /Tier [SA] triggers|intrinsic-risk triggers/i,
    `${KICKOFF} must NOT list Tier S / Tier A trigger questions -- those belong to ` +
      `ai-discipline.md, not to chunk-kickoff (which no longer classifies tier; tier ` +
      `arrives from the dispatch payload after C4).`,
  )
})

test('AC4(kickoff-orientation-stays): chunk-kickoff/SKILL.md still has the self-orientation bullets (File/Behavior/After/Obsoletes)', () => {
  const src = read(KICKOFF)

  // The four orientation bullets must still be present (only tier-classification is removed)
  assert.match(
    src,
    /File or interface/i,
    `${KICKOFF} must keep the orientation bullets (File, Behavior, After it ships, ` +
      `Likely obsoletes) -- only tier-classification is removed.`,
  )
  assert.match(
    src,
    /Behavior shift/i,
    `${KICKOFF} must keep the "Behavior shift" orientation bullet.`,
  )
  assert.match(
    src,
    /After it ships/i,
    `${KICKOFF} must keep the "After it ships" orientation bullet.`,
  )
  assert.match(
    src,
    /[Ll]ikely obsoletes/i,
    `${KICKOFF} must keep the "Likely obsoletes" orientation bullet.`,
  )
})

test('AC4(tdd-red-no-recall): tdd-red/SKILL.md carries no recall invocation instruction', () => {
  const src = read(TDD_RED)
  // recall is the BUILD-AGENT's first step -- tdd-red should NOT instruct the agent to invoke recall
  assert.doesNotMatch(
    src,
    /invoke\s+recall|run\s+recall|skill.*recall|recall.*skill/i,
    `${TDD_RED} must NOT instruct the agent to invoke recall -- recall is the ` +
      `build-agent's first step in its continuous context; tdd-red is the RED phase ` +
      `only and must not duplicate that instruction.`,
  )
})

test('AC4(tdd-green-no-recall): tdd-green/SKILL.md carries no recall invocation instruction', () => {
  const src = read(TDD_GREEN)
  assert.doesNotMatch(
    src,
    /invoke\s+recall|run\s+recall|skill.*recall|recall.*skill/i,
    `${TDD_GREEN} must NOT instruct the agent to invoke recall -- recall is the ` +
      `build-agent's first step in its continuous context; tdd-green is the GREEN ` +
      `phase only and must not duplicate that instruction.`,
  )
})

// ---------------------------------------------------------------------------
// AC6: currentState / requirements / endState / nonGoals are threaded into the
// builder's chunkContext / prompt (backward-compat: absent fields are tolerated).
// ---------------------------------------------------------------------------

test('AC6(currentState-threaded): chunkContext includes currentState (from dispatch args)', () => {
  const src = read(PIPELINE)

  // The chunkContext block (the template-literal joined array) must reference a.currentState
  // so it reaches the builder prompt.
  assert.match(
    src,
    /a\.currentState/,
    `${PIPELINE} must thread a.currentState into chunkContext / the builder prompt ` +
      `(AC6: the builder currently only gets taskStatement/specExcerpt -- the new ` +
      `cockpit fields currentState/requirements/endState/nonGoals must also arrive).`,
  )
})

test('AC6(requirements-threaded): chunkContext includes requirements (from dispatch args)', () => {
  const src = read(PIPELINE)
  assert.match(
    src,
    /a\.requirements/,
    `${PIPELINE} must thread a.requirements into chunkContext / the builder prompt (AC6).`,
  )
})

test('AC6(endState-threaded): chunkContext includes endState (from dispatch args)', () => {
  const src = read(PIPELINE)
  assert.match(
    src,
    /a\.endState/,
    `${PIPELINE} must thread a.endState into chunkContext / the builder prompt (AC6).`,
  )
})

test('AC6(nonGoals-threaded): chunkContext includes nonGoals (from dispatch args)', () => {
  const src = read(PIPELINE)
  assert.match(
    src,
    /a\.nonGoals/,
    `${PIPELINE} must thread a.nonGoals into chunkContext / the builder prompt (AC6).`,
  )
})

// ---------------------------------------------------------------------------
// AC4 (tier-in-context): the tier from the dispatch payload must be included
// in chunkContext so the build-agent can surface it at chunk-kickoff per
// chunk-kickoff/SKILL.md Step 3 ("Surface the tier from the dispatch payload
// if present"). Without this, the build-agent has no visibility of the tier
// even though chunk-kickoff instructs it to surface the payload tier.
// ---------------------------------------------------------------------------

test('AC4(tier-in-chunkContext): chunkContext includes the dispatch-payload tier so the builder can surface it at chunk-kickoff', () => {
  const src = read(PIPELINE)

  // Locate the chunkContext declaration (the array/join block that builds the
  // prompt text the builder receives). The block starts with `const chunkContext`
  // and ends at `.join('\n')` -- extract that exact window and verify `tier` is
  // referenced within it (not in the codex-review command or elsewhere).
  const ctxStart = src.indexOf('const chunkContext')
  assert.notEqual(ctxStart, -1, `${PIPELINE} must declare chunkContext.`)
  const ctxEnd = src.indexOf(".join('\\n')", ctxStart)
  assert.notEqual(ctxEnd, -1, `${PIPELINE}: chunkContext block must end with .join('\\n').`)
  const ctxWindow = src.slice(ctxStart, ctxEnd + 12)

  // Within that window, there must be a reference to `tier` (the normalized variable
  // from a.tier) so the dispatch-payload tier reaches the builder's prompt text.
  assert.match(
    ctxWindow,
    /\$\{tier\b|\btier\b.*chunkContext|`[^`]*tier[^`]*`|a\.tier/,
    `${PIPELINE}'s chunkContext block must include the dispatch-payload tier so the build-agent ` +
      `can surface it at chunk-kickoff per chunk-kickoff/SKILL.md Step 3 ("Surface the tier ` +
      `from the dispatch payload if present"). Without this, the builder has no visibility ` +
      `of the tier even though kickoff instructs it to surface the payload tier.`,
  )
})

// ---------------------------------------------------------------------------
// REGRESSION (tier-TDZ, introduced by C4 b0ca0e8 "thread tier into chunkContext"):
// the threading added a USE of `tier` inside the `const chunkContext` block but
// left `const tier = ...` declared 38 lines LOWER, so every dispatch threw
// "ReferenceError: Cannot access 'tier' before initialization" in ~5ms, before any
// build work. The AC4(tier-in-chunkContext) test above missed it because a static
// string-match cannot see declaration ORDER. Pinned two ways: a textual order +
// single-declaration assertion, AND an actual EXECUTION of the synchronous
// prologue. The file's top-level `await agent(...)` blocks importing it whole, but
// everything BEFORE the first phase('BUILD') is pure synchronous setup and runs in
// isolation -- which is exactly the surface a static-only test is blind to.
// ---------------------------------------------------------------------------

test('regression(tier-TDZ): const tier is declared exactly once, before chunkContext reads it', () => {
  const src = read(PIPELINE)
  const decls = src.match(/\bconst tier\s*=/g) || []
  assert.equal(
    decls.length, 1,
    `${PIPELINE} must declare \`const tier\` exactly once (found ${decls.length}). Two is the ` +
      `half-applied-fix failure ("Identifier 'tier' has already been declared").`,
  )
  const declIdx = src.indexOf('const tier =')
  const ctxIdx = src.indexOf('const chunkContext')
  assert.ok(declIdx !== -1 && ctxIdx !== -1, `${PIPELINE} must declare both const tier and const chunkContext.`)
  assert.ok(
    declIdx < ctxIdx,
    `${PIPELINE}: \`const tier\` (index ${declIdx}) must be declared BEFORE \`const chunkContext\` ` +
      `(index ${ctxIdx}), which reads tier at its Tier line. Declaring it after is the TDZ bug (C4 b0ca0e8).`,
  )
})

test('regression(tier-TDZ): the synchronous prologue executes without a temporal-dead-zone ReferenceError', async () => {
  const src = read(PIPELINE)
  const cut = src.indexOf("phase('BUILD')")
  assert.notEqual(cut, -1, `${PIPELINE} must contain phase('BUILD') -- the prologue/stage boundary.`)
  // Everything before the first phase('BUILD') is synchronous setup (schemas,
  // tierConfig, the normalized tier, chunkContext). Run it with the harness globals
  // it could touch stubbed, so the ONLY thing that can throw is a TDZ: `tier` read
  // by chunkContext before `const tier` is initialized.
  const prologue =
    "globalThis.args = { chunkId:'tdz', worktree:'/tmp/x', branch:'b', tier:'A', taskStatement:'t', acceptanceCriteria:'a' };\n" +
    "globalThis.phase = () => {}; globalThis.log = () => {}; globalThis.agent = async () => ({});\n" +
    "globalThis.parallel = async (xs) => xs.map(() => ({})); globalThis.workflow = async () => ({});\n" +
    "globalThis.budget = { total: null, spent: () => 0, remaining: () => Infinity };\n" +
    src.slice(0, cut)
  // A clean import == the declaration order is correct; a TDZ rejects the import.
  await import('data:text/javascript,' + encodeURIComponent(prologue))
})
