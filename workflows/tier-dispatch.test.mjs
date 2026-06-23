// tier-dispatch dial contract (pipeline-meritocracy chunk 1: 2-tier collapse).
//
// Pins the live 2-tier dial:
//   - tierConfig(default) -> build-agent / opus; tierConfig(heavy) -> build-agent-heavy / opus
//   - legacy S/A/B/C still resolve (A/S -> heavy, B/C/absent -> default)
//   - reviewerFor(heavy|A|S) -> chunk-reviewer-heavy; reviewerFor(default|B|C) -> chunk-reviewer
//   - the source no longer references any deleted file (build-agent-light/max)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { tierConfig, reviewerFor } from './tier-dispatch.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, 'tier-dispatch.mjs'), 'utf8')

// --- Criterion 1: two-tier dial, opus everywhere ---

test("C1(dial): tier default -> build-agent / opus", () => {
  assert.deepEqual(tierConfig('default'), { buildAgent: 'build-agent', buildModel: 'opus' })
})
test("C1(dial): tier heavy -> build-agent-heavy / opus", () => {
  assert.deepEqual(tierConfig('heavy'), { buildAgent: 'build-agent-heavy', buildModel: 'opus' })
})
test("C1(dial): absent/unknown tier defaults to the default builder (build-agent/opus)", () => {
  assert.deepEqual(tierConfig(null), { buildAgent: 'build-agent', buildModel: 'opus' })
})

// --- Criterion 1b: legacy S/A/B/C reads still resolve (old-spec / grader reads) ---

test("C1b(legacy): A/S -> heavy builder; B/C -> default builder", () => {
  assert.deepEqual(tierConfig('A'), { buildAgent: 'build-agent-heavy', buildModel: 'opus' })
  assert.deepEqual(tierConfig('S'), { buildAgent: 'build-agent-heavy', buildModel: 'opus' })
  assert.deepEqual(tierConfig('B'), { buildAgent: 'build-agent', buildModel: 'opus' })
  assert.deepEqual(tierConfig('C'), { buildAgent: 'build-agent', buildModel: 'opus' })
})

// --- Criterion 2: reviewer selector (stays sonnet; only the file scales) ---

test("C2(reviewer): heavy / legacy A / legacy S -> chunk-reviewer-heavy", () => {
  assert.deepEqual(reviewerFor('heavy'), { agentType: 'chunk-reviewer-heavy' })
  assert.deepEqual(reviewerFor('A'), { agentType: 'chunk-reviewer-heavy' })
  assert.deepEqual(reviewerFor('S'), { agentType: 'chunk-reviewer-heavy' })
})
test("C2(reviewer): default / legacy B / legacy C -> chunk-reviewer (base)", () => {
  assert.deepEqual(reviewerFor('default'), { agentType: 'chunk-reviewer' })
  assert.deepEqual(reviewerFor('B'), { agentType: 'chunk-reviewer' })
  assert.deepEqual(reviewerFor('C'), { agentType: 'chunk-reviewer' })
})

// --- Criterion 3: source no longer references a deleted file ---

test("C3(source): tier-dispatch.mjs references no deleted file (build-agent-light/max, fixer-light)", () => {
  for (const dead of ['build-agent-light', 'build-agent-max', 'fixer-light']) {
    assert.ok(!SRC.includes(dead), `tier-dispatch.mjs still references the deleted file '${dead}'`)
  }
})
