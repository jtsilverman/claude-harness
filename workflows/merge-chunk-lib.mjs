// merge-chunk-lib.mjs -- PURE, importable helpers + the memory-agent dispatch
// schema for the cockpit's candidate-routing step (three-loop-rebuild chunk C9,
// narrowed to routing by reset-or-decompose; the merge-chunk.js Workflow wrapper
// was DELETED by coo-simplification chunk 2, which folded its extract+dispatch
// directly into the cockpit merge step).
//
// The git dance (rebase chunk onto feat, fast-forward merge, suite run, cleanup)
// is the COO's reliable Bash recipe. The candidate routing is now a DIRECT
// memory-agent dispatch the cockpit fires after the recipe lands (cockpit
// SKILL.md ## Merge), reusing the tested logic and schema below -- no Workflow hop.
//
// Exports, all side-effect-free:
//   - extractCandidates(bundle)        -> the memory-agent batch.
//   - candidateCount(batch)            -> total routable items in a batch.
//   - memoryAgentSchema                -> the load-bearing dispatch output schema.
//   - buildMemoryAgentPrompt(batch, scope) -> the dispatch prompt.

// fixerRoundCandidates -- collect lessonCandidates from every fixer round in the
// bundle's review.judgeRounds array. A chunk that went through the internal fix-loop
// produces FIXER-round RAW lessons at bundle.review.judgeRounds[*].fixer.lessonCandidates
// (worker-pipeline FIXER_RESULT; the field pipeline-meritocracy chunk 2 renamed from
// review.fixRounds). Those must ride the routed batch too, else fix-loop lessons are
// silently dropped -- the exact failure C9 exists to prevent. We READ them defensively;
// a bundle with neither field simply contributes nothing.
//
// BACK-COMPAT: old archived sidecar bundles still carry review.fixRounds. Read
// judgeRounds when present, else fall back to fixRounds, so legacy bundles keep
// routing. A bundle carrying BOTH reads judgeRounds only -- no double-count.
function fixerRoundCandidates(bundle) {
  const review = bundle && typeof bundle === 'object' ? bundle.review : null
  const rounds = review && Array.isArray(review.judgeRounds)
    ? review.judgeRounds
    : (review && Array.isArray(review.fixRounds) ? review.fixRounds : [])
  const out = []
  for (const round of rounds) {
    const fixer = round && typeof round === 'object' ? round.fixer : null
    const cands = fixer && Array.isArray(fixer.lessonCandidates) ? fixer.lessonCandidates : []
    for (const c of cands) out.push(c)
  }
  return out
}

// extractCandidates -- assemble the memory-agent batch from a worker bundle:
// every lessonCandidate verbatim, PLUS every recallVerify verdict that is NOT
// 'applies' (an 'applies' verdict is the healthy default -- nothing to route; a
// 'stale'/'contradicted' verdict is routed as an obsolescence action naming its
// target entry).
//
// REAL BUNDLE SHAPE: the worker-pipeline final bundle wraps the BUILD_RESULT
// under `green` ({ chunkId, worktree, green: <BUILD_RESULT>, review, status }).
// lessonCandidates and recallVerify live in BUILD_RESULT, so the real paths are
// bundle.green.lessonCandidates and bundle.green.recallVerify. For backward
// compat (direct flat bundles in tests / legacy callers), fall back to the
// top-level fields when `green` is absent.
//
// FIXER-ROUND LESSONS (C-F2): a chunk that went through the internal fix-loop ALSO
// produces FIXER-round RAW lessons at bundle.review.judgeRounds[*].fixer.lessonCandidates
// (the field chunk 2 renamed from review.fixRounds; fixerRoundCandidates falls back to
// the old name for legacy bundles). Those must ride the routed batch too, else fix-loop
// lessons are silently dropped. We READ them defensively; a bundle with neither field adds nothing.
export function extractCandidates(bundle) {
  const b = bundle && typeof bundle === 'object' ? bundle : {}
  // Read from the real bundle shape (bundle.green) first; fall back to top-level
  // for test fixtures and legacy direct callers.
  const src = (b.green && typeof b.green === 'object') ? b.green : b
  const builderCandidates = Array.isArray(src.lessonCandidates) ? src.lessonCandidates : []
  // Fixer-round candidates ride the same batch. Defensive read: a bundle with no
  // judgeRounds/fixRounds adds nothing, so builder-only bundles are byte-identical in result.
  const lessonCandidates = builderCandidates.concat(fixerRoundCandidates(b))
  const recallVerifyAll = Array.isArray(src.recallVerify) ? src.recallVerify : []
  const recallVerify = recallVerifyAll.filter(
    (v) => v && v.verdict && String(v.verdict).toLowerCase() !== 'applies',
  )
  return { lessonCandidates, recallVerify }
}

// candidateCount -- the number of routable items in a batch (lessonCandidates plus
// non-applies recallVerify). Zero means there is nothing to dispatch.
export function candidateCount(batch) {
  const b = batch && typeof batch === 'object' ? batch : {}
  const lc = Array.isArray(b.lessonCandidates) ? b.lessonCandidates.length : 0
  const rv = Array.isArray(b.recallVerify) ? b.recallVerify.length : 0
  return lc + rv
}

// memoryAgentSchema -- the LOAD-BEARING schema for the cockpit's direct
// memory-agent dispatch (folded in from the deleted merge-chunk.js Workflow
// wrapper by coo-simplification chunk 2). Without it the memory-agent's structured
// output is unconstrained and the agent() global returns its final TEXT (a string),
// so `Array.isArray(ack.dispositions)` is FALSE and the cockpit gets dispositions:[]
// on every live run -- never the structured per-candidate audit trail. The schema
// forces a structured { dispositions: [...] } ack.
//
// items is a oneOf of TWO concrete shapes so the schema constrains actual output
// (an arbitrary {} satisfies neither branch):
//   memory-ack  : { disposition: string (required), entry_id: string|null }
//   wiki-route  : { route: 'wiki' (required), draft?: string, page?: string }
// (agents/memory-agent.md: wiki-routed candidates return as drafted pages for the
// COO to write inline; they do NOT write the vault themselves.)
export const memoryAgentSchema = {
  type: 'object',
  required: ['dispositions'],
  additionalProperties: true,
  properties: {
    dispositions: {
      type: 'array',
      description: 'one per routed candidate: memory ack OR wiki-route ack (agents/memory-agent.md)',
      items: {
        oneOf: [
          {
            type: 'object',
            description: 'memory ack: the memory-agent wrote or reconciled a memory entry',
            required: ['disposition'],
            additionalProperties: true,
            properties: {
              disposition: { type: 'string', description: 'wrote_new | merged_into:<id> | superseded:<id> | dropped_dup' },
              entry_id: { type: ['string', 'null'], description: 'the id written or modified; null for dropped_dup' },
            },
          },
          {
            type: 'object',
            description: 'wiki-route ack: the memory-agent routed this candidate to the wiki',
            required: ['route'],
            additionalProperties: true,
            properties: {
              route: { type: 'string', enum: ['wiki'], description: "'wiki' for a wiki-routed candidate" },
              draft: { type: 'string', description: 'the drafted wiki page content' },
              page: { type: 'string', description: 'the target wiki page path' },
            },
          },
        ],
      },
    },
  },
}

// buildMemoryAgentPrompt -- the prompt the cockpit's direct memory-agent dispatch
// carries (folded in from the deleted wrapper). agents/memory-agent.md is
// authoritative for routing, reconcile, scope, and serialization; this prompt only
// hands the agent its scope and the RAW batch.
export function buildMemoryAgentPrompt(batch, scope) {
  return [
    `You are the memory-agent. Reconcile + write the store for this merged chunk's`,
    `RAW lesson candidates and obsolescence verdicts. agents/memory-agent.md is`,
    `authoritative for routing, reconcile, scope, and serialization.`,
    ``,
    `Scope: ${scope || 'global'}`,
    `Batch (RAW lessonCandidates + non-applies recallVerify obsolescence actions):`,
    JSON.stringify(batch, null, 2),
  ].join('\n')
}
