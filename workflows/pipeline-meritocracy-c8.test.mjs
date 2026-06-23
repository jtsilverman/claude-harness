// RED test for pipeline-meritocracy chunk 8: the chunk-2-ripple data-loss bug +
// the stale fixerFor doc clause the re-run Stage-2 ship review surfaced.
//
// THE LIVE DEFECT THIS PINS (Codex P2, learning-loop data loss): chunk 2 renamed the
// bundle field review.fixRounds -> review.judgeRounds (the per-fixer-round record now
// lives at bundle.review.judgeRounds[*].fixer.lessonCandidates, worker-pipeline.js
// :1321). But workflows/merge-chunk-lib.mjs fixerRoundCandidates STILL reads the dead
// review.fixRounds, so under the new pipeline every fixer-round RAW lessonCandidate is
// SILENTLY DROPPED from memory routing (chunk 6's fixer lessons already lost). The fix:
// read judgeRounds primary with a back-compat fallback to fixRounds so old archived
// sidecar bundles still route.
//
// Pins the FULL acceptance contract (dispatch payload chunk 8):
//   (a) [Codex P2 BUG] extractCandidates routes review.judgeRounds[*].fixer.lessonCandidates
//       (RED against the current dead-field read), AND back-compat: an old bundle carrying
//       review.fixRounds[*].fixer.lessonCandidates still routes, AND a bundle carrying BOTH
//       fields does NOT double-count, AND a bundle with NEITHER field contributes nothing
//       (builder-only unchanged).
//   (b) [low doc] coo-sop.md §6 fixerFor line names ONLY the fixer model/effort/fixTier --
//       no '+ re-review + Codex re-fire' clause (a path chunk 2 deleted) -- mirroring the
//       as-built language chunk 7 installed in review-contract.md §3.1 (the opus
//       meritocracy-judge re-checks each fixer round).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const builderCands = () => [
  { raw_lesson: 'builder-lesson-1', kind_hint: 'tactical-rule', provenance: 'c8-build' },
  { raw_lesson: 'builder-lesson-2', kind_hint: 'pattern', provenance: 'c8-build' },
]

// (a) PRIMARY PATH -- the new bundle shape. extractCandidates must walk
// review.judgeRounds[*].fixer.lessonCandidates. This FAILS against the current
// dead-field read (fixerRoundCandidates only knows review.fixRounds).
test('c8 (a): extractCandidates routes review.judgeRounds[*].fixer.lessonCandidates (new shape)', async () => {
  const lib = await import(new URL('./merge-chunk-lib.mjs', import.meta.url))
  const bundle = {
    green: { lessonCandidates: builderCands(), recallVerify: [] },
    review: {
      judgeRounds: [
        { fixer: { lessonCandidates: [{ raw_lesson: 'judge-fixer-lesson', kind_hint: 'failure', provenance: 'c8-fix' }] } },
      ],
    },
  }
  const batch = lib.extractCandidates(bundle)
  const raws = batch.lessonCandidates.map((c) => c.raw_lesson)
  assert.equal(
    batch.lessonCandidates.length,
    3,
    `extractCandidates must collect builder(2) + judgeRounds fixer(1) = 3; got ${batch.lessonCandidates.length}. ` +
      `Reading the dead review.fixRounds silently drops the fixer lesson under the chunk-2 judgeRounds shape.`,
  )
  assert.ok(raws.includes('judge-fixer-lesson'), 'the review.judgeRounds fixer lesson must ride the batch')
})

// (a) BACK-COMPAT -- old archived sidecar bundles still carry review.fixRounds.
// They MUST keep routing via the fallback.
test('c8 (a): extractCandidates still routes review.fixRounds[*].fixer.lessonCandidates (back-compat)', async () => {
  const lib = await import(new URL('./merge-chunk-lib.mjs', import.meta.url))
  const bundle = {
    green: { lessonCandidates: builderCands(), recallVerify: [] },
    review: {
      fixRounds: [
        { fixer: { lessonCandidates: [{ raw_lesson: 'legacy-fixer-lesson', kind_hint: 'failure', provenance: 'old-archive' }] } },
      ],
    },
  }
  const batch = lib.extractCandidates(bundle)
  const raws = batch.lessonCandidates.map((c) => c.raw_lesson)
  assert.equal(batch.lessonCandidates.length, 3, 'builder(2) + legacy fixRounds fixer(1) = 3 (back-compat fallback)')
  assert.ok(raws.includes('legacy-fixer-lesson'), 'the legacy review.fixRounds fixer lesson must still route')
})

// (a) EDGE: both fields present -- do NOT double-count. A bundle that carried both the
// new judgeRounds and a residual fixRounds must contribute each round's lessons once,
// not twice. The fix reads judgeRounds when present, fixRounds only as the fallback.
test('c8 (a): a bundle carrying BOTH judgeRounds and fixRounds does not double-count', async () => {
  const lib = await import(new URL('./merge-chunk-lib.mjs', import.meta.url))
  const bundle = {
    green: { lessonCandidates: builderCands(), recallVerify: [] },
    review: {
      judgeRounds: [
        { fixer: { lessonCandidates: [{ raw_lesson: 'judge-fixer-lesson', kind_hint: 'failure', provenance: 'c8-fix' }] } },
      ],
      fixRounds: [
        { fixer: { lessonCandidates: [{ raw_lesson: 'judge-fixer-lesson', kind_hint: 'failure', provenance: 'c8-fix' }] } },
      ],
    },
  }
  const batch = lib.extractCandidates(bundle)
  const raws = batch.lessonCandidates.map((c) => c.raw_lesson)
  assert.equal(
    batch.lessonCandidates.length,
    3,
    `both-fields bundle must yield builder(2) + fixer(1) = 3, NOT 4 (double-count); got ${batch.lessonCandidates.length}.`,
  )
  assert.equal(raws.filter((r) => r === 'judge-fixer-lesson').length, 1, 'the fixer lesson must appear exactly once')
})

// (a) EDGE: neither field -- builder-only bundle is unchanged (contributes nothing extra).
test('c8 (a): a bundle with neither judgeRounds nor fixRounds contributes nothing (builder-only)', async () => {
  const lib = await import(new URL('./merge-chunk-lib.mjs', import.meta.url))
  const bundle = { green: { lessonCandidates: builderCands(), recallVerify: [] }, review: {} }
  const batch = lib.extractCandidates(bundle)
  assert.equal(batch.lessonCandidates.length, 2, 'builder-only bundle stays at 2 lessonCandidates')
})

// (a) the stale code comments naming review.fixRounds as the PRIMARY read must be
// updated to name review.judgeRounds. The source must mention judgeRounds.
test('c8 (a): merge-chunk-lib.mjs source names review.judgeRounds (not only the dead fixRounds)', () => {
  const src = read('workflows/merge-chunk-lib.mjs')
  assert.match(
    src,
    /review\.judgeRounds/,
    'merge-chunk-lib.mjs must read/name review.judgeRounds (the chunk-2 field), not only the dead review.fixRounds.',
  )
})

// (b) coo-sop §6: fixerFor names ONLY the fixer dial -- no re-review / Codex re-fire clause.
test('c8 (b): coo-sop §6 fixerFor line drops the re-review + Codex re-fire clause', () => {
  const body = read('coo/coo-sop.md')
  // The fixerFor sentence must not claim it keys re-review or a Codex re-fire (chunk 2
  // deleted that path; fixerFor returns only {agentType, model, fixTier}).
  assert.doesNotMatch(
    body,
    /fixerFor[^.]*re-review/,
    `coo-sop §6 fixerFor still claims it keys 're-review'; chunk 2 deleted that path. fixerFor keys the fixer dial ONLY.`,
  )
  assert.doesNotMatch(
    body,
    /fixerFor[^.]*(Codex re-fire|re-fire)/,
    `coo-sop §6 fixerFor still claims it keys a 'Codex re-fire'; chunk 2 deleted that path.`,
  )
})
