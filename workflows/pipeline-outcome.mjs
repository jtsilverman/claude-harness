// Build-outcome resolver (chunk pipeline-crash-recovery).
//
// EXTRACTED from worker-pipeline.js so it is import-safe + unit-testable:
// worker-pipeline.js runs `await agent(...)` at top level and references Workflow
// host globals, so importing that module would execute the pipeline. This module
// is PURE (no top-level side effects, no Workflow globals) -- it imports cleanly
// in a unit test, the same proof-pattern as tier-dispatch.mjs / fix-loop.mjs.
//
// worker-pipeline.js carries a VERBATIM-INLINED copy of resolveBuildOutcome (the
// Workflow sandbox has no module resolution -- it cannot `import` this file), so
// the two copies MUST move in lockstep; this module is the canonical, unit-tested
// source and the inline copy must agree with it.
//
// WHY THIS EXISTS (real failure, agnes-capable-ea C3): a build-agent COMMITTED in
// its worktree (sha b7ca962) but the workflow then returned NO valid bundle, so the
// pipeline -- which gated REVIEW on the self-reported bundle's commitSha -- skipped
// REVIEW silently and left an unreviewed ORPHAN commit on disk (recovered manually
// by a reflog reset + full re-run). A dead/timed-out/malformed agent returns nothing
// regardless of how firm the prompt is; the fix is harness-side. resolveBuildOutcome
// reads git HEAD as GROUND TRUTH (threaded in by the cockpit, which has Bash; a
// Workflow script cannot run git itself) and decides the outcome from the on-disk
// reality, not the agent's word.

// resolveBuildOutcome({ build, worktreeHead, baseRef }) -> { committed, reviewSha, status, message }
//
// Inputs:
//   build        -- the build-agent's returned bundle (may be null / undefined /
//                   schema-invalid / missing commitSha on a crash/timeout).
//   worktreeHead -- the worktree HEAD sha, when available. Two sources:
//                   (a) explicit: `git -C <worktree> rev-parse HEAD` after BUILD
//                       (only possible outside the pipeline -- a Workflow script
//                       cannot run git; used when the cockpit post-pipeline
//                       handler calls this resolver for crash recovery).
//                   (b) implicit: derived from build.commitSha when baseRef is
//                       present (the cockpit threads baseRef at launch; the
//                       pipeline uses the agent's self-reported sha as head when
//                       the agent did not crash).
//   baseRef      -- the worktree branch's start point (the feature-branch tip it
//                   branched from), threaded by the cockpit at worktree-creation time.
//                   HEAD advanced past base iff a build commit exists.
//
// Outcome:
//   committed -- true iff a real commit landed (HEAD advanced past base, or in
//                back-compat the self-reported green+sha says so).
//   reviewSha -- the HEAD sha when committed (REVIEW runs on base..HEAD); null when
//                no commit landed.
//   status    -- 'review' when a commit exists (proceed to the verification net,
//                even with a missing/invalid bundle -- the committed work is reviewed,
//                not orphaned); 'build-did-not-commit' when no commit landed (a CLEAR
//                terminal failure naming the state, never a silent empty return).
//   message   -- a human-readable reason on the terminal failure; '' otherwise.
//
// Ground-truth rule (AC1): when worktreeHead and baseRef are both present, the
// HEAD-advanced-past-base comparison is the authority. When only baseRef is present
// (the typical cockpit dispatch after the pipeline-crash-recovery fix: cockpit threads
// baseRef at launch; worktreeHead is not known in-pipeline for the crash case), the
// agent's self-reported commitSha serves as the effective head when available (the
// non-crash path). If the cockpit did NOT thread git shas at all (old/manual dispatch),
// fall back to the self-reported bundle (back-compat): committed iff
// build.green && build.commitSha, reviewSha = build.commitSha.
//
// CRASH-CASE ORPHAN DETECTION: a crashed agent (build=null/invalid) with baseRef
// present but no commitSha still cannot determine HEAD in-pipeline (no git access).
// That case falls through to back-compat (non-committed terminal). The COCKPIT
// completion handler is responsible for detecting the real orphan by running
// `git -C <worktree> rev-parse HEAD` after the pipeline finishes and comparing to
// baseRef; if HEAD advanced despite a "failed" pipeline return, the cockpit surfaces
// the orphaned commit to the COO.
export function resolveBuildOutcome({ build, worktreeHead, baseRef } = {}) {
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
