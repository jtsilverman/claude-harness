// coo-simplification-c3-ship-funnel-phases.test.mjs -- RED for chunk 3:
// split the ship funnel into a re-runnable GATE phase (Stage-1 live-run + Stage-2
// review + Codex) and a run-once ARTIFACT phase (diagram-refresher + demo-assembler).
//
// CONTRACT under test (specs/current.md chunk 3 acceptanceCriteria):
//
//   (AC1) gatesOnly returns after Stage-2: with args.gatesOnly the workflow returns a
//         result with NO diagrams and NO demo, and it NEVER dispatches the
//         diagram-refresher or the demo-assembler. The artifact phase is SEPARATELY
//         invocable (args.artifactsOnly) and, when invoked, dispatches the
//         diagram-refresher + the demo-assembler exactly once each, WITHOUT re-running
//         Stage-1 or Stage-2.
//   (AC3) A simulated Stage-2 FIX + re-run (a second gatesOnly pass) does NOT
//         re-dispatch diagram-refresher / demo. Only the artifact phase fires them, once.
//   (AC4) Anti-tautology: with the split reverted (no gatesOnly arg, the linear one-pass
//         path) the gate run DOES re-fire the artifact producers -- proving the test
//         distinguishes the split from the linear baseline.
//   (AC2-grep) ship-spec/SKILL.md outcome-routing: a fix re-runs the GATE phase
//              (gatesOnly), and the artifact phase is named run-once-on-green.
//
// ARCHITECTURE: the launchable `ship-review-workflow.js` is run as an AsyncFunction
// with stub harness globals (the same pattern as grader-workflow.test.mjs). The stub
// `agent`/`parallel`/`phase` record every dispatch (by label + agentType) so the test
// can assert WHICH agents fired in each mode -- the dispatch surface is the truth, not
// just the return value (sister memory: assert-merge-at-downstream-prompt-not-return-value).
//
// Run: node --test workflows/coo-simplification-c3-ship-funnel-phases.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const WORKFLOW = 'workflows/ship-review-workflow.js'
const SHIP_SPEC = 'skills/ship-spec/SKILL.md'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Build a runnable AsyncFunction from the launchable .js, minus the top-level
// `export const meta = { ... }` literal (export is illegal inside a function body).
function workflowFn() {
  const src = read(WORKFLOW)
  const body = src.replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\n\}\n/, '')
  return new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)
}

// A stub harness that records each agent dispatch. `agent(prompt, opts)` returns a
// canned result keyed by the dispatch's label/agentType so the funnel can proceed,
// and pushes a record of the dispatch so the test can assert WHICH agents fired.
//   - Stage-1 live-run  -> label 'stage1-live-run'        -> { verdict: 'pass', ... }
//   - Stage-2 review    -> label 'stage2-review'          -> { result: 'CLEAN', findings: [] }
//   - Stage-2 codex     -> label 'stage2-codex'           -> { result: 'CLEAN', findings: [] }
//   - diagram refresh   -> agentType 'diagram-refresher'  -> a REFRESH_SCHEMA-shaped draft
//   - demo              -> agentType 'demo-assembler'      -> a DEMO_SCHEMA-shaped draft
function makeHarness({ stage1Verdict = 'pass' } = {}) {
  const dispatches = []
  const phases = []
  const labelOf = (opts) => (opts && (opts.label || opts.agentType)) || '(unlabelled)'
  const result = (opts) => {
    const id = labelOf(opts)
    const at = opts && opts.agentType
    if (at === 'diagram-refresher' || id === 'diagram-refresh') {
      return { listed: 2, judgedStale: 1, diagrams: [{ name: 'L3', status: 'updated', mermaid: 'graph TD;', prose: 'p', note: 'none' }], note: 'none' }
    }
    if (at === 'demo-assembler' || id === 'stage3-demo') {
      return { narration: 'we took / did / got / means', evidenceRefs: ['ref'], note: 'none' }
    }
    if (id === 'stage1-live-run') {
      return { verdict: stage1Verdict, evidence: 'ran the system; observed output', failures: stage1Verdict === 'pass' ? [] : [{ what: 'broke', evidence: 'stack' }] }
    }
    if (id === 'stage2-review') return { result: 'CLEAN', findings: [] }
    if (id === 'stage2-codex') return { result: 'CLEAN', findings: [] }
    return {}
  }
  const agent = async (prompt, opts) => {
    dispatches.push({ label: (opts && opts.label) || null, agentType: (opts && opts.agentType) || null, phase: opts && opts.phase })
    return result(opts)
  }
  const parallel = async (fns) => Promise.all(fns.map((f) => f()))
  const phase = (t) => { phases.push(t) }
  const log = () => {}
  return { agent, parallel, phase, log, dispatches, phases }
}

// Did a given agentType OR label appear among the recorded dispatches?
const fired = (dispatches, key) => dispatches.some((d) => d.agentType === key || d.label === key)
const countFired = (dispatches, key) => dispatches.filter((d) => d.agentType === key || d.label === key).length

const baseArgs = {
  specSlug: 'coo-simplification',
  project: 'claude-code-setup',
  branch: 'feat/coo-simplification',
  baseRef: 'main',
  topTier: 'A',
  whatShipped: 'the funnel got phase-split',
}

// ---------------------------------------------------------------------------
// AC1: gatesOnly returns after Stage-2 with NO artifacts dispatched.
// ---------------------------------------------------------------------------
test('AC1: gatesOnly returns after Stage-2 with no diagram/demo dispatch', async () => {
  const h = makeHarness()
  const fn = workflowFn()
  const out = await fn({ ...baseArgs, gatesOnly: true }, h.agent, h.parallel, h.phase, h.log)

  // The gates ran.
  assert.ok(fired(h.dispatches, 'stage1-live-run'), 'Stage-1 live-run must run under gatesOnly')
  assert.ok(fired(h.dispatches, 'stage2-review'), 'Stage-2 review must run under gatesOnly')
  assert.ok(fired(h.dispatches, 'stage2-codex'), 'Stage-2 codex must run under gatesOnly')

  // The artifact producers did NOT.
  assert.ok(!fired(h.dispatches, 'diagram-refresher'), 'gatesOnly must NOT dispatch the diagram-refresher')
  assert.ok(!fired(h.dispatches, 'demo-assembler'), 'gatesOnly must NOT dispatch the demo-assembler')

  // No diagrams / demo in the returned result.
  assert.ok(out.diagrams == null, 'gatesOnly result must carry no diagram drafts')
  assert.ok(out.demo == null, 'gatesOnly result must carry no demo')
  assert.ok(out.stage2 && out.stage2.review, 'gatesOnly result still carries the Stage-2 verdict')
})

// ---------------------------------------------------------------------------
// AC1 (artifact phase): separately invocable, dispatches refresher + demo ONCE
// each, WITHOUT re-running Stage-1/Stage-2.
// ---------------------------------------------------------------------------
test('AC1: artifact phase is separately invocable and runs refresher + demo once, no gates', async () => {
  const h = makeHarness()
  const fn = workflowFn()
  const out = await fn(
    {
      ...baseArgs,
      artifactsOnly: true,
      // the COO threads the final clean gate result in (the artifact phase does not re-run the gates)
      stage1Evidence: 'final stage-1 evidence',
      stage2Verdict: 'CLEAN',
    },
    h.agent, h.parallel, h.phase, h.log
  )

  assert.equal(countFired(h.dispatches, 'diagram-refresher'), 1, 'artifact phase dispatches the diagram-refresher exactly once')
  assert.equal(countFired(h.dispatches, 'demo-assembler'), 1, 'artifact phase dispatches the demo-assembler exactly once')

  // The gates must NOT re-run in the artifact phase.
  assert.ok(!fired(h.dispatches, 'stage1-live-run'), 'artifact phase must NOT re-run Stage-1')
  assert.ok(!fired(h.dispatches, 'stage2-review'), 'artifact phase must NOT re-run Stage-2 review')

  // The artifact phase returns the drafts.
  assert.ok(out.diagrams, 'artifact phase returns diagram drafts')
  assert.ok(out.demo, 'artifact phase returns the demo draft')
})

// ---------------------------------------------------------------------------
// AC3: a simulated Stage-2 fix + re-run (a second gatesOnly pass) does NOT
// re-dispatch the artifact producers. Artifacts fire only in the artifact phase.
// ---------------------------------------------------------------------------
test('AC3: a Stage-2 fix re-run (gatesOnly) does not re-fire the artifact producers', async () => {
  const fn = workflowFn()

  // First gate pass (FINDINGS would route to a fix; here we just re-run gatesOnly).
  const h1 = makeHarness()
  await fn({ ...baseArgs, gatesOnly: true }, h1.agent, h1.parallel, h1.phase, h1.log)

  // The fix lands; the COO re-runs ONLY the gates.
  const h2 = makeHarness()
  await fn({ ...baseArgs, gatesOnly: true }, h2.agent, h2.parallel, h2.phase, h2.log)

  const totalRefresh = countFired(h1.dispatches, 'diagram-refresher') + countFired(h2.dispatches, 'diagram-refresher')
  const totalDemo = countFired(h1.dispatches, 'demo-assembler') + countFired(h2.dispatches, 'demo-assembler')
  assert.equal(totalRefresh, 0, 'two gatesOnly passes never dispatch the diagram-refresher')
  assert.equal(totalDemo, 0, 'two gatesOnly passes never dispatch the demo-assembler')

  // The artifact phase, fired ONCE after the final clean gate, fires them exactly once.
  const ha = makeHarness()
  await fn({ ...baseArgs, artifactsOnly: true, stage1Evidence: 'final', stage2Verdict: 'CLEAN' }, ha.agent, ha.parallel, ha.phase, ha.log)
  assert.equal(countFired(ha.dispatches, 'diagram-refresher'), 1, 'artifact phase fires the refresher exactly once on green')
  assert.equal(countFired(ha.dispatches, 'demo-assembler'), 1, 'artifact phase fires the demo exactly once on green')
})

// ---------------------------------------------------------------------------
// AC4 (anti-tautology): the LINEAR baseline (no gatesOnly, no artifactsOnly) still
// runs gates THEN artifacts in one pass -- so re-running it re-fires the artifact
// producers. This is the behavior the split exists to STOP; it proves the test
// distinguishes the gatesOnly mode from the old linear one-pass.
// ---------------------------------------------------------------------------
test('AC4: the linear one-pass re-fires artifacts (the behavior gatesOnly avoids)', async () => {
  const fn = workflowFn()
  const h1 = makeHarness()
  await fn({ ...baseArgs }, h1.agent, h1.parallel, h1.phase, h1.log)
  const h2 = makeHarness()
  await fn({ ...baseArgs }, h2.agent, h2.parallel, h2.phase, h2.log)
  const total = countFired(h1.dispatches, 'diagram-refresher') + countFired(h2.dispatches, 'diagram-refresher')
    + countFired(h1.dispatches, 'demo-assembler') + countFired(h2.dispatches, 'demo-assembler')
  assert.ok(total >= 4, 'the linear one-pass re-fires both artifact producers on every run (>=2 per run, 2 runs)')
})

// ---------------------------------------------------------------------------
// Edge: a Stage-1 FAIL still stops before Stage-2 (sequential gate preserved).
// ---------------------------------------------------------------------------
test('edge: a Stage-1 fail stops before Stage-2 even under gatesOnly', async () => {
  const h = makeHarness({ stage1Verdict: 'fail' })
  const fn = workflowFn()
  const out = await fn({ ...baseArgs, gatesOnly: true }, h.agent, h.parallel, h.phase, h.log)
  assert.equal(out.stopped, 'stage1-failed', 'a Stage-1 fail stops the funnel')
  assert.ok(!fired(h.dispatches, 'stage2-review'), 'Stage-2 review never runs after a Stage-1 fail')
  assert.ok(!fired(h.dispatches, 'diagram-refresher'), 'no artifacts on a Stage-1 fail')
})

// ---------------------------------------------------------------------------
// AC2 (grep): ship-spec/SKILL.md outcome-routing -- a fix re-runs the gate phase
// (gatesOnly), and the artifact phase is named run-once-on-green.
// ---------------------------------------------------------------------------
test('AC2: ship-spec outcome-routing names gatesOnly re-run + run-once-on-green artifacts', () => {
  const src = read(SHIP_SPEC)
  assert.ok(/gatesOnly/.test(src), 'ship-spec must name the gatesOnly re-run path')
  assert.ok(/run-once-on-green/.test(src), 'ship-spec must name the artifact phase as run-once-on-green')
  // The fix routing must tie the re-run to the GATE phase, not the whole funnel.
  assert.ok(/re-run[^.]*gate/i.test(src) || /gate[^.]*re-run/i.test(src),
    'ship-spec outcome-routing must say a fix re-runs the gate phase')
})

// ---------------------------------------------------------------------------
// Lockstep guard: the launchable keeps exactly one export (export const meta).
// ---------------------------------------------------------------------------
test('lockstep: ship-review-workflow.js keeps exactly one export (export const meta)', () => {
  const src = read(WORKFLOW)
  const exports = src.match(/^export\s+/gm) || []
  assert.equal(exports.length, 1, 'exactly one top-level export')
  assert.ok(/export\s+const\s+meta\s*=/.test(src), 'the one export is `export const meta`')
})
