// c8-reviewer-split-rename.test.mjs -- RED for chunk C8 (lean-system-rebuild):
// split the per-chunk review net by model strength and rename the Sonnet reviewer.
//
// CONTRACT under test (from the C8 dispatch payload + spec):
//   (1) The Codex lens NARROWS to "does the thing work" -- correctness/bugs/security
//       ONLY; it no longer judges spec-drift, AI-slop, or test-correctness.
//   (2) The Sonnet reviewer becomes the full-scope reviewer of all four dimensions
//       and is RENAMED spec-drift-slop-reviewer{,-heavy} -> chunk-reviewer{,-heavy}.
//
// AC1 rename complete; AC2 reviewerFor + inline-copy lockstep; AC3 frontmatter;
// AC4 dimension split (review-contract §2 + codexLensPrompt reframe; C7 §3 token +
// §3.1 rubric preserved); AC5 grader dual-match; AC6 suite green.
//
// Run: node --test workflows/c8-reviewer-split-rename.test.mjs
// Full suite (GLOB form -- bare `node --test workflows/` errors MODULE_NOT_FOUND on Node v25):
//   node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { reviewerFor } from './tier-dispatch.mjs'
import { deriveConformanceDoc } from './grader-workflow-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')
const has = (rel) => existsSync(join(repoRoot, rel))

// The three historical records that RECORD past state -- renaming references inside
// them falsifies the record, so the rename sweep must leave them verbatim.
const HISTORICAL_EXCLUDES = [
  'coo/catalog-audit-2026-06.md',
  'coo/fable-coherence-report-2026-06.md',
  'coo/voice-corpus-raw',
]

// Recursively walk a dir, returning every file path relative to repoRoot, skipping
// .git and the named historical records.
function walk(relDir, out = []) {
  const abs = join(repoRoot, relDir)
  if (!existsSync(abs)) return out
  for (const name of readdirSync(abs)) {
    const childRel = relDir ? `${relDir}/${name}` : name
    if (name === '.git') continue
    if (HISTORICAL_EXCLUDES.some((ex) => childRel === ex || childRel.startsWith(`${ex}/`))) continue
    const childAbs = join(repoRoot, childRel)
    if (statSync(childAbs).isDirectory()) walk(childRel, out)
    else out.push(childRel)
  }
  return out
}

// --- AC1: rename complete across operative surfaces ---

// The operative surfaces the spec names: agents/, workflows/, disciplines/,
// coo/agent-dispatch.md, coo/coo-sop.md, skills/. (specs/ archives + ledgers are
// not "operative surfaces" per AC1; the directed surfaces are these.)
const OPERATIVE_DIRS = ['agents', 'workflows', 'disciplines', 'skills']
const OPERATIVE_FILES = ['coo/coo-sop.md']

// AC1 vs AC5 reconciliation: AC5 REQUIRES the grader to keep matching the OLD
// reviewer name (so pre-rename session archives still route to review-contract).
// So the old name legitimately survives ONLY in the grader dual-match + its test
// fixture (and in this very test, which asserts the dual-match). Those are the
// deliberate AC5 retention, NOT a missed rename. Every OTHER operative surface must
// be fully renamed.
const DUAL_MATCH_RETENTION = new Set([
  'workflows/grader-workflow-lib.mjs', // AC5: dual-match `startsWith('spec-drift-slop-reviewer')`
  'workflows/grader-workflow.test.mjs', // AC5: exercises the old-name -> review-contract path
  'workflows/c8-reviewer-split-rename.test.mjs', // this test (asserts the dual-match)
])

test('AC1: zero `spec-drift-slop-reviewer` in operative surfaces (excluding the 3 historical records + the AC5 grader dual-match retention)', () => {
  const offenders = []
  const files = []
  for (const d of OPERATIVE_DIRS) walk(d, files)
  for (const f of OPERATIVE_FILES) if (has(f)) files.push(f)
  for (const f of files) {
    if (DUAL_MATCH_RETENTION.has(f)) continue
    const body = read(f)
    if (body.includes('spec-drift-slop-reviewer')) offenders.push(f)
  }
  assert.deepEqual(
    offenders,
    [],
    `These operative files still contain the OLD name 'spec-drift-slop-reviewer':\n` +
      offenders.join('\n') +
      `\nEvery operative reference must be renamed to chunk-reviewer{,-heavy} in lockstep ` +
      `(only the AC5 grader dual-match retention may keep the old name).`,
  )
})

test('AC1: the new agent files exist and the old agent files are gone', () => {
  assert.ok(has('agents/chunk-reviewer.md'), 'agents/chunk-reviewer.md must exist')
  assert.ok(has('agents/chunk-reviewer-heavy.md'), 'agents/chunk-reviewer-heavy.md must exist')
  assert.ok(!has('agents/spec-drift-slop-reviewer.md'), 'agents/spec-drift-slop-reviewer.md must be gone (renamed)')
  assert.ok(!has('agents/spec-drift-slop-reviewer-heavy.md'), 'agents/spec-drift-slop-reviewer-heavy.md must be gone (renamed)')
})

// --- AC2: reviewerFor returns the new names; inline copy byte-identical ---

test('AC2: reviewerFor(A) and (S) return chunk-reviewer-heavy', () => {
  assert.deepEqual(reviewerFor('A'), { agentType: 'chunk-reviewer-heavy' })
  assert.deepEqual(reviewerFor('S'), { agentType: 'chunk-reviewer-heavy' })
})

test('AC2: reviewerFor(B), (C), and absent return chunk-reviewer (base)', () => {
  assert.deepEqual(reviewerFor('B'), { agentType: 'chunk-reviewer' })
  assert.deepEqual(reviewerFor('C'), { agentType: 'chunk-reviewer' })
  assert.deepEqual(reviewerFor(undefined), { agentType: 'chunk-reviewer' })
})

test('AC2: worker-pipeline.js reviewerFor inline copy is byte-identical to tier-dispatch.mjs', () => {
  // Extract the reviewerFor function body (from `function reviewerFor` through the
  // matching closing brace at column 0) from both files and assert byte-parity
  // minus the `export ` keyword the lib carries (the inline copy is a plain function).
  const extract = (src) => {
    const m = src.match(/(?:export\s+)?function reviewerFor\(t\) \{[\s\S]*?\n\}/)
    assert.ok(m, 'could not locate reviewerFor() in source')
    return m[0].replace(/^export\s+/, '')
  }
  const lib = extract(read('workflows/tier-dispatch.mjs'))
  const inline = extract(read('workflows/worker-pipeline.js'))
  assert.equal(
    inline,
    lib,
    'worker-pipeline.js reviewerFor inline copy drifted from tier-dispatch.mjs (must stay byte-identical)',
  )
})

// --- AC3: agent frontmatter ---

test('AC3: chunk-reviewer.md frontmatter (name + sonnet/high)', () => {
  const body = read('agents/chunk-reviewer.md')
  assert.match(body, /^name:\s*chunk-reviewer\s*$/m, 'name: must be chunk-reviewer')
  assert.match(body, /^model:\s*sonnet\s*$/m, 'model: must be sonnet')
  assert.match(body, /^effort:\s*high\s*$/m, 'effort: must be high')
})

test('AC3: chunk-reviewer-heavy.md frontmatter (name + sonnet/xhigh)', () => {
  const body = read('agents/chunk-reviewer-heavy.md')
  assert.match(body, /^name:\s*chunk-reviewer-heavy\s*$/m, 'name: must be chunk-reviewer-heavy')
  assert.match(body, /^model:\s*sonnet\s*$/m, 'model: must be sonnet')
  assert.match(body, /^effort:\s*xhigh\s*$/m, 'effort: must be xhigh')
})

// --- AC4: dimension split (review-contract §2 + codexLensPrompt reframe) ---

test('AC4: review-contract.md §2 states the per-lens split (chunk-reviewer all-four, Codex correctness/bugs/security only)', () => {
  const body = read('disciplines/review-contract.md')
  // The chunk-reviewer owns all four dimensions.
  assert.match(
    body,
    /chunk-reviewer/,
    'review-contract.md §2 must name the chunk-reviewer as the full-scope (all-four) judge',
  )
  // The Codex lens is restricted to correctness / bugs / security and explicitly
  // NOT spec-drift / AI-slop / test-correctness.
  assert.match(
    body,
    /Codex[\s\S]*?(correctness|bug)[\s\S]*?security/i,
    'review-contract.md §2 must scope the Codex lens to correctness/bugs/security',
  )
  assert.match(
    body,
    /Codex[\s\S]*?\b(not|never|only)\b/i,
    'review-contract.md §2 must state the Codex lens does NOT judge drift/slop/test-correctness (the narrowing)',
  )
  // The OLD full-scope mandate ("Every reviewer judges all four") must be gone --
  // the contract is now split, not uniform.
  assert.doesNotMatch(
    body,
    /Every reviewer judges all four/,
    'the old uniform "Every reviewer judges all four" mandate must be replaced by the per-lens split',
  )
})

test('AC4: worker-pipeline.js codexLensPrompt carries a bug/security-focus mandate, not the full-scope contract injection', () => {
  const src = read('workflows/worker-pipeline.js')
  const m = src.match(/function codexLensPrompt\([\s\S]*?\n\}/)
  assert.ok(m, 'could not locate codexLensPrompt() in worker-pipeline.js')
  const fn = m[0]
  // The reframed prompt must NOT inject the full review-contract doc (that injection
  // is what made it judge all four dimensions).
  assert.doesNotMatch(
    fn,
    /injectedDocBlock\('review-contract'/,
    'codexLensPrompt must NOT inject the full-scope review-contract doc anymore (it now carries a bug/security-focus mandate)',
  )
  // The prompt must frame the Codex lens around correctness/bugs/security.
  assert.match(
    fn,
    /security/i,
    'codexLensPrompt must frame the Codex lens around bug/security/correctness',
  )
})

test('AC4: C7 section-3 [FIX:<C|B|A|S>] token + section-3.1 rate-the-fix rubric preserved in review-contract.md', () => {
  const body = read('disciplines/review-contract.md')
  assert.match(body, /\[FIX:<C\|B\|A\|S>\]/, 'C7 [FIX:<C|B|A|S>] token must be preserved')
  assert.match(body, /### 3\.1 Rate the fix/, 'C7 §3.1 rate-the-fix rubric heading must be preserved')
  for (const t of ['[FIX:C]', '[FIX:B]', '[FIX:A]', '[FIX:S]']) {
    assert.ok(body.includes(t), `rate-the-fix rubric must keep the ${t} tier`)
  }
})

// --- AC5: grader dual-match (old + new reviewer name -> review-contract) ---

test('AC5: deriveConformanceDoc maps BOTH old and new reviewer names to review-contract', () => {
  // The derivation reads a .meta.json sidecar next to a .jsonl. We assert on the
  // pure behavior by pointing at a real sidecar fixture would be ideal, but the
  // derivation only needs agentType -- so we verify the source maps both prefixes.
  const src = read('workflows/grader-workflow-lib.mjs')
  // One old-name path and one new-name path must both route to review-contract.
  assert.match(
    src,
    /spec-drift-slop-reviewer/,
    'grader role-derivation must STILL match the OLD name spec-drift-slop-reviewer (pre-rename archives)',
  )
  assert.match(
    src,
    /chunk-reviewer/,
    'grader role-derivation must ALSO match the NEW name chunk-reviewer',
  )
})

// Behavioral assertion on the pure helper itself, via a meta.json sidecar fixture.
test('AC5: deriveConformanceDoc returns review-contract for one old-name AND one new-name agentType', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const os = await import('node:os')
  const dir = mkdtempSync(join(os.tmpdir(), 'c8-grader-'))
  try {
    // Old name path.
    const oldJsonl = join(dir, 'agent-old.jsonl')
    writeFileSync(oldJsonl, '')
    writeFileSync(
      join(dir, 'agent-old.meta.json'),
      JSON.stringify({ agentType: 'spec-drift-slop-reviewer-heavy' }),
    )
    assert.equal(
      deriveConformanceDoc(oldJsonl, 'subagent'),
      'disciplines/review-contract.md',
      'old reviewer name must still route to review-contract (pre-rename archive)',
    )
    // New name path.
    const newJsonl = join(dir, 'agent-new.jsonl')
    writeFileSync(newJsonl, '')
    writeFileSync(
      join(dir, 'agent-new.meta.json'),
      JSON.stringify({ agentType: 'chunk-reviewer' }),
    )
    assert.equal(
      deriveConformanceDoc(newJsonl, 'subagent'),
      'disciplines/review-contract.md',
      'new reviewer name must route to review-contract',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
