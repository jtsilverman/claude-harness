// RED test for pipeline-meritocracy chunk 1: collapse the 4-tier (S/A/B/C)
// dispatch dial to 2 tiers (default | heavy), opus everywhere, and delete the
// orphaned effort-named worker-agent files.
//
// Pins the FULL acceptance contract:
//   AC1 tierConfig 2-tier   : default -> {build-agent, opus}; heavy -> {build-agent-heavy, opus}
//   AC2 legacy reads        : B/C/absent -> default; A/S -> heavy (old-spec reads still resolve, no crash)
//   AC3 fixerFor 2-tier     : default -> {fixer, opus}; heavy -> {fixer-heavy, opus}; legacy ranks map; both opus
//   AC4 deleted files absent: build-agent-light.md, build-agent-max.md, fixer-light.md gone
//   AC5 agent frontmatter   : build-agent opus/high, build-agent-heavy opus/xhigh,
//                             fixer opus/high, fixer-heavy opus/xhigh; chunk-reviewer stays sonnet
//   AC6 lockstep            : worker-pipeline.js inline tierConfig/reviewerFor/fixerFor
//                             byte-identical to tier-dispatch.mjs (minus `export`)
//   AC7 no dangling ref     : neither tier-dispatch.mjs nor worker-pipeline.js's dispatch
//                             dial references a deleted file
//   AC8 docs 2-tier         : coo-sop §6 + spec-collaboration Tier section state the 2-tier vocabulary

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// Defensive namespace import: in the RED state tierConfig/fixerFor still return the
// old 4-tier shape (the module loads fine), so a hard import is safe here, but the
// namespace form keeps every assertion failing on its OWN line if a future edit
// removes an export.
import * as dispatch from './tier-dispatch.mjs'
const tierConfig = dispatch.tierConfig
const fixerFor = dispatch.fixerFor
const reviewerFor = dispatch.reviewerFor

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const AGENTS = join(ROOT, 'agents')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const DISP_SRC = read('workflows/tier-dispatch.mjs')
const PIPE_SRC = read('workflows/worker-pipeline.js')

// --- AC1: tierConfig 2-tier (default | heavy), opus everywhere ---

test('AC1: tierConfig(default) -> { build-agent, opus }', () => {
  assert.deepEqual(tierConfig('default'), { buildAgent: 'build-agent', buildModel: 'opus' })
})
test('AC1: tierConfig(heavy) -> { build-agent-heavy, opus }', () => {
  assert.deepEqual(tierConfig('heavy'), { buildAgent: 'build-agent-heavy', buildModel: 'opus' })
})

// --- AC2: legacy S/A/B/C reads still resolve (old-spec reads), no crash ---

test('AC2: legacy B -> default builder (build-agent/opus)', () => {
  assert.deepEqual(tierConfig('B'), { buildAgent: 'build-agent', buildModel: 'opus' })
})
test('AC2: legacy C -> default builder (build-agent/opus)', () => {
  assert.deepEqual(tierConfig('C'), { buildAgent: 'build-agent', buildModel: 'opus' })
})
test('AC2: legacy A -> heavy builder (build-agent-heavy/opus)', () => {
  assert.deepEqual(tierConfig('A'), { buildAgent: 'build-agent-heavy', buildModel: 'opus' })
})
test('AC2: legacy S -> heavy builder (build-agent-heavy/opus)', () => {
  assert.deepEqual(tierConfig('S'), { buildAgent: 'build-agent-heavy', buildModel: 'opus' })
})
test('AC2: absent/unknown tier -> default builder (build-agent/opus), no crash', () => {
  assert.deepEqual(tierConfig(null), { buildAgent: 'build-agent', buildModel: 'opus' })
  assert.deepEqual(tierConfig(undefined), { buildAgent: 'build-agent', buildModel: 'opus' })
  assert.deepEqual(tierConfig('nonsense'), { buildAgent: 'build-agent', buildModel: 'opus' })
})
test('AC2: never dials to a deleted builder (no build-agent-light / build-agent-max)', () => {
  for (const t of ['default', 'heavy', 'B', 'C', 'A', 'S', null, undefined, 'nonsense']) {
    const a = tierConfig(t).buildAgent
    assert.ok(a !== 'build-agent-light' && a !== 'build-agent-max',
      `tierConfig(${JSON.stringify(t)}) returned a deleted builder: ${a}`)
  }
})

// --- AC3: fixerFor 2-tier, opus everywhere ---

const f = (tier) => `- [BUG][P1][FIX:${tier}] x -- a.js:1 -- worker -- why`

test('AC3: fixerFor default-tier finding -> fixer/opus', () => {
  const r = fixerFor([f('B')])
  assert.equal(r.agentType, 'fixer')
  assert.equal(r.model, 'opus')
})
test('AC3: fixerFor heavy-tier finding -> fixer-heavy/opus', () => {
  const r = fixerFor([f('A')])
  assert.equal(r.agentType, 'fixer-heavy')
  assert.equal(r.model, 'opus')
})
test('AC3: fixerFor legacy S -> fixer-heavy/opus (folds into heavy)', () => {
  const r = fixerFor([f('S')])
  assert.equal(r.agentType, 'fixer-heavy')
  assert.equal(r.model, 'opus')
})
test('AC3: fixerFor legacy C -> fixer/opus (folds into default; no fixer-light)', () => {
  const r = fixerFor([f('C')])
  assert.equal(r.agentType, 'fixer')
  assert.equal(r.model, 'opus')
})
test('AC3: fixerFor empty / untagged -> default (fixer/opus)', () => {
  assert.equal(fixerFor([]).agentType, 'fixer')
  assert.equal(fixerFor([]).model, 'opus')
  assert.equal(fixerFor(['- [SLOP][P3] no fix token -- a.js:1 -- worker -- why']).agentType, 'fixer')
})
test('AC3: fixerFor MAX-across — any heavy finding escalates the whole list', () => {
  assert.equal(fixerFor([f('C'), f('A')]).agentType, 'fixer-heavy')
  assert.equal(fixerFor([f('B'), f('S')]).agentType, 'fixer-heavy')
  assert.equal(fixerFor([f('C'), f('B')]).agentType, 'fixer')
})
test('AC3: fixerFor never dials a deleted fixer (no fixer-light)', () => {
  for (const findings of [[f('C')], [f('B')], [], [f('A')], [f('S')]]) {
    assert.notEqual(fixerFor(findings).agentType, 'fixer-light')
  }
})
test('AC3: fixerFor.fixTier is a 2-tier label (default | heavy)', () => {
  assert.equal(fixerFor([f('B')]).fixTier, 'default')
  assert.equal(fixerFor([f('A')]).fixTier, 'heavy')
})

// --- AC3b: reviewerFor accepts BOTH the 2-tier fixTier labels and legacy ---
// (fixCfg.fixTier flows into reviewerFor(fixTier) in worker-pipeline.js)

test('AC3b: reviewerFor(heavy) -> chunk-reviewer-heavy; reviewerFor(default) -> chunk-reviewer', () => {
  assert.deepEqual(reviewerFor('heavy'), { agentType: 'chunk-reviewer-heavy' })
  assert.deepEqual(reviewerFor('default'), { agentType: 'chunk-reviewer' })
  // legacy still resolves
  assert.deepEqual(reviewerFor('A'), { agentType: 'chunk-reviewer-heavy' })
  assert.deepEqual(reviewerFor('B'), { agentType: 'chunk-reviewer' })
})

// --- AC4: deleted files absent ---

for (const rel of ['agents/build-agent-light.md', 'agents/build-agent-max.md', 'agents/fixer-light.md']) {
  test(`AC4: ${rel} is deleted (absent on disk)`, () => {
    assert.ok(!existsSync(join(ROOT, rel)), `${rel} must be deleted (the effort-named tier files collapse to 2)`)
  })
}

// --- AC5: agent frontmatter (model/effort), reviewer stays sonnet ---

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

const FM_CASES = [
  ['agents/build-agent.md', 'opus', 'high'],
  ['agents/build-agent-heavy.md', 'opus', 'xhigh'],
  ['agents/fixer.md', 'opus', 'high'],
  ['agents/fixer-heavy.md', 'opus', 'xhigh'],
]
for (const [rel, model, effort] of FM_CASES) {
  test(`AC5: ${rel} frontmatter is model:${model} effort:${effort}`, () => {
    const fm = frontmatter(read(rel))
    assert.match(fm, new RegExp(`^model:\\s*${model}\\s*$`, 'm'), `${rel} must set model: ${model}. Got:\n${fm}`)
    assert.match(fm, new RegExp(`^effort:\\s*${effort}\\s*$`, 'm'), `${rel} must set effort: ${effort}. Got:\n${fm}`)
  })
}

test('AC5: chunk-reviewer stays sonnet (model diversity preserved, NOT collapsed to opus)', () => {
  const fm = frontmatter(read('agents/chunk-reviewer.md'))
  assert.match(fm, /^model:\s*sonnet\s*$/m, `chunk-reviewer.md must stay model: sonnet (non-goal: do not collapse the reviewer to opus). Got:\n${fm}`)
})

// --- AC6: lockstep (worker-pipeline.js inline copies byte-identical to the lib) ---

// Extract a top-level function block: declaration line through the first '}' at column 0.
function fnBlock(src, decl) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.includes(decl))
  assert.notEqual(start, -1, `could not find "${decl}" in source`)
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n')
  }
  throw new Error(`no closing brace found for ${decl}`)
}
for (const decl of ['function tierConfig', 'function reviewerFor', 'function fixerFor']) {
  test(`AC6: worker-pipeline ${decl} is byte-identical to tier-dispatch (lockstep)`, () => {
    const lib = fnBlock(DISP_SRC, decl).replace(/^export\s+/, '')
    const inline = fnBlock(PIPE_SRC, decl).replace(/^export\s+/, '')
    assert.equal(inline, lib, `inline ${decl} must be byte-identical to the lib (minus export)`)
  })
}

// --- AC7: no dangling dispatch reference to a deleted file ---
// The dispatch dial (the tierConfig/fixerFor switch bodies) must not name a deleted file.

test('AC7: tier-dispatch.mjs dial body has no reference to a deleted file', () => {
  for (const dead of ['build-agent-light', 'build-agent-max', 'fixer-light']) {
    assert.ok(!DISP_SRC.includes(dead),
      `tier-dispatch.mjs still references the deleted file '${dead}'`)
  }
})
test('AC7: worker-pipeline.js dial body has no reference to a deleted file', () => {
  for (const dead of ['build-agent-light', 'build-agent-max', 'fixer-light']) {
    assert.ok(!PIPE_SRC.includes(dead),
      `worker-pipeline.js still references the deleted file '${dead}'`)
  }
})
test('AC7: every buildAgent the dial returns resolves to an existing agent file', () => {
  const names = [...DISP_SRC.matchAll(/buildAgent:\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(names.length > 0, 'expected at least one buildAgent literal in tier-dispatch.mjs')
  for (const n of names) {
    assert.ok(existsSync(join(AGENTS, `${n}.md`)),
      `tier-dispatch.mjs dials buildAgent '${n}' but agents/${n}.md does not exist`)
  }
})
test('AC7: every fixer agentType the dial returns resolves to an existing agent file', () => {
  const names = [...DISP_SRC.matchAll(/agentType:\s*'(fixer[^']*)'/g)].map((m) => m[1])
  assert.ok(names.length > 0, 'expected at least one fixer agentType literal in tier-dispatch.mjs')
  for (const n of names) {
    assert.ok(existsSync(join(AGENTS, `${n}.md`)),
      `tier-dispatch.mjs dials fixer '${n}' but agents/${n}.md does not exist`)
  }
})

// --- AC8: docs state the 2-tier vocabulary ---

test('AC8: coo-sop §6 dial table states the 2-tier vocabulary (default + heavy), no deleted builders', () => {
  const sop = read('coo/coo-sop.md')
  // The §6 dial table must name the two tiers and must not list a deleted builder.
  assert.match(sop, /\bdefault\b/i, 'coo-sop §6 must reference the default tier')
  assert.match(sop, /\bheavy\b/i, 'coo-sop §6 must reference the heavy tier')
  for (const dead of ['build-agent-light', 'build-agent-max', 'fixer-light']) {
    assert.ok(!sop.includes(dead), `coo-sop.md still references the deleted file '${dead}'`)
  }
})
test('AC8: spec-collaboration Tier section states the 2-tier vocabulary', () => {
  const skill = read('skills/spec-collaboration/SKILL.md')
  // The Tier section must present the two-tier (default | heavy) vocabulary.
  assert.match(skill, /\bheavy\b/i, 'spec-collaboration Tier section must reference the heavy tier')
  assert.match(skill, /\bdefault\b/i, 'spec-collaboration Tier section must reference the default tier')
})
