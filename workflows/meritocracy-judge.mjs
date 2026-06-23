// Meritocracy-judge decision core (pipeline-meritocracy chunk 2).
//
// EXTRACTED from worker-pipeline.js so it is import-safe + unit-testable:
// worker-pipeline.js runs `await agent(...)` at top level and references Workflow
// host globals, so importing that module would execute the pipeline. This module
// is PURE (no top-level side effects, no Workflow globals) -- it imports cleanly
// in a unit test, the same proof-pattern as fix-loop.mjs and tier-dispatch.mjs.
//
// worker-pipeline.js carries a VERBATIM-INLINED copy of judgeDecision +
// collectReviewerFindings (the Workflow sandbox has no module resolution -- it
// cannot `import` this file), so the two copies MUST move in LOCKSTEP; this module
// is the canonical, unit-tested source and the inline copy must agree byte-for-byte
// (minus the `export` keyword).
//
// THE ARCHITECTURE THIS REPLACES (deleted in this chunk):
//   the mechanical fixLoopController severity-floor (P2/P3 findings cleared with 0
//   fix rounds -- the live worker-pipeline.js defect), the fixer-REJECT-adjudication
//   path (the fixer argued findings back and a re-review re-judged), and the
//   re-review-deadlock-escalation. Truth-arbitration was SCATTERED across three
//   actors. Now ONE opus meritocracy-judge weighs each finding TRUE-vs-FAULTY by
//   EVIDENCE (the agent prompt: agents/meritocracy-judge.md), returns
//   { verdict, fixList, issueLog }, and this PURE decision core routes its verdict.

// JUDGE_MAX_PASSES -- the judge re-check cap, pinned to the reset rule's
// two-failed-attempts (the same N=2 the old fix-loop used). After two fixer rounds
// on a still-open TRUE finding the loop STOPS and escalates to the COO with both
// repros, rather than churning a third patch.
export const JUDGE_MAX_PASSES = 2

// collectReviewerFindings(...reviews) -> the flat list of findings the reviewers
// raised, handed to the judge to ADJUDICATE. PURE: no I/O, no agent(). This is the
// judge's INPUT, not a clean/fix decision -- the judge owns truth, so this gathers
// every finding from every lens that RAN-and-was-not-clean and lets the judge weigh
// it. A reviewer that did not run (ran:false) is a verification gap surfaced
// elsewhere (degraded); it contributes no findings here. UNLIKE the deleted
// gatherFindings, there is NO severity filter and NO settled-REJECT dedup -- the
// judge adjudicates the raw set on evidence.
export function collectReviewerFindings(...reviews) {
  const open = []
  for (const r of reviews) {
    if (r && r.ran && !r.clean && Array.isArray(r.findings)) open.push(...r.findings)
  }
  return open
}

// judgeDecision(judgeResult, passCount) -> the next action of the per-chunk net,
// routed from the judge's adjudicated verdict. PURE: no I/O, no agent() -- the
// pipeline calls agent() around it. Given the judge's result (its verdict +
// fixList) and how many fixer rounds have already run, it returns exactly one of:
//
//   { action: 'clean' }    -- the judge adjudicated every finding FAULTY (empty
//                             fixList, verdict CLEAN); the chunk returns to the COO
//                             CLEAN -> merge. A FAULTY no-repro finding is dropped
//                             here and NEVER reaches the fixer.
//   { action: 'fix' }      -- the fixList carries >=1 TRUE finding and passCount < N;
//                             dispatch the fixer on the fixList (the judge-confirmed
//                             findings ONLY). NO SEVERITY FLOOR: a TRUE P2/P3 finding
//                             fires the fixer exactly like a P1 -- a present TRUE
//                             finding is NEVER CLEAN (this is the live-defect fix).
//   { action: 'escalate', escalation: { openFindings } }
//                          -- TRUE findings still open at passCount >= N (the judge
//                             re-check could not clear them after 2 fixer rounds).
//                             STOP -- no third patch (the reset rule). Escalate to the
//                             COO carrying the open findings (the repros) so a genuine
//                             stuck finding is adjudicated, not silently dropped.
//   { action: 'gap', reason }
//                          -- FAIL-CLOSED: the judge was unreachable / errored / its
//                             verdict is missing or not one of CLEAN|FIX. A judge that
//                             could not adjudicate is a verification GAP, treated like
//                             a down lens -- NEVER a silent CLEAN. The pipeline routes
//                             a gap to a non-clean terminal (failed), surfacing the
//                             reason, so a chunk is never declared clean off a judge
//                             that did not actually run.
export function judgeDecision(judgeResult, passCount) {
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
