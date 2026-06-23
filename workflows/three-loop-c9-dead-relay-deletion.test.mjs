// RED test for chunk C9: delete the dead old-relay agent files.
//
// The 5-context relay (recall / test-author / implementer) was replaced by the
// single build-agent in chunks 4/5. Chunk 9 deletes the 7 now-dead agent files
// and removes their references from the two tests that enumerate the active
// agent roster. This test pins the full acceptance contract:
//
//   AC1. The 7 dead files are gone.
//   AC2. The 2 live verification-net files survive.
//   AC3. No live dispatch/import/test-roster pointer to the 7 deleted files.
//   AC4. subagent-self-sufficiency.test.mjs updated (no dead names in ALL_AGENTS).
//   AC5. worker-return-quality.test.mjs updated (no dead names in WORKER_PROMPTS).
//   AC6. Pipeline BUILD + REVIEW dispatch still resolve to existing agent files.
//
// Run: node --test workflows/three-loop-c9-dead-relay-deletion.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const exists = (rel) => existsSync(join(root, rel))
const read   = (rel) => readFileSync(join(root, rel), 'utf8')

// --- The 7 files that must be GONE ---

const DEAD = [
  'agents/recall.md',
  'agents/test-author.md',
  'agents/test-author-light.md',
  'agents/test-author-heavy.md',
  'agents/implementer.md',
  'agents/implementer-light.md',
  'agents/implementer-heavy.md',
]

// --- AC1: 7 dead files must not exist ---

for (const rel of DEAD) {
  test(`AC1: ${rel} is deleted (dead relay agent)`, () => {
    assert.ok(
      !exists(rel),
      `${rel} still exists. This file was part of the old 5-context relay ` +
        `(recall / test-author / implementer) that the single build-agent ` +
        `replaced in chunks 4/5. It must be deleted in this chunk.`,
    )
  })
}

// --- AC2: 2 live verification-net files must survive ---

const LIVE_REVIEWERS = [
  'agents/chunk-reviewer.md',
  'agents/chunk-reviewer-heavy.md',
]

for (const rel of LIVE_REVIEWERS) {
  test(`AC2: ${rel} still exists (live verification net)`, () => {
    assert.ok(
      exists(rel),
      `${rel} is MISSING. This file is the live Sonnet verification-net lens ` +
        `dispatched by worker-pipeline.js (reviewerFor). It must NOT be deleted.`,
    )
  })
}

// --- AC3: subagent-self-sufficiency.test.mjs has no dead names in ALL_AGENTS ---

test('AC4: subagent-self-sufficiency.test.mjs does not enumerate dead relay agents in ALL_AGENTS', () => {
  const src = read('workflows/subagent-self-sufficiency.test.mjs')

  // Find the ALL_AGENTS array content only (between 'const ALL_AGENTS = [' and the closing ']')
  const allAgentsMatch = src.match(/const ALL_AGENTS\s*=\s*\[([\s\S]*?)\]/)
  assert.ok(
    allAgentsMatch,
    'Could not locate ALL_AGENTS array in subagent-self-sufficiency.test.mjs',
  )
  const arrayBody = allAgentsMatch[1]

  const deadNames = [
    'recall',
    'test-author-heavy',
    'test-author-light',
    'test-author',
    'implementer-heavy',
    'implementer-light',
    'implementer',
  ]
  for (const name of deadNames) {
    assert.ok(
      !arrayBody.includes(`'${name}'`) && !arrayBody.includes(`"${name}"`),
      `subagent-self-sufficiency.test.mjs ALL_AGENTS still includes '${name}'. ` +
        `This dead relay agent no longer exists on disk; remove it from the roster.`,
    )
  }
})

// --- AC5: worker-return-quality.test.mjs has no dead names in WORKER_PROMPTS ---

test('AC5: worker-return-quality.test.mjs does not reference dead relay agent files in WORKER_PROMPTS', () => {
  const src = read('workflows/worker-return-quality.test.mjs')

  // Find the WORKER_PROMPTS array content only
  const workerPromptsMatch = src.match(/const WORKER_PROMPTS\s*=\s*\[([\s\S]*?)\]/)
  assert.ok(
    workerPromptsMatch,
    'Could not locate WORKER_PROMPTS array in worker-return-quality.test.mjs',
  )
  const arrayBody = workerPromptsMatch[1]

  const deadPaths = [
    'agents/recall.md',
    'agents/test-author.md',
    'agents/implementer.md',
  ]
  for (const path of deadPaths) {
    assert.ok(
      !arrayBody.includes(path),
      `worker-return-quality.test.mjs WORKER_PROMPTS still references '${path}'. ` +
        `This dead relay agent no longer exists on disk; remove it from the list.`,
    )
  }
})

// --- AC6: pipeline BUILD + REVIEW dispatch resolves to existing agent files ---

test('AC6: worker-pipeline.js BUILD dispatch resolves to an existing build-agent file', () => {
  const src = read('workflows/worker-pipeline.js')

  // The buildAgent values are 'build-agent', 'build-agent-light', 'build-agent-heavy'
  // Extract the agentType values returned by tierConfig for each tier
  const buildAgentValues = [...src.matchAll(/buildAgent:\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(
    buildAgentValues.length > 0,
    'Could not find any buildAgent: entries in worker-pipeline.js',
  )
  for (const name of buildAgentValues) {
    const rel = `agents/${name}.md`
    assert.ok(
      exists(rel),
      `worker-pipeline.js dispatches buildAgent '${name}' but ${rel} does not exist. ` +
        `The BUILD dispatch is broken.`,
    )
  }
})

test('AC6: worker-pipeline.js REVIEW dispatch resolves to an existing reviewer file', () => {
  const src = read('workflows/worker-pipeline.js')

  // The reviewer agentTypes are 'chunk-reviewer' and 'chunk-reviewer-heavy'
  // (renamed in lean-system-rebuild C8). worker-pipeline.js dispatches reviewers via
  // reviewerFor(tier).agentType, so the literal agentType strings live in the inline
  // reviewerFor's `return { agentType: 'chunk-reviewer...' }` lines.
  const reviewerValues = [
    ...src.matchAll(/agentType:\s*'(chunk-reviewer[^']*)'/g),
  ].map((m) => m[1])
  assert.ok(
    reviewerValues.length > 0,
    'Could not find any chunk-reviewer agentType in worker-pipeline.js',
  )
  for (const name of reviewerValues) {
    const rel = `agents/${name}.md`
    assert.ok(
      exists(rel),
      `worker-pipeline.js dispatches reviewer '${name}' but ${rel} does not exist. ` +
        `The REVIEW dispatch is broken.`,
    )
  }
})
