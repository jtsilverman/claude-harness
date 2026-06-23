// Fix-loop controller + discipline-doc injection (lean-system-design chunk llr-C2).
//
// EXTRACTED from worker-pipeline.js so it is import-safe + unit-testable:
// worker-pipeline.js runs `await agent(...)` at top level and references Workflow
// host globals, so importing that module would execute the pipeline. This module
// is PURE (no top-level side effects, no Workflow globals) -- it imports cleanly
// in a unit test, the same proof-pattern as tier-dispatch.mjs.
//
// worker-pipeline.js carries a VERBATIM-INLINED copy of fixLoopController (the
// Workflow sandbox has no module resolution -- it cannot `import` this file), so
// the two copies MUST move in lockstep; this module is the canonical, unit-tested
// source and the inline copy must agree with it.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// N=2 -- the stuck-after-N threshold, pinned to the reset rule's two-failed-attempts
// (annex Part 5 #2). After two fixer rounds on a still-open finding the loop STOPS
// and escalates to the COO rather than churning a third patch.
export const FIX_LOOP_MAX_ATTEMPTS = 2

// The two discipline docs the pipeline injects (reviewers/builders inherit rules/
// but NOT disciplines/, so injection is the only delivery path -- A0's verified
// loading model). Repo-relative paths; the bytes are read at dispatch time.
export const DISCIPLINE_DOCS = {
  workerDiscipline: 'disciplines/worker-discipline.md', // builder + fixer
  reviewContract: 'disciplines/review-contract.md',     // reviewer + Codex
}

// injectDisciplineDocs(role, repoRoot) -> the injectedDocs object carrying the
// FULL FILE BYTES of the role's discipline doc(s). The build-agent + fixer get
// worker-discipline; the reviewer + Codex get review-contract. Returns the bytes
// verbatim (never a path, never a digest) so the payload carries the contract
// itself -- the only way it reaches an agent that does not inherit disciplines/.
//
// role: 'worker' (build-agent + fixer) -> { workerDiscipline: <bytes> }
//       'reviewer' (reviewer + Codex)  -> { reviewContract: <bytes> }
//
// NOTE: disciplines/ is GLOBAL -- it lives only in ~/.claude, never in a project
// repo. We derive the global root from THIS MODULE's own location (dirname of
// this file is ~/.claude/workflows, so join(that, '..') is ~/.claude). The passed
// repoRoot is NOT used to locate disciplines/ (kept for back-compat signature only).
const _globalRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export function injectDisciplineDocs(role, repoRoot) {  // eslint-disable-line no-unused-vars
  const readBytes = (rel) => readFileSync(join(_globalRoot, rel), 'utf8')
  if (role === 'reviewer') {
    return { reviewContract: readBytes(DISCIPLINE_DOCS.reviewContract) }
  }
  // default: the worker (build-agent + fixer) role
  return { workerDiscipline: readBytes(DISCIPLINE_DOCS.workerDiscipline) }
}

// fixLoopController(reviewFindings, fixerDispositions, attemptCount) -> the next
// action of the internal fix-loop. PURE: no I/O, no agent() -- the pipeline calls
// agent() around it. It is the terminator: given the CURRENT review's open
// findings (the re-review already adjudicated any prior REJECTs and dropped the
// ones it accepted), the prior round's fixer dispositions, and how many fixer
// rounds have already run, it returns exactly one of:
//
//   { action: 'clean' }      -- no material open findings; the chunk returns to the COO CLEAN.
//   { action: 'fix' }        -- open findings remain and attemptCount < N; dispatch the fixer.
//   { action: 'escalate', escalation: { reviewerFindings, fixerDispositions } }
//                            -- open findings still remain at attemptCount >= N (deadlock).
//                               STOP -- no third patch (the reset rule). Escalate to the COO
//                               carrying BOTH sides' evidence so the COO adjudicates:
//                               the reviewer's still-open findings AND the fixer's
//                               dispositions (incl. any REJECT rationale). A finding the
//                               fixer REJECTed with evidence that the re-review ACCEPTED is
//                               simply absent from reviewFindings -> clean, never churned.
// isLogOnlyRound(fixerDispositions) -> true iff the fixer round was NON-EMPTY and
// EVERY disposition is 'log-only'. PURE: no I/O, no agent(). The pipeline uses it to
// skip the re-review agent for an additive logs-only fix (C6's logging hard-gate, once
// a fixer adds logging, otherwise pays for a full re-review even though the change is
// additive/non-behavioral). The skip is RE-REVIEW ONLY: the suite still runs
// (revert-on-red, enforced by the fixer + the SUITE-RED guard in the loop body).
//
// An EMPTY or missing dispositions list is NOT a log-only round -- there is nothing
// additive to vouch for (e.g. a fixer that REJECTed everything and changed nothing must
// still be re-reviewed). A single non-log-only disposition (a mixed batch) returns false,
// so any behavioral fix keeps the normal re-review.
export function isLogOnlyRound(fixerDispositions) {
  if (!Array.isArray(fixerDispositions) || fixerDispositions.length === 0) return false
  return fixerDispositions.every((d) => d && d.disposition === 'log-only')
}

// findingSeverity(finding) -> the P-level (1|2|3) a finding carries. Matches
// [P<n>] only in the LEADING bracket-token prefix (the header tags such as
// [DIMENSION] [P<n>] [FIX:X] at the very start of the line), never in the body
// text that follows the title / ' -- ' separators. A finding with NO header match
// is treated as P1 (blocking) -- fail safe, an unclassified finding blocks. PURE.
export function findingSeverity(finding) {
  // Reviewers emit each finding with a LEADING markdown list bullet per the
  // review contract (`- [<DIM>][P<n>]...`). Strip a single leading bullet so the
  // start-anchored header scan below sees the first [..] token, not the `- `.
  const s = String(finding).replace(/^\s*[-*+]\s+/, '')
  // Anchored to the start: skip zero or more [...] tokens that are NOT [P<n>]
  // (with optional whitespace between them), then match [P<n>]. A [P<n>]
  // appearing only in the body (after the title / ' -- ' separators) never
  // reaches this anchor and leaves the match null -> P1 (the fail-safe default).
  const m = /^\s*(?:\[(?!P[123])[^\]]*\]\s*)*\[P([123])\]/.exec(s)
  return m ? Number(m[1]) : 1
}

// findingKey(finding) -> the cross-round DEDUP key for a review finding:
// DIM (the leading [DIMENSION] bracket token) + file-path + normalized-title.
// NO :lines -- line numbers shift after a fix, so keying on them would make a
// re-raised-but-shifted finding look new. The title is normalized (lowercased,
// whitespace + punctuation stripped) so a re-raise that only differs in case or
// spacing still collides. PURE. Used by gatherFindings to drop a settled REJECT
// that the re-review re-raised in a later round under a shifted line/wording.
export function findingKey(finding) {
  // Reviewers emit each finding with a LEADING markdown list bullet per the
  // review contract (`- [<DIM>][P<n>]...`). Strip a single leading bullet so the
  // start-anchored title strip below sees the first [..] token, not the `- `.
  const s = String(finding).replace(/^\s*[-*+]\s+/, '')
  // DIM = the FIRST leading [..] bracket token (e.g. [BUG], [SLOP], [DRIFT]);
  // skip [P<n>] / [FIX:X] severity/tier tags which are not the dimension.
  const dimMatch = /\[(?!P[123]\])(?!FIX:)([^\]]+)\]/.exec(s)
  const dim = dimMatch ? dimMatch[1].trim().toLowerCase() : ''
  // file-path = the file token from the second ' -- ' segment of the review-contract
  // format (`<title> -- <file>:<lines> -- <alt> -- <why>`), with the trailing
  // :line(:col) stripped. Falls back to '' when the segment is absent or contains
  // no path token. This avoids an extension whitelist so .yaml/.toml/Dockerfile/
  // extensionless paths all produce a valid key.
  const parts = s.split(' -- ')
  const fileSeg = parts[1] ? parts[1].trim() : ''
  const pathMatch = fileSeg ? /^([\w./:-][^\s:]*?)(?::\d+(?::\d+)?)?$/.exec(fileSeg) : null
  const path = pathMatch ? pathMatch[1].toLowerCase() : ''
  // title = the short description in parts[0] after stripping ALL leading [...]
  // bracket tokens (DIM, severity, fix-tier). This is the CONTRACT TITLE -- the
  // stable human-readable label shared by a finding and its re-raises even when
  // :lines shift or the reviewer rephrases the 'why' tail. Using parts[last] (the
  // 'why') failed when a re-raise reworded the explanation: different 'why' text ->
  // different key -> settled REJECT not suppressed.
  const titleRaw = parts[0].replace(/^(?:\[[^\]]*\]\s*)+/, '').trim() || s
  const title = titleRaw.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return `${dim}|${path}|${title}`
}

// gatherFindings(...reviews[, settledKeys]) -> the open findings from a set of
// review lenses (codex + sonnet + any fallback). A reviewer that did NOT run
// (ran:false) is a verification gap, not a clean pass -- but it contributes no
// FINDINGS to fix; the degraded flag already surfaces the gap. Only
// ran-and-not-clean lenses contribute findings.
//
// The OPTIONAL trailing argument, when it is a Set, is settledKeys: the
// accumulated dedup keys of REJECTs the re-review has already ACCEPTED in a
// prior round. Any gathered finding whose findingKey is in that Set is DROPPED
// -- a settled REJECT cannot re-appear in a later round. Absent or empty Set
// drops nothing (back-compat: the legacy gatherFindings(...reviews) call shape).
export function gatherFindings(...reviews) {
  let settledKeys = null
  if (reviews.length && reviews[reviews.length - 1] instanceof Set) {
    settledKeys = reviews.pop()
  }
  const open = []
  for (const r of reviews) {
    if (r && r.ran && !r.clean && Array.isArray(r.findings)) open.push(...r.findings)
  }
  if (!settledKeys || settledKeys.size === 0) return open
  return open.filter((f) => !settledKeys.has(findingKey(f)))
}

export function fixLoopController(reviewFindings, fixerDispositions, attemptCount) {
  const openFindings = Array.isArray(reviewFindings) ? reviewFindings : []
  const attempts = Number(attemptCount) || 0

  // SEVERITY-FLOORED clean gate: terminate CLEAN when NO open finding is P1
  // (blocking). P2/P3 nits ride into the bundle for the COO go/no-go and never
  // force another fixer round; an empty list and an all-P2/P3 list both clear.
  // An untagged finding (and the synthetic [SUITE-RED] / [CODEX-REFIRE-GAP][P1]
  // integrity guards) is P1 -> blocks. Correct code is never churned: a REJECT
  // the re-review accepted is simply absent from openFindings.
  if (!openFindings.some((f) => findingSeverity(f) === 1)) {
    return { action: 'clean' }
  }

  // Open findings remain. If we have NOT yet hit the N=2 stop, dispatch the fixer
  // (another fix -> re-review round).
  if (attempts < FIX_LOOP_MAX_ATTEMPTS) {
    return { action: 'fix' }
  }

  // Deadlock: findings still open after N=2 fixer rounds. STOP -- no third patch
  // (the two-failed-attempts reset rule). Escalate to the COO with BOTH sides'
  // evidence so a hallucinated finding is not churned and a genuine stuck finding
  // is not silently dropped.
  return {
    action: 'escalate',
    escalation: {
      reviewerFindings: openFindings,
      fixerDispositions: Array.isArray(fixerDispositions) ? fixerDispositions : [],
    },
  }
}
