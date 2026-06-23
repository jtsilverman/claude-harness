// RED test for lean-system-design chunk llr-C2:
//   "internal fix-loop + fixer REJECT path + doc injection + wired schemas"
//
// This chunk moves the review fix-loop INSIDE the per-chunk pipeline: when the
// verification net returns findings, a dedicated `fixer` agent resolves them and
// the work is RE-REVIEWED automatically, looping until CLEAN or stuck-after-N=2
// (N=2 = the two-failed-attempts reset rule). The COO is OUT of the fix-loop; the
// pipeline returns to the COO only when CLEAN or escalated.
//
// The chunk's FULL acceptance contract, pinned here as one suite so an
// implementation that satisfies only the first criterion (a plausible shadow)
// cannot pass:
//
//   (1) A seeded REAL finding drives the fix-loop controller through fixer then
//       re-review to CLEAN (unit-tested on the PURE controller).
//   (2) A HALLUCINATED finding is REJECTed by the fixer with evidence and does
//       NOT churn correct code; after N=2 deadlock it ESCALATES carrying BOTH
//       sides' evidence (unit-tested on the pure controller).
//   (3) Dispatch injects disciplines/worker-discipline.md (builder+fixer) and
//       disciplines/review-contract.md (reviewer+Codex): injectedDocs carries the
//       FULL file bytes (asserted byte-for-byte).
//   (4) Dispatch-payload (i) and return-bundle (ii) match annex Part 4 D shapes:
//       return-bundle carries lessonCandidates:[{raw_lesson,kind_hint,provenance}]
//       (RAW, not drafted) + recallVerify.
//   (5) RECALL remains a SEPARATE harness stage (not folded into the builder);
//       inlined tierConfig matches the canonical dial incl. S->build-agent-max.
//   (6) reviewerFor dial: B/C->chunk-reviewer, A/S->...-heavy.
//
// Test strategy (mirrors three-loop-c5-single-agent-dispatch.test.mjs +
// c3-launchable-parity.test.mjs):
//   - The fix-loop terminator is extracted as a PURE, import-safe controller in
//     workflows/fix-loop.mjs (no top-level side effects, no Workflow globals), so
//     it is IMPORTED and its return VALUES asserted directly -- the authoritative
//     proof for criteria 1, 2. Same module also exports the canonical
//     injectDisciplineDocs helper + the doc-path map, imported and asserted on real
//     file bytes (criterion 3).
//   - worker-pipeline.js executes the pipeline at top level on import (top-level
//     `await agent(...)`, Workflow globals), so it CANNOT be imported; its WIRING
//     (the fixer dispatch, re-review, injectedDocs threading into the build/fixer/
//     reviewer/codex payloads, the return-bundle fields, RECALL-as-separate-stage,
//     tierConfig S->build-agent-max) is asserted as STATIC SOURCE TEXT. The full
//     agent()-wired end-to-end run is exercised downstream at E2 (bootstrap-gate
//     live chunk) -- named as the gap in completion notes.
//
// No tautology: every expected value (the controller's action verbs, the N=2
// escalation, the byte-equality of injected docs, the dial's S->build-agent-max)
// is fixed from the chunk task statement + annex contract BELOW, before any
// implementation -- never read back from the implementation.
//
// Run: node --test workflows/llr-c2-fix-loop.test.mjs
// Full suite (GLOB form): node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  fixLoopController,
  findingSeverity,
  injectDisciplineDocs,
  DISCIPLINE_DOCS,
  FIX_LOOP_MAX_ATTEMPTS,
  gatherFindings,
  findingKey,
} from './fix-loop.mjs'
import { tierConfig, reviewerFor } from './tier-dispatch.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const PIPELINE = 'workflows/worker-pipeline.js'
const DISPATCH = 'workflows/tier-dispatch.mjs'

// A finding line in the review contract's shape (dimension, severity, file:lines,
// altitude, why). The controller treats it opaquely -- it routes on PRESENCE +
// the fixer's disposition, never on parsing the line.
const realFinding = "[BUG] HIGH agents/x.md:12 worker-level — null deref on empty findings array"
const hallucinatedFinding = "[BUG] HIGH workflows/fix-loop.mjs:1 worker-level — controller never terminates (FALSE)"

// =====================================================================
// Criterion 5 (first, it gates the others): RECALL stays a separate stage +
// the 2-tier dial resolves (pipeline-meritocracy c1 collapsed S/A/B/C to default|heavy).
// =====================================================================

test('AC5(dial): tierConfig heavy / legacy A / legacy S -> build-agent-heavy / opus', () => {
  for (const t of ['heavy', 'A', 'S']) {
    assert.deepEqual(tierConfig(t), { buildAgent: 'build-agent-heavy', buildModel: 'opus' },
      `tierConfig('${t}') must resolve to build-agent-heavy/opus`)
  }
})

test('AC5(dial): tierConfig default / legacy B / legacy C / absent -> build-agent / opus', () => {
  for (const t of ['default', 'B', 'C', undefined]) {
    assert.deepEqual(tierConfig(t), { buildAgent: 'build-agent', buildModel: 'opus' },
      `tierConfig('${t}') must resolve to build-agent/opus`)
  }
})

test('AC5(lockstep): worker-pipeline.js inlined tierConfig references no deleted file (build-agent-max/light)', () => {
  const body = read(PIPELINE)
  // The inlined copy (Workflow sandbox has no module resolution) must move in
  // lockstep with tier-dispatch.mjs: 2-tier, opus everywhere, no deleted-file ref.
  for (const dead of ['build-agent-light', 'build-agent-max']) {
    assert.ok(!body.includes(dead), `${PIPELINE}'s inlined dial still references the deleted file '${dead}'`)
  }
})

test('AC5(recall-in-builder): RECALL is folded INTO the build-agent (C4: separate RECALL stage removed; anti-skip = required recallEvidence field)', () => {
  const body = read(PIPELINE)
  // C4 (board-confirmed the operator decision 2026-06-12): the separate RECALL harness
  // stage is REMOVED -- recall folds into the builder's one continuous context.
  // The new anti-skip is a REQUIRED recallEvidence field in BUILD_RESULT.
  // The old RECALL phase + RECALL_KICKOFF_RESULT schema must be gone.
  assert.doesNotMatch(body, /phase\('RECALL'\)/, `${PIPELINE} must NOT keep a separate RECALL harness stage -- C4 folds recall into the builder's context.`)
  assert.doesNotMatch(
    body,
    /RECALL_KICKOFF_RESULT/,
    `${PIPELINE} must NOT define RECALL_KICKOFF_RESULT -- C4 removes the recall-kickoff harness-stage schema.`,
  )
  // New anti-skip: recallEvidence is a REQUIRED field in BUILD_RESULT.
  assert.match(
    body,
    /recallEvidence/,
    `${PIPELINE} must carry recallEvidence in BUILD_RESULT (the new anti-skip: a build return missing it is malformed).`,
  )
})

test('AC6(reviewer-dial): reviewerFor B/C -> base, A/S -> -heavy', () => {
  assert.equal(reviewerFor('B').agentType, 'chunk-reviewer')
  assert.equal(reviewerFor('C').agentType, 'chunk-reviewer')
  assert.equal(reviewerFor('A').agentType, 'chunk-reviewer-heavy')
  assert.equal(reviewerFor('S').agentType, 'chunk-reviewer-heavy')
})

// =====================================================================
// Criterion 1: a seeded REAL finding loops the controller fix -> re-review -> CLEAN
// =====================================================================

test('AC1(N=2 constant): the stuck-after-N threshold is N=2 (the two-failed-attempts reset rule)', () => {
  assert.equal(
    FIX_LOOP_MAX_ATTEMPTS,
    2,
    `FIX_LOOP_MAX_ATTEMPTS must be 2 -- the chunk pins N=2 to the reset rule's two-failed-attempts. Got ${FIX_LOOP_MAX_ATTEMPTS}.`,
  )
})

test('AC1(real->fix): a fresh review with open findings and no prior fixer round -> action fix', () => {
  // Round 0: the verification net just returned a real finding; no fixer has run
  // yet (attemptCount 0). The controller must dispatch the fixer.
  const out = fixLoopController([realFinding], null, 0)
  assert.equal(out.action, 'fix', `with open findings and attemptCount 0 the controller must dispatch the fixer. Got ${JSON.stringify(out)}`)
})

test('AC1(real->clean): after the fixer fixed it, a re-review with NO open findings -> action clean', () => {
  // The fixer returned `fixed` for the real finding; the re-review came back clean
  // (empty findings). The controller terminates CLEAN -- the chunk returns to the COO.
  const fixerDispositions = [{ finding: realFinding, disposition: 'fixed', evidence: 'pinned + fix', files: ['agents/x.md'] }]
  const out = fixLoopController([], fixerDispositions, 1)
  assert.equal(out.action, 'clean', `a re-review with no open findings must terminate CLEAN. Got ${JSON.stringify(out)}`)
})

test('AC1(empty->clean): a first review that is already clean -> action clean (no fixer churn)', () => {
  const out = fixLoopController([], null, 0)
  assert.equal(out.action, 'clean', `an already-clean first review must terminate CLEAN with no fixer dispatch. Got ${JSON.stringify(out)}`)
})

// =====================================================================
// Criterion 2: a HALLUCINATED finding is REJECTed with evidence, does NOT churn,
// and ESCALATES after N=2 carrying BOTH sides' evidence.
// =====================================================================

test('AC2(reject->no-churn): a finding the fixer REJECTed with evidence, dropped by the re-review, does NOT churn -> clean', () => {
  // The fixer verified the finding was a false positive and REJECTed it with
  // evidence; the re-review adjudicated the evidence, agreed, and dropped it
  // (so the re-review's open-findings list is empty). The controller must NOT
  // loop again -- correct code is never churned. It terminates CLEAN.
  const fixerDispositions = [{ finding: hallucinatedFinding, disposition: 'REJECT', evidence: 'fix-loop.mjs:40 terminates at N=2; output observed', files: [] }]
  const out = fixLoopController([], fixerDispositions, 1)
  assert.equal(out.action, 'clean', `a REJECT the re-review accepted (no open findings) must terminate CLEAN, never churn correct code. Got ${JSON.stringify(out)}`)
})

test('AC2(deadlock->escalate): a finding the fixer REJECTed but the re-review RE-RAISED, after N=2, ESCALATES with both sides evidence', () => {
  // Deadlock: round 1 the fixer REJECTed with evidence; the re-review held its
  // ground and re-raised the finding (still open). attemptCount has reached N=2.
  // The controller must ESCALATE to the COO, NOT dispatch a third fixer round
  // (no third patch -- the reset rule). The escalation must carry BOTH sides'
  // evidence: the reviewer's open findings AND the fixer's rejection rationale.
  const fixerDispositions = [{
    finding: hallucinatedFinding,
    disposition: 'REJECT',
    evidence: 'fix-loop.mjs:40 returns escalate at attemptCount>=2; command output proves termination',
    files: [],
  }]
  const out = fixLoopController([hallucinatedFinding], fixerDispositions, FIX_LOOP_MAX_ATTEMPTS)
  assert.equal(out.action, 'escalate', `a still-open finding at attemptCount >= N=2 must ESCALATE, not dispatch a third fixer round. Got ${JSON.stringify(out)}`)
  // BOTH sides' evidence must ride on the escalation so the COO can adjudicate.
  assert.ok(out.escalation, `the escalate action must carry an escalation payload with both sides' evidence. Got ${JSON.stringify(out)}`)
  assert.deepEqual(
    out.escalation.reviewerFindings,
    [hallucinatedFinding],
    `the escalation must carry the reviewer's still-open findings (reviewer side). Got ${JSON.stringify(out.escalation)}`,
  )
  assert.deepEqual(
    out.escalation.fixerDispositions,
    fixerDispositions,
    `the escalation must carry the fixer's dispositions incl. the REJECT rationale (fixer side). Got ${JSON.stringify(out.escalation)}`,
  )
})

test('AC2(real-deadlock->escalate): even a NON-rejected open finding that survives to N=2 escalates rather than looping forever', () => {
  // Not every deadlock is a REJECT: a genuinely-hard finding the fixer marked
  // `stuck` (two failed attempts) and is still open at N=2 must also escalate, not
  // loop a third time.
  const fixerDispositions = [{ finding: realFinding, disposition: 'stuck', evidence: 'tried A, tried B; both failed because ...', files: ['agents/x.md'] }]
  const out = fixLoopController([realFinding], fixerDispositions, FIX_LOOP_MAX_ATTEMPTS)
  assert.equal(out.action, 'escalate', `a still-open finding at N=2 (stuck) must escalate, never loop a third fixer round. Got ${JSON.stringify(out)}`)
})

test('AC2(below-N-still-open->fix): open findings below N=2 keep looping (fix), only at N=2 do they escalate', () => {
  // Boundary: at attemptCount 1 (< 2) with open findings the controller still
  // dispatches the fixer -- escalation is reserved for the N=2 deadlock.
  const out = fixLoopController([realFinding], [{ finding: realFinding, disposition: 'fixed', evidence: 'x', files: [] }], 1)
  assert.equal(out.action, 'fix', `open findings at attemptCount 1 (< N=2) must keep looping (dispatch the fixer). Got ${JSON.stringify(out)}`)
})

// =====================================================================
// Criterion 3: doc injection -- injectedDocs carries the FULL file bytes.
// =====================================================================

test('AC3(doc-map): DISCIPLINE_DOCS names the two discipline docs by their repo-relative paths', () => {
  assert.equal(DISCIPLINE_DOCS.workerDiscipline, 'disciplines/worker-discipline.md')
  assert.equal(DISCIPLINE_DOCS.reviewContract, 'disciplines/review-contract.md')
})

test('AC3(builder+fixer): injectDisciplineDocs("worker") returns injectedDocs.workerDiscipline == the FULL file bytes', () => {
  const injected = injectDisciplineDocs('worker', root)
  const fileBytes = read('disciplines/worker-discipline.md')
  assert.equal(
    injected.workerDiscipline,
    fileBytes,
    `injectedDocs.workerDiscipline must equal the FULL bytes of disciplines/worker-discipline.md (builders/fixers ` +
      `inherit rules/ but NOT disciplines/, so injection is the only delivery path). It does not match the file bytes.`,
  )
})

test('AC3(reviewer+codex): injectDisciplineDocs("reviewer") returns injectedDocs.reviewContract == the FULL file bytes', () => {
  const injected = injectDisciplineDocs('reviewer', root)
  const fileBytes = read('disciplines/review-contract.md')
  assert.equal(
    injected.reviewContract,
    fileBytes,
    `injectedDocs.reviewContract must equal the FULL bytes of disciplines/review-contract.md (reviewers/Codex ` +
      `inherit rules/ but NOT disciplines/, so injection is the only delivery path). It does not match the file bytes.`,
  )
})

test('AC3(wiring): worker-pipeline.js injects worker-discipline into the build+fixer payloads and review-contract into the reviewer+codex payloads', () => {
  const body = read(PIPELINE)
  // The pipeline must READ both discipline docs and thread their bytes into the
  // right payloads. Assert the injection helper / doc bytes reach the dispatch.
  assert.match(
    body,
    /worker-discipline\.md/,
    `${PIPELINE} must inject disciplines/worker-discipline.md into the build-agent + fixer payloads (full bytes).`,
  )
  assert.match(
    body,
    /review-contract\.md/,
    `${PIPELINE} must inject disciplines/review-contract.md into the reviewer + Codex payloads (full bytes).`,
  )
  assert.match(
    body,
    /injectedDocs/,
    `${PIPELINE} must thread an injectedDocs structure (full discipline-doc bytes) into the dispatched payloads ` +
      `-- reviewers/builders inherit rules/ but NOT disciplines/, so injection is the only delivery path.`,
  )
})

// =====================================================================
// Criterion 4: dispatch-payload (i) + return-bundle (ii) match annex Part 4 D.
// =====================================================================

test('AC4(bundle-raw-lessons): BUILD_RESULT carries lessonCandidates:[{raw_lesson,kind_hint,provenance}] RAW (not drafted)', () => {
  const body = read(PIPELINE)
  // Annex (ii): the return bundle carries RAW lesson candidates (the worker does
  // NOT run capture-learning's drafting; the memory-agent reconciles downstream).
  assert.match(
    body,
    /lessonCandidates/,
    `${PIPELINE}'s build-result schema must carry lessonCandidates (RAW {raw_lesson,kind_hint,provenance}), per annex Part 4 D (ii).`,
  )
  assert.match(body, /raw_lesson/, `${PIPELINE} lessonCandidates entries must use the RAW {raw_lesson,kind_hint,provenance} shape.`)
  assert.match(body, /kind_hint/, `${PIPELINE} lessonCandidates entries must carry kind_hint.`)
  assert.match(body, /provenance/, `${PIPELINE} lessonCandidates entries must carry provenance.`)
})

test('AC4(bundle-recallVerify): BUILD_RESULT carries recallVerify (the required per-entry read-verify field)', () => {
  const body = read(PIPELINE)
  assert.match(
    body,
    /recallVerify/,
    `${PIPELINE}'s build-result schema must carry recallVerify per annex Part 4 C/D (ii) -- the per-loaded-entry ` +
      `read-verify verdict (anti-skip: a REQUIRED field).`,
  )
})

test('AC4(dispatch-payload): the BUILD_RESULT schema carries recallEvidence (the anti-skip for recall-in-builder model, C4)', () => {
  const body = read(PIPELINE)
  // C4 removed recallKickoffArtifact (the old RECALL harness-stage artifact path).
  // The new anti-skip is a REQUIRED recallEvidence field in BUILD_RESULT -- a build
  // return missing the field is rejected as malformed.
  assert.match(
    body,
    /recallEvidence/,
    `${PIPELINE}'s BUILD_RESULT schema must carry recallEvidence (the C4 anti-skip: ` +
      `the builder runs recall in its continuous context and proves it via this required ` +
      `field; a return missing it is malformed).`,
  )
})

// =====================================================================
// Codex fix-loop review findings (fresh-context review of the C2 fix-loop wiring).
// Each pins the corrected behavior in worker-pipeline.js static source -- the
// pipeline executes at import (top-level await agent), so it cannot be imported;
// its WIRING is asserted as source text, the same strategy as the criteria above.
// =====================================================================

test('FIX1(suite-green-gates-clean): a fixer round that breaks the suite (suiteGreen false) must NOT be allowed to declare CLEAN', () => {
  const body = read(PIPELINE)
  // Finding 1: after the fixer applies a fix, the suite must be GREEN before the
  // loop may terminate CLEAN. The fixer returns suiteGreen; if it is false the loop
  // must NOT declare clean off an empty re-review -- it must loop / escalate. So the
  // loop body must CONSUME fixer.suiteGreen, not just collect it in the schema.
  assert.match(
    body,
    /fixer\s*&&\s*fixer\.suiteGreen\s*===\s*false|fixer\.suiteGreen\s*===\s*false|!\s*\(?\s*fixer\s*&&\s*fixer\.suiteGreen\s*\)?/,
    `${PIPELINE}'s fix-loop must HONOR fixer.suiteGreen: a fixer round that broke the suite (suiteGreen false) ` +
      `must keep the loop open (loop again, or escalate at N=2), never short-circuit to CLEAN off an empty re-review. ` +
      `suiteGreen must be consumed in the loop body, not merely declared in FIXER_RESULT.`,
  )
})

test('FIX2(clean-clears-resolved-findings): a CLEAN return must not still carry the now-resolved original findings', () => {
  const body = read(PIPELINE)
  // Finding 2: when the fix-loop reaches CLEAN, the returned review must not still
  // report the resolved original findings (a CLEAN result with a non-empty findings
  // list is self-contradictory). The bundle must reflect the final (resolved) review
  // state, so a CLEAN clears the stale findings on the surfaced lenses.
  assert.match(
    body,
    /cleanResolvedFindings|clearResolvedOnClean|resolvedFindingsCleared/,
    `${PIPELINE} must clear the resolved findings from the returned review when the fix-loop reached CLEAN ` +
      `(a CLEAN bundle still listing the now-fixed original findings is self-contradictory).`,
  )
})

test('FIX3(supported-status): the deadlock path returns a SUPPORTED bundle status, not a non-routable string', () => {
  const body = read(PIPELINE)
  // Finding 3: the cockpit recognizes only two bundle statuses -- 'awaiting-review'
  // and 'failed' (cockpit SKILL.md: "anything else is a contract violation -> fail
  // loud"). The N=2 deadlock must return one of those (the escalation payload still
  // rides in review.escalation), NOT a bare 'escalated' the cockpit cannot route.
  assert.doesNotMatch(
    body,
    /status\s*=\s*[^\n]*escalation\s*\?\s*'escalated'/,
    `${PIPELINE} must NOT return status 'escalated' on the 2-pass cap -- the cockpit only routes ` +
      `'awaiting-review' | 'failed' (it fails loud on anything else). Map the escalation to 'failed' ` +
      `(quarantine -> reset-or-decompose) and carry the escalation evidence in review.escalation.`,
  )
  // pipeline-meritocracy chunk 2: the judge's 2-pass-cap escalation AND its fail-closed
  // gap both map to the SUPPORTED 'failed' status (the cockpit quarantines + routes to
  // reset-or-decompose); the escalation/gap payloads ride in review.escalation/judgeGap.
  assert.match(
    body,
    /\(escalation \|\| judgeGap\)\s*\?\s*'failed'\s*:\s*'awaiting-review'/,
    `${PIPELINE}'s escalation/gap terminal must return the SUPPORTED 'failed' status so the cockpit ` +
      `quarantines it and routes it to reset-or-decompose (the escalation/gap payload rides in review).`,
  )
})

test('FIX4(final-fixer-sha): the bundle publishes the FINAL post-fix commit sha, not only the pre-fix build sha', () => {
  const body = read(PIPELINE)
  // Finding 4: after the fix-loop lands commits the bundle must report the final
  // post-fix sha so the cockpit's effective-touches (git diff-tree on the chunk's
  // commitSha, cockpit SKILL.md) covers the fixer's file changes too -- not only the
  // original build commit. currentSha holds the final fix-loop sha; surface it.
  assert.match(
    body,
    /finalCommitSha\s*:/,
    `${PIPELINE} must surface the FINAL fix-loop commit sha as a finalCommitSha bundle field so the cockpit's ` +
      `effective-touches diff-tree covers the fixer's file changes, not just the pre-fix build commit.`,
  )
})

// =====================================================================
// NEW (fix-disciplines-global-resolve): injectDisciplineDocs resolves disciplines/
// from the GLOBAL ~/.claude root, not from the passed repoRoot.
// =====================================================================

test('AC3(global-resolve): injectDisciplineDocs reads disciplines/ from the module-anchored global root even when repoRoot has no disciplines/ child', () => {
  // Use workflows/ as the bogus repoRoot -- it has no disciplines/ child.
  // If injectDisciplineDocs resolved against repoRoot it would throw (ENOENT)
  // or return wrong bytes. The assertion proves that the module-anchored root
  // (join(here, '..'), i.e. the tree the module lives in) is used instead of
  // the passed repoRoot -- so a project repoRoot lacking disciplines/ does NOT
  // cause a failed read. In a worktree this is the worktree root, not the
  // literal ~/.claude absolute path; what matters is the ignore-repoRoot behavior.
  const bogusRepoRoot = join(here, '..', 'workflows')
  const injected = injectDisciplineDocs('worker', bogusRepoRoot)
  const canonicalBytes = read('disciplines/worker-discipline.md')
  assert.equal(
    injected.workerDiscipline,
    canonicalBytes,
    `injectDisciplineDocs must read disciplines/ from the global ~/.claude root (derived from ` +
      `the module's own location), NOT from the passed repoRoot. Called with a bogus repoRoot ` +
      `(${bogusRepoRoot}) that has no disciplines/ child, it must still return the correct bytes. ` +
      `Got: ${injected.workerDiscipline ? injected.workerDiscipline.slice(0, 80) + '...' : String(injected.workerDiscipline)}`,
  )
})

test('FIX5(cumulative-rereview-diff): the re-review judges the CUMULATIVE chunk diff, not only the latest fixer commit', () => {
  const body = read(PIPELINE)
  // Finding 5: the re-review must judge the whole accumulated branch diff (the
  // original build commit + every fixer commit), not just `git show <latest-fixer-sha>`,
  // so a fixer change that interacts badly with the original build is caught. The
  // re-review diff command must be a RANGE spanning the chunk's full contribution,
  // not a single-commit `git show <sha>`.
  assert.match(
    body,
    /reviewSha\s*\}?\^|\$\{reviewSha\}\^|git[^\n]*diff[^\n]*\$\{reviewSha\}/,
    `${PIPELINE}'s reReviewPrompt must judge the CUMULATIVE chunk diff (a range from the build commit's parent ` +
      `through the latest fixer commit), not a single-commit \`git show <latest-fixer-sha>\` -- otherwise a fixer ` +
      `change that regresses the original build code is invisible to the re-review.`,
  )
})

// =====================================================================
// system-hardening-v2 chunk 1: SEVERITY-FLOORED clean gate.
//
// Behavior shift: fixLoopController no longer terminates CLEAN only at
// openFindings.length===0 (which forced another fixer round over any P3 nit).
// It now floors on severity: it returns CLEAN when NO open finding is P1
// (blocking). P2/P3 findings ride into the bundle for the COO go/no-go and
// never force a fixer round. Severity is parsed from a [P<n>] tag (regex
// /\[P([123])\]/); an UNTAGGED finding is treated as P1 (blocking) -- fail
// safe, an unclassified finding blocks. The two synthetic integrity guards
// ([SUITE-RED], [CODEX-REFIRE-GAP]) are re-tagged to carry [P1] so the gate is
// a uniform "any open P1 blocks".
//
// All expected values are fixed from the chunk task statement BELOW, never read
// back from the implementation (no tautology). The anti-tautology guard is the
// PARITY assertion + the explicit "P2/P3-only -> clean" assertion: reverting the
// gate change (back to length===0) flips the P2/P3-only clean assertion to FAIL.
// =====================================================================

// Fixtures use the REAL wire format reviewers emit: a LEADING markdown list
// bullet (`- `) per review-contract.md:105. A bullet-LESS string is a shape the
// live pipeline NEVER emits; using it here hid the keystone-inert bug (the
// start-anchored severity/key regexes never matched past the `- `).
const P1 = '- [BUG] [P1] agents/x.md:12 -- worker -- blocking null deref'
const P2 = '- [SLOP] [P2] agents/x.md:20 -- worker -- redundant comment (nit)'
const P3 = '- [DRIFT] [P3] agents/x.md:30 -- worker -- cosmetic wording (nit)'
const UNTAGGED = '- [BUG] HIGH agents/x.md:5 -- worker -- finding with no [P<n>] tag'
const SUITE_RED = '[SUITE-RED] fixer round r1 left the suite RED (suiteGreen=false) -- not CLEAN'
const REFIRE_GAP = '[CODEX-REFIRE-GAP][P1] Codex re-fire returned null/ran:false (outage); verification incomplete'

test('AC-sev(P2/P3-only -> clean): a review whose ONLY open findings are P2/P3 nits terminates CLEAN (no fixer churn)', () => {
  // The core behavior shift + the anti-tautology pin. Under the OLD length===0
  // gate this would return 'fix' (non-empty findings) and force a fixer round;
  // under the severity floor it returns 'clean' because no open finding is P1.
  // Reverting the gate change flips THIS assertion to FAIL.
  const out = fixLoopController([P2, P3], null, 0)
  assert.equal(
    out.action,
    'clean',
    `a review with only P2/P3 open findings must terminate CLEAN -- P2/P3 ride into the bundle, they never ` +
      `force a fixer round. Got ${JSON.stringify(out)}`,
  )
})

test('AC-sev(one P1 -> fix): a single open [P1] finding forces another fixer round', () => {
  const out = fixLoopController([P2, P1, P3], null, 0)
  assert.equal(
    out.action,
    'fix',
    `an open [P1] finding among nits must keep the loop open (dispatch the fixer). Got ${JSON.stringify(out)}`,
  )
})

test('AC-sev(untagged -> P1 -> fix): an untagged finding is treated as P1 (blocking) and forces a fixer round', () => {
  const out = fixLoopController([UNTAGGED], null, 0)
  assert.equal(
    out.action,
    'fix',
    `a finding with no [P<n>] tag must be treated as P1 (fail safe: an unclassified finding blocks). ` +
      `Got ${JSON.stringify(out)}`,
  )
})

test('AC-sev(SUITE-RED blocks): a [SUITE-RED] integrity guard (no Pn tag) must block -> never clean', () => {
  // [SUITE-RED] carries no [P<n>] tag, so the no-match->P1 rule makes it block.
  const out = fixLoopController([SUITE_RED], null, 0)
  assert.equal(
    out.action,
    'fix',
    `a [SUITE-RED] guard (untagged -> P1) must block the loop, never let it declare CLEAN. Got ${JSON.stringify(out)}`,
  )
})

test('AC-sev(CODEX-REFIRE-GAP blocks): a [CODEX-REFIRE-GAP][P1] guard must block -> never clean', () => {
  // Re-tagged to [P1] so the uniform "any open P1 blocks" rule keeps it blocking.
  const out = fixLoopController([REFIRE_GAP], null, 0)
  assert.equal(
    out.action,
    'fix',
    `a [CODEX-REFIRE-GAP][P1] guard must block the loop, never let it declare CLEAN. Got ${JSON.stringify(out)}`,
  )
})

test('AC-sev(empty -> clean): an empty openFindings list still terminates CLEAN (unchanged)', () => {
  const out = fixLoopController([], null, 0)
  assert.equal(out.action, 'clean', `an empty review must terminate CLEAN (unchanged). Got ${JSON.stringify(out)}`)
})

test('AC-sev(N=2 + open P1 -> escalate): a P1 still open at attemptCount>=2 escalates (unchanged)', () => {
  const out = fixLoopController([P1], [{ finding: P1, disposition: 'stuck', evidence: 'x', files: [] }], FIX_LOOP_MAX_ATTEMPTS)
  assert.equal(out.action, 'escalate', `an open P1 at N=2 must escalate, never loop a third round. Got ${JSON.stringify(out)}`)
})

test('AC-sev(N=2 + only P2/P3 -> clean): P2/P3-only findings at N=2 still terminate CLEAN (severity floor precedes the N=2 deadlock)', () => {
  // Even at the N=2 boundary, P2/P3-only findings are not blocking -> CLEAN, not
  // escalate. The severity floor decides CLEAN before the attempt count is consulted.
  const out = fixLoopController([P2, P3], [{ finding: P1, disposition: 'fixed', evidence: 'x', files: [] }], FIX_LOOP_MAX_ATTEMPTS)
  assert.equal(out.action, 'clean', `P2/P3-only findings at N=2 must terminate CLEAN (not escalate). Got ${JSON.stringify(out)}`)
})

// --- Lockstep parity: the worker-pipeline.js inline fixLoopController body must
// stay BYTE-IDENTICAL to the fix-loop.mjs canonical (minus the `export` keyword).
// The tests import the LIB; the Workflow harness runs the inlined SCRIPT copy --
// drift means the suite is green while the launchable artifact is wrong. ---

// Extract a top-level `function <name>(...) { ... }` block by brace-matching from
// its declaration to the matching close-brace at column 0. Independent of the
// implementation (a primitive scan), so the parity check is not tautological.
function extractFn(src, name) {
  const decl = new RegExp(`^(export\\s+)?function ${name}\\(`, 'm')
  const m = decl.exec(src)
  assert.ok(m, `could not locate function ${name} in source`)
  const start = m.index + (m[1] ? m[1].length : 0) // strip a leading `export ` if present
  // brace-match from the first '{' after the decl
  let i = src.indexOf('{', m.index)
  assert.ok(i !== -1, `no opening brace for ${name}`)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break } }
  }
  return src.slice(start, i)
}

// pipeline-meritocracy chunk 2: the OLD fix-loop's inlined fixLoopController +
// findingSeverity (the severity floor) are DELETED from worker-pipeline.js, replaced
// by the inlined judgeDecision + collectReviewerFindings from meritocracy-judge.mjs.
// The lockstep parity now applies to THOSE (asserted in pipeline-meritocracy-c2.test.mjs).
// Here we pin REPLACE-means-ABSENT: the old inlined machinery is gone.
test('AC-parity(severity-floor REMOVED): worker-pipeline.js no longer inlines fixLoopController / findingSeverity', () => {
  const body = read(PIPELINE)
  assert.ok(!/function fixLoopController/.test(body),
    `${PIPELINE} must NOT keep the inlined fixLoopController (the judge decision replaces the severity floor).`)
  assert.ok(!/function findingSeverity/.test(body),
    `${PIPELINE} must NOT keep the inlined findingSeverity (the severity floor it served is deleted).`)
  // The fix-loop.mjs lib KEEPS these exports (other importers + its own unit tests use
  // them); only the worker-pipeline.js inline copies are obsoleted by the rewire.
  const lib = read('workflows/fix-loop.mjs')
  assert.match(lib, /export function fixLoopController/, 'fix-loop.mjs keeps exporting fixLoopController (lib retained; only the pipeline inline is removed).')
})

test('AC-retag(SUITE-RED guard retained, CODEX-REFIRE-GAP removed)', () => {
  const body = read(PIPELINE)
  // The SUITE-RED guard survives the rewire (a fixer round that left the suite red
  // forces the judge verdict to FIX so the loop keeps the round open).
  assert.match(
    body,
    /\[SUITE-RED\]/,
    `${PIPELINE}'s SUITE-RED guard must survive the judge rewire (a red fixer suite must not declare CLEAN).`,
  )
  // The CODEX-REFIRE-GAP guard is REMOVED: the judge fail-closed gap replaces it.
  assert.ok(
    !/CODEX-REFIRE-GAP/.test(body),
    `${PIPELINE} must NOT keep the CODEX-REFIRE-GAP guard -- the judge fail-closed gap (judgeDecision -> 'gap') replaces it.`,
  )
})

// =====================================================================
// FIXER ROUND: header-only severity match (finding [P2] in the body
// must not override the fact that the header has no severity tag).
//
// A finding whose header has no [P<n>] tag but whose body text contains
// a reference like "[P2]" or "[P3]" must be treated as P1 (the no-match
// fail-safe), not as the [P<n>] found in the body. The regex must be
// anchored to the leading bracket tokens only.
// =====================================================================

test('FIX-header-only(body-P2 does not override untagged->P1): a header-untagged finding whose body text contains [P2] is still treated P1 (blocking)', () => {
  // The current regex /\[P([123])\]/ searches the whole string. A finding like
  //   '[BUG][FIX:B] desc -- f:5 -- worker -- avoid [P2] patterns'
  // has no [P<n>] in its header, so the no-match->P1 rule should apply (blocking).
  // But the whole-string regex matches [P2] in the body and returns non-blocking (2).
  // This test pins the correct behavior: header-untagged -> P1, regardless of body.
  const finding = '- [BUG][FIX:B] missing gate -- file.js:5 -- worker -- must handle [P2] findings correctly'
  const sev = findingSeverity(finding)
  assert.equal(
    sev,
    1,
    `findingSeverity must return 1 (blocking) for a header-untagged finding even if the body ` +
      `text mentions "[P2]". The regex must match [P<n>] only in the leading bracket tokens, ` +
      `not anywhere in the string. Got: ${sev}`,
  )
})

test('FIX-header-only(body-P3 does not override untagged->P1): a header-untagged finding whose body text contains [P3] is still treated P1 (blocking)', () => {
  const finding = '- [SLOP][FIX:C] redundant code -- file.js:20 -- worker -- this was previously [P3] nit level'
  const sev = findingSeverity(finding)
  assert.equal(
    sev,
    1,
    `findingSeverity must return 1 for a header-untagged finding with [P3] in the body. Got: ${sev}`,
  )
})

// =====================================================================
// FIXER ROUND: contract-bulleted wire format (the keystone-inert regression).
//
// Reviewers emit every finding line with a LEADING markdown list bullet per
// review-contract.md:105 (`- [<DIM>][P<n>][FIX:X] ...`). The start-anchored
// severity/key regexes did not tolerate the `- `, so a real bulleted
// `- [SLOP][P3]...` fell through to the untagged->P1 fail-safe: every real
// finding was treated P1, the severity floor never fired, and a P2/P3-only
// review still forced a fixer round (the keystone was DEAD on production input).
// These pins exercise the REAL wire shape and fail if the bullet-strip is reverted.
// =====================================================================

test('FIX-bullet(contract-bulleted P3 -> severity 3): a real `- [SLOP][P3]...` line parses as P3, not the untagged->P1 fail-safe', () => {
  const finding = '- [SLOP][P3][FIX:C] redundant comment -- agents/x.md:1 -- worker -- nit'
  const sev = findingSeverity(finding)
  assert.equal(
    sev,
    3,
    `findingSeverity must strip the leading "- " bullet and parse [P3] -> 3. A start-anchored regex that ` +
      `does not tolerate the bullet falls through to untagged->P1 (keystone-inert). Got: ${sev}`,
  )
})

test('FIX-bullet(contract-bulleted P3-only review -> clean): a P2/P3-only bulleted review terminates CLEAN (the keystone fires on production input)', () => {
  const out = fixLoopController(['- [SLOP][P3][FIX:C] redundant comment -- agents/x.md:1 -- worker -- nit'], [], 0)
  assert.equal(
    out.action,
    'clean',
    `a P2/P3-only review IN THE REAL BULLETED WIRE FORMAT must terminate CLEAN. Before the fix this returned ` +
      `'fix' (bulleted P3 mis-parsed as P1), so the severity floor never fired on production input. Got ${JSON.stringify(out)}`,
  )
})

test('FIX-bullet(contract-bulleted P1 -> fix): a real `- [BUG][P1]...` line still forces a fixer round', () => {
  const out = fixLoopController(['- [BUG][P1][FIX:B] null deref -- agents/x.md:12 -- worker -- crashes on empty'], [], 0)
  assert.equal(
    out.action,
    'fix',
    `a bulleted [P1] finding must keep the loop open (dispatch the fixer). Got ${JSON.stringify(out)}`,
  )
})

test('FIX-bullet(findingKey strips bullet + tags from title): a bulleted finding keys on the contract title, not the [DIM]/[P]/[FIX] tags', () => {
  const key = findingKey('- [SLOP][P3][FIX:C] redundant comment -- agents/x.md:1 -- worker -- nit')
  const title = key.split('|')[2]
  assert.equal(
    title,
    'redundantcomment',
    `findingKey must strip the leading "- " bullet AND all leading [DIM]/[P]/[FIX] bracket tokens from the ` +
      `title. A start-anchored strip that does not tolerate the bullet leaks the tags (e.g. 'slopp3fixcredundantcomment'). Got title: ${title}`,
  )
})

// =====================================================================
// system-hardening-v2 chunk 2: NARROWED re-review scoping + settledRejectKeys.
//
// Two behavior shifts, both about stopping the fix-loop's re-review from
// churning correct code:
//
//  (A) reReviewPrompt is NARROWED: the per-criterion nit-hunt line
//      ('check each ONE AT A TIME, hunt for OMISSIONS') is REPLACED by scoping
//      that (a) verifies each named round-1 finding is resolved and (b) flags
//      only NEW P1 correctness/security/acceptance regressions the fixer
//      introduced -- it no longer emits fresh P2/P3 drift/slop. The
//      cumulative-diff RANGE (git ... diff ${reviewSha}^..${sha}) is RETAINED
//      (it catches a fixer regressing the original build).
//
//  (B) gatherFindings gains a TRAILING settledKeys Set arg + a dedup key
//      (findingKey = DIM + file-path + normalized-title, NO :lines -- lines
//      shift after a fix). The loop body maintains an ACCUMULATING
//      settledRejectKeys Set: a prior round's REJECT whose key the re-review did
//      NOT re-raise is added to the Set, so it cannot re-appear in a later round.
//      A re-raised REJECT is NOT settled and still loops.
//
// All expected values are fixed from the chunk task statement BELOW, never read
// back from the implementation. The anti-tautology guard is AC-settle(round-2
// suppression): reverting the settledRejectKeys wiring re-admits the settled key
// and flips that assertion to FAIL.
// =====================================================================

// Two findings sharing a DIM + file but differing only by :lines, title case/
// whitespace, AND 'why' wording -- used to prove the dedup key strips :lines
// and uses the CONTRACT TITLE (parts[0] after bracket tokens), NOT the why tail.
// Full review-contract format: [DIM][Pn][FIX:B] <title> -- <file>:<lines> -- <alt> -- <why>
const rejectR1 = '- [BUG][P1][FIX:B] Null Deref On Empty Findings -- workflows/x.mjs:12 -- worker -- controller crashes when findings is empty'
const rejectR2SameKey = '- [BUG][P1][FIX:B] null   deref on empty findings -- workflows/x.mjs:40 -- worker -- crashes when findings array is null or undefined'
const otherFinding = '- [SLOP][P1][FIX:C] redundant guard clause -- workflows/y.mjs:7 -- worker -- guard is unnecessary here'

test('AC-settle(gatherFindings drops settled key): a finding whose key is in settledKeys is dropped from the gathered list', () => {
  const review = { ran: true, clean: false, findings: [rejectR2SameKey, otherFinding] }
  const settled = new Set([findingKey(rejectR1)])
  const out = gatherFindings(review, settled)
  assert.ok(
    !out.includes(rejectR2SameKey),
    `gatherFindings must DROP a finding whose key is in settledKeys (rejectR2 shares rejectR1's key -- ` +
      `same DIM+file+normalized-title, only :lines/case differ). Got: ${JSON.stringify(out)}`,
  )
  assert.ok(
    out.includes(otherFinding),
    `gatherFindings must KEEP a finding whose key is NOT in settledKeys. Got: ${JSON.stringify(out)}`,
  )
})

test('AC-settle(empty/absent Set drops nothing -- back-compat): gatherFindings with no settledKeys arg, or an empty Set, drops nothing', () => {
  const review = { ran: true, clean: false, findings: [rejectR2SameKey, otherFinding] }
  // Absent trailing Set (the legacy call shape gatherFindings(...reviews)).
  const noArg = gatherFindings(review)
  assert.deepEqual(
    noArg,
    [rejectR2SameKey, otherFinding],
    `gatherFindings called WITHOUT a settledKeys Set must behave exactly as before (drop nothing) -- back-compat. ` +
      `Got: ${JSON.stringify(noArg)}`,
  )
  // Explicit empty Set.
  const emptySet = gatherFindings(review, new Set())
  assert.deepEqual(
    emptySet,
    [rejectR2SameKey, otherFinding],
    `gatherFindings with an EMPTY settledKeys Set must drop nothing. Got: ${JSON.stringify(emptySet)}`,
  )
})

test('AC-settle(key strips :lines + normalizes title): two findings differing only by :lines and title whitespace/case share a key', () => {
  // The dedup key = DIM + file-path + normalized-title (lowercased,
  // whitespace/punctuation-stripped), NO :lines. rejectR1 and rejectR2SameKey
  // differ only by :12 vs :40 and 'Null Deref On Empty Findings' vs
  // 'null   deref on empty findings' -- they must produce the SAME key.
  assert.equal(
    findingKey(rejectR1),
    findingKey(rejectR2SameKey),
    `findingKey must match across :lines drift and title case/whitespace differences ` +
      `(${findingKey(rejectR1)} vs ${findingKey(rejectR2SameKey)}).`,
  )
  // A different DIM, file, or material title-word must NOT collide.
  assert.notEqual(
    findingKey(rejectR1),
    findingKey(otherFinding),
    `findingKey must differ for a different DIM+file+title (no false collisions).`,
  )
})

// --- The loop-body settledRejectKeys mechanism is asserted as STATIC SOURCE
// TEXT (worker-pipeline.js executes at import -- top-level await agent -- so it
// cannot be imported; its WIRING is grep-asserted, the same strategy as the
// other FIX/AC wiring tests above). ---

// pipeline-meritocracy chunk 2: the settledRejectKeys / REJECT-settle dedup, the
// reReviewPrompt narrowing, and the inlined gatherFindings + findingKey are all
// OBSOLETED by the judge rewire. The judge OWNS truth -- there is no fixer REJECT to
// settle, no Sonnet re-review to narrow, no cross-round dedup Set. The reviewers'
// findings are gathered for the judge via collectReviewerFindings (no severity filter,
// no settled-key dedup), and the judge re-check replaces the re-review. We pin
// REPLACE-means-ABSENT for the removed machinery + the cumulative-range survival.

test('AC-settle(REMOVED): the settledRejectKeys / REJECT-settle dedup machinery is absent', () => {
  const body = read(PIPELINE)
  assert.ok(!/settledRejectKeys/.test(body),
    `${PIPELINE} must NOT keep settledRejectKeys -- the judge owns truth, so there is no fixer REJECT to settle across rounds.`)
  assert.ok(!/disposition\s*===\s*'REJECT'/.test(body),
    `${PIPELINE} must NOT key any settle on the REJECT disposition (the fixer no longer has a REJECT path).`)
})

test('AC-settle(judge seeding): findings are gathered for the judge via collectReviewerFindings (no severity filter, no dedup Set)', () => {
  const body = read(PIPELINE)
  assert.match(body, /=\s*collectReviewerFindings\(/,
    `${PIPELINE} must gather the reviewers' findings for the judge via collectReviewerFindings (replacing gatherFindings + the settled-key dedup).`)
  assert.ok(!/function gatherFindings/.test(body),
    `${PIPELINE} must NOT keep the inlined gatherFindings (the judge gather has no severity filter / settled-key dedup).`)
  assert.ok(!/function findingKey/.test(body),
    `${PIPELINE} must NOT keep the inlined findingKey (the cross-round dedup it served is gone).`)
})

// --- The re-review is REPLACED by the judge re-check (reReviewPrompt removed). ---

test('AC-narrow(re-review REPLACED by judge re-check): reReviewPrompt is gone, judgeLensPrompt re-checks', () => {
  const body = read(PIPELINE)
  assert.ok(!/function reReviewPrompt/.test(body),
    `${PIPELINE} must NOT keep reReviewPrompt -- the opus judge re-check (judgeLensPrompt P5) replaces the Sonnet re-review.`)
  assert.match(body, /function judgeLensPrompt/,
    `${PIPELINE} must define judgeLensPrompt (the judge dispatch + P5 re-check that replaces the re-review).`)
  assert.match(body, /RE-CHECK \(P5\)/,
    `${PIPELINE}'s judge dispatch must carry the P5 re-check framing (re-adjudicate that each TRUE finding is resolved + no new finding reproduces).`)
})

test('AC-narrow(cumulative range RETAINED in the judge re-check): the reviewSha^..currentSha range is KEPT', () => {
  const body = read(PIPELINE)
  // The cumulative-diff regression catch survives: the judge re-check judges the
  // FULL chunk contribution (build commit + every fixer commit), not the latest
  // fixer commit in isolation.
  assert.match(
    body,
    /diff \$\{reviewSha\}\^\.\.\$\{currentSha\}/,
    `${PIPELINE}'s judge re-check must RETAIN the cumulative branch-diff range (git ... diff ` +
      `\${reviewSha}^..\${currentSha}) -- it catches a fixer regressing the original build.`,
  )
})

// --- Lockstep parity for the NEW judge decision core (the inline worker-pipeline.js
// copies must stay byte-identical to the meritocracy-judge.mjs canonical, minus
// `export`). The deleted gatherFindings/findingKey parity is replaced by this. ---

test('AC-judge-parity(judgeDecision byte-match): the inline judgeDecision is byte-identical to the meritocracy-judge.mjs canonical', () => {
  const canonical = extractFn(read('workflows/meritocracy-judge.mjs'), 'judgeDecision')
  const inline = extractFn(read(PIPELINE), 'judgeDecision')
  assert.equal(
    inline,
    canonical,
    `${PIPELINE}'s inline judgeDecision drifted from meritocracy-judge.mjs (must stay byte-identical minus the export ` +
      `keyword -- the tests import the lib, the harness runs the inline copy; drift = green suite, wrong launchable).`,
  )
})

test('AC-judge-parity(collectReviewerFindings byte-match): the inline copy is byte-identical to the canonical', () => {
  const canonical = extractFn(read('workflows/meritocracy-judge.mjs'), 'collectReviewerFindings')
  const inline = extractFn(read(PIPELINE), 'collectReviewerFindings')
  assert.equal(
    inline,
    canonical,
    `${PIPELINE}'s inline collectReviewerFindings drifted from meritocracy-judge.mjs (must stay byte-identical minus export).`,
  )
})

// =====================================================================
// FIXER ROUND 2: system-hardening-v2 chunk 2 fixes
//   F1: reReviewPrompt must list the prior round's non-REJECT findings
//   F2: findingKey must use the contract SHORT TITLE (parts[0] after
//       bracket tokens), not the 'why' tail (parts[last])
// =====================================================================

// F2: key by contract title (the short description), not by the 'why'
// tail. In the full review-contract format:
//   [DIM][Pn][FIX:B] <short title> -- <file>:<lines> -- <altitude> -- <why>
// the same finding re-raised may have a different 'why' wording (the
// reviewer rephrases the explanation) but the same short title. The dedup
// key must use the short title so a re-raise with different why wording
// still matches the settled key.
//
// Anti-tautology: reverting to `parts[parts.length - 1]` flips this test
// to FAIL (the two 'why' strings differ -> different keys -> settled REJECT
// gets re-admitted).
const contractR1 = '[BUG][P1][FIX:B] null deref on empty findings -- workflows/x.mjs:12 -- worker -- controller crashes when findings is empty'
const contractR2_sameTitle = '[BUG][P1][FIX:B] null deref on empty findings -- workflows/x.mjs:40 -- worker -- crashes when the array passed in is null or undefined'

test('F2(findingKey uses contract title not why): full contract-format findings with same title but different why/line share a key', () => {
  // Both findings name the same root issue ('null deref on empty findings')
  // but differ in line number (:12 vs :40) and in the 'why' wording. A
  // settled REJECT from round 1 must suppress the round-2 re-raise even
  // when the reviewer rephrased the why.
  const k1 = findingKey(contractR1)
  const k2 = findingKey(contractR2_sameTitle)
  assert.equal(
    k1,
    k2,
    `findingKey must produce the SAME key for full-contract-format findings that share the short title ` +
    `but differ in line number and why wording. The key must use the short title (parts[0] after ` +
    `stripping leading bracket tokens), NOT the 'why' tail (parts[last]). ` +
    `Got: ${k1} vs ${k2}`,
  )
})

test('F2(findingKey no collision on different title): full contract-format findings with different titles must NOT share a key', () => {
  const other = '[BUG][P1][FIX:B] missing null check before iteration -- workflows/x.mjs:12 -- worker -- iterating null crashes'
  assert.notEqual(
    findingKey(contractR1),
    findingKey(other),
    `findingKey must NOT collide on findings with different short titles (${findingKey(contractR1)} vs ${findingKey(other)}).`,
  )
})

// P2: findingKey must extract paths from non-whitelisted extensions.
// The previous regex whitelisted only .mjs/.js/.ts/.md/.json/.sh/.py, so a
// finding citing config/app.yaml:12 yielded path='' and produced a weakened
// dedup key. The fix reads the file token from parts[1] (the second ' -- '
// segment) and strips the trailing :line(:col), matching the review-contract
// format: `<title> -- <file>:<lines> -- <alt> -- <why>`.
//
// Two tests: (a) .yaml path is extracted, (b) same-title re-raise on a
// shifted line on that .yaml file still collides (NO :lines in the key).
//
// Anti-tautology: reverting to the old whitelist regex makes (a) fail
// because path='' for a .yaml finding, which is the bug being fixed.
const yamlFinding1 = '- [BUG] [P1] bad config -- config/app.yaml:12 -- worker -- wrong value'
const yamlFinding2 = '- [BUG] [P1] bad config -- config/app.yaml:99 -- worker -- still wrong'

test('P2(findingKey extracts non-whitelisted extension path): a .yaml finding yields a non-empty path', () => {
  const k = findingKey(yamlFinding1)
  // The key is DIM|path|title; path must not be empty for a .yaml finding.
  const parts = k.split('|')
  assert.strictEqual(parts.length, 3, `findingKey must return DIM|path|title (3 parts), got: ${k}`)
  assert.ok(
    parts[1] !== '',
    `findingKey must extract the file path from a .yaml finding; got path='' (key: ${k}). ` +
    `The old extension whitelist (mjs/js/ts/md/json/sh/py) excludes .yaml. ` +
    `Fix: parse path from parts[1] of the ' -- '-delimited contract format, ` +
    `stripping the trailing :line(:col).`,
  )
  assert.ok(
    parts[1].includes('yaml'),
    `findingKey path part must contain 'yaml', got: ${parts[1]} (key: ${k})`,
  )
})

test('P2(findingKey same key across shifted lines on .yaml file): re-raise on same .yaml file with shifted line yields same key', () => {
  const k1 = findingKey(yamlFinding1)
  const k2 = findingKey(yamlFinding2)
  assert.equal(
    k1,
    k2,
    `findingKey must produce the SAME key for a .yaml finding re-raised with a shifted line number. ` +
    `The key must NOT include :lines (lines shift after a fix). ` +
    `Got: ${k1} vs ${k2}`,
  )
})

// F1: reReviewPrompt must list the prior round's non-REJECT findings.
// The prompt claims "(listed below)" but never actually enumerates them,
// leaving the re-reviewer without the target finding texts to verify
// against. The fix: pass the prior round's findings to reReviewPrompt
// (or derive them from fixerDispositions) and emit a list in the prompt.

test('F1(judge re-check enumerates the fixer dispositions): the judge prompt lists the prior round dispositions', () => {
  const body = read(PIPELINE)
  // pipeline-meritocracy chunk 2: reReviewPrompt is DELETED. The judge re-check
  // (judgeLensPrompt) receives the fixer's prior-round dispositions and enumerates
  // each one so the judge can confirm each TRUE finding is resolved (P5). Assert the
  // judge prompt maps the fixer dispositions into its body.
  assert.match(
    body,
    /fixerDispositions\.map\(/,
    `${PIPELINE}'s judgeLensPrompt must enumerate the fixer's prior-round dispositions (fixerDispositions.map) ` +
    `so the judge re-check can confirm each TRUE finding is resolved (replacing the deleted reReviewPrompt list).`,
  )
})

// =====================================================================
// pipeline-meritocracy chunk 2: residualFindings REMOVED.
//
// The OLD severity floor let the fix-loop terminate CLEAN with open P2/P3
// findings still present, so residualFindings surfaced those nits for the COO.
// The judge has NO severity floor -- every TRUE finding (any P-level) fires
// the fixer, so a CLEAN terminal means NO TRUE finding remains; there are no
// "residual nits that rode through the floor" to surface. The residualFindings
//    another fixer round" (endState: "P2/P3 ride into the bundle").
//
// Fix: add a top-level `residualFindings` field to the return bundle:
//   - CLEAN + fix round(s) ran: the final openFindings (the non-P1 nits
//     that rode through the floor)
//   - CLEAN with zero open findings OR no fix round ran: []
//   - Non-clean terminal (escalation): [] (no residual surfaced)
//
// The per-lens findings remain cleared to [] (resolvedLens unchanged).
//
// Anti-tautology: the `residualFindings` field is ABSENT before this fix,
// so the first assertion (field-present) fails on unpatched code; the
// second assertion (sources the final openFindings, not always []) must
// also pass to prevent a trivially-empty implementation.
// =====================================================================

test('P2-residual(REMOVED): the residualFindings field is gone (no severity floor -> no residual nits)', () => {
  const body = read(PIPELINE)
  // With NO severity floor, a CLEAN terminal means NO TRUE finding remains -- there is
  // nothing residual to surface. The residualFindings field is obsoleted by the rewire.
  assert.ok(
    !/residualFindings/.test(body),
    `${PIPELINE} must NOT keep residualFindings -- the judge has no severity floor, so a CLEAN terminal ` +
    `carries no "P2/P3 nits that rode through the floor" (the live defect this chunk fixes).`,
  )
})

test('P2-judge(every TRUE finding fires the fixer): no severity floor in the judge decision', () => {
  const body = read(PIPELINE)
  // REPLACE-means-ABSENT for the floor itself: judgeDecision routes ANY non-empty
  // fixList to 'fix' (no `findingSeverity` gate). Assert the floor helper is absent and
  // the FIX route is unconditional on a non-empty fixList.
  assert.ok(!/findingSeverity/.test(body),
    `${PIPELINE} must NOT keep findingSeverity -- the judge fixes every TRUE finding regardless of severity.`)
  assert.match(body, /fixList\.length === 0/,
    `${PIPELINE}'s judgeDecision must clear ONLY on an empty fixList (CLEAN), and fix on any non-empty fixList -- no severity floor.`)
})

test('P2-residual(per-lens findings still cleared): resolvedLens still clears per-lens findings to [] on CLEAN (unchanged)', () => {
  const body = read(PIPELINE)
  // The resolvedLens() helper must remain intact -- it keeps per-lens findings []
  // on a CLEAN terminal so no resolved finding is re-surfaced as still-open.
  // The residualFindings field is ADDITIVE; resolvedLens must not be removed.
  assert.match(
    body,
    /resolvedLens\s*\(/,
    `${PIPELINE} must retain the resolvedLens() helper -- per-lens findings are still ` +
    `cleared to [] on CLEAN (resolved findings must not re-appear as still-open). ` +
    `The residualFindings field is additive and does not replace this behavior.`,
  )
  assert.match(
    body,
    /findings\s*:\s*\[\s*\]/,
    `resolvedLens must still return findings:[] for each lens on a CLEAN terminal.`,
  )
})

test('P2-resolvedLens(cleanResolvedFindings keyed on ANY judge CLEAN terminal): the CLEAN-clear guard survives the rewire', () => {
  const body = read(PIPELINE)
  // The CLEAR-RESOLVED-FINDINGS guard survives, keyed on ANY judge CLEAN terminal --
  // it clears the per-lens findings whether the judge dropped them FAULTY with zero
  // fixer rounds (pipeline-meritocracy chunk 10) or the fixer resolved them across
  // rounds. It is NO LONGER gated on judgeRounds.length > 0: a clean bundle must
  // never surface stale lens.findings.
  assert.match(
    body,
    /const cleanResolvedFindings = \(judgeDecisionResult\.action === 'clean'\)/,
    `${PIPELINE}'s cleanResolvedFindings must be keyed on ANY judge CLEAN terminal ` +
    `(no judgeRounds.length gate -- chunk 10 widened it so a zero-fixer-round CLEAN clears too).`,
  )
  assert.doesNotMatch(
    body,
    /cleanResolvedFindings = \([^)]*judgeRounds\.length > 0/,
    `${PIPELINE}'s cleanResolvedFindings must NOT re-gate on judgeRounds.length > 0 (chunk 10).`,
  )
})
