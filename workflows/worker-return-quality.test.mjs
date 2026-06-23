// RED test for chunk C1: Worker return-quality standard.
//
// Pins the chunk's single behavior: every worker agent prompt carries an
// explicit return-quality instruction -- the spec's named PRIMARY mechanism
// ("the skill/prompt IS the mechanism. No gate"). The four worker prompts
// (test-author, implementer, recall, chunk-reviewer) must each
// instruct the subagent to return adequate, accurate, structured detail as
// standard practice, where the old prompt asked only for a one-liner.
//
// This is a static-text acceptance check (the natural proof for a prompt chunk):
// it reads the four agent prompt files as text and asserts the return-quality
// instruction is present in each. It does NOT execute anything and does NOT
// assert exact prose -- only that the instruction the spec names exists, so the
// implementer keeps wording freedom.
//
// Run: node --test workflows/worker-return-quality.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

// test-author / implementer / recall removed in chunk 9 (dead relay agents).
// build-agent is the single worker that now runs the full inner loop.
const WORKER_PROMPTS = [
  'agents/build-agent.md',
  'agents/chunk-reviewer.md',
]

// The return-quality standard the spec defines, matched loosely (case-insensitive)
// so the implementer can word the instruction freely. The spec's own phrasing is
// "return-quality standard" / "return adequate, accurate, structured" detail. The
// `[\s\S]{0,40}` between "structured" and "detail/info/return" tolerates filler
// words ("structured info", "structured detail in every field") without matching
// an unrelated stray "structured" elsewhere.
const RETURN_QUALITY =
  /return[- ]quality|adequate[,\s]+(?:accurate[,\s]+)?structured[\s\S]{0,40}(?:detail|info|field|return)/i

for (const rel of WORKER_PROMPTS) {
  test(`${rel} carries an explicit return-quality instruction`, () => {
    const body = read(rel)
    assert.match(
      body,
      RETURN_QUALITY,
      `${rel} is missing the explicit return-quality instruction. The spec's PRIMARY ` +
        `mechanism is the prompt itself (return adequate, accurate, structured detail ` +
        `as standard practice), not a gate -- the old prompt asked only for a one-liner.`,
    )
  })
}
