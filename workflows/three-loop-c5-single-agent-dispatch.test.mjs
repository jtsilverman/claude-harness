// RED test for three-loop-rebuild chunk 5:
//   "single-agent dispatch + verification wiring"
//
// This chunk is the TRANSITION SWITCH of the whole rebuild: it rewrites the
// worker pipeline to dispatch ONE build-agent (which runs recall -> RED -> GREEN
// -> refactor -> self-check -> commit in one continuous context, merged
// in chunk 4) instead of the old five-context relay (recall / test-author /
// implementer / checkpoint / reviewer split across separate agents). The
// per-criterion acceptance grade and the Codex/Sonnet verification net stay as
// SEPARATE fresh-context steps OUTSIDE the build-agent -- a maker grading its own
// omissions is the blindness that split exists to catch.
//
// The chunk's FULL acceptance contract, pinned here as one suite of focused
// assertions so an implementation that satisfies only the first criterion (a
// plausible shadow) cannot pass:
//
//   (1) tier-dispatch.mjs's tierConfig returns the SINGLE-AGENT dial
//       { buildAgent, buildModel } -- light=Tier C, base=Tier B, heavy=Tier A/S --
//       NOT the old per-stage { redAgent, greenAgent, redModel, greenModel }. This
//       is the authoritative proof: tier-dispatch.mjs is pure data + import-safe,
//       so it is imported directly and its return VALUES asserted (not text).
//   (2) The old per-stage field NAMES (redAgent / greenAgent / redModel / greenModel)
//       are GONE from tierConfig's return -- the split is a real replacement, not
//       additive. (`rg -n 'redAgent|greenAgent'` must return nothing -- an explicit
//       acceptance criterion -- so we assert the SOURCE TEXT of BOTH files is clean.)
//   (3) worker-pipeline.js dispatches ONE build-agent: it spawns the tier-selected
//       build-agent (agentType drawn from the dial's buildAgent) and NO LONGER
//       spawns the old build-relay agentTypes ('recall' / 'test-author' /
//       'implementer'), which collapse into the build-agent's single context.
//   (4) The per-criterion acceptance check stays a SEPARATE fresh-context Sonnet
//       agent() step OUTSIDE the build-agent (NOT folded into the build-agent's
//       prompt) -- so worker-pipeline.js still spawns a distinct per-criterion /
//       Sonnet reviewer agent().
//   (5) The Codex cost-gate is FLIPPED so Tier C now FIRES Codex: the deliberate
//       cost-skip gate must no longer exclude C. (Previously C/absent were skipped;
//       now C yields a Codex result.)
//   (6) The Codex-UNAVAILABLE fallback exists: on a Codex error / quota-exhaust the
//       pipeline falls back to ONE fresh-context Sonnet review pass and flags the
//       run `degraded` -- a chunk never ships with zero independent verification.
//   (7) The return bundle PRESERVES the shape the cockpit consumes (red / green /
//       review.codex / review.sonnet / review.drafted / review.explanation /
//       review.proof / status) AND the captures field is ABSENT -- the builder emits
//       only RAW lessonCandidates; the memory-agent reconciles downstream (no
//       draft-capture step; the pipeline must NOT surface a captures field).
//
// Test strategy (the two established proofs next door in tier-dispatch.test.mjs /
// merge-robustness.test.mjs / subagent-self-sufficiency.test.mjs):
//   - tier-dispatch.mjs is pure data + import-safe (no top-level side effects), so
//     it is IMPORTED and its return values asserted directly -- the authoritative
//     dial proof (criteria 1, 2-on-the-module).
//   - worker-pipeline.js executes the pipeline at top level on import (top-level
//     `await agent(...)`, no import.meta.url guard) and references Workflow harness
//     globals (agent / parallel / phase) absent in a unit-test context, so it
//     CANNOT be imported -- importing it would run the pipeline / crash on load.
//     Its wiring is therefore asserted as STATIC SOURCE TEXT (criteria 2-on-the-
//     pipeline, 3, 4, 5, 6, 7). A live end-to-end run of the whole pipeline (real
//     Workflow host + real subagents + real Codex) is impractical in-worktree; per
//     the chunk's own acceptance criterion ("one chunk runs through end-to-end OR a
//     documented dry-run if a live run is impractical in-worktree") and the
//     workflow-host-requires-live-end-to-end-smoke-test pattern, the structural
//     proof here is the documented dry-run -- the COO runs the live one-chunk pass
//     at merge.
//
// No tautology: every expected value (the dial shape, the build-agent names, the
// gate-flip, the degraded fallback, the preserved bundle keys) is fixed from the
// chunk's task statement + acceptance criteria BELOW, before any implementation is
// written -- never read back from the implementation.
//
// Run: node --test workflows/three-loop-c5-single-agent-dispatch.test.mjs
// Full suite (GLOB form -- bare `node --test workflows/` errors MODULE_NOT_FOUND on Node v25):
//   node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { tierConfig } from './tier-dispatch.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const PIPELINE = 'workflows/worker-pipeline.js'
const DISPATCH = 'workflows/tier-dispatch.mjs'

// The authoritative SINGLE-AGENT dial, fixed from the chunk task statement:
// "tier -> which build-agent file (light=Tier C, base=Tier B, heavy=Tier A, max=Tier S) +
// model". pipeline-meritocracy c1 collapsed the dial to 2 tiers (default | heavy),
// opus everywhere; legacy S/A/B/C still resolve (A/S -> heavy, B/C/absent -> default).
// Each row: tier input -> expected build-agent FILE (frontmatter sets effort) + model.
const DIAL = [
  { tier: 'default', buildAgent: 'build-agent',       buildModel: 'opus' },
  { tier: 'heavy',   buildAgent: 'build-agent-heavy', buildModel: 'opus' },
  { tier: 'C', buildAgent: 'build-agent',       buildModel: 'opus' },
  { tier: 'B', buildAgent: 'build-agent',       buildModel: 'opus' },
  { tier: 'A', buildAgent: 'build-agent-heavy', buildModel: 'opus' },
  { tier: 'S', buildAgent: 'build-agent-heavy', buildModel: 'opus' },
]

// === Criterion 1: tierConfig returns the single-agent dial { buildAgent, buildModel } ===

for (const { tier, buildAgent, buildModel } of DIAL) {
  test(`AC1(dial): tier ${tier} -> buildAgent '${buildAgent}' / buildModel '${buildModel}'`, () => {
    const cfg = tierConfig(tier)
    assert.equal(
      cfg.buildAgent,
      buildAgent,
      `tierConfig('${tier}').buildAgent must be '${buildAgent}'. The chunk collapses the five-agent ` +
        `relay into ONE build-agent dispatch, so tierConfig must return a SINGLE-agent dial ` +
        `{ buildAgent, buildModel } (default=build-agent, heavy=build-agent-heavy) -- not the old ` +
        `per-stage { redAgent, greenAgent }. Got: ${JSON.stringify(cfg)}`,
    )
    assert.equal(
      cfg.buildModel,
      buildModel,
      `tierConfig('${tier}').buildModel must be '${buildModel}' (the dispatch model for the build-agent ` +
        `spawn: opus on both tiers). Got: ${JSON.stringify(cfg)}`,
    )
  })
}

test("AC1(dial): absent / unknown tier defaults to the base build-agent (the default tier's pair)", () => {
  // An absent/unknown tier must fall through to the base builder (build-agent at
  // model opus), the single-agent analogue of the old "default -> base" fall-through.
  for (const t of [undefined, '', 'wat']) {
    const cfg = tierConfig(t)
    assert.equal(
      cfg.buildAgent,
      'build-agent',
      `tierConfig(${JSON.stringify(t)}).buildAgent must default to 'build-agent' (the default-tier ` +
        `builder). Got: ${JSON.stringify(cfg)}`,
    )
    assert.equal(
      cfg.buildModel,
      'opus',
      `tierConfig(${JSON.stringify(t)}).buildModel must default to 'opus' (opus everywhere). ` +
        `Got: ${JSON.stringify(cfg)}`,
    )
  }
})

test('AC1(dial): tier input is case-insensitive (lowercase resolves like uppercase)', () => {
  const upper = tierConfig('A')
  const lower = tierConfig('a')
  assert.equal(lower.buildAgent, upper.buildAgent, "tierConfig('a').buildAgent must equal tierConfig('A').buildAgent")
  assert.equal(lower.buildModel, upper.buildModel, "tierConfig('a').buildModel must equal tierConfig('A').buildModel")
  assert.equal(upper.buildAgent, 'build-agent-heavy', "tierConfig('A').buildAgent must be 'build-agent-heavy'")
})

// === Criterion 2: the old per-stage relay fields are GONE (real replacement, not additive) ===

test("AC2(dial): tierConfig no longer returns the old per-stage relay fields", () => {
  // The single-agent dial REPLACES the per-stage dial. A lingering redAgent /
  // greenAgent / redModel / greenModel on the return would mean the five-agent
  // relay could still be wired -- so assert all four are absent on a representative tier.
  const cfg = tierConfig('A')
  for (const dead of ['redAgent', 'greenAgent', 'redModel', 'greenModel']) {
    assert.ok(
      !(dead in cfg),
      `tierConfig still returns the old per-stage field '${dead}' (${JSON.stringify(cfg[dead])}). ` +
        `The chunk replaces the five-agent relay dial with the single-agent { buildAgent, buildModel }; ` +
        `every per-stage field must be removed. Got: ${JSON.stringify(cfg)}`,
    )
  }
})

test("AC2(grep): `rg -n 'redAgent|greenAgent'` returns nothing in BOTH files", () => {
  // The chunk's explicit acceptance criterion. Both the canonical module AND the
  // verbatim inline copy in worker-pipeline.js (Workflow sandbox has no module
  // resolution) must drop every redAgent/greenAgent reference, INCLUDING in comments.
  for (const rel of [DISPATCH, PIPELINE]) {
    const body = read(rel)
    assert.doesNotMatch(
      body,
      /redAgent/,
      `${rel} still contains 'redAgent'. The acceptance criterion is \`rg -n 'redAgent|greenAgent'\` ` +
        `returns nothing in worker-pipeline.js / tier-dispatch.mjs -- every reference (code AND comments) ` +
        `must go when the relay dial is replaced by the single-agent dial.`,
    )
    assert.doesNotMatch(
      body,
      /greenAgent/,
      `${rel} still contains 'greenAgent'. The acceptance criterion requires zero redAgent/greenAgent ` +
        `references across both files.`,
    )
  }
})

// === Criterion 3: worker-pipeline.js dispatches ONE build-agent (relay agentTypes are gone) ===

test('AC3(one-build): worker-pipeline.js dispatches the tier-selected build-agent', () => {
  const body = read(PIPELINE)
  // The build dispatch must spawn the dial's buildAgent. After the collapse, the
  // build spawn's agentType reads from the single-agent dial field (buildAgent).
  assert.match(
    body,
    /agentType:\s*\w*\.?buildAgent\b/,
    `${PIPELINE} does not dispatch the build-agent via the single-agent dial. The collapsed pipeline must ` +
      `spawn ONE build-agent whose agentType comes from the dial's buildAgent field (e.g. ` +
      `\`agentType: tierCfg.buildAgent\`), replacing the old per-stage tierCfg.redAgent / tierCfg.greenAgent spawns.`,
  )
})

test('AC3(no-relay): worker-pipeline.js no longer spawns the build-relay agentTypes (recall / test-author / implementer)', () => {
  const body = read(PIPELINE)
  // recall, RED (test-author), and GREEN (implementer) were three separate relay
  // contexts; chunk 4 merged them INTO the build-agent's one continuous context.
  // None of those three may survive as an agentType spawn for the build itself.
  // (The verification net's Sonnet reviewer agentType is reviewerFor(...).agentType,
  // a DIFFERENT string entirely, so this does not catch the legitimate review stage.)
  assert.doesNotMatch(
    body,
    /agentType:\s*'recall'/,
    `${PIPELINE} still spawns a separate 'recall' agent. Recall collapses INTO the build-agent's one ` +
      `continuous context (chunk 4); the pipeline must not spawn it as its own relay stage.`,
  )
  assert.doesNotMatch(
    body,
    /agentType:\s*'test-author(-light|-heavy)?'/,
    `${PIPELINE} still spawns a separate 'test-author' (RED) agent. The RED stage collapses INTO the ` +
      `build-agent; no standalone test-author spawn may remain.`,
  )
  assert.doesNotMatch(
    body,
    /agentType:\s*'implementer(-light|-heavy)?'/,
    `${PIPELINE} still spawns a separate 'implementer' (GREEN) agent. The GREEN stage collapses INTO the ` +
      `build-agent; no standalone implementer spawn may remain.`,
  )
})

// === Criterion 4: the per-criterion acceptance check stays a SEPARATE fresh-context step ===

test('AC4(separate-check): the per-criterion acceptance check runs in its own fresh-context agent (build-agent dispatched AND a separate reviewer spawn coexist)', () => {
  const body = read(PIPELINE)
  // "a maker grading its own omissions is the blindness it exists to catch": the
  // per-criterion check must be a DISTINCT agent() spawn, OUTSIDE the build-agent.
  // The post-rewrite shape is: ONE build-agent dispatch (agentType from the dial's
  // buildAgent) AND a SEPARATE Sonnet reviewer spawn (agentType reviewerFor(...))
  // that carries the per-criterion grade. We assert BOTH coexist -- this fails on
  // HEAD (where the build-agent dispatch does not yet exist), so it is a real RED,
  // not a pure-preservation green; and it stays satisfied only if the implementer
  // KEEPS the per-criterion check as its own spawn rather than folding it into the
  // build-agent prompt.
  assert.match(
    body,
    /agentType:\s*\w*\.?buildAgent\b/,
    `${PIPELINE} must dispatch the build-agent (agentType from the dial's buildAgent) -- the single-agent ` +
      `build context the per-criterion check sits OUTSIDE of. Until that dispatch exists, the "separate check" ` +
      `invariant has no build-agent to be separate from.`,
  )
  assert.match(
    body,
    /agentType:\s*reviewerFor\(/,
    `${PIPELINE} no longer spawns a separate Sonnet reviewer (reviewerFor(...).agentType). The per-criterion ` +
      `acceptance check must run in its OWN fresh context OUTSIDE the build-agent -- it must not be folded into ` +
      `the build-agent's prompt (a maker grading its own omissions is the blindness it exists to catch).`,
  )
  assert.match(
    body,
    /per-criterion/i,
    `${PIPELINE} no longer references the 'per-criterion' acceptance check. It must survive as a SEPARATE ` +
      `fresh-context grading step (the omission-defect countermeasure), distinct from the build-agent.`,
  )
})

// === Criterion 5: the Codex gate uses normalizeTier (2-tier: both tiers fire) ===
//
// pipeline-meritocracy c1 collapsed the 4-tier dial to 2 tiers (default | heavy).
// Tier C no longer exists -- it folds into `default`. Both live tiers fire the Codex
// lens (gpt-5.4-mini/medium at default, gpt-5.5/xhigh at heavy per coo-sop.md § 6).
// The gate must use normalizeTier() to correctly handle new-vocab (`default`/`heavy`)
// AND legacy (A/S/B/C) chunks. Raw `tier === 'A' || tier === 'S' || tier === 'B'` is
// the broken form: new-vocab `tier` is uppercased to 'DEFAULT'/'HEAVY' and never
// matches those literals -- Codex silently skips every new-spec chunk.
test('AC5(cost-gate): the Codex gate uses normalizeTier (both 2-tier values fire)', () => {
  const body = read(PIPELINE)
  // The gate must use normalizeTier, not raw old-vocab tier literals.
  assert.doesNotMatch(
    body,
    /tier\s*===\s*'A'\s*\|\|\s*tier\s*===\s*'S'\s*\|\|\s*tier\s*===\s*'B'/,
    `${PIPELINE} still uses the raw tier === 'A' || 'S' || 'B' gate. After the 2-tier collapse, ` +
      `tier is uppercased ('DEFAULT'/'HEAVY') and those literals never match. Use normalizeTier().`,
  )
  // The gate must reference normalizeTier so both new-vocab AND legacy inputs resolve.
  assert.match(
    body,
    /normalizeTier\(tier\)/,
    `${PIPELINE}'s codexFires gate must use normalizeTier(tier) so new-vocab chunks ('default'/'heavy') ` +
      `fire the Codex lens correctly (both tiers have a Codex entry in coo-sop.md § 6).`,
  )
  // The Codex agent() dispatch must still be GUARDED by that gate (not unconditional).
  assert.match(
    body,
    /codexFires\s*\?\s*agent\(/,
    `${PIPELINE}'s Codex lens dispatch must be guarded by the cost-gate (codexFires).`,
  )
})

// === Criterion 6: the Codex-unavailable fallback -> one Sonnet review pass + flag degraded ===

test('AC6(fallback): a Codex outage falls back to a fresh-context Sonnet review pass and flags the run `degraded`', () => {
  const body = read(PIPELINE)
  // On Codex error/quota-exhaust the pipeline must NOT ship with zero independent
  // verification: it falls back to ONE fresh-context Sonnet review pass and marks
  // the run degraded. 'degraded' appears NOWHERE in the current pipeline (verified
  // at RED-authoring time), so its presence is the load-bearing signal the fallback
  // was wired. We require the literal `degraded` marker AND that it is surfaced in
  // the returned bundle (a flag the cockpit can read), not merely a local variable.
  assert.match(
    body,
    /degraded/,
    `${PIPELINE} never mentions 'degraded'. The chunk adds a Codex-unavailable fallback: on a Codex ` +
      `error/quota-exhaust, fall back to ONE fresh-context Sonnet review pass and flag the run \`degraded\` ` +
      `so a chunk never ships with zero independent verification. The current pipeline has no such flag.`,
  )
  // The degraded flag must reach the RETURN bundle (so the cockpit/CEO sees the
  // run was verified by the fallback, not the primary Codex lens). Assert a
  // `degraded:` key appears inside a returned object structure.
  assert.match(
    body,
    /degraded\s*:/,
    `${PIPELINE} mentions 'degraded' but never sets it as a bundle field (\`degraded: ...\`). The fallback's ` +
      `degraded flag must be SURFACED in the pipeline's return bundle so the cockpit can flag the run as ` +
      `verified-by-fallback (no zero-verification ship).`,
  )
})

// === Criterion 7: the bundle shape is preserved; captures REMOVED (RAW-only design) ===

test('AC7(bundle): the return bundle preserves the shape the cockpit consumes [PRESERVATION GUARD]', () => {
  const body = read(PIPELINE)
  // PRESERVATION GUARD (intentionally green on HEAD): the chunk task says
  // "preserve the existing bundle shape the cockpit consumes (red/green/review/
  // drafted fields) as much as possible so the cockpit keeps working." This
  // assertion pins that the single-agent collapse does NOT regress those fields --
  // it is satisfied by HEAD by design and must STAY satisfied after the rewrite.
  // The cockpit reads review.codex / review.sonnet / review.explanation /
  // review.proof / review.drafted / status / red / green at merge; collapsing to
  // one build-agent must NOT break these consumed fields.
  for (const key of ['codex:', 'sonnet:', 'explanation:', 'proof:', 'drafted:']) {
    assert.match(
      body,
      new RegExp(key.replace(':', '\\s*:')),
      `${PIPELINE}'s return bundle no longer carries the cockpit-consumed field '${key.replace(':', '')}'. ` +
        `The chunk must PRESERVE the existing bundle shape (review.codex / review.sonnet / review.explanation / ` +
        `review.proof / review.drafted) so the cockpit keeps working after the single-agent collapse.`,
    )
  }
  assert.match(
    body,
    /status:\s*\S/,
    `${PIPELINE}'s return bundle no longer sets a 'status' field. The cockpit reads bundle.status ` +
      `('awaiting-review' | 'failed') to route the chunk; it must be preserved. (Matches \`status:\` ` +
      `followed by any value -- a ternary, an identifier, or a literal.)`,
  )
})

test('AC7(captures-absent): the OLD draft-captures field is NOT surfaced in the bundle (RAW-only design)', () => {
  const body = read(PIPELINE)
  // scrub-captures chunk: the build-agent now emits only RAW lessonCandidates;
  // the OLD 'captures' (DRAFT capture-learning output) field was removed from
  // BUILD_RESULT and must NOT appear as a return key in the bundle's drafted block.
  // The memory path is lessonCandidates -> memory-agent downstream (build-agent.md:29).
  assert.doesNotMatch(
    body,
    /captures\s*:\s*build\.captures/,
    `${PIPELINE} still returns 'captures: build.captures' in its bundle. The scrub-captures ` +
      `chunk removed the OLD draft-captures field: the builder now emits only RAW lessonCandidates ` +
      `(+ recallVerify); the memory-agent reconciles downstream. No 'captures' key should be ` +
      `surfaced in the return bundle -- it was dead output no consumer read.`,
  )
})
