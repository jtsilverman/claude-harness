// codex-fallback-opus.test.mjs -- RED for chunk codex-fallback-opus
//   (lean-system-rebuild, 2026-06-13):
//   Upgrade the Codex-outage fallback from a second Sonnet pass to an OPUS
//   full-scope review, so when the cross-vendor Codex lens is down the fallback
//   is a stronger lens.
//
// CONTRACT under test (from the dispatch payload + spec):
//   AC1: the codexFallback dispatch uses model:'opus', NOT reviewerFor(tier).agentType
//        (i.e. the fallback is NOT the Sonnet chunk-reviewer agentType).
//   AC2: `degraded` is still set true on the Codex-outage fallback path (unchanged signal).
//   AC3: the PRIMARY Sonnet full-scope chunk-reviewer lens still runs on every tier
//        (the primary Sonnet dispatch is unchanged -- fallback-ONLY change).
//   AC4: the opus fallback carries the full-scope review contract
//        (injectedDocBlock('review-contract', ...) is present in sonnetLensPrompt,
//        which the fallback reuses) and returns REVIEW_RESULT schema, and its result
//        is gathered into findings via gatherFindings.
//
// Source-inspection idiom (same as tier-s-adversarial.test.mjs / c8 / c5):
//   The REVIEW block lives in a Workflow script (agent()/parallel() only exist in the
//   harness), so we static-analyze the source text and assert on its structure.
//   The fallback dispatch block is targeted by its label string (the unique anchor).
//
// Run: node --test workflows/codex-fallback-opus.test.mjs
// Full suite: node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')

const PIPELINE = read('workflows/worker-pipeline.js')

// ── AC1: codexFallback dispatch uses model:'opus', NOT reviewerFor agentType ──

test('AC1: codexFallback dispatch carries model:opus and does NOT use reviewerFor(tier).agentType', () => {
  // The fallback block is anchored by `codexFallback = await agent(`. We locate
  // THAT specific call (not the sonnetLensPrompt comment or function body which
  // also mention 'codex-fallback') and inspect the opts object for model:'opus'.
  //
  // The old shape was:
  //   { agentType: reviewerFor(tier).agentType, label: `codex-fallback:${chunkId}`, ... }
  // The new shape must carry model:'opus' instead of agentType.
  const callIdx = PIPELINE.indexOf('codexFallback = await agent(')
  assert.ok(
    callIdx !== -1,
    'codexFallback = await agent( not found in worker-pipeline.js -- the fallback dispatch block may have been removed or renamed',
  )

  // Capture the full agent() call opts -- 400 chars forward is enough for the
  // single-line opts object.
  const callWindow = PIPELINE.slice(callIdx, callIdx + 400)

  // The fallback agent() call must carry model:'opus'.
  assert.match(
    callWindow,
    /model:\s*'opus'/,
    "the codexFallback agent() call must carry model:'opus' -- the fallback was upgraded from Sonnet to Opus but model:'opus' is not present in the dispatch opts",
  )

  // The fallback agent() call must NOT dispatch via reviewerFor(tier).agentType --
  // that is the old Sonnet-reviewer shape the chunk replaces.
  assert.doesNotMatch(
    callWindow,
    /agentType:\s*reviewerFor\(tier\)\.agentType/,
    "the codexFallback agent() call must NOT use reviewerFor(tier).agentType (the old Sonnet-reviewer shape) -- it was replaced by model:'opus'",
  )
})

// ── AC2: degraded is still set true on the Codex-outage fallback path ──

test('AC2: degraded is still set true on the Codex-outage fallback path', () => {
  // The fallback block guards on codexReview.ran === false and must set degraded=true.
  // We assert the guard condition and the assignment are both still present.
  assert.match(
    PIPELINE,
    /codexReview\.ran === false/,
    'the Codex-outage guard (codexReview.ran === false) must still be present -- degraded is gated by it',
  )
  assert.match(
    PIPELINE,
    /degraded\s*=\s*true/,
    'degraded = true must still be assigned in the Codex-outage fallback block',
  )
  // And it must reach the return bundle (so the cockpit sees the flag).
  assert.match(
    PIPELINE,
    /degraded\s*:/,
    'degraded must be surfaced as a return-bundle field (degraded:) so the cockpit can read it',
  )
})

// ── AC3: the PRIMARY Sonnet full-scope chunk-reviewer lens is unchanged ──

test('AC3: the primary Sonnet chunk-reviewer lens (every-tier) is still present and unchanged', () => {
  // The primary Sonnet reviewer is dispatched via reviewerFor(tier).agentType and
  // labelled sonnet:${chunkId} inside the REVIEW parallel block. The fallback
  // change must NOT remove or alter it.
  assert.match(
    PIPELINE,
    /label:\s*`sonnet:\$\{chunkId\}`/,
    'the primary Sonnet full-scope lens (label: `sonnet:${chunkId}`) must still be present in the REVIEW parallel block',
  )
  assert.match(
    PIPELINE,
    /agentType:\s*reviewerFor\(tier\)\.agentType[\s\S]{0,200}?label:\s*`sonnet:\$\{chunkId\}`|label:\s*`sonnet:\$\{chunkId\}`[\s\S]{0,200}?agentType:\s*reviewerFor\(tier\)\.agentType/,
    'the primary Sonnet lens dispatch must still use reviewerFor(tier).agentType (keyed by tier) with the sonnet label',
  )
})

// ── AC4: fallback carries review-contract + REVIEW_RESULT schema + feeds gatherFindings ──

test('AC4: sonnetLensPrompt (used by the fallback) still injects disciplines/review-contract.md', () => {
  // The fallback calls sonnetLensPrompt('codex-fallback') which internally calls
  // injectedDocBlock('review-contract', 'disciplines/review-contract.md', ...).
  // That injection is the mechanism that delivers the full-scope contract to the
  // opus agent. Assert it is still present in the sonnetLensPrompt body.
  //
  // Extract the sonnetLensPrompt function body.
  const m = PIPELINE.match(/function sonnetLensPrompt\([\s\S]*?\n\}/)
  assert.ok(m, 'sonnetLensPrompt() must exist in worker-pipeline.js')
  const fn = m[0]

  assert.match(
    fn,
    /injectedDocBlock\('review-contract'/,
    'sonnetLensPrompt must call injectedDocBlock(\'review-contract\', ...) to deliver disciplines/review-contract.md to the fallback agent -- this injection was present before and must remain',
  )
})

test('AC4: codexFallback agent() call carries schema REVIEW_RESULT', () => {
  // The fallback must return REVIEW_RESULT so gatherFindings can consume its output.
  // Anchor on the actual agent() call, not the comment or sonnetLensPrompt body.
  const callIdx = PIPELINE.indexOf('codexFallback = await agent(')
  assert.ok(callIdx !== -1, 'codexFallback = await agent( not found')
  const callWindow = PIPELINE.slice(callIdx, callIdx + 400)

  assert.match(
    callWindow,
    /schema:\s*REVIEW_RESULT/,
    'the codexFallback agent() call must carry schema:REVIEW_RESULT so its findings are in the right shape for gatherFindings',
  )
})

test('AC4: codexFallback is gathered into findings via collectReviewerFindings', () => {
  // pipeline-meritocracy chunk 2: the reviewers' findings (incl. the codex-fallback
  // pass when Codex was down) are gathered for the JUDGE via collectReviewerFindings.
  // codexFallback must be in THAT call so its findings reach the judge's adjudication
  // exactly as before.
  const m = PIPELINE.match(/=\s*collectReviewerFindings\(([^)]*)\)/)
  assert.ok(m, 'could not locate the judge seeding `collectReviewerFindings(...)` call')
  const args = m[1]
  assert.match(
    args,
    /codexFallback/,
    'the seeding collectReviewerFindings(...) call must include codexFallback so its findings reach the judge',
  )
})
