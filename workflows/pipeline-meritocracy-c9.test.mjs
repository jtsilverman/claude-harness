// RED test for pipeline-meritocracy chunk 9: tier-scale the meritocracy-judge effort
// (the Codex P2 ship-gate finding) + delete the orphaned shouldRefireCodex dead code.
//
// THE LIVE DEFECT THIS PINS (Codex P2, spec req #6): chunk 2 dispatched the judge with
// the hardcoded `agentType: 'meritocracy-judge'` string + `model: tierCfg.buildModel`
// (opus) and NO effort. Effort rides the agent FILE's frontmatter (the subagent-effort
// mechanic), and only agents/meritocracy-judge.md (opus/high) exists -- so the HEAVY
// judge runs opus/HIGH, not the spec-required opus/xhigh. The fix mirrors the
// build-agent / reviewer / fixer pattern: a judgeFor(tier) selector that picks the
// effort-named FILE, a meritocracy-judge-heavy.md (opus/xhigh, byte-identical body),
// and both judge dispatch sites routed through judgeFor(tier).agentType.
//
// Pins the FULL acceptance contract (dispatch payload chunk 9):
//   AC1 judgeFor(tier)        : default -> {agentType:'meritocracy-judge'};
//                              heavy -> {agentType:'meritocracy-judge-heavy'};
//                              legacy A/S -> heavy, B/C/absent -> default (normalizeTier-folded)
//   AC2 -heavy agent file     : agents/meritocracy-judge-heavy.md exists, model:opus effort:xhigh,
//                              body byte-identical to meritocracy-judge.md minus frontmatter
//   AC3 both judge sites       : both worker-pipeline.js judge dispatch sites use judgeFor(tier).agentType
//   AC4 precheck enumeration   : heavy enumerates meritocracy-judge-heavy; default still meritocracy-judge
//   AC5 shouldRefireCodex gone : absent from tier-dispatch.mjs + worker-pipeline.js (grep clean of live callers)
//   AC6 lockstep byte-parity   : worker-pipeline.js inline judgeFor byte-identical to tier-dispatch.mjs (minus export)
//   AC7 description fix         : meritocracy-judge.md description no longer claims 'via the dispatch'
//   AC8 0 em-dashes across every touched file

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// Namespace import: in the RED state judgeFor is not yet exported, so a hard named
// import would be a module-load error that masks every other assertion. The namespace
// form keeps each behavior assertion failing on its OWN line.
import * as dispatch from './tier-dispatch.mjs'
const judgeFor = dispatch.judgeFor || (() => { throw new Error('judgeFor not exported from tier-dispatch.mjs') })

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const AGENTS = join(ROOT, 'agents')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const DISP_SRC = read('workflows/tier-dispatch.mjs')
const PIPE_SRC = read('workflows/worker-pipeline.js')

// --- AC1: judgeFor(tier) selects the effort-named judge FILE ---

test('AC1: judgeFor(default) -> meritocracy-judge', () => {
  assert.equal(judgeFor('default').agentType, 'meritocracy-judge')
})
test('AC1: judgeFor(heavy) -> meritocracy-judge-heavy', () => {
  assert.equal(judgeFor('heavy').agentType, 'meritocracy-judge-heavy')
})
test('AC1: legacy A/S fold to heavy (meritocracy-judge-heavy)', () => {
  assert.equal(judgeFor('A').agentType, 'meritocracy-judge-heavy')
  assert.equal(judgeFor('S').agentType, 'meritocracy-judge-heavy')
})
test('AC1: legacy B/C and absent/unknown fold to default (meritocracy-judge)', () => {
  assert.equal(judgeFor('B').agentType, 'meritocracy-judge')
  assert.equal(judgeFor('C').agentType, 'meritocracy-judge')
  assert.equal(judgeFor(null).agentType, 'meritocracy-judge')
  assert.equal(judgeFor(undefined).agentType, 'meritocracy-judge')
  assert.equal(judgeFor('nonsense').agentType, 'meritocracy-judge')
})
test('AC1: the judge model stays opus on BOTH tiers (only effort changes via the file)', () => {
  // Edge: judgeFor selects the FILE (which dials effort); the dispatch model is opus
  // everywhere. judgeFor returns an agentType only -- it must NOT downgrade the model.
  // Confirm the dispatch model literal at the judge sites is tierCfg.buildModel (opus),
  // NOT a per-tier model branch.
  assert.match(PIPE_SRC, /agentType:\s*judgeFor\(tier\)\.agentType,\s*model:\s*tierCfg\.buildModel/,
    'the judge dispatch must keep model: tierCfg.buildModel (opus) -- judgeFor scales effort via the file, not the model')
})

// --- AC2: agents/meritocracy-judge-heavy.md exists, frontmatter dial, byte-identical body ---

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
// Body = everything AFTER the 2nd '---' (the frontmatter close).
function bodyAfterFrontmatter(src) {
  const lines = src.split('\n')
  let dashes = 0
  let i = 0
  for (; i < lines.length; i++) {
    if (lines[i] === '---') { dashes++; if (dashes === 2) { i++; break } }
  }
  return lines.slice(i).join('\n')
}

test('AC2: agents/meritocracy-judge-heavy.md exists', () => {
  assert.ok(existsSync(join(AGENTS, 'meritocracy-judge-heavy.md')),
    'agents/meritocracy-judge-heavy.md must exist (the heavy-tier judge file dials opus/xhigh)')
})
test('AC2: meritocracy-judge-heavy.md frontmatter is model:opus effort:xhigh', () => {
  const fm = frontmatter(read('agents/meritocracy-judge-heavy.md'))
  assert.match(fm, /^model:\s*opus\s*$/m, `meritocracy-judge-heavy must set model: opus. Got:\n${fm}`)
  assert.match(fm, /^effort:\s*xhigh\s*$/m, `meritocracy-judge-heavy must set effort: xhigh. Got:\n${fm}`)
})
test('AC2: meritocracy-judge-heavy.md body is byte-identical to meritocracy-judge.md (minus frontmatter)', () => {
  const baseBody = bodyAfterFrontmatter(read('agents/meritocracy-judge.md'))
  const heavyBody = bodyAfterFrontmatter(read('agents/meritocracy-judge-heavy.md'))
  assert.equal(heavyBody, baseBody,
    'meritocracy-judge-heavy body (after frontmatter) must be byte-identical to meritocracy-judge.md body')
})
test('AC2: base meritocracy-judge.md stays opus/high (the default judge lane)', () => {
  const fm = frontmatter(read('agents/meritocracy-judge.md'))
  assert.match(fm, /^model:\s*opus\s*$/m)
  assert.match(fm, /^effort:\s*high\s*$/m)
})

// --- AC3: BOTH judge dispatch sites route through judgeFor(tier).agentType ---

test('AC3: both worker-pipeline.js judge dispatch sites use judgeFor(tier).agentType', () => {
  // The initial P2 adjudication (label judge:) AND the P5 re-check (label judge-recheck:)
  // must each dispatch agentType: judgeFor(tier).agentType -- exactly two occurrences.
  const sites = [...PIPE_SRC.matchAll(/agentType:\s*judgeFor\(tier\)\.agentType/g)]
  assert.equal(sites.length, 2,
    `expected EXACTLY 2 judge dispatch sites using judgeFor(tier).agentType (P2 + P5), found ${sites.length}`)
})
test('AC3: no hardcoded judge dispatch literal survives at the dispatch sites', () => {
  // The hardcoded `agentType: 'meritocracy-judge'` string must no longer appear as a
  // DISPATCH literal. It may survive only inside the judgeFor selector body (the return
  // value). So a `label: 'judge...'`-adjacent hardcoded literal is the smell. Pin the
  // negative: no `agentType: 'meritocracy-judge', model: tierCfg.buildModel` dispatch line.
  assert.ok(!/agentType:\s*'meritocracy-judge',\s*model:\s*tierCfg\.buildModel/.test(PIPE_SRC),
    'the judge dispatch must NOT keep the hardcoded agentType: \'meritocracy-judge\' literal -- route it through judgeFor(tier).agentType')
})

// --- AC4: precheck enumerates the right judge file per tier ---

test('AC4: expectedAgentTypesForTier(heavy) enumerates meritocracy-judge-heavy, not the base judge', async () => {
  const { expectedAgentTypesForTier } = await import('./agenttype-precheck.mjs')
  const types = expectedAgentTypesForTier('heavy')
  assert.ok(types.includes('meritocracy-judge-heavy'),
    `heavy tier precheck must enumerate meritocracy-judge-heavy. Got: [${types.join(', ')}]`)
  assert.ok(!types.includes('meritocracy-judge'),
    `heavy tier precheck must NOT enumerate the base meritocracy-judge (the judge is now chunk-tier-matched). Got: [${types.join(', ')}]`)
})
test('AC4: expectedAgentTypesForTier(default) still enumerates meritocracy-judge (not -heavy)', async () => {
  const { expectedAgentTypesForTier } = await import('./agenttype-precheck.mjs')
  const types = expectedAgentTypesForTier('default')
  assert.ok(types.includes('meritocracy-judge'),
    `default tier precheck must still enumerate meritocracy-judge. Got: [${types.join(', ')}]`)
  assert.ok(!types.includes('meritocracy-judge-heavy'),
    `default tier precheck must NOT enumerate meritocracy-judge-heavy. Got: [${types.join(', ')}]`)
})

// --- AC5: shouldRefireCodex deleted from BOTH lockstep copies (grep clean of live callers) ---

test('AC5: shouldRefireCodex is absent from tier-dispatch.mjs', () => {
  assert.ok(!/shouldRefireCodex/.test(DISP_SRC),
    'shouldRefireCodex must be deleted from tier-dispatch.mjs (orphaned dead code, zero live callers)')
})
test('AC5: shouldRefireCodex is absent from worker-pipeline.js', () => {
  assert.ok(!/shouldRefireCodex/.test(PIPE_SRC),
    'shouldRefireCodex must be deleted from the worker-pipeline.js inline lockstep copy + its narrating comment')
})

// --- AC6: judgeFor inline lockstep byte-parity (the surviving-fn lockstep invariant) ---

// Extract a named top-level function block: declaration line through the first '}' at column 0.
function fnBlock(src, decl) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.includes(decl))
  assert.notEqual(start, -1, `could not find "${decl}" in source`)
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n')
  }
  throw new Error(`no closing brace found for ${decl}`)
}

test('AC6: worker-pipeline judgeFor is byte-identical to tier-dispatch judgeFor (lockstep, minus export)', () => {
  const lib = fnBlock(DISP_SRC, 'function judgeFor').replace(/^export\s+/, '')
  const inline = fnBlock(PIPE_SRC, 'function judgeFor').replace(/^export\s+/, '')
  assert.equal(inline, lib, 'inline judgeFor must be byte-identical to the lib (minus export)')
})

test('AC6: the surviving lockstep fns stay byte-identical across both copies', () => {
  // Mirror-surface: deleting shouldRefireCodex from one copy only would break parity.
  // Confirm every SURVIVING lockstep function is still byte-identical between the two files.
  for (const decl of ['function normalizeTier', 'function tierConfig', 'function reviewerFor', 'function fixerFor', 'function judgeFor']) {
    const lib = fnBlock(DISP_SRC, decl).replace(/^export\s+/, '')
    const inline = fnBlock(PIPE_SRC, decl).replace(/^export\s+/, '')
    assert.equal(inline, lib, `inline ${decl} must be byte-identical to the lib (minus export)`)
  }
})

// --- AC7: the meritocracy-judge.md description names the file-selected mechanism, not the false dispatch claim ---

test('AC7: meritocracy-judge.md description no longer claims effort is set "via the dispatch"', () => {
  const desc = frontmatter(read('agents/meritocracy-judge.md'))
  assert.ok(!/via the dispatch/i.test(desc),
    'the meritocracy-judge.md description must NOT claim effort is set "via the dispatch" -- effort rides the agent FILE (a -heavy file), the dispatch model is opus')
})

// --- AC8: 0 em-dashes across every touched file ---

test('AC8: 0 em-dashes across every file this chunk touches', () => {
  const touched = [
    'workflows/tier-dispatch.mjs',
    'workflows/worker-pipeline.js',
    'workflows/agenttype-precheck.mjs',
    'agents/meritocracy-judge.md',
    'agents/meritocracy-judge-heavy.md',
    'workflows/pipeline-meritocracy-c9.test.mjs',
  ]
  // The em-dash is referenced by codepoint (String.fromCharCode(0x2014)), NOT a
  // literal char, so this test file does not self-trip its own assertion.
  const EM_DASH = String.fromCharCode(0x2014)
  for (const rel of touched) {
    if (!existsSync(join(ROOT, rel))) continue
    const src = read(rel)
    assert.ok(!src.includes(EM_DASH), `${rel} must contain 0 em-dashes (U+2014)`)
  }
})
