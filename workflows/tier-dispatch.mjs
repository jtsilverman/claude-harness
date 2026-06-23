// Tier -> build-agent dispatch dial. Extracted from worker-pipeline.js so it is
// importable + unit-testable: worker-pipeline.js runs `await agent(...)` at top
// level, so importing that module would execute the pipeline. This module is
// pure data + pure selectors -- import-safe.
//
// SINGLE SOURCE OF TRUTH for the dial is coo/coo-sop.md § 6; this code and
// that section (and the tier context in disciplines/worker-discipline.md) must agree.
//
// TWO-TIER dial (pipeline-meritocracy chunk 1): the old four-tier S/A/B/C dial
// collapses to TWO tiers -- `default` and `heavy` -- with opus everywhere
// (aggressive models; the cheap-sonnet boilerplate lane and the rarely-needed max
// step are intentionally dropped, max moves off the build path to the ship-time
// redesigner). tierConfig returns a single { buildAgent, buildModel }.
//
//   default -> build-agent       (effort high,  model opus) <- the ~80% of chunks
//   heavy   -> build-agent-heavy  (effort xhigh, model opus) <- absorbs old A + break-glass S
//
// The mechanic (pattern claude-code-subagent-model-effort-and-ultracode): a
// subagent's reasoning EFFORT is set by the agent FILE's frontmatter, not by an
// inline dispatch opt -- there is no `effort` arg to agent(). So effort is dialed
// by SELECTING the effort-named build-agent file; `buildModel` stays the dispatch
// arg.
//
// LEGACY READS: old specs (and grader sessions) still carry S/A/B/C letters; they
// must keep resolving. A/S map to heavy, B/C (and an absent/unknown tier) map to
// default. So `normalizeTier` folds both vocabularies into the two live tiers.
export function normalizeTier(t) {
  switch (String(t || '').toUpperCase()) {
    case 'HEAVY':
    case 'A':
    case 'S': return 'heavy'
    // 'DEFAULT', 'B', 'C', and an absent/unknown tier all map to the default tier.
    default:  return 'default'
  }
}

export function tierConfig(t) {
  return normalizeTier(t) === 'heavy'
    ? { buildAgent: 'build-agent-heavy', buildModel: 'opus' }
    : { buildAgent: 'build-agent',       buildModel: 'opus' }
}

// The Sonnet chunk-reviewer (the full-scope all-four-dimensions lens) is
// tier-selectable (it stays sonnet for model diversity; only the effort scales).
// Effort is again frontmatter-only, so the selector picks the FILE: default -> base
// (effort high), heavy -> -heavy (effort xhigh). Legacy A/S -> -heavy, B/C -> base.
export function reviewerFor(t) {
  return normalizeTier(t) === 'heavy'
    ? { agentType: 'chunk-reviewer-heavy' }
    : { agentType: 'chunk-reviewer' }
}

// fixerFor(findings) dials the FIX-loop fixer by the FIX-tier -- the complexity /
// blast-radius of the FIX a reviewer recommends, taken as the MAX across all open
// findings -- NOT by the chunk tier (there is NO chunk-tier floor: a trivial fix on
// an S-chunk gets sonnet). Reviewers tag each finding with `[FIX:<C|B|A|S>]` per the
// rate-the-fix rubric in disciplines/review-contract.md (trivial=C, ordinary=B,
// complex-or-high-blast=A, extreme-or-irreversible=S). A finding with no parseable
// [FIX:] token defaults to B; an empty findings list yields fixTier B (a harmless
// guard -- the loop only dispatches a fixer when findings are non-empty).
//
// The dial folds the reviewer-recommended FIX rank into the two live tiers (opus
// everywhere): a complex/high-blast fix (legacy A/S, or `heavy`) -> fixer-heavy
// (opus/xhigh); everything else (legacy B/C, or `default`) -> fixer (opus/high).
// Reviewers still tag findings with `[FIX:<C|B|A|S>]` (the review-contract rubric);
// the MAX rank across findings sets the tier, then folds to default|heavy. Effort
// is frontmatter-only, so the agentType selects the FILE (which dials effort).
//   default -> fixer       (opus/high, the base)
//   heavy   -> fixer-heavy  (opus/xhigh)
const FIX_TIER_RANK = { C: 0, B: 1, A: 2, S: 3 }
const FIX_RANK_TIER = ['C', 'B', 'A', 'S']
export function fixerFor(findings) {
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
export function judgeFor(t) {
  return normalizeTier(t) === 'heavy'
    ? { agentType: 'meritocracy-judge-heavy' }
    : { agentType: 'meritocracy-judge' }
}
