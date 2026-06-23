export const meta = {
  name: 'worker-pipeline',
  description: 'Run one chunk as a single build-agent + a fresh-context verification net in a cockpit-made shared worktree, returning a review bundle',
  phases: [
    { title: 'BUILD', detail: 'ONE build-agent runs recall -> chunk-kickoff -> RED -> RED-state record -> GREEN -> refactor -> self-check -> commit in ONE continuous context; builder emits RAW lessonCandidates (no capture-learning drafting); recall is the builder\'s first step in its own context (anti-skip: required recallEvidence field in BUILD_RESULT)', model: 'opus everywhere (default high, heavy xhigh)' },
    { title: 'REVIEW', detail: 'fresh-context verification net OUTSIDE the build-agent, split by model strength: a Codex does-it-work lens (correctness/bugs/security only; fires on both tiers -- gpt-5.4-mini/medium at default, gpt-5.5/xhigh at heavy; Opus fallback on Codex outage, flags degraded) + a full-scope Sonnet chunk-reviewer lens (all four dimensions incl. the per-criterion walk; every tier) + an opus adversarial lens gated to `heavy` (assume-a-hole; fail-open, never sets degraded; findings feed the judge) on the committed diff', model: 'sonnet (chunk-reviewer lens) + Codex (cross-model, both tiers) + opus (adversarial, heavy only)' },
    { title: 'JUDGE', detail: 'ONE opus meritocracy-judge (agents/meritocracy-judge.md) adjudicates EACH reviewer finding TRUE-vs-FAULTY by EVIDENCE (the P2 walk) + grounds in the real project/data (P9), returns { verdict: CLEAN|FIX, fixList (every TRUE finding, NO severity floor), issueLog } and persists the issue log to a durable per-chunk sidecar (crash-survivable). A FAULTY no-repro finding is dropped here and never reaches the fixer; a present TRUE finding (any severity) never returns CLEAN. Re-runs after each fixer round (P5 re-check); 2-pass cap then escalate. Replaces the deleted mechanical severity-floor + fixer-arbitration path + re-review-deadlock-escalation.', model: 'opus (judge; effort high default / xhigh heavy)' },
  ],
}

// inlined from tier-dispatch.mjs (Workflow sandbox has no module resolution); must agree with that file + coo/coo-sop.md § 6
// TWO-TIER dial (pipeline-meritocracy chunk 1): the old four-tier S/A/B/C dial
// collapses to `default` (build-agent/opus/high) + `heavy` (build-agent-heavy/opus/xhigh),
// opus everywhere. normalizeTier folds legacy S/A/B/C into the two live tiers so
// old-spec reads still resolve (A/S -> heavy, B/C/absent -> default).
function normalizeTier(t) {
  switch (String(t || '').toUpperCase()) {
    case 'HEAVY':
    case 'A':
    case 'S': return 'heavy'
    // 'DEFAULT', 'B', 'C', and an absent/unknown tier all map to the default tier.
    default:  return 'default'
  }
}

function tierConfig(t) {
  return normalizeTier(t) === 'heavy'
    ? { buildAgent: 'build-agent-heavy', buildModel: 'opus' }
    : { buildAgent: 'build-agent',       buildModel: 'opus' }
}

function reviewerFor(t) {
  return normalizeTier(t) === 'heavy'
    ? { agentType: 'chunk-reviewer-heavy' }
    : { agentType: 'chunk-reviewer' }
}
// fixerFor(findings) dials the FIX-loop fixer by the FIX-tier -- the complexity /
// blast-radius of the FIX a reviewer recommends, taken as the MAX across all open
// findings -- NOT by the chunk tier. Reviewers tag each finding with `[FIX:<C|B|A|S>]`
// per the rate-the-fix rubric in disciplines/review-contract.md (trivial=C, ordinary=B,
// complex-or-high-blast=A, extreme-or-irreversible=S). The MAX rank folds into the two
// live tiers (A/S -> heavy, B/C -> default), opus everywhere; an untagged finding
// defaults to B and an empty list yields the default lane.
//   default -> fixer       (opus/high, the base)
//   heavy   -> fixer-heavy  (opus/xhigh)
const FIX_TIER_RANK = { C: 0, B: 1, A: 2, S: 3 }
const FIX_RANK_TIER = ['C', 'B', 'A', 'S']
function fixerFor(findings) {
  const list = Array.isArray(findings) ? findings : []
  // Per-finding: parse `[FIX:<tier>]` (case-insensitive); untagged defaults to B.
  // MAX across all findings (C<B<A<S). Empty list -> B (the default lane).
  let maxRank = FIX_TIER_RANK.B
  if (list.length) {
    maxRank = -1
    for (const f of list) {
      const m = /\[FIX:([CBAS])\]/i.exec(String(f || ''))
      const rank = m ? FIX_TIER_RANK[m[1].toUpperCase()] : FIX_TIER_RANK.B
      if (rank > maxRank) maxRank = rank
    }
  }
  // Fold the legacy FIX rank into the two live tiers: A/S -> heavy, B/C -> default.
  const fixTier = normalizeTier(FIX_RANK_TIER[maxRank])
  return fixTier === 'heavy'
    ? { agentType: 'fixer-heavy', model: 'opus', fixTier: 'heavy' }
    : { agentType: 'fixer',       model: 'opus', fixTier: 'default' }
}

// judgeFor(t): the meritocracy-judge effort dial, mirroring tierConfig/reviewerFor.
// The judge stays opus (model diversity is not the point here -- it IS the opus
// truth-arbiter); only its reasoning EFFORT scales by tier, and effort is
// frontmatter-only, so the selector picks the FILE: default -> meritocracy-judge
// (opus/high), heavy -> meritocracy-judge-heavy (opus/xhigh). normalizeTier folds
// legacy A/S -> heavy, B/C/absent -> default. The dispatch model stays opus (the
// caller passes tierCfg.buildModel); judgeFor returns the agentType only.
function judgeFor(t) {
  return normalizeTier(t) === 'heavy'
    ? { agentType: 'meritocracy-judge-heavy' }
    : { agentType: 'meritocracy-judge' }
}

// codexTierArg(t): translate a two-tier (or legacy S/A/B/C) value into the
// --tier argument for codex-review.sh. codex-review.sh's tier_config() accepts
// ONLY S|A|B|C (or empty for the pre-tier default); it exits 2 on any other input.
// Mapping follows the coo-sop.md § 6 Codex column:
//   heavy  (or legacy A/S) -> 'S' : gpt-5.5/xhigh, the strong Codex lens
//   default (or legacy B/C) -> 'B' : gpt-5.4-mini/medium, the cheap cross-model lens
//   absent (empty t)        -> ''  : no --tier flag; codex-review.sh falls back to
//                                    medium effort (the pre-tier default, no model override)
// This function is NOT part of the lockstep set (tier-dispatch.mjs / tier-config /
// fixerFor / etc.); it is a LOCAL worker-pipeline.js helper that bridges the
// two-tier vocabulary and the legacy codex-review.sh CLI surface.
function codexTierArg(t) {
  if (!t || String(t).trim() === '') return ''   // absent -> no --tier flag
  // heavy -> 'S' (gpt-5.5/xhigh), default -> 'B' (gpt-5.4-mini/medium)
  return normalizeTier(t) === 'heavy' ? 'S' : 'B'
}

// One chunk = one background worker-pipeline. The cockpit launches N of these
// (one per launchable chunk, up to the concurrency cap) as separate background
// Workflow invocations -- separate workflows so each notifies on its own
// completion (continuous scheduling, Req 4), NOT one wave-parallel() barrier.
//
// args (built by the cockpit, which created the worktree via Bash BEFORE launch
// -- Workflow scripts have no filesystem/bash access, so the shared worktree
// must be made outside and threaded in):
//   { chunkId, branch, worktree, taskStatement, acceptanceCriteria, specExcerpt, tier }
// tier (default|heavy, optional; legacy A/S/B/C still resolve via normalizeTier)
// drives three things: (1) which build-agent FILE is dispatched + the dispatch
// model (tierConfig) -- the file dials effort (default -> base/high, heavy ->
// -heavy/xhigh) while the model is the dispatch arg (opus on both tiers); and the
// fresh-context Sonnet reviewer FILE (reviewerFor) -- default -> base (sonnet/high),
// heavy -> -heavy (sonnet/xhigh), stays sonnet for model diversity; (2) the REVIEW
// Codex lens -- fires on BOTH tiers (default: gpt-5.4-mini/medium via --tier B;
// heavy: gpt-5.5/xhigh via --tier S); Tier C is absorbed into `default` after the
// 2-tier collapse (coo/coo-sop.md § 6); codexTierArg translates the 2-tier vocab
// to the legacy codex-review.sh --tier values (S|A|B|C);
// (3) codex-review.sh's --tier (model + reasoning effort) when the Codex lens runs.
// The Sonnet full-scope chunk-reviewer lens runs on EVERY tier independently.
//
// Stage order (chunk 5): BUILD -> REVIEW. BUILD is ONE build-agent that runs the
// whole per-chunk inner loop (recall -> chunk-kickoff -> RED -> RED-state record
// -> GREEN -> refactor -> self-check -> commit) in ONE continuous
// context (merged in chunk 4), replacing the old recall / test-author / implementer
// / checkpoint relay. REVIEW is the fresh-context verification net that sits
// OUTSIDE the build-agent.
//
// args may arrive as a parsed object or, depending on how the launcher encodes
// it, as a JSON string -- the Workflow `args` field has no declared schema type,
// so the harness can thread it verbatim. Tolerate both: parse a string form.
let a = args || {}
if (typeof a === 'string') {
  try { a = JSON.parse(a) } catch (e) { a = {} }
}
const chunkId = a.chunkId || 'unknown'
const worktree = a.worktree
if (!worktree) {
  throw new Error(
    'worker-pipeline: args.worktree is required (got typeof args=' + (typeof args) +
    ', raw=' + JSON.stringify(args).slice(0, 200) + '). The cockpit creates the ' +
    'shared worktree via Bash before launch and threads its absolute path in.'
  )
}

// DOC INJECTION (lean-system-design chunk llr-C2, per A0's verified loading model).
// Builders, the fixer, the reviewers, and the Codex lens inherit CLAUDE.md + rules/
// at spawn but NOT disciplines/ -- so the discipline docs only reach them if the
// dispatch payload carries their FULL BYTES. A Workflow script has no filesystem
// access, so it cannot read disciplines/worker-discipline.md or
// disciplines/review-contract.md itself; the cockpit (which has Bash) reads the
// bytes -- via fix-loop.mjs's injectDisciplineDocs() helper, the canonical reader --
// and attaches them as args.injectedDocs (annex Part 4 D (i): runtime-attached by
// the cockpit, never authored). This pipeline THREADS those bytes into the right
// payloads: workerDiscipline -> the build-agent + fixer; reviewContract -> the
// full-scope chunk-reviewer (Sonnet) lens only (C8: the Codex does-it-work lens no
// longer takes the full contract -- it carries a focused bug/security mandate). (If
// the cockpit did not attach them -- e.g. a direct
// dispatch outside the cockpit -- the threaded value is empty and each agent falls
// back to reading the doc from its canonical global path (~/.claude/disciplines/),
// which is why the prompt still names the path.)
const injectedDocs = (a.injectedDocs && typeof a.injectedDocs === 'object') ? a.injectedDocs : {}
const workerDisciplineDoc = injectedDocs.workerDiscipline || ''  // disciplines/worker-discipline.md bytes (builder + fixer)
const reviewContractDoc = injectedDocs.reviewContract || ''      // disciplines/review-contract.md bytes (the full-scope chunk-reviewer / Sonnet lens)

// A block that injects a discipline doc's full bytes into an agent payload, or --
// when the cockpit did not attach the bytes -- instructs the agent to read the doc
// from its canonical global path (~/.claude/disciplines/). The path is named either
// way so the contract is reachable.
function injectedDocBlock(label, rel, bytes) {
  if (bytes) {
    return `\n--- INJECTED ${label} (${rel}, full text -- you do NOT inherit disciplines/) ---\n${bytes}\n--- END INJECTED ${label} ---\n`
  }
  // disciplines/ is GLOBAL (~/.claude/disciplines/) -- it does not exist in project
  // worktrees. Point the agent at the canonical absolute path, not "your worktree".
  return `\n(Read ~/.claude/${rel} -- that is your ${label} contract at its canonical global path; you do not inherit disciplines/, so it was not auto-loaded.)\n`
}

// VERBATIM-INLINED from meritocracy-judge.mjs (the Workflow sandbox has no module
// resolution, so this script cannot import that module). meritocracy-judge.mjs is
// the canonical, unit-tested source; this inline copy MUST move in lockstep with it.
//
// THE ARCHITECTURE THIS REPLACES (deleted in pipeline-meritocracy chunk 2): the
// mechanical severity-floor controller (P2/P3 findings cleared with 0 fix rounds --
// the live defect), the fixer-arbitration path (the fixer argued findings back and a
// re-review re-judged), and the re-review-deadlock-escalation. Truth-arbitration was
// SCATTERED across three actors. Now ONE opus meritocracy-judge
// (agents/meritocracy-judge.md) weighs each finding TRUE-vs-FAULTY by EVIDENCE and
// returns { verdict, fixList, issueLog }; this PURE decision core routes its verdict.
const JUDGE_MAX_PASSES = 2

function collectReviewerFindings(...reviews) {
  const open = []
  for (const r of reviews) {
    if (r && r.ran && !r.clean && Array.isArray(r.findings)) open.push(...r.findings)
  }
  return open
}

function judgeDecision(judgeResult, passCount) {
  const passes = Number(passCount) || 0
  const verdict = judgeResult && typeof judgeResult.verdict === 'string'
    ? judgeResult.verdict.toUpperCase()
    : null
  const fixList = (judgeResult && Array.isArray(judgeResult.fixList)) ? judgeResult.fixList : []

  // FAIL-CLOSED: a missing/null judge result, or any verdict that is not one of the
  // two valid adjudications (CLEAN | FIX), is a verification GAP -- never a silent
  // CLEAN. An ERROR/unreachable judge resolves here.
  if (verdict !== 'CLEAN' && verdict !== 'FIX') {
    return {
      action: 'gap',
      reason: (judgeResult && judgeResult.error)
        ? String(judgeResult.error)
        : 'judge returned no valid CLEAN|FIX verdict (unreachable/errored) -- fail-closed verification gap, never silent CLEAN',
    }
  }

  // FAIL-CLOSED on an INCONSISTENT verdict/fixList pair. A judge result is consistent
  // only when CLEAN pairs with an empty fixList and FIX pairs with a non-empty one. The
  // two inconsistent pairs -- FIX with an empty fixList (a fix verdict naming nothing to
  // fix), and CLEAN with a non-empty fixList (a clean verdict still carrying open
  // findings) -- are a self-contradicting adjudication the judge should never emit, so
  // they are a verification GAP, NEVER a silent CLEAN. The old `verdict === 'CLEAN' ||
  // fixList.length === 0` clean branch resolved BOTH to clean (the `||` short-circuited
  // on the empty fixList regardless of verdict), a fail-OPEN on the merge gate -- the
  // exact silent-CLEAN this net exists to kill.
  const cleanConsistent = verdict === 'CLEAN' && fixList.length === 0
  const fixConsistent = verdict === 'FIX' && fixList.length > 0
  if (!cleanConsistent && !fixConsistent) {
    return {
      action: 'gap',
      reason:
        `judge returned an INCONSISTENT verdict/fixList pair (verdict '${verdict}', ` +
        `fixList length ${fixList.length}) -- fail-closed verification gap, never silent CLEAN`,
    }
  }

  // CLEAN: the judge adjudicated every finding FAULTY (a CLEAN verdict AND an empty
  // fixList -- a consistent clean). A FAULTY no-repro finding was dropped by the judge
  // and never reaches the fixer.
  if (cleanConsistent) {
    return { action: 'clean' }
  }

  // FIX: the fixList carries >=1 TRUE finding (a consistent FIX). NO SEVERITY FLOOR --
  // any present TRUE finding fires the fixer (P2/P3 included). Below the cap -> another
  // fixer round.
  if (passes < JUDGE_MAX_PASSES) {
    return { action: 'fix' }
  }

  // Cap reached: TRUE findings still open after N=2 fixer rounds. STOP -- no third
  // patch (the two-failed-attempts reset rule). Escalate to the COO with the open
  // findings (both repros) so a genuine stuck finding is adjudicated, not dropped.
  return {
    action: 'escalate',
    escalation: { openFindings: fixList },
  }
}

// VERBATIM-INLINED from pipeline-outcome.mjs (the Workflow sandbox has no module
// resolution, so this script cannot import that module). pipeline-outcome.mjs is the
// canonical, unit-tested source; this inline copy MUST move in lockstep with it.
//
// resolveBuildOutcome decides the build outcome from GIT GROUND TRUTH when available,
// falling back to the self-reported bundle for old/manual dispatches (back-compat).
// WHY (real failure, agnes-capable-ea C3): a build-agent COMMITTED (sha b7ca962) but
// then returned NO valid bundle, so the old self-reported gate skipped REVIEW
// silently and stranded an unreviewed ORPHAN commit. A dead/timed-out agent returns
// nothing regardless of prompt; the fix is harness-side -- review the on-disk commit
// (git HEAD ground truth) or fail loud with a clear terminal, never silently drop it.
//
// Three-tier ground-truth lookup (see pipeline-outcome.mjs for full docs):
//   FULL (worktreeHead + baseRef): explicit HEAD > base comparison, always authoritative.
//   PARTIAL (baseRef only): use build.commitSha as effective head (non-crash path).
//   BACK-COMPAT (no git shas): self-reported build.green && build.commitSha.
// CRASH-CASE ORPHAN DETECTION: when the agent crashes (no bundle) with baseRef present,
// the pipeline cannot determine HEAD (no git access); the COCKPIT completion handler
// detects the real orphan post-pipeline by comparing `git -C <worktree> rev-parse HEAD`
// to baseRef.
function resolveBuildOutcome({ build, worktreeHead, baseRef } = {}) {
  const head = typeof worktreeHead === 'string' ? worktreeHead.trim() : ''
  const base = typeof baseRef === 'string' ? baseRef.trim() : ''
  const haveGitTruth = head.length > 0 && base.length > 0

  if (haveGitTruth) {
    // FULL GROUND TRUTH (explicit worktreeHead + baseRef): a commit exists iff HEAD
    // advanced past the base ref. This holds whether or not the agent returned a valid
    // bundle -- the on-disk commit is real.
    const committed = head !== base
    if (committed) {
      return { committed: true, reviewSha: head, status: 'review', message: '' }
    }
    return {
      committed: false,
      reviewSha: null,
      status: 'build-did-not-commit',
      message:
        'BUILD stage left no commit: worktree HEAD (' + head + ') did not advance past the base ref (' + base +
        '). The build-agent could not land a commit (no test pass, crash, or timeout before commit); there is ' +
        'nothing to review. Route to reset-or-decompose.',
    }
  }

  // PARTIAL GROUND TRUTH (baseRef only -- typical cockpit dispatch after the
  // pipeline-crash-recovery fix): the cockpit threads baseRef at worktree-creation
  // time but cannot thread worktreeHead at launch (the build has not run yet).
  // Use build.commitSha as the effective head when it is available (the non-crash
  // path: the build agent did not crash and reported its own sha).
  if (base.length > 0) {
    const agentSha = (build && typeof build.commitSha === 'string') ? build.commitSha.trim() : ''
    if (agentSha.length > 0) {
      const committed = agentSha !== base
      if (committed) {
        return { committed: true, reviewSha: agentSha, status: 'review', message: '' }
      }
      return {
        committed: false,
        reviewSha: null,
        status: 'build-did-not-commit',
        message:
          'BUILD stage left no commit: the build-agent\'s commitSha (' + agentSha +
          ') matches the base ref (' + base +
          '); no commit advanced past the base. The build-agent could not land a commit; ' +
          'nothing to review. Route to reset-or-decompose.',
      }
    }
    // baseRef present but no agent sha (crashed/null/invalid bundle): the pipeline
    // cannot determine HEAD without git access. Fall through to back-compat (which
    // also yields a non-committed terminal). The COCKPIT completion handler detects
    // the real orphan post-pipeline by comparing `git -C <worktree> rev-parse HEAD`
    // to baseRef.
  }

  // BACK-COMPAT (no git shas threaded -- old/manual dispatch): fall back to the
  // self-reported bundle, the pre-fix behavior.
  const selfCommitted = !!(build && build.green && build.commitSha)
  if (selfCommitted) {
    return { committed: true, reviewSha: build.commitSha, status: 'review', message: '' }
  }
  return {
    committed: false,
    reviewSha: null,
    status: 'build-did-not-commit',
    message:
      'BUILD stage reported no committed work (no git ground-truth shas were threaded in, and the self-reported ' +
      'bundle has no green commitSha). The build-agent could not make the test pass or returned no valid bundle; ' +
      'nothing to review. Route to reset-or-decompose.',
  }
}

// agentType-availability helpers (pipeline-meritocracy chunk 6). VERBATIM-INLINED from
// workflows/agenttype-precheck.mjs (the Workflow sandbox has no module resolution),
// LOCKSTEP: the two copies MUST move together; agenttype-precheck.mjs is the canonical,
// unit-tested source and this copy must agree (minus the `export` keyword).
//
// THE FAILURE THIS GUARDS (on-chain-analyst chunk 3, the agents-do-not-hot-reload
// memory): a Workflow snapshots its agent registry AT LAUNCH, so a newly-merged-but-
// unregistered agent file crashes a configurable-agentType dispatch with an uncaught
// `agent type 'X' not found` -- AND the crash lands AFTER the build committed, leaving
// an orphaned commit and an ambiguous failure with no named recovery condition. The
// pipeline catches that ONE error class and returns a CLEAN terminal failed bundle
// (status 'failed', reason 'agenttype-unavailable', the missing agentType, the
// PRESERVED buildOutcome) so the COO sees a named, recoverable signal. A non-not-found
// error (a real bug / schema violation / timeout) is NOT this class and propagates.
function isAgentTypeNotFoundError(err) {
  if (!err) return false
  const msg = typeof err === 'string' ? err : (err && err.message) ? String(err.message) : ''
  return /agent\s+type\s+['"`].+?['"`]\s+not\s+found/i.test(msg)
}
function extractMissingAgentType(err) {
  if (!err) return null
  const msg = typeof err === 'string' ? err : (err && err.message) ? String(err.message) : ''
  const m = /agent\s+type\s+['"`](.+?)['"`]\s+not\s+found/i.exec(msg)
  return m ? m[1] : null
}
function agentUnavailableBundle({ chunkId, worktree, branch, agentType, buildOutcome, phase } = {}) {
  const failureReason =
    `dispatch of agent type '${agentType}' failed: \`agent type '${agentType}' not found\`. The Workflow ` +
    `snapshots its agent registry AT LAUNCH, so a newly-merged-but-unregistered agent file crashes the ` +
    `dispatch (registration lag). RECOVERY: confirm the agent is live-registered (the harness "New agent ` +
    `types now available" signal), then relaunch this chunk. ` +
    (buildOutcome && buildOutcome.committed
      ? `The build COMMITTED (sha ${buildOutcome.reviewSha}) before the crash -- recover that commit, do not orphan it.`
      : `No build commit landed before the crash.`)
  return {
    chunkId,
    worktree: worktree || null,
    branch: branch || null,
    // buildOutcome PRESERVED verbatim: the committed build (if any) is reported so the
    // COO can recover the orphan, not lose it.
    buildOutcome: buildOutcome || null,
    review: {
      reason: 'agenttype-unavailable',
      agentType: agentType || null,
      phase: phase || null,
      failureReason,
    },
    status: 'failed',
  }
}

// BUILD_RESULT -- the shape the single BUILD stage returns (chunk 5). The
// build-agent runs the ENTIRE per-chunk loop in one continuous context and
// returns: the commit info (branch + sha, sha omitted on a GREEN-stage failure),
// the RED-state integrity record location (test-first ordering, verifiable
// post-hoc), and the worker-half-of-checkpoint DRAFTS the cockpit applies at merge
// (explanation / proof / specUpdateSummary / diagram / wiki). The builder emits
// RAW lessonCandidates (+ recallVerify); the memory-agent reconciles downstream.
const BUILD_RESULT = {
  type: 'object',
  // commitSha is NOT required: a build-agent that cannot make the test pass
  // returns green:false with no commit, and the pipeline routes that to a
  // 'failed' bundle (the cockpit quarantines it). Requiring commitSha would
  // force a fabricated sha on a genuine GREEN-stage failure -- a false success.
  required: ['branch', 'summary', 'green', 'redStateRecord', 'explanation', 'proof', 'specUpdateSummary', 'recallEvidence'],
  additionalProperties: false,
  properties: {
    branch: { type: 'string', description: 'the worktree branch the commit landed on' },
    commitSha: { type: 'string', description: 'the provisional GREEN/implementation commit sha; omit when green is false (no commit landed)' },
    redCommitSha: { type: 'string', description: 'the separate RED commit sha if the build-agent used the separate-RED-commit prong (else omit); pins the failing test before any implementation' },
    redStateRecord: { type: 'string', description: 'the RED-state integrity record location -- the artifact path or the RED commit sha -- so test-first ordering (RED before GREEN) is verifiable post-hoc' },
    // NOTE: there is no self-reported actual-touched-files field. The cockpit
    // computes the AUTHORITATIVE actual-touches itself from this chunk's commitSha
    // via `git diff-tree --no-commit-id -r --name-only <commitSha>` and unions it
    // with the declared touches[] (cockpit SKILL.md § The tick step 2). A Workflow
    // script can't run git, so the cockpit -- which has Bash and holds the sha -- is
    // the only reliable place to derive it; a worker echo would be at most a hint
    // the cockpit never depended on, so it is not carried.
    summary: { type: 'string', description: 'one-line behavior shift + what was deleted, or why the test could not be made to pass (the cockpit relay reads this for the wave view)' },
    behaviorShift: { type: 'string', description: 'what externally-visible behavior changed (the before -> after), naming the files touched and what the change deleted; in one line. Not "done".' },
    failureReason: { type: 'string', description: 'on a non-green result, the actual cause the test could not be made to pass (so the cockpit can route it to reset-or-decompose); else "none".' },
    green: { type: 'boolean', description: 'true iff the full suite is green at commit time; false if the build-agent could not make the test pass' },
    deleted: { type: 'string', description: 'code the change obsoleted and deleted, or "none" (the REFACTOR dead-code scan result, reported even when empty)' },
    tier: { type: 'string', description: 'the tier surfaced from the dispatch payload at chunk-kickoff (S/A/B/C); the build-agent does NOT classify tier -- it arrives from the spec decomposition and is echo-reported here' },
    // The chunk-end self-check, folded into the build-agent's one continuous
    // context (loop step 7 self-check). These are DRAFTS the cockpit
    // (sole writer) applies at merge -- the worker writes NOTHING shared.
    explanation: { type: 'string', description: 'translation-gated plain-English: what changed + why it is right. Every technical term paired with a plain unpack. A DRAFT; the cockpit presents it at the go/no-go.' },
    proof: { type: 'string', description: 'the watch-it proof: a real input and the resulting output, or the acceptance run, explained plainly. A DRAFT.' },
    acceptanceArtifact: { type: 'string', description: 'when the chunk\'s verification hook is a STANDALONE acceptance script (specs/scripts/<slug>-c<N>-acceptance.{sh,py}), the repo-relative path of that script as committed on the branch -- so the cockpit can verify the deliverable actually came back, not just that the run was described in proof. The new worker discipline prefers an in-suite test (disciplines/worker-discipline.md: no standalone tracked acceptance scripts); omit with a one-line note ("verification hook is an inline test, no standalone script") when the chunk\'s hook is an in-suite test rather than a script. Omit when green is false.' },
    specUpdateSummary: { type: 'string', description: 'the drafted ## Completed chunks entry prose for this chunk. The cockpit applies it to current.md at merge via an Edit-tool surgical replace (cockpit SKILL.md § Merge); the worker NEVER writes current.md.' },
    diagram: { type: 'string', description: 'drafted diagram-refresh, or "none". When present, lead with the target vault path then the full drafted content (path + content). The cockpit commits it to the vault at merge; NEVER written here.' },
    wiki: { type: 'string', description: 'drafted wiki / project-page refresh, or "none". When present, lead with the target vault path then the full drafted content (path + content). Applied by the cockpit at merge; NEVER written here.' },
    // lessonCandidates (annex Part 4 D (ii)) -- RAW lesson candidates, NOT drafted.
    // RAW means raw: no capture-learning drafting; the build-agent emits one
    // candidate per genuine surprise and the memory-agent reconciles + writes downstream.
    lessonCandidates: {
      type: 'array',
      description: 'RAW lesson candidates (annex Part 4 D (ii)): one per genuine surprise (empirical discovery, failed approach, reusable pattern). RAW, not drafted -- the memory-agent reconciles + writes downstream; the worker never writes memory.',
      items: {
        type: 'object',
        required: ['raw_lesson', 'kind_hint', 'provenance'],
        additionalProperties: false,
        properties: {
          raw_lesson: { type: 'string', description: 'the lesson in raw form -- the surprise as observed, not yet routed or voiced' },
          kind_hint: { type: 'string', description: 'a routing hint for the memory-agent (e.g. tactical-rule | concept | failure | obsolescence)' },
          provenance: { type: 'string', description: 'where it came from -- the chunk, the file:line, or the command output that surfaced it' },
        },
      },
    },
    // recallEvidence (C4 anti-skip) -- the builder's recall run, surfaced in the
    // return bundle so a build return with no recall evidence is rejected as malformed
    // (the same anti-skip trick as requiring recallVerify, now for the recall run
    // itself). Carries: the search terms/keywords used, the surfaced entries or an
    // explicit 'none relevant', and the per-body-loaded-entry read-verify lines that
    // B4 added to recall (entry_id, verdict, evidence). The recallVerify field below
    // carries those same per-entry verdicts as a sibling; recallEvidence is the top-
    // level anti-skip proof that recall ran. Do not duplicate: recallEvidence carries
    // searchTerms + surfacedEntries; recallVerify carries the per-entry verdict array.
    recallEvidence: {
      type: 'object',
      description: 'REQUIRED. Proof that the build-agent ran recall in its continuous context: { searchTerms (string), surfacedEntries (string -- the entries found OR explicit "none relevant"), recallVerify (array of {entry_id, verdict, evidence}) }. A missing recallEvidence field is a malformed return -- the harness rejects it (the anti-skip for recall-in-the-builder model).',
      required: ['searchTerms', 'surfacedEntries'],
      additionalProperties: true,
      properties: {
        searchTerms: { type: 'string', description: 'the keywords / search terms used in the recall run' },
        surfacedEntries: { type: 'string', description: 'the entries recall surfaced (titles + one-line relevance), or explicit "none relevant" when the search returned nothing load-bearing' },
      },
    },
    // recallVerify (annex Part 4 C/D (ii)) -- the per-loaded-entry read-verify
    // verdict. REQUIRED field per loaded entry (anti-skip: a missing verdict is a
    // malformed return the harness rejects). [] when no entries were loaded.
    recallVerify: {
      type: 'array',
      description: 'one read-verify line per recall entry the build-agent loaded (annex Part 4 C). [] when none loaded; never omitted. The COO routes every verdict != applies to the memory-agent (kind_hint: obsolescence).',
      items: {
        type: 'object',
        required: ['entry_id', 'verdict'],
        additionalProperties: true,
        properties: {
          entry_id: { type: 'string', description: 'the loaded entry id' },
          verdict: { type: 'string', description: 'applies | stale | contradicted -- the load-bearing-refs check result' },
          action: { type: 'string', description: 'supersede | delete | none -- the proposed COO action on a non-applies verdict' },
          why: { type: 'string', description: 'what reality showed (one line; the check command + output)' },
          replacement_hint: { type: 'string', description: 'supersede only: the corrected rule' },
        },
      },
    },
    // OPTIONAL failure trail. NOT in required: absent/empty on a clean build is valid.
    // Never a gate -- debuggability only (disciplines/worker-discipline.md).
    failureLog: {
      type: 'array',
      description: 'OPTIONAL failure trail (never a gate). Absent/empty on clean build.',
      items: {
        type: 'object',
        required: ['phase', 'what_failed', 'error', 'repro_cmd', 'attempt', 'resolution'],
        additionalProperties: true,
        properties: {
          phase:       { type: 'string', description: 'recall|red|green|refactor|selfcheck|commit|fix-loop' },
          what_failed: { type: 'string', description: 'one-line description of what broke' },
          error:       { type: 'string', description: 'verbatim error excerpt' },
          repro_cmd:   { type: 'string', description: 'exact command to reproduce' },
          attempt:     { type: 'number', description: 'attempt number (1, 2, ...)' },
          resolution:  { type: 'string', description: 'how resolved, or "open"' },
        },
      },
    },
  },
}

// REVIEW_RESULT -- the shape each verification-net reviewer returns (chunk 9).
// One schema for both lenses (Codex bugs/security + per-criterion, Sonnet
// drift/slop + per-criterion). `ran` distinguishes a real review from a SKIPPED
// reviewer: a reviewer that errored or was unavailable is a verification GAP, not
// a clean pass (the net-down lesson) -- ran:false with clean:false forces the
// cockpit to treat it as an unreviewed lens, never silently as CLEAN. (Chunk 5:
// the Codex error-skip now triggers a Sonnet FALLBACK instead of shipping with a
// gap -- see the degraded path below.)
const REVIEW_RESULT = {
  type: 'object',
  // note is REQUIRED, not optional: a skipped reviewer MUST carry its reason so
  // the cockpit can surface the gap to the operator -- an absent note on a skip would
  // hide why the lens did not run (papering a gap as silence). On a real run the
  // reviewer sets note:"none".
  required: ['ran', 'clean', 'findings', 'note'],
  additionalProperties: false,
  properties: {
    ran: { type: 'boolean', description: 'true iff the reviewer actually ran and produced a RESULT line; false on a skipped/errored reviewer (a verification GAP, not a clean pass)' },
    clean: { type: 'boolean', description: 'true iff the reviewer ran AND reported RESULT: CLEAN. Always false when ran is false -- a skip is never clean.' },
    findings: { type: 'array', items: { type: 'string' }, description: 'each finding line verbatim ([P<n>] for Codex, [DRIFT]/[SLOP] for Sonnet). Each line carries the detail the cockpit routes on: severity, location (file:lines), and altitude (worker-level technical fix vs CEO-level vision/scope call). Empty array when clean or skipped.' },
    note: { type: 'string', description: 'REQUIRED. On a skip: the reason (e.g. "codex not on PATH", "codex exit 4"). On a real run: "none". Calibration: surface the gap, never paper over it.' },
  },
}

// NORMALIZE the tier ONCE, BEFORE chunkContext references it. TDZ-safe: chunkContext's
// Tier line reads `tier`, so this `const` MUST precede it (declaring it lower throws
// "Cannot access 'tier' before initialization" on every dispatch -- the C4 b0ca0e8
// regression). Uppercase so every downstream consumer (tierConfig/reviewerFor/
// codex-review.sh --tier) agrees; an empty/absent tier stays '' (still falsy, so the
// `tier ? ...` guard and the `|| 'absent'` fallbacks are unchanged).
const tier = String(a.tier || '').toUpperCase()

const chunkContext = [
  `Chunk id: ${chunkId}`,
  `Shared worktree (cd here first, use paths relative to it): ${worktree}`,
  `Branch: ${a.branch || '(the worktree current branch)'}`,
  // Tier arrives from the spec decomposition (set by the COO, not re-derived by the
  // builder). Thread it into chunkContext so the build-agent can surface it at
  // chunk-kickoff per chunk-kickoff/SKILL.md Step 3. Absent means the cockpit did
  // not send a tier (old manual dispatches); the builder notes "tier not in payload".
  tier ? `Tier: ${tier}` : `Tier: (not in payload)`,
  ``,
  `Chunk task statement:`,
  a.taskStatement || '(none provided)',
  ``,
  `Acceptance criteria:`,
  a.acceptanceCriteria || '(none provided)',
  // Spec entry fields (C4: threaded in from the cockpit dispatch payload;
  // backward-compat when absent -- old manual dispatches only carry taskStatement
  // + acceptanceCriteria + specExcerpt and omit these new fields).
  a.currentState  ? `\nCurrent state:\n${a.currentState}`   : '',
  a.requirements  ? `\nRequirements:\n${a.requirements}`     : '',
  a.endState      ? `\nEnd state:\n${a.endState}`             : '',
  // edgeCases is the 11th schema field (C7): boundary/error/invariant/integration
  // cases the chunk must also pin (required, may be []). Thread it so the build-agent
  // can drive RED past happy-path acceptanceCriteria. Backward-compat when absent.
  a.edgeCases     ? `\nEdge cases:\n${a.edgeCases}`           : '',
  a.nonGoals      ? `\nNon-goals:\n${a.nonGoals}`             : '',
  a.specExcerpt   ? `\nSpec excerpt:\n${a.specExcerpt}`       : '',
  ``,
  `RETURN-QUALITY STANDARD: return adequate, accurate, structured detail in every field of your schema -- not a one-liner where the field asks for the behavior shift + files + deletions, the finding's severity/location/altitude, or the failure's cause + recall. The schema field descriptions are the contract.`,
].join('\n')

// Tier -> build-agent FILE + dispatch model via tierConfig (inlined at the top
// of this file from tier-dispatch.mjs -- the Workflow sandbox has no module
// resolution, so the import was replaced by a verbatim local copy). tier-dispatch.mjs
// stays the canonical, unit-tested dial; this inline copy is a forced duplicate
// that must agree with it. The dial is documented in coo/coo-sop.md § 6 (single
// source of truth) and must agree with that section and the tier context in
// disciplines/worker-discipline.md. Mechanic: a subagent's reasoning EFFORT is
// frontmatter-only -- there is no `effort` arg to agent() -- so effort is dialed
// by SELECTING the effort-named build-agent FILE (default -> base/high, heavy ->
// -heavy/xhigh). buildModel is the dispatch arg (opus on both tiers); max effort
// moves off the build path to the ship-time redesigner.
const tierCfg = tierConfig(a.tier)

// (`tier` is normalized above, before chunkContext, which reads it -- TDZ-safe.)

// BUILD -- the SINGLE build-agent stage (chunk 5, simplified by C4). ONE agent runs
// the entire per-chunk inner loop in one continuous context: recall -> chunk-kickoff
// -> RED -> RED-state integrity record -> GREEN -> REFACTOR -> self-check -> commit.
// The builder emits RAW lessonCandidates (+ recallVerify); the memory-agent
// reconciles downstream (no capture-learning drafting in the builder).
// This replaces the old five-context relay (recall / test-author / implementer /
// checkpoint split across separate agents) -- the chunk's understanding never has to
// survive a context handoff. The build-agent FILE is tier-selected (effort
// frontmatter), the model is the dispatch arg.
//
// The build-agent runs recall + chunk-kickoff ITSELF in its first steps (C4:
// the separate RECALL harness stage is removed -- its job is now the builder's
// first step in its continuous context). The anti-skip is a REQUIRED recallEvidence
// field in BUILD_RESULT: a build return missing that field is rejected as malformed.
//
// The build-agent writes NOTHING shared: it commits inside this worktree and
// returns the checkpoint DRAFTS (explanation / proof / specUpdateSummary /
// diagram / wiki) for the COO (sole writer) to apply at merge. It emits RAW
// lessonCandidates (+ recallVerify); the memory-agent reconciles downstream.
// The one thing that does NOT collapse into it is the per-criterion acceptance
// grade (the REVIEW stage below) -- a maker grading its own omissions is the
// blindness that split exists to catch.
phase('BUILD')
const build = await agent(
  [
    `You are the build-agent for this chunk -- the single worker that runs the ENTIRE`,
    `per-chunk inner loop in ONE continuous context (recall -> chunk-kickoff -> RED ->`,
    `RED-state integrity record -> GREEN -> REFACTOR -> self-check -> commit).`,
    chunkContext,
    ``,
    `Follow your build-agent instructions exactly. In short: invoke recall, self-orient`,
    `via chunk-kickoff, write the ONE failing test pinning the FULL`,
    `acceptance contract and confirm it fails for the right reason, record the RED-state`,
    `integrity record BEFORE green (so test-first ordering is verifiable post-hoc), make`,
    `the test pass with minimal code, run the FULL suite green, REFACTOR (delete dead`,
    `code, re-run green), self-critique your own diff, then commit provisionally in this`,
    `shared worktree (deliberate staging, no co-author footer, no commits to main).`,
    ``,
    `CRITICAL -- you are inside a worker worktree, NOT the cockpit. DRAFT only. Emit`,
    `RAW lesson candidates {raw_lesson,kind_hint,provenance} into lessonCandidates; do`,
    `NOT run capture-learning or draft routed captures -- the memory-agent reconciles`,
    `downstream (build-agent.md:29). Draft the worker-half-of-checkpoint content (a`,
    `translation-gated plain-English explanation, a watch-it proof, the ## Completed`,
    `chunks specUpdateSummary, any diagram / wiki refresh). Return all of it as structured`,
    `data: NEVER write any shared state (current.md, the vault, memory). The cockpit --`,
    `the sole writer -- applies the drafts at merge after the operator's go/no-go.`,
    ``,
    `The per-criterion acceptance check is NOT yours: it runs in a SEPARATE fresh context`,
    `outside you (a maker grading its own omissions is the blindness it exists to catch).`,
    injectedDocBlock('worker-discipline', 'disciplines/worker-discipline.md', workerDisciplineDoc),
  ].join('\n'),
  { agentType: tierCfg.buildAgent, model: tierCfg.buildModel, label: `build:${chunkId}`, phase: 'BUILD', schema: BUILD_RESULT }
)

// GIT-GROUNDED build outcome (chunk pipeline-crash-recovery). The committed/reviewSha
// decision now comes from GIT GROUND TRUTH, not solely the self-reported bundle.
// resolveBuildOutcome (verbatim-inlined above from pipeline-outcome.mjs) uses a
// three-tier lookup:
//   FULL (worktreeHead + baseRef both present): explicit HEAD > base comparison.
//     This is the strongest form -- used when the cockpit post-pipeline handler
//     detects an orphan by calling the resolver with the real worktree HEAD it read
//     via `git -C <worktree> rev-parse HEAD` AFTER the pipeline returned.
//   PARTIAL (baseRef only -- typical cockpit dispatch after pipeline-crash-recovery):
//     The cockpit threads args.baseRef (the feature-branch tip at worktree-creation
//     time) at launch; args.worktreeHead is NOT threaded at launch because the build
//     has not run yet (a Workflow script cannot read git mid-execution). For a
//     non-crashed agent, build.commitSha serves as the effective head, compared to
//     baseRef -- a correct-but-quiet agent AND a git-grounded base both resolve the
//     real sha. For a crashed agent (no bundle), this branch falls through; see below.
//   BACK-COMPAT (no git shas): self-reported build.green && build.commitSha (old/manual
//     dispatch; the pre-fix behavior for cockpits that did not thread baseRef).
// CRASH-CASE ORPHAN DETECTION: when the agent crashes (null/invalid bundle) with
// baseRef present, the in-pipeline resolver cannot determine HEAD (no git access in a
// Workflow script) and yields 'build-did-not-commit'. The COCKPIT completion handler
// is responsible for the real orphan check: `git -C <worktree> rev-parse HEAD` vs
// baseRef after the pipeline returns -- if HEAD advanced despite a 'failed' bundle,
// the cockpit surfaces the orphaned commit to the COO (cockpit SKILL.md § On pipeline
// completion). chunk 7's merge engine consumes the sha, so a no-commit result still
// quarantines, not merges.
const buildOutcome = resolveBuildOutcome({ build, worktreeHead: a.worktreeHead, baseRef: a.baseRef })
const committed = buildOutcome.committed

// REVIEW -- the multi-lens verification net (chunk 9), the fresh-context grading
// that sits OUTSIDE the build-agent. Two model-diverse reviewers judge the
// build-agent's committed diff, split by model strength (C8):
//   - The Codex lens (a different model entirely) is the does-it-work lens:
//     correctness, bugs, unhandled failure modes, and security ONLY. It does NOT
//     judge spec-drift, AI-slop, or test-correctness -- those are the chunk-reviewer's.
//   - The Sonnet lens (chunk-reviewer) is the FULL-SCOPE lens: all four dimensions
//     (spec-drift incl. the per-criterion acceptance walk, AI-slop, bug/security,
//     test-correctness). The per-criterion omission walk lives HERE (a maker grading
//     its own omissions is the blindness this fresh-context split exists to catch).
// So "does it work" still gets two models (Codex + the chunk-reviewer's own
// correctness pass); drift/slop/test-correctness get the chunk-reviewer only. Model
// diversity is the whole point -- the context-rich coder is the worst judge of its
// own blind spots.
//
// Both reviewers are SCRIPT-orchestrated stages: this Workflow script spawns them
// via agent()/parallel(). Neither is nested inside another agent, so the
// "subagents can't chain" limit does not bite here. They only READ the diff ->
// run concurrently.
//
// Codex COST-GATE (the operator 2026-06-13 REVERT of the chunk-5 flip): the Codex lens fires
// only on {A,S,B}. A/S get the deep gpt-5.5 review, B gets the cheaper cross-model
// lens via codex-review.sh's --tier; Tier C + absent SKIP Codex to spare the operator's
// subscription (the gated thunk resolves to null). The Sonnet chunk-reviewer
// (full-scope) runs on EVERY tier, so a C/absent chunk is still independently verified
// -- a Codex skip on C is the cost-gate, not a verification gap.
//
// Codex-UNAVAILABLE FALLBACK (chunk 5 NEW): on a Codex error / quota-exhaust
// (the lens returns ran:false), the pipeline must NOT ship with zero independent
// verification. It falls back to ONE fresh-context Sonnet review pass over the
// same diff and flags the run `degraded` (surfaced in the return bundle) so the
// cockpit / CEO sees the chunk was verified by the fallback lens, not the primary
// Codex lens. A degraded run is still verified -- it just lost the cross-model
// Codex signal and is flagged so.
//
// Findings do NOT change the chunk's status: the bundle still goes to the cockpit,
// which routes findings through the fix-loop at the go/no-go. The worker only
// attaches what the net saw.
//
// AGENTTYPE-UNAVAILABLE GUARD (pipeline-meritocracy chunk 6). Every dispatch below
// uses a configurable agentType (chunk-reviewer[-heavy], meritocracy-judge,
// fixer[-heavy]) that the Workflow snapshots its registry on AT LAUNCH. A newly-merged-
// but-unregistered agent file crashes the dispatch with an uncaught `agent type 'X' not
// found` -- AFTER the build already committed (orphan ambiguity). This try wraps the
// whole post-build net so that ONE error class resolves to a CLEAN terminal failed
// bundle (status 'failed', reason 'agenttype-unavailable', the missing agentType, the
// PRESERVED buildOutcome) instead of an uncaught crash. A NON-not-found error (a real
// bug / schema violation / timeout) is re-thrown -- real errors are never swallowed.
// (The body is intentionally NOT re-indented under the try: the wrap is a single-line
// control-flow change, so the diff stays a reviewable two-line add + the catch, not a
// 600-line whitespace churn.)
try {
phase('REVIEW')
// reviewSha is the GIT-GROUNDED sha (resolveBuildOutcome above): the real worktree
// HEAD when a commit landed, null otherwise. REVIEW runs on base..HEAD, so a
// committed-but-bundleless build (crash/timeout after commit) is reviewed on its real
// HEAD instead of being skipped because the self-reported bundle had no sha.
const reviewSha = buildOutcome.reviewSha

// The Codex lens prompt + schema, reused for the primary Codex pass. Built as a
// factory so (on a Codex outage) the Sonnet FALLBACK lens can be spawned from the
// same pipeline without duplicating prose.
// codexLensPrompt(sha, tierArg): the Codex lens over a committed diff at a tier.
// Defaults to the INITIAL review (reviewSha at the chunk tier). (pipeline-meritocracy
// chunk 2 removed the fix-loop Codex re-fire: the opus meritocracy-judge re-checks
// each fixer round, replacing the Sonnet re-review + Codex re-fire. The orphaned
// re-fire dial that gated that deleted path was removed in chunk 9.)
//
// C8 SPLIT: the Codex lens is the DOES-IT-WORK lens -- correctness, bugs, unhandled
// failure modes, and security ONLY. It does NOT walk spec-drift, AI-slop, or
// test-correctness (those are the chunk-reviewer's full-scope job, run on Sonnet),
// so this prompt no longer injects the full-scope review-contract doc and no longer
// runs the per-criterion drift walk. It is fine for Codex to NOTE a glaring
// correctness-adjacent issue, but it is not asked to enumerate drift/slop/tests.
function codexLensPrompt(sha = reviewSha, tierArg = codexTierArg(tier)) {
  return [
    `You are the CODEX lens of the verification net -- the DOES-IT-WORK lens. Your`,
    `mandate is correctness, bugs, unhandled failure modes, and SECURITY holes`,
    `(injection, auth, unvalidated user-controlled input) ONLY. You do NOT judge`,
    `spec-drift, AI-slop, or test-correctness -- a separate full-scope chunk-reviewer`,
    `(on Sonnet) owns those. Hunt for ways this committed diff is WRONG or UNSAFE.`,
    `Run the project's Codex reviewer over this chunk's committed diff and report what it found.`,
    ``,
    `Do exactly this, from inside the worktree (close stdin with < /dev/null so the`,
    `backgrounded codex call never hangs reading stdin):`,
    `  cd ${worktree}`,
    `  bash ~/.claude/scripts/codex-review.sh --commit ${sha}${tierArg ? ` --tier ${tierArg}` : ''} < /dev/null`,
    ``,
    `That script runs \`codex review\` and prints \`- [P<n>] ...\` finding lines then a final`,
    `\`RESULT: CLEAN\` or \`RESULT: FINDINGS=<n>\`. The tier (${tierArg || 'default'}) scales the`,
    `review model + reasoning effort -- do not override it.`,
    ``,
    `Map the output into the schema:`,
    `  - script exited 0 and printed a RESULT line`,
    `    -> ran:true; clean = (RESULT: CLEAN); findings = every \`[P<n>]\` line verbatim`,
    `    (empty when the bug/security hunt is clean); note:"none".`,
    `  - script exited non-zero, or codex is not on PATH, or it errored before a RESULT line`,
    `    -> ran:false, clean:false, findings:[], note:"<the reason, e.g. codex exit 4>".`,
    `Calibration: a skipped reviewer is a verification GAP, not CLEAN. CLEAN is a valid`,
    `and expected default for a sound diff. Report honestly; never invent findings,`,
    `never paper over a skip as clean. The fix-tier tag on any finding you do raise`,
    `follows disciplines/review-contract.md section 3.1 (trivial=C ... irreversible=S).`,
  ].join('\n')
}

// The Sonnet lens prompt, parameterized by role: the primary 'drift-slop' pass,
// or the Codex-outage 'codex-fallback' pass (same diff + same per-criterion check,
// just standing in for the unavailable Codex lens so the chunk keeps an
// independent verification signal).
function sonnetLensPrompt(role) {
  const fallback = role === 'codex-fallback'
  return [
    fallback
      ? `You are the CODEX-UNAVAILABLE FALLBACK lens: the primary Codex lens errored or was`
      : `Review this chunk's committed change for spec-drift and AI-slop, PLUS a SCOPED,`,
    fallback
      ? `quota-exhausted, so you stand in for it as a FRESH-CONTEXT Opus review pass so the`
      : `per-criterion check that the diff actually satisfied the chunk's acceptance`,
    fallback
      ? `chunk never ships with zero independent verification. Review the committed change for`
      : `contract (the omission-defect countermeasure). Follow your reviewer instructions`,
    fallback
      ? `correctness, spec-drift, and AI-slop, PLUS the SCOPED per-criterion check below.`
      : `exactly, including the calibration discipline.`,
    ``,
    `The diff: run \`git -C ${worktree} show ${reviewSha}\` (the chunk's one commit).`,
    `For surrounding context a hunk does not show, Read the file under ${worktree}.`,
    `The spec to judge against: ${a.specPath || '~/.claude/specs/current.md'}`,
    a.specExcerpt ? `Spec excerpt (the chunk's contract):\n${a.specExcerpt}` : '',
    ``,
    `SCOPED PER-CRITERION CHECK (do this ALONGSIDE the spec-drift / AI-slop hunt, never`,
    `instead of it). This chunk's acceptance criteria are:`,
    a.acceptanceCriteria || '(none provided)',
    a.edgeCases ? `\nEdge cases the chunk must also pin (boundary/error/invariant/integration):\n${a.edgeCases}` : '',
    `Go through them ONE AT A TIME. For EACH acceptance criterion, decide from the diff`,
    `whether it is SATISFIED or MISSING/omitted. Do NOT run one open-ended "looks fine"`,
    `pass -- enumerate and check each criterion explicitly, because review is structurally`,
    `blind to what was OMITTED: a change can be drift-free yet silently fail to satisfy a`,
    `criterion. Explicitly hunt for acceptance criteria the diff did NOT satisfy, and emit`,
    `one \`[DRIFT]\` finding line per UNSATISFIED criterion (naming the omitted criterion).`,
    ``,
    `Then map your verdict into the schema: ran:true; clean = (RESULT: CLEAN and no MISSING`,
    `criterion); findings = every \`[DRIFT]\`/\`[SLOP]\` line verbatim PLUS one line per`,
    `MISSING criterion (empty only when drift/slop AND every criterion are clean); note:"none".`,
    `If you cannot get the diff or the spec, ran:false with the reason in note --`,
    `a skipped lens is a gap, not a clean pass.`,
    injectedDocBlock('review-contract', 'disciplines/review-contract.md', reviewContractDoc),
  ].filter(Boolean).join('\n')
}

// The OPUS ADVERSARIAL lens prompt (tier-s-adversarial). A THIRD review lens spawned
// ONLY on Tier S -- an ADDITIONAL paranoia layer on top of the two required lenses
// (Codex does-it-work + Sonnet full-scope), NOT a new required gate. Its stance is
// distinct from both: it ATTACKS the committed diff on the assumption a hole EXISTS,
// hunting collisions, fail-open paths, unhandled edge cases, and silent-skip seams --
// the exact class a hand-run opus pass on on-chain-analyst F2 caught (a fill-identity
// collision; a poll_sentinel fail-open) that the two-lens net missed.
//
// Calibration (memory: calibrate-verification-prompts-for-truth): an attack stance
// can make a model manufacture job-fulfilling false positives, so the prompt pairs
// the assume-a-hole framing with a hard EVIDENCE requirement per flag (a concrete
// file:line + the exact input that triggers the hole) and routes findings to the
// MERITOCRACY-JUDGE, which grain-of-salts every adversarial flag -- reproducing it
// TRUE or counter-reproducing it FAULTY -- so a hallucinated finding is dropped on
// evidence, not churned. Fail-open on its own outage (handled at the call site) means
// even a noisy adversarial lens can never block a sound chunk.
//
// It mirrors sonnetLensPrompt's worktree diff-read + review-contract injection so it
// returns CONTRACT-FORMAT findings (the [P<n>]/[DRIFT]/[SLOP] lines) carrying the
// [FIX:<tier>] rate-the-fix tag the fixer dial reads.
function adversarialLensPrompt() {
  return [
    `You are the ADVERSARIAL lens of the verification net -- the heavy-tier-only paranoia`,
    `pass. ASSUME THERE IS A HOLE in this committed diff and hunt it down. Your stance`,
    `is to ATTACK the change, not to confirm it: a hand-run opus adversarial pass once`,
    `caught real holes (a fill-identity collision; a fail-open poll sentinel) that the`,
    `two standard lenses missed -- you are that pass, in-pipeline.`,
    ``,
    `Hunt specifically for: COLLISIONS (two things that share an identity/key/path and`,
    `clobber each other), FAIL-OPEN paths (an error/missing-input branch that silently`,
    `proceeds as if all is well instead of failing loud), UNHANDLED EDGE CASES (empty /`,
    `single / duplicate / boundary / null / already-exists inputs), and SILENT-SKIP`,
    `seams (a guard or early-return that skips work without surfacing that it skipped).`,
    `Default toward FLAGGING when you see a plausible hole.`,
    ``,
    `The diff: run \`git -C ${worktree} show ${reviewSha}\` (the chunk's one commit).`,
    `For surrounding context a hunk does not show, Read the file under ${worktree}.`,
    a.specExcerpt ? `Spec excerpt (the chunk's contract):\n${a.specExcerpt}` : '',
    `\nThis chunk's acceptance criteria (use them to find what the diff must NOT break):`,
    a.acceptanceCriteria || '(none provided)',
    a.edgeCases ? `\nEdge cases the chunk must also cover (hunt these as UNHANDLED EDGE CASE holes):\n${a.edgeCases}` : '',
    ``,
    // CALIBRATION (memory: calibrate-verification-prompts-for-truth) -- the attack
    // stance is paired with a hard evidence bar so it converges on real holes, not
    // hallucinated ones. The meritocracy-judge's grain-of-salt adjudication is the
    // second net: it reproduces or counter-reproduces every flag on evidence.
    `EVIDENCE BAR: every finding MUST cite a concrete file:line AND the exact input /`,
    `condition that triggers the hole. "This looks risky" with no triggering input is`,
    `NOT a finding -- drop it. A hole you cannot make concrete is not a hole. "No hole`,
    `found" is a valid, honest result; do not manufacture findings to fill the role.`,
    ``,
    `Map your verdict into the schema: ran:true; clean = (no concrete hole found);`,
    `findings = one verbatim line per concrete hole, each carrying its [FIX:<tier>]`,
    `rate-the-fix tag per disciplines/review-contract.md §3.1 (trivial=C ... irreversible=S);`,
    `note:"none". If you cannot get the diff, ran:false with the reason in note.`,
    injectedDocBlock('review-contract', 'disciplines/review-contract.md', reviewContractDoc),
  ].filter(Boolean).join('\n')
}

// Codex COST-GATE (2-tier: both tiers fire Codex, per coo-sop.md § 6). After the
// pipeline-meritocracy c1 collapse, there are only two live tiers (`default` and
// `heavy`); the old Tier-C skip is gone because C no longer exists (it folds into
// `default`). Both tiers get the Codex cross-model lens -- cheap gpt-5.4-mini/medium
// at `default`, full gpt-5.5/xhigh at `heavy` (via codexTierArg -> codex-review.sh
// --tier B|S). `degraded` stays false on a gated skip -- it flags only a Codex OUTAGE
// on a tier that SHOULD fire (codexReview.ran === false), handled by the fallback below;
// a gated skip leaves codexReview === null, distinct from an outage.
// `normalizeTier(tier)` folds legacy S/A/B/C and absent into `default`|`heavy`, so
// both new-vocab AND old-spec chunks fire the gate correctly.
const codexFires = normalizeTier(tier) === 'default' || normalizeTier(tier) === 'heavy'
const [codexReview, sonnetReview, adversarialReview] = !committed ? [null, null, null] : await parallel([
  // Codex lens (does-it-work: correctness/bugs/security only, C8 split): fires on
  // both tiers (gpt-5.4-mini/medium at default, gpt-5.5/xhigh at heavy).
  // model:'sonnet' is PINNED, not inherited: this lens only invokes the external
  // codex-review.sh CLI (the bug/security reasoning is the gpt-5.x Codex model's,
  // not Claude's). Without the pin it floats to the session model (Opus COO) and
  // burns the most expensive model on CLI-wrapper work.
  () => codexFires
    ? agent(
        codexLensPrompt(),
        { label: `codex:${chunkId}`, phase: 'REVIEW', schema: REVIEW_RESULT, model: 'sonnet' }
      )
    : Promise.resolve(null),
  () => agent(
    sonnetLensPrompt('drift-slop'),
    { agentType: reviewerFor(tier).agentType, label: `sonnet:${chunkId}`, phase: 'REVIEW', schema: REVIEW_RESULT }
  ),
  // OPUS ADVERSARIAL lens: a THIRD paranoia lens GATED to `heavy` (pipeline-
  // meritocracy chunk 2 re-gated it from the deleted legacy Tier S to the 2-tier
  // `heavy` -- normalizeTier folds legacy A/S into heavy, so old-spec heavy chunks
  // still fire it). On `default` the thunk resolves to null (no spawn), so default
  // REVIEW stays <=2 lenses. model:'opus' is the strongest reviewer, DISTINCT from
  // the opus build-agent-heavy (the BUILDER). It is an ADDITIONAL layer on top of the
  // two required lenses, NOT a new required gate -- fail-open on its own outage
  // (below): a null/errored return does NOT set `degraded` (that flag is RESERVED for
  // a Codex OUTAGE on a tier that should fire) and does NOT block the run. Its
  // findings feed the meritocracy-judge (collected by collectReviewerFindings),
  // which adjudicates them on evidence like any other lens's.
  () => normalizeTier(tier) === 'heavy'
    ? agent(
        adversarialLensPrompt(),
        { label: `adversarial:${chunkId}`, phase: 'REVIEW', schema: REVIEW_RESULT, model: 'opus' }
      ).catch(() => null)
    : Promise.resolve(null),
])

// Codex-UNAVAILABLE fallback (chunk 5). If the Codex lens errored / was
// unavailable (ran:false -- a verification GAP), fall back to ONE fresh-context
// OPUS review pass over the same diff and flag the run `degraded`. Opus is a
// STRONGER lens than the old Sonnet fallback: cross-vendor diversity is already
// lost during the outage, so upgrading to Opus buys a stronger review at no
// diversity cost. This guarantees a committed chunk is NEVER shipped with zero
// independent verification: either Codex ran, or the OPUS fallback did.
// `degraded` is surfaced in the return bundle so the cockpit / CEO knows the
// chunk was verified by the fallback, not the primary cross-model Codex lens.
let degraded = false
let codexFallback = null
if (committed && codexReview && codexReview.ran === false) {
  degraded = true
  codexFallback = await agent(
    sonnetLensPrompt('codex-fallback'),
    { model: 'opus', label: `codex-fallback-opus:${chunkId}`, phase: 'REVIEW', schema: REVIEW_RESULT }
  )
}

// INTERNAL JUDGE -> FIX -> RE-CHECK loop (pipeline-meritocracy chunk 2, replacing
// the llr-C2 fix-loop). The verification net's findings no longer return straight
// to the COO, and no mechanical severity floor decides fix-or-not: the opus
// meritocracy-judge ADJUDICATES every reviewer finding TRUE-vs-FAULTY by evidence
// and returns { verdict, fixList, issueLog }; the fixer then resolves the
// judge-confirmed fixList ONLY, and the judge RE-CHECKS, looping until CLEAN or
// stuck-after-N=2 (N=2 = the two-failed-attempts reset rule). The COO is OUT of the
// loop -- the pipeline returns to it ONLY when CLEAN or escalated, never mid-churn.
//
// The judge + fixer are part of the verification-net side, NOT the build-agent's
// continuous context: they are fresh-context agents the pipeline (script)
// dispatches -- so the maker-grading-its-own-work blindness the net exists to catch
// stays caught.
//
// The fixer fixes the judge-confirmed findings ONLY (P4) -- it does NOT arbitrate
// (the meritocracy-judge already owns truth). Per finding it returns a `fixed`, a
// `log-only` (the only change was additive logging), a `stuck` (two failed attempts,
// no third patch), or an `unreproducible` (the confirmed finding did not reproduce
// when the fixer went to fix it -- routed BACK to the judge with a counter-repro,
// NEVER a silent skip). The fixer has no refuse-with-evidence disposition: the judge,
// not the fixer, decides what is true; a finding the judge dropped never reaches the
// fixer at all.
const FIXER_RESULT = {
  type: 'object',
  required: ['suiteGreen', 'dispositions'],
  additionalProperties: true,
  properties: {
    commitSha: { type: 'string', description: 'the fixer\'s provisional fix commit sha (omit if no code change landed -- e.g. every confirmed finding turned out unreproducible)' },
    suiteGreen: { type: 'boolean', description: 'true iff the FULL suite is green after the fixes (revert-on-red enforced)' },
    dispositions: {
      type: 'array',
      description: 'one per RECEIVED (judge-confirmed) finding (every finding appears exactly once): fixed | log-only | stuck | unreproducible, with evidence (log-only = the ONLY change was added logging -> additive; unreproducible = the confirmed finding did not reproduce when fixing -> reported BACK to the judge, not silently skipped)',
      items: {
        type: 'object',
        required: ['finding', 'disposition', 'evidence'],
        additionalProperties: true,
        properties: {
          finding: { type: 'string', description: 'the finding line received' },
          disposition: { type: 'string', description: 'fixed | log-only | stuck | unreproducible' },
          evidence: { type: 'string', description: 'fixed: pinning test + proof; unreproducible: the counter-repro for the judge (what you ran/traced -> what you observed); stuck: attempts + read' },
          files: { type: 'array', items: { type: 'string' }, description: 'files the fix touched (empty for unreproducible)' },
        },
      },
    },
    lessonCandidates: {
      type: 'array',
      description: 'RAW lesson candidates from inside the fix dispatch (a discovery made while fixing is capturable). RAW, not drafted.',
      items: { type: 'object', additionalProperties: true },
    },
  },
}

// JUDGE_RESULT -- the shape the meritocracy-judge returns (pipeline-meritocracy
// chunk 2). The judge adjudicates each reviewer finding TRUE-vs-FAULTY by EVIDENCE
// (P2 / the re-check P5) and returns the fix-or-clean DECISION + the transparent
// issue log. NO severity floor: the fixList carries EVERY TRUE finding regardless of
// P-level, so a chunk with any present TRUE finding never returns CLEAN. The judge
// PERSISTS the issueLog to a durable per-chunk sidecar at the post-judge + each
// round + terminal boundary (crash-survivable) and reports the path here. On an
// internal failure it sets `error`; judgeDecision treats a missing/invalid verdict
// as a FAIL-CLOSED verification GAP, never a silent CLEAN.
const JUDGE_RESULT = {
  type: 'object',
  required: ['verdict', 'fixList', 'issueLog'],
  additionalProperties: true,
  properties: {
    verdict: { type: 'string', description: 'CLEAN (every finding adjudicated FAULTY -- merge) | FIX (>=1 TRUE finding on the fixList). Any other value (or an absent verdict) is treated by judgeDecision as a fail-closed verification GAP, never a silent CLEAN.' },
    fixList: {
      type: 'array',
      items: { type: 'string' },
      description: 'every TRUE (reproduces) finding verbatim, REGARDLESS of severity -- NO floor. Empty iff verdict CLEAN. The fixer fixes ONLY these (P4); a FAULTY no-repro finding is absent here and never reaches the fixer.',
    },
    issueLog: {
      type: 'array',
      description: 'the transparent per-finding adjudication record (P3): one entry per finding the judge weighed, with its repro/expected/actual, the TRUE|FAULTY verdict, the rationale (a FAULTY entry carries the counter-repro), and the disposition.',
      items: {
        type: 'object',
        required: ['finding', 'judgeVerdict', 'rationale'],
        additionalProperties: true,
        properties: {
          finding: { type: 'string', description: 'the finding line adjudicated' },
          repro: { type: 'string', description: 'the finding\'s repro (the triggering input/command)' },
          expected: { type: 'string', description: 'what a correct build does' },
          actual: { type: 'string', description: 'what this build does' },
          judgeVerdict: { type: 'string', description: 'TRUE (reproduces -> fixList) | FAULTY (no surviving repro -> dropped)' },
          rationale: { type: 'string', description: 'why; for a FAULTY verdict the counter-repro (what the judge ran/traced -> what it observed)' },
          disposition: { type: 'string', description: 'the finding\'s disposition (e.g. on-fix-list | dropped | resolved)' },
        },
      },
    },
    issueLogPath: { type: 'string', description: 'the durable per-chunk issue-log sidecar path the judge persisted to (so a crash-after-judge leaves a readable log on disk and the pipeline records the location)' },
    error: { type: 'string', description: 'set ONLY when the judge could not adjudicate (diff unreadable, internal error); judgeDecision routes it to a fail-closed GAP, never a silent CLEAN' },
    lessonCandidates: {
      type: 'array',
      description: 'RAW lesson candidates from inside the judge dispatch. RAW, not drafted.',
      items: { type: 'object', additionalProperties: true },
    },
  },
}

// cumulativeDiffRange(sha): the ONE source of the cumulative-range git command string,
// used by BOTH the P5 re-check judge dispatch AND the fixer dispatch so the fixer
// operates on the EXACT range the judge re-adjudicates (build commit + every fixer
// commit, reviewSha^..sha). Single source = the two ranges are identical by
// construction, not by two prompts independently spelling the same string. On round 1
// (no prior fixer commit) the range reduces to the single build commit; the fixer and
// judge stay identical.
function cumulativeDiffRange(sha) {
  return `git -C ${worktree} diff ${reviewSha}^..${sha}`
}

// judgeLensPrompt(sha, passContext, issueLogSidecar, ..., diffMode): the meritocracy-
// judge dispatch over the chunk's diff. The INITIAL P2 adjudication runs on the SINGLE
// build commit (diffMode 'single' -> `git show ${sha}`); the P5 re-check (after a fixer
// round) runs on the CUMULATIVE range (diffMode 'cumulative' -> cumulativeDiffRange).
// The single-commit committed-diff line is gated to the initial path ONLY: on the
// re-check path it would CONTRADICT the cumulative range, so the re-check prompt names
// only the cumulative range. The judge persists its issueLog to the per-chunk durable
// sidecar at issueLogSidecar (atomic tmp+rename) so a crash leaves a readable log.
function judgeLensPrompt(sha, passContext, issueLogSidecar, reviewerFindings, fixerDispositions, diffMode = 'single') {
  const diffLine = diffMode === 'cumulative'
    ? `The committed diff to judge (the CUMULATIVE chunk contribution): \`${cumulativeDiffRange(sha)}\` (read the surrounding`
    : `The committed diff to judge: \`git -C ${worktree} show ${sha}\` (read the surrounding`
  return [
    `You are the MERITOCRACY-JUDGE of the per-chunk verification net (agents/meritocracy-judge.md):`,
    `the single truth-arbiter. Two model-diverse reviewers flagged findings independently; you`,
    `adjudicate EACH one TRUE (reproduces) vs FAULTY (no surviving repro / refuted by the diff /`,
    `the two reviewers contradict) by EVIDENCE -- never by which lens raised it. ${passContext}`,
    chunkContext,
    ``,
    `cd ${worktree} first (it is the repo root).`,
    diffLine,
    `files for context). GROUND your adjudication in the REAL project + real data the chunk`,
    `touches (P9), not the diff alone or the tiny synthetic fixture.`,
    ``,
    `THE REVIEWER FINDINGS to adjudicate (one verdict each):`,
    ...(Array.isArray(reviewerFindings) && reviewerFindings.length
      ? reviewerFindings.map((f, i) => `  ${i + 1}. ${f}`)
      : ['  (none -- the reviewers returned clean; if truly empty, verdict CLEAN with no fixer dispatch)']),
    (Array.isArray(fixerDispositions) && fixerDispositions.length)
      ? `\nThe fixer's dispositions from the prior round (re-check P5: confirm each TRUE finding is`
        + ` now resolved (its repro no longer reproduces) AND no NEW finding the fix introduced`
        + ` reproduces; an 'unreproducible' disposition the fixer routed back is yours to re-adjudicate):\n`
        + fixerDispositions.map((d) => `  - [${d.disposition}] ${d.finding}\n    fixer evidence: ${d.evidence}`).join('\n')
      : '',
    ``,
    `THE WALK (P2 initial / P5 re-check): for EACH finding read its repro/expected/actual and`,
    `reproduce it against the diff (run it, or trace it). If actual reproduces (differs from`,
    `expected) -> verdict TRUE, add to the fixList. If not -> verdict FAULTY, write the`,
    `counter-repro (what you ran/traced -> what you observed), drop it. The lens is irrelevant;`,
    `only repro vs counter-repro decides. NO SEVERITY FLOOR: a TRUE P2/P3 finding goes on the`,
    `fixList exactly like a P1 -- a present TRUE finding is NEVER CLEAN. If the fixList is empty,`,
    `verdict CLEAN.`,
    ``,
    `PERSIST the issue log DURABLY to the per-chunk sidecar at:`,
    `  ${issueLogSidecar}`,
    `Write it with an ATOMIC tmp+rename (write a tmp file derived from that path, fsync it, then`,
    `rename/replace it onto the target -- the cockpit-sidecar durability pattern) so a crash`,
    `between write and rename never leaves a torn file. Persist at the post-judge boundary (now),`,
    `and again at each fixer round + the terminal boundary on a re-check. A crash-after-judge`,
    `MUST leave a readable log on disk.`,
    ``,
    `Return { verdict: "CLEAN"|"FIX", fixList: [<every TRUE finding verbatim>], issueLog:`,
    `[{finding, repro, expected, actual, judgeVerdict, rationale, disposition}], issueLogPath:`,
    `"${issueLogSidecar}" }. If you genuinely cannot adjudicate (diff unreadable, spec missing),`,
    `set \`error\` with the reason -- the pipeline fails closed (a judge that could not adjudicate`,
    `is a verification GAP, never a silent CLEAN).`,
  ].filter(Boolean).join('\n')
}

// The fixer dispatch prompt: a thin, finding-driven worker that resolves EXACTLY
// the JUDGE-CONFIRMED findings on the chunk's worktree and returns a per-finding
// disposition. It carries the injected worker-discipline (it does not inherit
// disciplines/). The fixer no longer arbitrates (P4): the meritocracy-judge already
// ruled what is TRUE, so the fixer fixes the confirmed findings only. It has no
// refuse-with-evidence path -- a finding the judge dropped never reaches the fixer; a
// confirmed finding the fixer finds UNREPRODUCIBLE when fixing routes BACK to the
// judge with a counter-repro, never a silent skip.
function fixerPrompt(sha, findings) {
  return [
    `You are the FIXER of the per-chunk verification net (agents/fixer.md). The builder`,
    `built; the meritocracy-judge adjudicated truth; you resolve the SPECIFIC judge-`,
    `confirmed findings it returned, and nothing else. You do NOT rebuild the chunk, do`,
    `NOT expand scope, do NOT add behavior no finding named, do NOT touch files the fixes`,
    `do not require, and you do NOT re-litigate a finding (the judge owns truth, not you).`,
    chunkContext,
    ``,
    `cd ${worktree} first (it is the repo root).`,
    `The diff under review (the CUMULATIVE chunk contribution -- build commit + every prior`,
    `fixer commit -- the SAME range the P5 re-check judge re-adjudicates against): \`${cumulativeDiffRange(sha)}\`.`,
    ``,
    `JUDGE-CONFIRMED FINDINGS to resolve (one disposition per finding -- every finding appears exactly once):`,
    ...findings.map((f, i) => `  ${i + 1}. ${f}`),
    ``,
    `Per finding: BUG/SECURITY/TEST/missed-criterion -> RED-first (pin with a failing test,`,
    `watch it fail for the right reason, then fix minimally). SLOP/dead-code/excess-drift ->`,
    `direct surgical edit. If a confirmed finding turns out UNREPRODUCIBLE when you go to fix`,
    `it, do NOT silently skip it: disposition 'unreproducible' with your counter-repro (what`,
    `you ran/traced -> what you observed) so the judge re-adjudicates it -- the judge owns`,
    `truth, you report back. Two failed attempts on one finding -> stuck (no third patch).`,
    `Re-run the FULL suite (revert-on-red). Commit fixes provisionally (deliberate staging,`,
    `imperative subject naming the findings resolved, no footers; never to main).`,
    `Return the bundle: { commitSha|null, suiteGreen, dispositions:[{finding,disposition,evidence,files}],`,
    `lessonCandidates:[{raw_lesson,kind_hint,provenance}] (RAW) }.`,
    injectedDocBlock('worker-discipline', 'disciplines/worker-discipline.md', workerDisciplineDoc),
  ].filter(Boolean).join('\n')
}

// escalation (non-null only at the 2-pass cap): the open repros the COO adjudicates.
let escalation = null
// finalCommitSha: the FINAL post-fix commit sha -- the original build commit when no
// fixer landed a commit, else the last fixer commit. The bundle publishes it so the
// cockpit's effective-touches (git diff-tree on the chunk's sha, cockpit SKILL.md)
// covers the FIXER'S file changes too, not only the pre-fix build commit --
// under-reporting touches is the same-file-edit hazard that reconciliation exists to
// catch. The branch-based merge already replays every commit; this field only fixes
// the single-sha effective-touches read.
let finalCommitSha = reviewSha
// The per-chunk durable issue-log sidecar: a dotfile in the worktree, keyed by
// chunk id, where the JUDGE persists its adjudication record (P3) at the post-judge
// + each fixer round + terminal boundary (atomic tmp+rename), so a crash-after-judge
// leaves a readable log on disk. The pipeline THREADS this path into the judge
// dispatch and records the persisted path (judge.issueLogPath) in the bundle. The
// judge agent has Bash/fs; a Workflow script does not, so the WRITE is the agent's.
const issueLogSidecar = `${worktree}/.issue-log-${chunkId}.json`
// The terminal judge result (the last adjudication) + the per-round judge re-checks.
let judge = null
let judgeRounds = []   // one entry per fixer round: { fixer, reCheck }
let judgeDecisionResult = { action: 'clean' }
if (committed) {
  // The reviewers' raw findings, handed to the JUDGE to adjudicate TRUE-vs-FAULTY by
  // evidence. NO severity filter, NO settled-finding dedup -- the judge owns truth, so
  // it weighs the raw set. A down lens contributes nothing (degraded already flags it).
  const reviewerFindings = collectReviewerFindings(codexReview, sonnetReview, adversarialReview, codexFallback)
  // POST-JUDGE (P2): the initial adjudication. The judge reproduces each finding,
  // returns { verdict, fixList, issueLog }, and persists the issue log durably.
  judge = await agent(
    judgeLensPrompt(reviewSha, 'This is the INITIAL adjudication (P2) over the build commit.', issueLogSidecar, reviewerFindings, null),
    { agentType: judgeFor(tier).agentType, model: tierCfg.buildModel, label: `judge:${chunkId}`, phase: 'JUDGE', schema: JUDGE_RESULT }
  )
  let passCount = 0
  let currentSha = reviewSha
  let fixerDispositions = null
  // JUDGE -> FIX -> RE-CHECK. The judge decision routes: clean -> merge; fix ->
  // dispatch the fixer on the fixList ONLY (P4), then the judge re-checks (P5);
  // gap -> fail-closed (a judge that could not adjudicate is a verification GAP,
  // never a silent CLEAN); escalate at the 2-pass cap (no third patch).
  while (true) {
    judgeDecisionResult = judgeDecision(judge, passCount)
    if (judgeDecisionResult.action === 'clean') break
    if (judgeDecisionResult.action === 'gap') break        // fail-closed terminal (status maps to failed)
    if (judgeDecisionResult.action === 'escalate') { escalation = judgeDecisionResult.escalation; break }
    // action === 'fix': dispatch the fixer on the judge-confirmed fixList ONLY,
    // dialed by the FIX-tier (the MAX [FIX:] tier across the fixList, fixerFor) --
    // default -> fixer/opus, heavy -> fixer-heavy/opus.
    const fixList = Array.isArray(judge.fixList) ? judge.fixList : []
    const fixCfg = fixerFor(fixList)
    const fixer = await agent(
      fixerPrompt(currentSha, fixList),
      { agentType: fixCfg.agentType, model: fixCfg.model, label: `fixer:${chunkId}:r${passCount + 1}`, phase: 'JUDGE', schema: FIXER_RESULT }
    )
    passCount += 1
    fixerDispositions = fixer && Array.isArray(fixer.dispositions) ? fixer.dispositions : []
    // The fixer's new commit is what the judge re-checks (fall back to the prior sha
    // if the fixer landed no commit -- e.g. every confirmed finding was unreproducible).
    currentSha = (fixer && fixer.commitSha) ? fixer.commitSha : currentSha
    finalCommitSha = currentSha   // publish the latest landed sha (effective-touches read)
    // RE-CHECK (P5): the judge re-adjudicates over the CUMULATIVE diff -- is each TRUE
    // finding now resolved, and did the fix introduce any NEW finding that reproduces?
    // An 'unreproducible' disposition the fixer routed back is the judge's to re-rule.
    // The judge re-persists the issue log at this round boundary (durable).
    judge = await agent(
      judgeLensPrompt(currentSha, `This is the RE-CHECK (P5) after fixer round r${passCount}. Re-adjudicate over the CUMULATIVE diff (run \`git -C ${worktree} diff ${reviewSha}^..${currentSha}\`) -- the SAME range the fixer operated on.`, issueLogSidecar, reviewerFindings, fixerDispositions, 'cumulative'),
      { agentType: judgeFor(tier).agentType, model: tierCfg.buildModel, label: `judge-recheck:${chunkId}:r${passCount}`, phase: 'JUDGE', schema: JUDGE_RESULT }
    )
    judgeRounds.push({ fixer, reCheck: judge })
    // HONOR FIXER SUITE FAILURES. A fixer change that broke the suite (suiteGreen
    // false) must NOT let the loop declare CLEAN off an empty re-check -- a CLEAN that
    // ships a red suite is a false success. Force the judge verdict to FIX (carrying a
    // SUITE-RED finding) so the loop keeps the round open and, at the cap, escalates.
    if (fixer && fixer.suiteGreen === false) {
      const suiteRed = `[SUITE-RED] fixer round r${passCount} left the suite RED (suiteGreen=false) -- the fix could not be landed green; not CLEAN`
      const judgeFixList = (judge && Array.isArray(judge.fixList)) ? judge.fixList : []
      judge = {
        ...(judge || {}),
        verdict: 'FIX',
        fixList: judgeFixList.includes(suiteRed) ? judgeFixList : [...judgeFixList, suiteRed],
      }
    }
  }
}

// CLEAR RESOLVED FINDINGS ON CLEAN. When the judge terminated CLEAN, the ORIGINAL
// codex/sonnet/fallback lenses still carry the findings the judge has since
// adjudicated -- whether it dropped them as FAULTY on the first pass (zero fixer
// rounds) or the fixer resolved them across rounds. A bundle that reports status
// awaiting-review (clean) while its surfaced lenses still list non-empty findings is
// self-contradictory -- a downstream consumer reading review.codex.findings would see
// adjudicated findings as if still open. So on ANY CLEAN terminal we surface the
// lenses in their FINAL resolved state (ran preserved, clean:true, findings:[]); the
// full audit trail of what was first found, how the judge ruled, and how it was
// resolved is preserved verbatim in review.issueLog + review.judgeRounds, never lost.
// A non-clean terminal (escalation / gap) surfaces the lenses verbatim.
const cleanResolvedFindings = (judgeDecisionResult.action === 'clean')
function resolvedLens(lens) {
  if (!lens) return lens
  if (!cleanResolvedFindings) return lens
  // It ran and was adjudicated CLEAN by the judge re-check; reflect the resolved state.
  return { ...lens, clean: true, findings: [] }
}

// Status routing. The internal JUDGE -> FIX -> RE-CHECK loop resolves findings BEFORE
// the bundle returns, so the COO sees a chunk in one of TWO terminal bundle states
// only -- never mid-churn. The cockpit recognizes exactly two bundle statuses
// ('awaiting-review' | 'failed') and FAILS LOUD on anything else, so a deadlock / gap
// must NOT invent a third status string the cockpit cannot route:
//   'failed'        -- the build-agent could not make the test pass (no commit -- the
//                      git-grounded 'build-did-not-commit' terminal, see buildOutcome),
//                      OR the judge escalated after the 2-pass cap, OR the judge was a
//                      verification GAP (fail-closed: unreachable/errored, never a
//                      silent CLEAN). All quarantine and route to reset-or-decompose
//                      for the operator's call. On an escalation the COO adjudicates from
//                      review.escalation (the open repros); on a gap, review.judgeGap
//                      names the reason. Both ride the bundle; only the status string
//                      maps to the supported 'failed' so the cockpit routes it.
//   'awaiting-review' -- committed AND the judge reached CLEAN; ready to merge.
// The no-commit terminal maps to 'failed' (the only quarantine status the cockpit
// routes), but it is NOT a silent empty return: buildOutcome.status names the state
// ('build-did-not-commit') and buildOutcome.message carries the human-readable reason,
// both surfaced in the bundle below (buildOutcome + green.failureReason) so the COO
// sees a CLEAR terminal signal.
const judgeGap = judgeDecisionResult.action === 'gap' ? judgeDecisionResult.reason : null
const status = !committed ? 'failed' : ((escalation || judgeGap) ? 'failed' : 'awaiting-review')

// The bundle. The worker fills explanation / proof / drafted from the single BUILD
// stage (chunk 5: the build-agent's one continuous context) and codex / sonnet from
// the REVIEW stage (chunk 9). `degraded` flags a Codex-outage run that fell back to
// the Opus lens. drafted carries the shared-state content the cockpit applies at
// merge -- the worker returns it all as data, never writes anything shared.
return {
  chunkId,
  worktree,
  branch: build ? build.branch : (a.branch || null),
  // Back-compat for the cockpit's existing bundle consumers (red / green): the
  // five-context relay's separate red/green stages collapsed into the single
  // build-agent, so these now project that one result. `red` carries the RED-state
  // integrity record (test-first ordering, verifiable post-hoc); `green` carries
  // the build result the cockpit reads for commitSha / behaviorShift / deleted /
  // failureReason (same field names it always read).
  red: build ? { redStateRecord: build.redStateRecord, redCommitSha: build.redCommitSha || null } : null,
  green: build,
  // finalCommitSha (Codex finding 4): the chunk's FINAL post-fix commit sha (the
  // build commit when no fixer landed a commit, else the last fixer commit). The
  // cockpit diff-trees this for effective-touches so the fixer's file changes are
  // covered, not just the pre-fix build commit. Distinct from green.commitSha, which
  // stays the build-agent's own reported provisional commit (back-compat untouched).
  finalCommitSha: committed ? finalCommitSha : null,
  // buildOutcome (chunk pipeline-crash-recovery): the GIT-GROUNDED build resolution.
  // On a no-commit terminal it carries status:'build-did-not-commit' + a human-readable
  // message naming the state, so a build-agent crash/timeout that left no commit returns
  // a CLEAR terminal signal (AC3), never a silent empty return. On a committed build it
  // carries status:'review' + the git-grounded reviewSha the REVIEW stage ran on. The
  // top-level bundle status still maps to the cockpit's 'awaiting-review'|'failed' contract.
  buildOutcome,
  review: {
    // codex/sonnet/fallback surfaced in their FINAL resolved state on a CLEAN
    // terminal: a CLEAN bundle must not list findings the judge adjudicated + the
    // fixer resolved. The original-vs-resolved audit trail lives in issueLog +
    // judgeRounds.
    codex: resolvedLens(codexReview),        // tier-scaled ~/.claude/scripts/codex-review.sh on the worker's diff (both tiers; null only if gated off)
    sonnet: resolvedLens(sonnetReview),      // chunk-reviewer (full-scope Sonnet) pass on the worker's diff
    adversarial: resolvedLens(adversarialReview), // the opus adversarial paranoia lens (HEAVY ONLY; null on default and on its own fail-open outage)
    codexFallback: resolvedLens(codexFallback), // codex-fallback-opus: the OPUS fallback pass when Codex was unavailable (null otherwise)
    degraded: degraded,        // true iff Codex was unavailable and the OPUS fallback verified instead (a flagged, still-verified run)
    tier: tier,                // the tier the Codex lens reviewed at (default|heavy or legacy A|B|C|S)
    // MERITOCRACY-JUDGE result (pipeline-meritocracy chunk 2). The opus judge owns
    // the truth decision; the COO no longer routes findings through a fix-loop at the
    // go/no-go. judgeVerdict is the judge's terminal { verdict, fixList, issueLog }
    // (the LAST adjudication). issueLog is the transparent per-finding adjudication
    // record (TRUE/FAULTY + rationale), persisted durably at issueLogPath so a crash
    // leaves a readable log. judgeRounds is the per-round { fixer, reCheck } record.
    // decision is the routed action ('clean' | 'escalate' | 'gap'); escalation
    // (non-null only at the 2-pass cap) carries the open repros; judgeGap (non-null
    // only on a fail-closed gap) names why the judge could not adjudicate.
    judgeVerdict: judge ? { verdict: judge.verdict || null, fixList: judge.fixList || [] } : null,
    issueLog: judge ? (judge.issueLog || []) : [],
    issueLogPath: judge ? (judge.issueLogPath || issueLogSidecar) : null,
    decision: judgeDecisionResult.action,
    judgeRounds,
    escalation,                // null unless the judge escalated after the 2-pass cap (carries openFindings)
    judgeGap,                  // null unless the judge was a fail-closed verification GAP (carries the reason)
    explanation: build ? build.explanation : null,
    proof: build ? build.proof : null,
    drafted: build ? {
      specUpdateSummary: build.specUpdateSummary,
      diagram: build.diagram || 'none',
      wiki: build.wiki || 'none',
    } : null,
  },
  status,
}
} catch (e) {
  // AGENTTYPE-UNAVAILABLE (pipeline-meritocracy chunk 6). A configurable-agentType
  // dispatch in the post-build net hit `agent type 'X' not found` -- the registration-
  // lag crash (the Workflow snapshots its registry at launch; a newly-merged agent file
  // is not yet registered). Resolve it to a CLEAN terminal failed bundle naming the
  // missing agentType + the relaunch condition, with the buildOutcome PRESERVED so a
  // committed build is reported (not orphaned ambiguously). Any OTHER error is a real
  // failure -- re-throw so it is never swallowed.
  if (!isAgentTypeNotFoundError(e)) throw e
  return agentUnavailableBundle({
    chunkId,
    worktree,
    branch: build ? build.branch : (a.branch || null),
    agentType: extractMissingAgentType(e),
    buildOutcome,
    phase: 'REVIEW/JUDGE',
  })
}
