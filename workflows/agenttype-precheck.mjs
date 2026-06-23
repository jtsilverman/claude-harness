// agentType-availability helper (pipeline-meritocracy chunk 6).
//
// EXTRACTED from worker-pipeline.js so it is import-safe + unit-testable:
// worker-pipeline.js runs `await agent(...)` at top level and references Workflow
// host globals, so importing that module would execute the pipeline. This module is
// PURE (no top-level side effects, no Workflow globals) -- it imports cleanly in a
// unit test, the same proof-pattern as tier-dispatch.mjs / meritocracy-judge.mjs /
// pipeline-outcome.mjs.
//
// THE FAILURE THIS GUARDS (on-chain-analyst chunk 3, the agents-do-not-hot-reload
// memory): a Workflow snapshots its agent registry AT LAUNCH. A newly-merged agent
// file (e.g. meritocracy-judge) not yet registered in the running session crashes the
// WHOLE workflow with an uncaught `agent type 'X' not found` -- and the crash lands
// AFTER the build-agent committed in its worktree, leaving an orphaned commit and an
// ambiguous failure with no named recovery condition.
//
// TWO defenses, two scopes:
//   (a) GRACEFUL FAILURE (this module's classifier + bundle-builder, inlined LOCKSTEP
//       into worker-pipeline.js): the pipeline catches the not-found error from a
//       configurable-agentType dispatch and returns a CLEAN terminal failed bundle
//       (status 'failed', reason 'agenttype-unavailable', the missing agentType, the
//       PRESERVED buildOutcome) so the COO sees a named, recoverable signal -- never an
//       uncaught crash and never an orphaned-but-unreported commit. This catches the
//       REGISTRATION-LAG case (the file exists on disk but the live session has not
//       registered it).
//   (b) DISK PRECHECK (expectedAgentTypesForTier here + scripts/agenttype_precheck.mjs):
//       before launch, enumerate the agentTypes a tier's pipeline will dispatch and
//       verify each agents/<name>.md exists on disk; exit non-zero naming any missing
//       file. This catches a NOT-YET-CREATED / NOT-YET-MERGED agent file -- it does NOT
//       catch registration lag (the file is on disk but unregistered); (a) covers that.
//
// LOCKSTEP: worker-pipeline.js carries a VERBATIM-INLINED copy of
// isAgentTypeNotFoundError + extractMissingAgentType + agentUnavailableBundle (the
// Workflow sandbox has no module resolution -- it cannot `import` this file), so the
// two copies MUST move in LOCKSTEP; this module is the canonical, unit-tested source
// and the inline copy must agree (minus the `export` keyword).

import { normalizeTier } from './tier-dispatch.mjs'

// isAgentTypeNotFoundError(err) -> boolean. TRUE iff the error is the harness's
// "agent type 'X' not found" rejection (the registration-lag / missing-file crash),
// FALSE for every OTHER error -- a real bug (a thrown TypeError inside the agent, a
// schema violation, a timeout) MUST propagate, never be swallowed as unavailable.
// Robust match: the harness text is like
//   `agent type 'meritocracy-judge' not found. Available agents: ...`
// so we match the stable head `agent type '<name>' not found` (case-insensitive,
// flexible whitespace), tolerant of the trailing "Available agents:" tail. Accepts an
// Error or a bare string message.
export function isAgentTypeNotFoundError(err) {
  if (!err) return false
  const msg = typeof err === 'string' ? err : (err && err.message) ? String(err.message) : ''
  return /agent\s+type\s+['"`].+?['"`]\s+not\s+found/i.test(msg)
}

// extractMissingAgentType(err) -> the quoted agentType name from a not-found error,
// or null when the error is not a not-found error (nothing to extract). Used to NAME
// the missing agent in the failed bundle so the COO knows exactly which file to
// register/relaunch on.
export function extractMissingAgentType(err) {
  if (!err) return null
  const msg = typeof err === 'string' ? err : (err && err.message) ? String(err.message) : ''
  const m = /agent\s+type\s+['"`](.+?)['"`]\s+not\s+found/i.exec(msg)
  return m ? m[1] : null
}

// agentUnavailableBundle({ chunkId, worktree, branch, agentType, buildOutcome, phase })
// -> the pipeline's structured TERMINAL failed bundle for an agenttype-unavailable
// dispatch. status 'failed' (the cockpit routes only 'awaiting-review' | 'failed', and
// fails loud on a third string), review.reason 'agenttype-unavailable' (the clean,
// COO-recoverable signal naming the relaunch condition), review.agentType (the missing
// file to register), and the PRESERVED buildOutcome so a committed build is reported,
// not orphaned ambiguously. The COO reads buildOutcome.committed/reviewSha to recover
// the orphan (register the agent + relaunch, reviewing the committed diff).
export function agentUnavailableBundle({ chunkId, worktree, branch, agentType, buildOutcome, phase } = {}) {
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

// expectedAgentTypesForTier(tier) -> the list of configurable agentTypes a tier's
// worker-pipeline will dispatch by NAME (so a disk precheck can verify each
// agents/<name>.md exists). Enumerated from the SAME 2-tier dial the pipeline uses
// (normalizeTier from tier-dispatch.mjs), so the precheck stays in step with the dial:
//   build-agent[-heavy]       (tierConfig.buildAgent -- chunk-tier-matched)
//   chunk-reviewer[-heavy]    (reviewerFor.agentType -- chunk-tier-matched)
//   meritocracy-judge[-heavy] (judgeFor.agentType -- chunk-tier-matched; the judge + re-check dispatch)
//   fixer + fixer-heavy       (BOTH, regardless of chunk tier -- see below)
//
// The build-agent, reviewer, AND judge ARE chunk-tier-matched (chunk 9 added the judgeFor
// effort dial: default -> meritocracy-judge, heavy -> meritocracy-judge-heavy), so each
// tier lists only its own variant. The FIXER is NOT: fixerFor(findings) in tier-dispatch.mjs dials the fixer
// agentType by the FIX-tier -- the MAX [FIX:<C|B|A|S>] rank across the judge's fixList
// -- INDEPENDENT of the chunk's BUILD tier (there is no chunk-tier floor). So a
// default-tier chunk whose fixList carries a [FIX:A]/[FIX:S] finding dispatches
// `fixer-heavy`, and a heavy-tier chunk with only [FIX:C]/[FIX:B] findings dispatches
// plain `fixer`. BOTH fixer files are reachable from EITHER tier, so the precheck must
// enumerate BOTH variants in both tiers -- enumerating only the tier-matched one lets a
// missing/unmerged agents/fixer-heavy.md PASS a default precheck, then crash at the
// fixer dispatch post-commit (exactly the path the pre-launch loud-reject prevents).
//
// The adversarial lens and the Codex-fallback dispatch carry NO agentType (model-only
// dispatches, no agent-file lookup), so they are NOT enumerated -- a missing agent
// FILE cannot affect them.
export function expectedAgentTypesForTier(tier) {
  const heavy = normalizeTier(tier) === 'heavy'
  // build-agent, reviewer, and judge are ALL chunk-tier-matched -> each tier lists its variant.
  const tierMatched = heavy
    ? ['build-agent-heavy', 'chunk-reviewer-heavy', 'meritocracy-judge-heavy']
    : ['build-agent', 'chunk-reviewer', 'meritocracy-judge']
  // fixer is FIX-tier-dialed, not chunk-tier-dialed -> both variants are reachable.
  return [...tierMatched, 'fixer', 'fixer-heavy']
}
