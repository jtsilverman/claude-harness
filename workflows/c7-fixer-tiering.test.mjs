// RED test for lean-system-rebuild C7: fixer-tiering by FIX-tier.
//
// Pins the FULL acceptance contract for the chunk:
//   AC1 fixerFor single-tier  : C->{fixer-light,sonnet,C} B->{fixer,sonnet,B}
//                               A->{fixer-heavy,opus,A}   S->{fixer-heavy,opus,S}
//   AC2 fixerFor MAX-across    : mixed findings take the MAX (C<B<A<S)
//   AC3 fixerFor defaults      : untagged finding -> B; lowercase [fix:a] -> A; [] -> B
//   AC4 shouldRefireCodex      : REMOVED (the orphaned re-fire dial was deleted in chunk 9)
//   AC5 fixer variant files    : fixer-light (sonnet/low) + fixer-heavy (opus/high)
//                               bodies byte-identical to fixer.md's body
//   AC6 review-contract        : rate-the-fix rubric (all four tier->criterion) +
//                               section-3 finding line shows [FIX:<C|B|A|S>];
//                               no stale finding-line format WITHOUT the FIX token
//   AC7 lockstep + wiring       : worker-pipeline.js inline fixerFor byte-identical to
//                               tier-dispatch.mjs; fix-loop wires fixerFor(fixList).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// Import the selectors defensively: in the RED state the module does not yet
// export fixerFor, and a hard `import {..}` would be a module-load error that masks
// every other assertion. A namespace import lets the behavior tests fail on their
// OWN assertion (the selector is undefined), while the file-based AC5/AC6/AC7
// assertions still run and fail on their own.
import * as dispatch from './tier-dispatch.mjs'
const fixerFor = dispatch.fixerFor || (() => { throw new Error('fixerFor not exported from tier-dispatch.mjs') })

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENTS = join(__dirname, '..', 'agents')
const DISP_SRC = readFileSync(join(__dirname, 'tier-dispatch.mjs'), 'utf8')
const PIPE_SRC = readFileSync(join(__dirname, 'worker-pipeline.js'), 'utf8')
const CONTRACT = readFileSync(join(__dirname, '..', 'disciplines', 'review-contract.md'), 'utf8')

// A finding line in the review-contract format, with a given FIX tier.
const f = (tier) => `- [BUG][P1][FIX:${tier}] x -- a.js:1 -- worker -- why`

// --- AC1: fixerFor single-finding tier ---

// pipeline-meritocracy c1 folded the 4-tier fixer dial into 2 (default | heavy),
// opus everywhere: legacy C/B -> default (fixer/opus), legacy A/S -> heavy
// (fixer-heavy/opus). The [FIX:] rank parse + MAX-across logic is unchanged.
test('AC1: fixerFor single C -> fixer/opus/default (folds into default)', () => {
  assert.deepEqual(fixerFor([f('C')]), { agentType: 'fixer', model: 'opus', fixTier: 'default' })
})
test('AC1: fixerFor single B -> fixer/opus/default', () => {
  assert.deepEqual(fixerFor([f('B')]), { agentType: 'fixer', model: 'opus', fixTier: 'default' })
})
test('AC1: fixerFor single A -> fixer-heavy/opus/heavy', () => {
  assert.deepEqual(fixerFor([f('A')]), { agentType: 'fixer-heavy', model: 'opus', fixTier: 'heavy' })
})
test('AC1: fixerFor single S -> fixer-heavy/opus/heavy', () => {
  assert.deepEqual(fixerFor([f('S')]), { agentType: 'fixer-heavy', model: 'opus', fixTier: 'heavy' })
})

// --- AC2: fixerFor MAX across findings ---

test('AC2: [FIX:C]+[FIX:A] -> fixer-heavy/opus/heavy (MAX)', () => {
  assert.deepEqual(fixerFor([f('C'), f('A')]), { agentType: 'fixer-heavy', model: 'opus', fixTier: 'heavy' })
})
test('AC2: [FIX:B]+[FIX:S] -> fixer-heavy/opus/heavy (MAX)', () => {
  assert.deepEqual(fixerFor([f('B'), f('S')]), { agentType: 'fixer-heavy', model: 'opus', fixTier: 'heavy' })
})
test('AC2: all [FIX:C] -> fixer/opus/default', () => {
  assert.deepEqual(fixerFor([f('C'), f('C'), f('C')]), { agentType: 'fixer', model: 'opus', fixTier: 'default' })
})

// --- AC3: fixerFor defaults ---

test('AC3: untagged finding defaults to default tier', () => {
  assert.equal(fixerFor(['- [SLOP][P3] no fix token -- a.js:1 -- worker -- why']).fixTier, 'default')
})
test('AC3: lowercase [fix:a] parses as A -> heavy', () => {
  assert.deepEqual(fixerFor(['- [BUG][P1][fix:a] x -- a.js:1 -- worker -- why']),
    { agentType: 'fixer-heavy', model: 'opus', fixTier: 'heavy' })
})
test('AC3: empty findings list yields fixTier default', () => {
  assert.equal(fixerFor([]).fixTier, 'default')
})
test('AC3: untagged finding does not lower a tagged MAX (default B floors per-finding, not the list)', () => {
  // an untagged finding contributes B (-> default); a sibling [FIX:C] is lower, so MAX folds to default
  assert.equal(fixerFor([f('C'), '- [SLOP][P3] untagged -- a.js:1 -- worker -- why']).fixTier, 'default')
})

// --- AC4 (shouldRefireCodex) REMOVED: the orphaned re-fire dial was deleted in
// pipeline-meritocracy chunk 9 (zero live callers since chunk 2 deleted the Codex
// re-fire path). Its behavior + lockstep tests are gone with the function. ---

// --- AC5: fixer variant files exist, frontmatter dial, byte-identical body ---

// Extract everything AFTER the closing line of the frontmatter block (the 2nd '---').
function bodyAfterFrontmatter(src) {
  const lines = src.split('\n')
  let dashes = 0
  let i = 0
  for (; i < lines.length; i++) {
    if (lines[i] === '---') { dashes++; if (dashes === 2) { i++; break } }
  }
  return lines.slice(i).join('\n')
}
function frontmatter(src) {
  const lines = src.split('\n')
  let dashes = 0
  const fm = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---') { dashes++; if (dashes === 2) break; continue }
    if (dashes === 1) fm.push(lines[i])
  }
  return fm.join('\n')
}

const FIXER_BASE = readFileSync(join(AGENTS, 'fixer.md'), 'utf8')
const baseBody = bodyAfterFrontmatter(FIXER_BASE)

// pipeline-meritocracy c1: fixer-light deleted; opus everywhere. fixer = default
// (opus/high), fixer-heavy = heavy (opus/xhigh). Bodies stay byte-identical.
test('AC5: agents/fixer-light.md is deleted (the cheap-sonnet lane is dropped)', () => {
  assert.ok(!existsSync(join(AGENTS, 'fixer-light.md')),
    'fixer-light.md must be deleted (pipeline-meritocracy c1 collapsed to 2 fixer tiers)')
})

test('AC5: agents/fixer-heavy.md exists, frontmatter model:opus effort:xhigh, body byte-identical', () => {
  const src = readFileSync(join(AGENTS, 'fixer-heavy.md'), 'utf8')
  const fm = frontmatter(src)
  assert.match(fm, /^model:\s*opus\s*$/m, `fixer-heavy frontmatter must set model: opus. Got:\n${fm}`)
  assert.match(fm, /^effort:\s*xhigh\s*$/m, `fixer-heavy frontmatter must set effort: xhigh. Got:\n${fm}`)
  assert.equal(bodyAfterFrontmatter(src), baseBody,
    'fixer-heavy body (after frontmatter) must be byte-identical to fixer.md body')
})

test('AC5: base fixer.md is opus/high (the default fixer lane)', () => {
  const fm = frontmatter(FIXER_BASE)
  assert.match(fm, /^model:\s*opus\s*$/m)
  assert.match(fm, /^effort:\s*high\s*$/m)
})

// --- AC6: review-contract rubric + FIX token in section-3 format ---

test('AC6: review-contract has the rate-the-fix rubric (all four tier->criterion)', () => {
  // trivial/mechanical=C, ordinary=B, complex-or-high-blast=A, extreme-or-irreversible=S.
  // Each mapping must appear on the SAME rubric line, in either order (tier-then-
  // criterion or criterion-then-tier), so the rubric's prose layout is not pinned.
  const onSameLine = (re) => CONTRACT.split('\n').some((l) => re.test(l))
  assert.ok(onSameLine(/\bC\b.*trivial|trivial.*\bC\b/i), 'rubric must map trivial/mechanical <-> C')
  assert.ok(onSameLine(/\bB\b.*ordinary|ordinary.*\bB\b/i), 'rubric must map ordinary <-> B')
  assert.ok(onSameLine(/\bA\b.*(complex|high.?blast)|(complex|high.?blast).*\bA\b/i),
    'rubric must map complex/high-blast <-> A')
  assert.ok(onSameLine(/\bS\b.*(extreme|irreversible)|(extreme|irreversible).*\bS\b/i),
    'rubric must map extreme/irreversible <-> S')
})

test('AC6: section-3 finding-line format carries the [FIX:<C|B|A|S>] token', () => {
  assert.ok(CONTRACT.includes('[FIX:<C|B|A|S>]'),
    'section-3 finding line format must show the [FIX:<C|B|A|S>] token')
})

test('AC6: no stale finding-line format WITHOUT the FIX token remains (mirror-surface, stated once)', () => {
  // The old format line was `[<DIMENSION>][P<severity>] <title> ...` with NO [FIX:].
  // After the edit, any line carrying [<DIMENSION>][P<severity>] in a format-template
  // position must also carry [FIX:. Grep for the old template fragment lacking FIX.
  const stale = CONTRACT.split('\n').filter(
    (l) => l.includes('[<DIMENSION>][P<severity>]') && !l.includes('[FIX:'),
  )
  assert.equal(stale.length, 0,
    `stale finding-line format (no FIX token) still present:\n${stale.join('\n')}`)
})

// --- AC7: lockstep (byte-identical inline copies) + wiring (source inspection) ---

// Extract a named function's full source block (declaration through its closing
// brace at column 0). Both files declare these at top level, so a '}' at column 0
// terminates the block.
function fnBlock(src, decl) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.includes(decl))
  assert.notEqual(start, -1, `could not find "${decl}" in source`)
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n')
  }
  throw new Error(`no closing brace found for ${decl}`)
}

test('AC7: worker-pipeline fixerFor is byte-identical to tier-dispatch fixerFor (lockstep)', () => {
  const lib = fnBlock(DISP_SRC, 'function fixerFor').replace(/^export\s+/, '')
  const inline = fnBlock(PIPE_SRC, 'function fixerFor').replace(/^export\s+/, '')
  assert.equal(inline, lib, 'inline fixerFor must be byte-identical to the lib (minus export)')
})

test('AC7: the JUDGE -> FIX loop dispatches the fixer via fixerFor(fixList)', () => {
  // pipeline-meritocracy chunk 2: the OLD fix-loop dispatched fixerFor(openFindings);
  // the new judge loop dispatches the fixer on the JUDGE-CONFIRMED fixList, dialed by
  // fixerFor(fixList) (the MAX [FIX:] tier across the confirmed findings).
  assert.match(PIPE_SRC, /fixerFor\(fixList\)/,
    'the judge -> fix loop must compute the fixer dispatch from fixerFor(fixList) (the judge-confirmed findings)')
})

test('AC7: the fixer dial folds to a 2-tier agentType (fixer | fixer-heavy), opus everywhere', () => {
  // The fixerFor dial result drives the fixer agentType. Confirm the inlined dial still
  // returns the 2-tier fixer agents (the dial itself is unchanged by chunk 2; only the
  // call argument moved from openFindings to the judge's fixList).
  assert.match(PIPE_SRC, /agentType:\s*fixCfg\.agentType/,
    'the fixer dispatch must use the fixerFor-computed agentType (fixCfg.agentType)')
})

// --- codex-refire-gap mechanism REMOVED (pipeline-meritocracy chunk 2) ---
// The OLD fix-loop ran a Sonnet re-review + a guarded Codex re-fire each round, and the
// CODEX-REFIRE-GAP guard caught a null / ran:false refire as a verification gap. The new
// architecture replaces the Sonnet re-review + Codex re-fire with the opus MERITOCRACY-
// JUDGE re-check (P5), and the judge's own FAIL-CLOSED gap (judgeDecision -> 'gap' on an
// unreachable/errored judge) is the new "verification incomplete -> never silent CLEAN"
// guard. So the codex-refire-gap source-inspection tests are obsoleted by the rewire; the
// gap-on-incomplete-verification invariant is now pinned by the judge fail-closed tests in
// pipeline-meritocracy-c2.test.mjs (AC7: judge ERROR/missing verdict -> 'gap', never clean).

test('codex-refire-gap REMOVED: the deleted re-review + codex-refire machinery is absent from worker-pipeline.js', () => {
  // REPLACE-means-ABSENT: confirm the obsoleted machinery is gone, not merely that the
  // judge was added alongside it.
  assert.ok(!/codexRefire/.test(PIPE_SRC),
    'worker-pipeline.js must NOT keep the codexRefire re-fire (the judge re-check replaces the Sonnet re-review + Codex re-fire)')
  assert.ok(!/CODEX-REFIRE-GAP/.test(PIPE_SRC),
    'worker-pipeline.js must NOT keep the CODEX-REFIRE-GAP guard (the judge fail-closed gap replaces it)')
})

test('codex-refire-gap REPLACED: the judge fail-closed gap is the new verification-incomplete guard', () => {
  // The fail-closed invariant now lives in the inlined judgeDecision: a missing/invalid
  // verdict returns action 'gap', and the pipeline maps a gap to a non-clean terminal.
  assert.match(PIPE_SRC, /action:\s*'gap'/,
    'judgeDecision must return action gap on a fail-closed (unreachable/errored) judge -- the new verification-incomplete guard')
  assert.match(PIPE_SRC, /judgeGap/,
    'the pipeline must route the judge gap (judgeGap) to a non-clean terminal, never a silent CLEAN')
})

test('AC4 (codex-refire-gap): initial-review degraded path (codexReview.ran===false, ~line 671) is unchanged (source inspection)', () => {
  // The initial-review outage path uses codexReview.ran === false to set degraded=true
  // and trigger the Sonnet fallback. This chunk must NOT modify that path.
  // Verify the exact condition still exists in source (it was there before; must remain).
  const hasInitialPath = /codexReview\.ran\s*===?\s*false/.test(PIPE_SRC)
  assert.ok(hasInitialPath,
    'worker-pipeline.js initial-review degraded path (codexReview.ran===false) must be present and unchanged')
  // Also verify it is distinct from the refire guard — initial uses codexReview, refire uses codexRefire
  const initialLine = PIPE_SRC.split('\n').find(l => /codexReview\.ran\s*===?\s*false/.test(l))
  assert.ok(initialLine && !initialLine.includes('codexRefire'),
    `initial-review path line must reference codexReview (not codexRefire). Line: ${initialLine}`)
})
