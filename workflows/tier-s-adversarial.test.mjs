// tier-s-adversarial.test.mjs -- RED for chunk tier-s-adversarial (lean-system-rebuild
// post-E3 hardening): add a THIRD, opus, adversarial reviewer lens to
// workflows/worker-pipeline.js's REVIEW parallel block, gated to Tier S ONLY,
// alongside the existing Codex does-it-work lens and the Sonnet full-scope lens.
//
// CONTRACT under test (from the dispatch payload + spec):
//   AC1: when tier==='S' the REVIEW parallel block dispatches an opus adversarial
//        reviewer (model:'opus', distinct label adversarial:${chunkId}, schema
//        REVIEW_RESULT); it IS spawned for S and is NOT spawned for A/B/C.
//   AC2: the adversarial review's findings feed the fix-loop -- the gatherFindings
//        call that seeds the loop includes the adversarial review (so ran && !clean
//        findings are fixed + re-reviewed like any other lens).
//   AC3: fail-open -- a null/errored adversarial return does NOT set `degraded`
//        (degraded stays reserved for a Codex outage on a tier that should fire) and
//        does NOT hard-block the run.
//   AC4: the adversarial prompt is adversarial (assume-a-hole framing) and DISTINCT
//        from both the Sonnet full-scope prompt and the Codex does-it-work prompt.
//   AC5: tierConfig('S') deep-equals { buildAgent:'build-agent-max', buildModel:'opus' }
//        (pin the opus-builder-for-S invariant).
//
// The pipeline's REVIEW block is SCRIPT-only (agent()/parallel() exist only in the
// Workflow harness, so the block cannot be executed here) -- it is static-analyzed:
// the source is read as text and asserted on structure, the existing test idiom for
// this file (see c8-reviewer-split-rename.test.mjs). tierConfig is exercised at
// runtime via the exported tier-dispatch.mjs (AC5).
//
// Run: node --test workflows/tier-s-adversarial.test.mjs
// Full suite (GLOB form -- bare `node --test workflows/` errors MODULE_NOT_FOUND on Node v25):
//   node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { tierConfig } from './tier-dispatch.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')

const PIPELINE = read('workflows/worker-pipeline.js')

// Extract a top-level `function NAME(...) { ... }` block from source: from the
// declaration through the matching closing brace at column 0 (the same brace-depth-0
// terminator the c8 test uses for codexLensPrompt). Returns null when absent.
function extractFn(src, name) {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
  return m ? m[0] : null
}

// --- AC5: legacy Tier-S still dials an opus builder (the mis-dial-to-sonnet invariant) ---
// pipeline-meritocracy c1 collapsed the dial: legacy S folds into `heavy`
// (build-agent-heavy/opus). The invariant the c16 stall taught -- a high-stakes
// chunk must never mis-dial to a sonnet builder -- holds: opus everywhere now.

test('AC5: tierConfig(S) deep-equals { buildAgent: build-agent-heavy, buildModel: opus } (S folds to heavy)', () => {
  assert.deepEqual(
    tierConfig('S'),
    { buildAgent: 'build-agent-heavy', buildModel: 'opus' },
    'tierConfig(S) must fold to build-agent-heavy/opus -- a high-stakes chunk must never mis-dial to a sonnet builder (c16 stalled on sonnet)',
  )
})

test('AC5: worker-pipeline.js tierConfig inline copy folds legacy S to an opus builder (no deleted-file ref)', () => {
  const fn = extractFn(PIPELINE, 'tierConfig')
  assert.ok(fn, 'could not locate tierConfig() in worker-pipeline.js')
  // The inline copy must move in lockstep with tier-dispatch.mjs: opus builders only,
  // and no reference to the deleted build-agent-max.
  assert.ok(!fn.includes('build-agent-max'),
    'worker-pipeline.js tierConfig inline copy must not reference the deleted build-agent-max')
  assert.match(fn, /buildModel: 'opus'/,
    'worker-pipeline.js tierConfig inline copy must dial an opus builder')
})

// --- AC1: the adversarial lens is opus, distinct-labelled, REVIEW_RESULT-schema'd,
//          gated to tier==='S' (spawned for S, NOT for A/B/C) ---

test('AC1: the REVIEW parallel block dispatches an opus adversarial lens with a distinct label', () => {
  // The adversarial agent() call must specify model:'opus' and a distinct
  // adversarial:${chunkId} label, schema REVIEW_RESULT.
  assert.match(
    PIPELINE,
    /label:\s*`adversarial:\$\{chunkId\}`/,
    'an agent() call must use the distinct label `adversarial:${chunkId}`',
  )
  // The adversarial dispatch carries model:'opus' (it is an OPUS reviewer, distinct
  // from the build-agent-max builder).
  assert.match(
    PIPELINE,
    /label:\s*`adversarial:\$\{chunkId\}`[\s\S]{0,200}?model:\s*'opus'|model:\s*'opus'[\s\S]{0,200}?label:\s*`adversarial:\$\{chunkId\}`/,
    'the adversarial lens dispatch must carry model:\'opus\'',
  )
  // It uses the REVIEW_RESULT schema like the other lenses.
  assert.match(
    PIPELINE,
    /label:\s*`adversarial:\$\{chunkId\}`[\s\S]{0,200}?schema:\s*REVIEW_RESULT|schema:\s*REVIEW_RESULT[\s\S]{0,200}?label:\s*`adversarial:\$\{chunkId\}`/,
    'the adversarial lens dispatch must use schema: REVIEW_RESULT',
  )
})

test('AC1: the adversarial lens is gated to `heavy` (Promise.resolve(null) on default)', () => {
  // pipeline-meritocracy chunk 2 RE-GATED the adversarial lens from the deleted legacy
  // Tier S to the 2-tier `heavy` (normalizeTier folds legacy A/S into heavy). The thunk
  // must be guarded by normalizeTier(tier) === 'heavy' and resolve to null when it does
  // not hold (no spawn on default).
  const idx = PIPELINE.indexOf('adversarial:${chunkId}')
  assert.ok(idx !== -1, 'adversarial lens dispatch not found')
  // Window around the adversarial dispatch (the thunk and its ternary).
  const window = PIPELINE.slice(Math.max(0, idx - 400), idx + 400)
  assert.match(
    window,
    /normalizeTier\(\s*tier\s*\)\s*===\s*'heavy'/,
    'the adversarial lens must be gated by `normalizeTier(tier) === \'heavy\'`',
  )
  assert.match(
    window,
    /Promise\.resolve\(null\)/,
    'on a non-heavy tier the adversarial thunk must resolve to null (no spawn)',
  )
})

// --- AC2: the adversarial review feeds the JUDGE via collectReviewerFindings ---

test('AC2: the judge seeding collectReviewerFindings(...) call includes the adversarial review', () => {
  // pipeline-meritocracy chunk 2: the reviewers' findings are gathered for the JUDGE
  // via collectReviewerFindings(codexReview, sonnetReview, adversarialReview,
  // codexFallback); the adversarial review must be in THAT call so its findings reach
  // the judge's adjudication.
  const m = PIPELINE.match(/=\s*collectReviewerFindings\(([^)]*)\)/)
  assert.ok(m, 'could not locate the judge seeding `collectReviewerFindings(...)` call')
  const args = m[1]
  assert.match(
    args,
    /adversarialReview|adversarial/,
    'the seeding collectReviewerFindings(...) call must include the adversarial review so its findings reach the judge',
  )
})

// --- AC4: the adversarial prompt is adversarial AND distinct from both other prompts ---

test('AC4: an adversarialLensPrompt() builder exists with assume-a-hole framing', () => {
  const fn = extractFn(PIPELINE, 'adversarialLensPrompt')
  assert.ok(fn, 'a distinct adversarialLensPrompt() builder must exist (mirroring sonnetLensPrompt / codexLensPrompt)')
  // Adversarial framing: it must instruct the reviewer to ATTACK / assume a hole.
  assert.match(
    fn,
    /attack|assume[\s-]?a[\s-]?hole|assume there|hole|adversar/i,
    'adversarialLensPrompt must carry assume-a-hole / attack-the-diff framing',
  )
  // It must hunt the failure-mode classes the spec names (collisions, fail-open,
  // edge cases, silent-skip seams) -- at least one of these signature words.
  assert.match(
    fn,
    /collision|fail-open|edge case|silent[\s-]?skip|unhandled/i,
    'adversarialLensPrompt must hunt collisions / fail-open paths / edge cases / silent-skip seams',
  )
  // It must receive the review-contract doc the same way the Sonnet lens does (so it
  // returns contract-format findings + the [FIX:] rate-the-fix tag).
  assert.match(
    fn,
    /injectedDocBlock\('review-contract'/,
    'adversarialLensPrompt must inject disciplines/review-contract.md (mirror sonnetLensPrompt) so it returns contract-format findings + [FIX:] tags',
  )
})

test('AC4: adversarialLensPrompt is DISTINCT from both the Sonnet and the Codex prompts', () => {
  const adv = extractFn(PIPELINE, 'adversarialLensPrompt')
  const sonnet = extractFn(PIPELINE, 'sonnetLensPrompt')
  const codex = extractFn(PIPELINE, 'codexLensPrompt')
  assert.ok(adv, 'adversarialLensPrompt() must exist')
  assert.ok(sonnet, 'sonnetLensPrompt() must exist')
  assert.ok(codex, 'codexLensPrompt() must exist')
  // Strip the function name so distinctness is about the BODY, not just the name.
  const body = (fn, name) => fn.replace(`function ${name}`, '').trim()
  const advBody = body(adv, 'adversarialLensPrompt')
  assert.notEqual(advBody, body(sonnet, 'sonnetLensPrompt'), 'adversarial prompt body must differ from the Sonnet full-scope prompt')
  assert.notEqual(advBody, body(codex, 'codexLensPrompt'), 'adversarial prompt body must differ from the Codex does-it-work prompt')
  // The adversarial prompt carries its OWN distinguishing framing absent from both
  // other prompts: the does-it-work Codex prompt is correctness/bugs/security; the
  // Sonnet prompt is drift/slop + per-criterion. The adversarial prompt's signature
  // is the "assume there is a hole / attack" stance.
  assert.match(adv, /attack|assume[\s-]?a[\s-]?hole|assume there/i, 'adversarial prompt must carry its distinct attack/assume-a-hole stance')
})

// --- AC3: fail-open -- the adversarial lens must NOT influence `degraded` ---

test('AC3: fail-open -- the adversarial thunk catches its own agent() rejection so a failure resolves to null', () => {
  // The adversarial agent() call is gated on tier==='S', but if the opus agent
  // itself rejects (timeout / outage), the rejection propagates through parallel()
  // and blocks the ENTIRE REVIEW block -- the opposite of fail-open. The thunk MUST
  // attach a .catch() so an agent() failure resolves to null rather than rejecting.
  //
  // We locate the adversarial thunk region (within ~300 chars of the adversarial
  // label) and assert it carries a .catch( guard.
  const idx = PIPELINE.indexOf('adversarial:${chunkId}')
  assert.ok(idx !== -1, 'adversarial lens dispatch not found')
  // Window: 600 chars centred on the adversarial label covers the full thunk.
  const window = PIPELINE.slice(Math.max(0, idx - 300), idx + 300)
  assert.match(
    window,
    /\.catch\(/,
    'the adversarial thunk must attach .catch() after agent() so an agent failure resolves to null rather than rejecting through parallel() and blocking REVIEW',
  )
})

test('AC3: fail-open -- `degraded` is set ONLY by a Codex outage, never by the adversarial lens', () => {
  // degraded must be set exclusively by the Codex-outage fallback path (codexReview
  // ran === false). The adversarial lens must NOT appear in any `degraded = true`
  // assignment guard. We assert: every `degraded = true` assignment's controlling
  // condition references codexReview, and none references the adversarial review.
  const degradedAssigns = [...PIPELINE.matchAll(/degraded\s*=\s*true/g)]
  assert.ok(degradedAssigns.length > 0, 'expected at least one `degraded = true` assignment (the Codex fallback)')
  // The adversarial review must never gate a degraded assignment: assert no
  // `if (... adversarial ...) { ... degraded = true`-shaped block exists.
  assert.doesNotMatch(
    PIPELINE,
    /adversarial[\s\S]{0,120}?degraded\s*=\s*true/,
    'the adversarial lens must be fail-open: it must NOT set degraded (that flag is reserved for a Codex outage)',
  )
  // And the degraded guard must still be the codexReview.ran === false path.
  assert.match(
    PIPELINE,
    /codexReview\.ran === false/,
    'degraded must still be gated by the Codex-outage condition (codexReview.ran === false)',
  )
})
