// RED test for chunk pipeline-crash-recovery:
//   "harden worker-pipeline.js against the build-committed-but-no-bundle crash"
//
// OBSERVED FAILURE (real, Agnes/agnes-capable-ea C3): a build-agent COMMITTED in
// the worktree (sha b7ca962) but the workflow returned NO valid bundle, so the
// internal REVIEW/fix-loop never ran -- an unreviewed ORPHAN commit was stranded on
// disk and had to be recovered manually (reflog reset + full re-run). Root cause:
// the pipeline trusts the build-agent's RETURNED bundle for the commit sha + as the
// GATE to REVIEW; an agent that dies/times-out/returns-malformed AFTER committing
// produces no bundle, so REVIEW is skipped silently.
//
// The fix is harness-side resilience: derive the build commit sha from git HEAD
// (ground truth) rather than solely from the self-reported bundle, and on a
// committed-but-bundleless state run REVIEW on the diff anyway; if HEAD did not
// advance, return a CLEAR terminal build-failure.
//
// THE CHUNK'S FULL ACCEPTANCE CONTRACT, pinned here as one suite so an
// implementation satisfying only the first criterion (a plausible shadow) cannot pass:
//
//   AC1: the pipeline derives the build commit sha from `git -C <worktree> rev-parse
//        HEAD` (ground truth) after BUILD, not solely from the self-reported bundle.
//        (A Workflow script cannot run git, so the cockpit-supplied git-grounded
//        head/base shas are threaded in via args and the pure resolver compares them.)
//   AC2: build-agent returns null / schema-invalid / missing-sha BUT worktree HEAD
//        advanced past the base ref (a commit exists) -> PROCEED to REVIEW on the
//        diff base..HEAD (the committed work is reviewed, not discarded); missing
//        narrative bundle fields are tolerated.
//   AC3: worktree HEAD did NOT advance (no build commit) AND no valid bundle -> a
//        CLEAR terminal failure naming the state ('build-did-not-commit' + message),
//        not a hang or a silent empty return.
//   AC4: the normal happy path (valid bundle returned) is behaviorally unchanged --
//        all bundle fields flow as before; only the review/commit sha is git-grounded.
//   AC5: full suite green; existing worker-pipeline tests pass (the whole suite run).
//
// Test strategy (the established proofs next door -- tier-dispatch.test.mjs /
// llr-c2-fix-loop.test.mjs / three-loop-c5-single-agent-dispatch.test.mjs):
//   - worker-pipeline.js runs `await agent(...)` at top level and references Workflow
//     host globals, so it CANNOT be imported (importing executes the pipeline /
//     SyntaxErrors under the CJS package.json). Its WIRING is asserted as static
//     SOURCE TEXT.
//   - The decision LOGIC is extracted into a PURE, import-safe helper module
//     (workflows/pipeline-outcome.mjs) -- the same canonical-module-plus-verbatim-
//     inline-copy idiom as fix-loop.mjs / tier-dispatch.mjs (the Workflow sandbox has
//     no module resolution, so worker-pipeline.js inlines a copy that must move in
//     lockstep). The helper is imported and its return VALUES asserted directly --
//     the authoritative branch proof (AC1-AC4 on the logic).
//
// No tautology: every expected value (the outcome states, the git-grounded sha
// source, the terminal status string) is fixed from the chunk's task statement +
// acceptance criteria BELOW, before any implementation -- never read back from impl.
//
// Run: node --test workflows/pipeline-crash-recovery.test.mjs
// Full suite (GLOB form -- bare `node --test workflows/` errors MODULE_NOT_FOUND on Node v25):
//   node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { resolveBuildOutcome } from './pipeline-outcome.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const PIPELINE = 'workflows/worker-pipeline.js'
const HELPER = 'workflows/pipeline-outcome.mjs'

// Two distinct shas: a base ref (the feature-branch tip the worktree branched from)
// and an advanced HEAD (a real build commit landed). When HEAD === base, no commit landed.
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

// =====================================================================
// AC1 + AC4: git-grounded sha is the review sha on the HAPPY path
// =====================================================================

test('AC1/AC4(happy): a valid bundle + advanced HEAD -> committed, reviewSha is the git HEAD ground truth', () => {
  const build = { green: true, commitSha: HEAD }
  const out = resolveBuildOutcome({ build, worktreeHead: HEAD, baseRef: BASE })
  assert.equal(out.committed, true,
    'A valid green bundle with an advanced HEAD must resolve committed:true (the happy path is unchanged). Got: ' + JSON.stringify(out))
  assert.equal(out.reviewSha, HEAD,
    'reviewSha must be the git-grounded worktree HEAD (ground truth), not solely the self-reported bundle field. Got: ' + JSON.stringify(out))
  assert.equal(out.status, 'review',
    "A committed build must route to REVIEW (status 'review'), not a terminal failure. Got: " + JSON.stringify(out))
  assert.notEqual(out.status, 'build-did-not-commit',
    'The happy path must NOT be the terminal no-commit failure. Got: ' + JSON.stringify(out))
})

test('AC1(ground-truth-over-self-report): a bundle self-reporting a STALE sha is overridden by git HEAD', () => {
  // The whole point of AC1: trust git HEAD, not the agent's word. If the bundle's
  // self-reported commitSha disagrees with the real worktree HEAD, the git-grounded
  // HEAD wins as the review sha (a correct-but-quiet agent AND a crashed agent both
  // then resolve the REAL sha).
  const STALE = 'cccccccccccccccccccccccccccccccccccccccc'
  const build = { green: true, commitSha: STALE }
  const out = resolveBuildOutcome({ build, worktreeHead: HEAD, baseRef: BASE })
  assert.equal(out.reviewSha, HEAD,
    'reviewSha must come from the git-grounded worktree HEAD, overriding a stale self-reported bundle sha. Got: ' + JSON.stringify(out))
})

// =====================================================================
// AC2: committed-but-no-valid-bundle -> PROCEED to REVIEW (not discarded)
// =====================================================================

for (const [label, build] of [
  ['null bundle', null],
  ['undefined bundle', undefined],
  ['schema-invalid bundle (no green/sha)', { summary: 'partial' }],
  ['missing-sha bundle (green true, no commitSha)', { green: true }],
  ['green-false-but-committed bundle', { green: false }],
]) {
  test(`AC2(partial): ${label} BUT HEAD advanced -> committed:true, status 'review' on base..HEAD`, () => {
    const out = resolveBuildOutcome({ build, worktreeHead: HEAD, baseRef: BASE })
    assert.equal(out.committed, true,
      `A ${label} with an ADVANCED HEAD means a real commit exists on disk -- it must be REVIEWED, not orphaned. ` +
      'committed must be true (the committed work is reviewed). Got: ' + JSON.stringify(out))
    assert.equal(out.status, 'review',
      `A committed-but-bundleless build (${label}) must PROCEED to REVIEW (status 'review') instead of a silent ` +
      'no-review return. Got: ' + JSON.stringify(out))
    assert.equal(out.reviewSha, HEAD,
      `The review must run on the git HEAD (${label} provides no usable bundle sha, so HEAD is the only ground truth). ` +
      'Got: ' + JSON.stringify(out))
  })
}

// =====================================================================
// AC3: no-commit + no-bundle -> CLEAR terminal failure, not silent/hang
// =====================================================================

for (const [label, build] of [
  ['null bundle', null],
  ['schema-invalid bundle', { summary: 'died' }],
  ['green-false bundle (could not pass the test)', { green: false }],
]) {
  test(`AC3(terminal): ${label} AND HEAD did NOT advance -> terminal 'build-did-not-commit'`, () => {
    const out = resolveBuildOutcome({ build, worktreeHead: BASE, baseRef: BASE })
    assert.equal(out.committed, false,
      `No commit landed (HEAD === base) for a ${label}: committed must be false. Got: ` + JSON.stringify(out))
    assert.equal(out.status, 'build-did-not-commit',
      `A no-commit + no-valid-bundle state must return a CLEAR terminal failure naming the state ` +
      `('build-did-not-commit'), not a silent empty return. Got: ` + JSON.stringify(out))
    assert.ok(typeof out.message === 'string' && out.message.length > 0,
      'The terminal failure must carry a human-readable message naming the state (not a bare/empty return). Got: ' + JSON.stringify(out))
    assert.notEqual(out.status, 'review',
      'A no-commit state has nothing to review -- it must NOT route to REVIEW. Got: ' + JSON.stringify(out))
  })
}

test('AC3(distinct-from-green-stage-failure): a clean green:false no-commit is its OWN clear terminal, not silent', () => {
  // The pre-existing "build-agent could not make the test pass" path (green:false,
  // no commit) is a legitimate failure; the chunk must keep it CLEAR (a named
  // terminal), never a silent empty return that looks like success.
  const out = resolveBuildOutcome({ build: { green: false, failureReason: 'could not pass' }, worktreeHead: BASE, baseRef: BASE })
  assert.equal(out.committed, false, 'green:false with no commit is not committed. Got: ' + JSON.stringify(out))
  assert.equal(out.status, 'build-did-not-commit',
    'A no-commit build (whatever the bundle said) resolves to the clear terminal status. Got: ' + JSON.stringify(out))
})

// =====================================================================
// AC1 (source wiring): the pipeline READS git HEAD ground truth + threads base/head
// =====================================================================

test('AC1(source): worker-pipeline.js derives the build sha from a git rev-parse HEAD ground truth, not solely the bundle', () => {
  const body = read(PIPELINE)
  // A Workflow script cannot run git itself, so the git HEAD ground truth is
  // threaded in from the cockpit (which has Bash) -- the same delivery model as
  // injectedDocs. The pipeline must reference a git-grounded head/base sha source
  // (worktreeHead + baseRef from args), NOT take the review sha solely from
  // build.commitSha. The literal `rev-parse HEAD` must appear (the ground-truth
  // contract is named) and the pipeline must consume the threaded head sha.
  assert.match(body, /rev-parse HEAD/,
    `${PIPELINE} never references \`git rev-parse HEAD\`. AC1 requires the build commit sha be derived from ` +
    'the git HEAD ground truth (threaded in by the cockpit, which has Bash); name the contract in the source.')
  assert.match(body, /worktreeHead/,
    `${PIPELINE} never reads a git-grounded worktreeHead. The pipeline must consume the cockpit-supplied ` +
    'git HEAD sha (a.worktreeHead) as the ground truth, not solely the self-reported build.commitSha.')
  assert.match(body, /baseRef/,
    `${PIPELINE} never reads a baseRef. AC1/AC2 compare HEAD to the base ref (the worktree's branch start point) ` +
    'to decide whether a commit landed; the pipeline must consume the cockpit-supplied base ref.')
})

test('AC1(source): the review/commit sha flows through resolveBuildOutcome, not a bare `build.commitSha` gate', () => {
  const body = read(PIPELINE)
  // The OLD gate `const committed = !!(build && build.green && build.commitSha)` took
  // the sha solely from the bundle. After the fix the outcome (committed + reviewSha)
  // comes from the git-grounded resolver. Assert the resolver is invoked.
  assert.match(body, /resolveBuildOutcome\s*\(/,
    `${PIPELINE} does not invoke resolveBuildOutcome(...). The git-grounded outcome resolution (committed + ` +
    'reviewSha + terminal status) must run through the shared pure helper, verbatim-inlined from ' +
    `${HELPER} (the Workflow sandbox has no module resolution -- the fix-loop.mjs / tier-dispatch.mjs idiom).`)
  // The bare self-reported-only gate must be gone (it is the bug: a crashed agent
  // reports nothing, so this gate skips REVIEW on a committed orphan).
  assert.doesNotMatch(body, /const\s+committed\s*=\s*!!\(\s*build\s*&&\s*build\.green\s*&&\s*build\.commitSha\s*\)/,
    `${PIPELINE} still gates on the bare self-reported \`!!(build && build.green && build.commitSha)\`. That is the ` +
    'bug: a build-agent that commits then crashes reports no bundle, so REVIEW is skipped on a committed orphan. ' +
    'The committed/reviewSha decision must come from the git-grounded resolveBuildOutcome instead.')
})

// =====================================================================
// AC2 (source wiring): committed-but-bundleless routes to REVIEW
// =====================================================================

test('AC2(source): the partial-completion state (committed, no valid bundle) is named and routed to REVIEW', () => {
  const body = read(PIPELINE)
  // The pipeline must reference the build-did-not-commit terminal status string
  // (AC3) AND keep REVIEW reachable when committed is true regardless of bundle
  // validity. The reviewSha that REVIEW runs on must come from the resolver's
  // git-grounded value, so the partial-completion commit gets reviewed.
  assert.match(body, /build-did-not-commit/,
    `${PIPELINE} never sets the 'build-did-not-commit' terminal status. AC3 requires a CLEAR terminal failure ` +
    'naming the no-commit state, distinct from a normal green:false failure.')
  // reviewSha must be sourced from the resolver outcome (the git-grounded value),
  // not from `committed ? build.commitSha : null` (the self-reported-only source).
  assert.doesNotMatch(body, /const\s+reviewSha\s*=\s*committed\s*\?\s*build\.commitSha\s*:\s*null/,
    `${PIPELINE} still sets reviewSha from the self-reported \`committed ? build.commitSha : null\`. After the fix ` +
    'reviewSha must be the resolver\'s git-grounded sha so a committed-but-bundleless build is reviewed on its real HEAD.')
})

// =====================================================================
// AC3 (source wiring): the terminal status reaches the bundle's status field
// =====================================================================

test("AC3(source): 'build-did-not-commit' maps to a terminal 'failed' bundle status the cockpit can route", () => {
  const body = read(PIPELINE)
  // The cockpit recognizes exactly two bundle statuses ('awaiting-review' | 'failed')
  // and FAILS LOUD on anything else (cockpit SKILL.md). So the new 'build-did-not-commit'
  // terminal must MAP to 'failed' for the bundle.status field while still naming the
  // state in a message/failureReason -- never invent a third top-level status string.
  // Assert both the marker exists AND the bundle keeps the two-status contract.
  assert.match(body, /status:\s*\S/,
    `${PIPELINE}'s return bundle no longer sets a 'status' field; the cockpit routes on bundle.status.`)
  // The no-commit terminal must surface a message/reason (not a bare empty return).
  assert.match(body, /build-did-not-commit/,
    `${PIPELINE} must name the 'build-did-not-commit' state in the failure path (message / failureReason), ` +
    'so the COO sees a clear terminal signal, not a silent empty return.')
})

// =====================================================================
// AC4 (source wiring): happy-path bundle fields are preserved
// =====================================================================

test('AC4(source): the happy-path bundle shape the cockpit consumes is preserved [PRESERVATION GUARD]', () => {
  const body = read(PIPELINE)
  // PRESERVATION GUARD: the cockpit reads red / green / review.codex / review.sonnet
  // / review.explanation / review.proof / review.drafted / status at merge. The
  // git-grounding fix must NOT regress those consumed fields -- only the sha source changes.
  for (const key of ['codex:', 'sonnet:', 'explanation:', 'proof:', 'drafted:']) {
    assert.match(body, new RegExp(key.replace(':', '\\s*:')),
      `${PIPELINE}'s return bundle no longer carries the cockpit-consumed field '${key.replace(':', '')}'. ` +
      'AC4 requires the happy-path bundle shape be preserved -- only the review/commit sha becomes git-grounded.')
  }
})

// =====================================================================
// Partial ground-truth path (baseRef threaded at launch, no worktreeHead -- typical
// post-fix cockpit dispatch). The cockpit threads baseRef at worktree-creation time;
// worktreeHead is not available in-pipeline (a Workflow script cannot run git and the
// build has not happened yet at launch). resolveBuildOutcome uses build.commitSha as
// the effective head when it is available (the non-crashed agent path).
// =====================================================================

test('partial(non-crash): baseRef threaded + valid build.commitSha advanced past base -> committed, reviewSha from commitSha', () => {
  // Typical post-fix cockpit dispatch: baseRef known at launch, worktreeHead absent.
  // The build agent succeeded and reported commitSha; it is compared to baseRef.
  const build = { green: true, commitSha: HEAD }
  const out = resolveBuildOutcome({ build, baseRef: BASE })   // no worktreeHead
  assert.equal(out.committed, true,
    'Partial ground truth (baseRef + commitSha): commitSha advanced past baseRef -> committed:true. Got: ' + JSON.stringify(out))
  assert.equal(out.reviewSha, HEAD,
    'Partial ground truth: reviewSha must be the agent-reported commitSha (compared to baseRef). Got: ' + JSON.stringify(out))
  assert.equal(out.status, 'review',
    "Partial ground truth: a committed build must route to REVIEW (status 'review'). Got: " + JSON.stringify(out))
})

test('partial(sha-matches-base): baseRef threaded + build.commitSha equals baseRef -> terminal build-did-not-commit', () => {
  // Build agent reported a sha equal to baseRef: no commit advanced. Clear terminal.
  const build = { green: true, commitSha: BASE }  // sha matches base = no advance
  const out = resolveBuildOutcome({ build, baseRef: BASE })
  assert.equal(out.committed, false,
    'Partial ground truth: commitSha === baseRef means no commit advanced; committed must be false. Got: ' + JSON.stringify(out))
  assert.equal(out.status, 'build-did-not-commit',
    "Partial ground truth: no advance -> terminal 'build-did-not-commit'. Got: " + JSON.stringify(out))
})

test('partial(crash): baseRef threaded + null bundle (crashed agent) -> falls through to terminal (cockpit orphan-check owns this)', () => {
  // Build agent crashed: no bundle, no commitSha. The in-pipeline resolver cannot
  // determine HEAD without git access. It falls through to back-compat (also terminal).
  // The COCKPIT completion handler is responsible for the real orphan detection.
  const out = resolveBuildOutcome({ build: null, baseRef: BASE })   // no worktreeHead, null bundle
  assert.equal(out.committed, false,
    'Partial ground truth (crash/null bundle): no commitSha available -> cannot confirm committed; false. Got: ' + JSON.stringify(out))
  assert.equal(out.status, 'build-did-not-commit',
    "Partial ground truth (crash): without a usable commitSha, resolver yields 'build-did-not-commit' (cockpit owns real orphan check). Got: " + JSON.stringify(out))
})

// =====================================================================
// Back-compat fallback path (no worktreeHead/baseRef threaded -- old/manual dispatch)
//
// AC4 (Finding 2 pin): when the cockpit dispatches WITHOUT git shas (old or manual
// dispatch), resolveBuildOutcome falls back to the pre-fix self-reported gate
// (build.green && build.commitSha). This IS the happy path for existing cockpit
// dispatches that pre-date the pipeline-crash-recovery chunk. A refactor that drops
// this fallback conditional would pass the AC1-AC4 tests (which all supply
// worktreeHead/baseRef) while silently breaking the back-compat behavior for every
// in-flight pre-update cockpit dispatch.
// =====================================================================

test('AC4(back-compat): no git shas threaded + valid green bundle -> committed, reviewSha from self-reported bundle', () => {
  // Old/manual dispatch: cockpit did not thread worktreeHead/baseRef.
  // The back-compat path must resolve committed:true from build.green && build.commitSha.
  const build = { green: true, commitSha: HEAD }
  const out = resolveBuildOutcome({ build })   // no worktreeHead, no baseRef
  assert.equal(out.committed, true,
    'Back-compat (no git shas): a green bundle with a commitSha must resolve committed:true. Got: ' + JSON.stringify(out))
  assert.equal(out.reviewSha, HEAD,
    'Back-compat (no git shas): reviewSha must come from the self-reported bundle.commitSha. Got: ' + JSON.stringify(out))
  assert.equal(out.status, 'review',
    "Back-compat (no git shas): a committed build must route to REVIEW (status 'review'). Got: " + JSON.stringify(out))
})

test('AC4(back-compat): no git shas threaded + null bundle -> terminal build-did-not-commit', () => {
  // Old/manual dispatch: no worktreeHead, no baseRef, and a null bundle (crash).
  // The back-compat path must produce a clear terminal, not a silent empty return.
  const out = resolveBuildOutcome({ build: null })   // no worktreeHead, no baseRef
  assert.equal(out.committed, false,
    'Back-compat (null bundle, no git shas): committed must be false. Got: ' + JSON.stringify(out))
  assert.equal(out.status, 'build-did-not-commit',
    "Back-compat (null bundle, no git shas): must return terminal 'build-did-not-commit'. Got: " + JSON.stringify(out))
  assert.ok(typeof out.message === 'string' && out.message.length > 0,
    'Back-compat (null bundle, no git shas): terminal failure must carry a human-readable message. Got: ' + JSON.stringify(out))
})

test('AC4(back-compat): no git shas threaded + green:false bundle -> terminal build-did-not-commit', () => {
  // Old/manual dispatch, build-agent returned green:false (could not pass the test).
  // Back-compat path: no git truth, no green commitSha -> terminal failure.
  const out = resolveBuildOutcome({ build: { green: false, failureReason: 'test could not pass' } })
  assert.equal(out.committed, false,
    'Back-compat (green:false, no git shas): committed must be false. Got: ' + JSON.stringify(out))
  assert.equal(out.status, 'build-did-not-commit',
    "Back-compat (green:false, no git shas): must resolve terminal 'build-did-not-commit'. Got: " + JSON.stringify(out))
})

test('AC4(back-compat): no git shas threaded + green:true but no commitSha -> terminal build-did-not-commit', () => {
  // Old/manual dispatch: bundle is green but has no commitSha (malformed or missing).
  // Back-compat path: build.green && build.commitSha requires BOTH; no sha -> not committed.
  const out = resolveBuildOutcome({ build: { green: true } })   // no commitSha
  assert.equal(out.committed, false,
    'Back-compat (green:true, no commitSha, no git shas): without a commitSha the build is not considered committed. Got: ' + JSON.stringify(out))
  assert.equal(out.status, 'build-did-not-commit',
    "Back-compat (missing commitSha, no git shas): must return terminal 'build-did-not-commit'. Got: " + JSON.stringify(out))
})

test('AC4(back-compat fallback guard): source code retains the self-reported fallback conditional', () => {
  // The back-compat path lives in both the canonical module and the verbatim-inlined
  // copy in worker-pipeline.js. A refactor that drops the fallback while all AC1-AC4
  // tests supply explicit worktreeHead/baseRef would pass the suite undetected.
  // Pin the fallback conditional by asserting the source text of BOTH files.
  const helper = read(HELPER)
  const pipeline = read(PIPELINE)
  // The fallback sentinel: the self-reported gate that fires when no git shas are present.
  const fallbackPattern = /build\s*&&\s*build\.green\s*&&\s*build\.commitSha/
  assert.match(helper, fallbackPattern,
    `${HELPER} no longer contains the back-compat self-reported gate (build && build.green && build.commitSha). ` +
    'Dropping this conditional breaks the fallback for old/manual cockpit dispatches that do not thread git shas.')
  assert.match(pipeline, fallbackPattern,
    `${PIPELINE}'s verbatim-inlined resolveBuildOutcome copy no longer contains the back-compat self-reported gate. ` +
    'The inline copy must move in lockstep with pipeline-outcome.mjs (per the lockstep contract).')
})

test('partial(source guard): source code retains the baseRef-only partial ground-truth branch', () => {
  // The partial ground-truth branch (baseRef present, no worktreeHead, use build.commitSha
  // as effective head) exists in both canonical module and the verbatim-inlined copy.
  // A refactor that drops it would silently degrade to back-compat for all post-fix
  // cockpit dispatches (which thread baseRef but not worktreeHead).
  const helper = read(HELPER)
  const pipeline = read(PIPELINE)
  // The partial-branch sentinel: `if (base.length > 0)` gates the agentSha lookup.
  const partialPattern = /base\.length\s*>\s*0/
  assert.match(helper, partialPattern,
    `${HELPER} no longer contains the partial ground-truth branch (base.length > 0 gate for agentSha lookup). ` +
    'Dropping this branch degrades all post-fix cockpit dispatches (which thread baseRef) to the back-compat path.')
  assert.match(pipeline, partialPattern,
    `${PIPELINE}'s inlined copy no longer contains the partial ground-truth branch (base.length > 0). ` +
    'The inline copy must move in lockstep with pipeline-outcome.mjs.')
})

// =====================================================================
// Cockpit wiring: baseRef threading and orphan-commit detection documented
// =====================================================================

test('cockpit(baseRef-threading): cockpit SKILL.md documents threading baseRef in the dispatch payload', () => {
  // Finding 1 (DRIFT P2): the cockpit SKILL.md Per-launch step 3 previously omitted
  // worktreeHead/baseRef, making the pipeline's git-grounded logic inert for all
  // production dispatches. Pin that the cockpit now documents baseRef in the payload.
  const skill = read('skills/cockpit/SKILL.md')
  assert.match(skill, /baseRef/,
    'skills/cockpit/SKILL.md must mention baseRef in the dispatch payload (Per-launch step 3). ' +
    'Without baseRef threaded at launch, the pipeline\'s partial ground-truth path (build.commitSha vs baseRef) ' +
    'cannot fire and all dispatches degrade to the pre-fix self-reported gate.')
})

test('cockpit(orphan-check): cockpit SKILL.md documents post-pipeline orphan-commit detection', () => {
  // Finding 1 follow-through: the crash-case orphan (build-agent committed then crashed,
  // pipeline returns failed) cannot be detected in-pipeline. The cockpit completion handler
  // must check git HEAD vs baseRef after the pipeline returns "failed". Pin this.
  const skill = read('skills/cockpit/SKILL.md')
  assert.match(skill, /ORPHAN.COMMIT|orphan.commit|orphaned commit/i,
    'skills/cockpit/SKILL.md must document orphaned-commit detection in the completion handler. ' +
    'A crashed build-agent may have committed before crashing; the cockpit must check ' +
    'git HEAD vs baseRef when the pipeline returns failed/build-did-not-commit.')
})

// =====================================================================
// Helper module hygiene: import-safe + the lockstep-inline contract is documented
// =====================================================================

test('helper: pipeline-outcome.mjs is import-safe (pure, no Workflow globals, no top-level side effects)', () => {
  // Proven by the fact that the import at the top of THIS test file already
  // succeeded; assert the export is a function so a bad refactor is caught.
  assert.equal(typeof resolveBuildOutcome, 'function',
    'resolveBuildOutcome must be an exported pure function importable in a unit test (the tier-dispatch.mjs idiom).')
})

test('helper: worker-pipeline.js inlines a verbatim copy and names the lockstep contract', () => {
  const body = read(PIPELINE)
  const helper = read(HELPER)
  // The Workflow sandbox has no module resolution, so worker-pipeline.js cannot
  // import pipeline-outcome.mjs -- it inlines a copy. The inline copy must name the
  // canonical source so the lockstep duplication is auditable (the fix-loop.mjs idiom).
  assert.match(body, /pipeline-outcome\.mjs/,
    `${PIPELINE} must name pipeline-outcome.mjs as the canonical source of the inlined resolveBuildOutcome copy ` +
    '(the Workflow sandbox has no module resolution; the inline copy must move in lockstep with the canonical module).')
  // The canonical module names its own role (extracted-for-import-safety), like fix-loop.mjs.
  assert.match(helper, /worker-pipeline\.js/,
    `${HELPER} must reference worker-pipeline.js (naming the verbatim-inline lockstep contract), like fix-loop.mjs.`)
})
