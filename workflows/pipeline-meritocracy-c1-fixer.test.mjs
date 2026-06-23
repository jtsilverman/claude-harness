// Fixer RED tests for pipeline-meritocracy chunk 1 findings:
//   F1 (P1): codexFires must use normalizeTier (not raw uppercased tier string)
//            so 'default'/'heavy' new-vocab chunks fire the Codex gate.
//   F2 (P1): codexLensPrompt must pass a supported --tier value (S|A|B|C) to
//            codex-review.sh; passing 'default'/'heavy' causes exit 2 and a
//            ran:false outage on every new-vocab chunk.
//   F3 (BUG/P2): same root as F1 -- duplicate of the static-source angle.
//   F4 (SLOP/P3): stale meta.detail strings reference the old 4-tier vocabulary.
//
// Run: node --test workflows/pipeline-meritocracy-c1-fixer.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')
const PIPELINE = read('workflows/worker-pipeline.js')

// --- F1/F3: codexFires must use normalizeTier, not a raw tier string comparison ---
// The old codexFires = tier === 'A' || tier === 'S' || tier === 'B' is broken after
// the 2-tier collapse: `tier` is uppercased (e.g. 'DEFAULT', 'HEAVY') but not
// normalized, so both new-vocab values fail the check and Codex silently skips.
// Fix: codexFires must route through normalizeTier so new-vocab chunks fire correctly.

test('F1/F3: codexFires must not use a raw old-vocab tier literal check (tier === A/S/B)', () => {
  // The old gate `tier === 'A' || tier === 'S' || tier === 'B'` is the broken form:
  // it can never match 'DEFAULT' or 'HEAVY'. If this literal pattern is present,
  // the gate is broken for all new-vocab chunks dispatched after chunk 1 merges.
  const hasBrokenGate = /const codexFires\s*=\s*tier\s*===\s*'[ASB]'/.test(PIPELINE)
  assert.equal(
    hasBrokenGate,
    false,
    'codexFires must NOT use raw tier === A/S/B literals; ' +
    'after the 2-tier collapse, `tier` is uppercased (DEFAULT/HEAVY) and those literals never match. ' +
    'Use normalizeTier(tier) to gate correctly.',
  )
})

test('F1/F3: codexFires must use normalizeTier (so new-vocab default/heavy tiers fire Codex)', () => {
  // The correct gate uses normalizeTier to fold any input (DEFAULT, HEAVY, A, S, B, C,
  // '') into 'default' or 'heavy' before deciding. The simplest correct form:
  //   const codexFires = true  (both tiers have a Codex lens per coo-sop §6)
  // or a normalizeTier-based check:
  //   const normT = normalizeTier(tier); const codexFires = normT === 'default' || normT === 'heavy'
  // Either way, `normalizeTier` must appear in the codexFires expression or the
  // expression must be trivially true (both tiers fire). We assert: the source
  // does NOT use the old broken `tier === 'A' || tier === 'S' || tier === 'B'`
  // pattern AND the Codex gate is either `true` or involves normalizeTier.
  //
  // Locate the codexFires assignment:
  const m = PIPELINE.match(/const codexFires\s*=\s*([^\n]+)/)
  assert.ok(m, 'could not locate `const codexFires = ...` in worker-pipeline.js')
  const expr = m[1]
  // Must not be the broken raw-literal check:
  const isBroken = /tier\s*===\s*'[ASB]'/.test(expr) || /tier\s*===\s*'[asb]'/.test(expr)
  assert.equal(isBroken, false,
    `codexFires expression "${expr.trim()}" still uses raw old-vocab tier literals; must use normalizeTier`)
  // Must be either `true` (both tiers fire) or reference normalizeTier:
  const isCorrect = expr.trim() === 'true' || /normalizeTier/.test(expr)
  assert.equal(isCorrect, true,
    `codexFires expression "${expr.trim()}" must be \`true\` or use normalizeTier(tier) -- raw tier literals miss new-vocab chunks`)
})

// --- F2 (P1): codexLensPrompt must map tier to a supported codex-review.sh --tier value ---
// codex-review.sh tier_config() accepts only S|A|B|C (or empty for the pre-tier default).
// After the 2-tier collapse, passing 'default' or 'heavy' directly causes exit 2
// ("codex-review: unknown tier default") -> ran:false -> Codex degraded on EVERY
// new-vocab chunk. Fix: a codexTierArg (or equivalent mapping) must translate the
// normalized two-tier vocabulary to legacy codex-review.sh values before the --tier arg.

test('F2: codex-review.sh --tier must receive a supported value (S|A|B|C or empty), not new-vocab labels', () => {
  // The codexLensPrompt function builds the shell command containing `--tier ${tierArg}`.
  // The tierArg must be a legacy codex-review.sh tier (S|A|B|C) or empty string.
  // If the function accepts the raw `tier` var ('DEFAULT', 'HEAVY') or the fixTier
  // labels ('default', 'heavy') directly as tierArg, codex-review.sh exits 2.
  //
  // Assert: when the fix is in place, the pipeline source must include a translation
  // step between the 2-tier vocabulary and the codex-review.sh argument.
  // We check that a function/helper mapping 'heavy'/'default' to 'S'/'B' (or similar)
  // exists in the source, OR that the codexLensPrompt default parameter is NOT `tier`
  // (the raw uppercased var) but rather a translated value.
  //
  // The simplest structural probe: a mapping function or inline translation that maps
  // 'heavy' -> 'S' and 'default' -> 'B' must appear in the pipeline source.
  const hasMapping = /heavy.*['":].*S|['":]S.*heavy/s.test(PIPELINE) &&
                     /default.*['":].*B|['":]B.*default/s.test(PIPELINE)
  // Alternatively, the codexLensPrompt default may be changed from `tierArg = tier`
  // to use a translation helper. Either way, the raw-tier passthrough must be gone.
  // We test: there must be no case where 'DEFAULT' or 'HEAVY' (uppercased literals that
  // tier = String(a.tier||'').toUpperCase() yields) can arrive at --tier without translation.
  //
  // Locate codexLensPrompt and assert it doesn't accept 'DEFAULT'/'HEAVY' raw:
  const fnMatch = PIPELINE.match(/function codexLensPrompt\([\s\S]*?\n\}/)
  assert.ok(fnMatch, 'codexLensPrompt function not found in worker-pipeline.js')
  const fnSrc = fnMatch[0]
  // The --tier injection line: `${tierArg ? ` --tier ${tierArg}` : ''}`.
  // If tierArg is 'DEFAULT'/'HEAVY', codex-review.sh exits 2.
  // The fix must ensure tierArg is always mapped to S|A|B|C|'' before reaching here.
  // We assert: either the default param for tierArg is no longer `tier` (the raw var),
  // or a codexTierArg mapping function exists in the pipeline source.
  const stillRawDefault = /function codexLensPrompt\([^)]*tierArg\s*=\s*tier[^)]*\)/.test(fnSrc)
  const hasCodexTierArgHelper = /codexTierArg\s*\(/.test(PIPELINE)
  // If still using raw `tier` as default AND no mapping helper exists, the bug persists.
  assert.equal(
    stillRawDefault && !hasCodexTierArgHelper,
    false,
    'codexLensPrompt still defaults tierArg to raw `tier` (which can be "DEFAULT"/"HEAVY") ' +
    'with no codexTierArg mapping helper. codex-review.sh rejects these values (exit 2, ran:false). ' +
    'Add a codexTierArg(t) -> S|A|B|C|"" translator and use it as the default.',
  )
})

test('F2: codexTierArg helper or equivalent maps heavy -> S, default -> B for codex-review.sh', () => {
  // If the fix uses a named codexTierArg helper (the expected approach), assert it
  // maps the two-tier vocabulary to supported codex-review.sh tier values.
  // If no such helper exists yet, this test probes the source for the mapping.
  const hasCodexTierArgHelper = /function codexTierArg/.test(PIPELINE)
  if (!hasCodexTierArgHelper) {
    // No helper yet; assert the mapping is present inline in codexLensPrompt or the
    // fix-loop call site. This will fail if neither the helper nor an inline mapping
    // exists -- which is the current broken state.
    assert.ok(hasCodexTierArgHelper,
      'codexTierArg() helper not found in worker-pipeline.js. ' +
      'The fix requires a codexTierArg(t) function that maps: heavy -> "S", default -> "B", absent -> "" ' +
      'so codex-review.sh --tier receives only supported values (S|A|B|C or empty).')
  }
  // Helper exists; assert it maps correctly via the source text.
  const idx = PIPELINE.indexOf('function codexTierArg')
  assert.ok(idx !== -1, 'codexTierArg not found after helper existence check')
  const window = PIPELINE.slice(idx, idx + 400)
  assert.match(window, /heavy.*'S'|'S'.*heavy/s,
    "codexTierArg must map 'heavy' -> 'S' (gpt-5.5/xhigh per coo-sop §6 Codex column)")
  assert.match(window, /default.*'B'|'B'.*default/s,
    "codexTierArg must map 'default' -> 'B' (gpt-5.4-mini/medium per coo-sop §6 Codex column)")
})

// --- F4 (SLOP/P3): stale meta.detail strings must be updated to 2-tier vocabulary ---

test('F4 SLOP: meta BUILD detail must not reference the old A/S|B/C model split', () => {
  // The old string 'opus (A/S) | sonnet (B/C)' describes the old 4-tier model split.
  // After the 2-tier collapse (opus everywhere), it is dead and misleading.
  assert.doesNotMatch(
    PIPELINE,
    /opus \(A\/S\) \| sonnet \(B\/C\)/,
    'meta BUILD detail still says "opus (A/S) | sonnet (B/C)"; after 2-tier collapse it should say "opus everywhere" (or similar)',
  )
})

test('F4 SLOP: meta REVIEW detail must not reference old 4-tier Codex cost-gate language', () => {
  // The old strings 'cost-gated to Tier A/S/B, C+absent skip' and
  // 'Tier-S-ONLY opus adversarial lens' and 'opus (adversarial, Tier S)'
  // reference the 4-tier vocabulary and are dead after the 2-tier collapse.
  assert.doesNotMatch(
    PIPELINE,
    /cost-gated to Tier A\/S\/B, C\+absent skip/,
    'meta REVIEW detail still references old 4-tier Codex cost-gate language',
  )
  assert.doesNotMatch(
    PIPELINE,
    /Tier-S-ONLY opus adversarial lens/,
    'meta REVIEW detail still references "Tier-S-ONLY" (old 4-tier vocabulary)',
  )
  assert.doesNotMatch(
    PIPELINE,
    /opus \(adversarial, Tier S\)/,
    'meta REVIEW detail still references "Tier S" old vocabulary',
  )
})
