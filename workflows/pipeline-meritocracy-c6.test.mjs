// RED test for pipeline-meritocracy chunk 6: a registration-lag agentType miss
// becomes a CLEAN, NAMED, COO-recoverable pipeline failure instead of an uncaught
// crash; the cockpit prechecks agent-file presence before launch; the skill documents
// the live-registration bootstrap rule.
//
// THE LIVE FAILURE THIS PINS (chunk 3, on-chain-analyst): a Workflow snapshots its
// agent registry AT LAUNCH, so a newly-merged agent file not yet registered in the
// running session crashes the whole workflow with an uncaught `agent type 'X' not
// found` AFTER the build committed (orphan ambiguity). meritocracy-judge merged but
// was not yet registered when chunk 3 launched, crashing the pipeline mid-review.
//
// Pins the FULL acceptance contract (dispatch payload chunk 6):
//   AC1 a judge/any-configurable agentType dispatch hitting `agent type 'X' not found`
//       yields { status:'failed', reason:'agenttype-unavailable', agentType:'X',
//       buildOutcome preserved }, NOT an uncaught throw (tested via the pure helper
//       AND via the live pipeline run through an AsyncFunction with a throwing stub)
//   AC2 scripts/agenttype_precheck.mjs exits 0 when all agent files present, non-zero
//       naming missing ones (default + heavy)
//   AC3 cockpit SKILL.md documents the precheck call + the bootstrap live-registration rule
//   AC4 node --test green + anti-tautology
//   AC5 worker-pipeline.js parse-validates (the new AsyncFunction)
//   Edge: a NON-agenttype error from agent() still propagates (real errors not swallowed)
//   Edge: build-did-commit is reported in the failed bundle (the COO can recover the orphan)
//   Edge: precheck heavy enumerates the adversarial + -heavy variants
//
// Test strategy: import the new PURE lib (workflows/agenttype-precheck.mjs) for the
// classifier + bundle-builder + tier-enumeration behavior (the lockstep canonical
// source). worker-pipeline.js is a non-importable Workflow script (top-level await +
// host globals): assert the inlined lockstep copy at SOURCE level AND drive it as an
// AsyncFunction with a stub `agent()` that THROWS the not-found error -- the strongest
// proof that the wrap catches it and returns the terminal bundle rather than throwing.
// The precheck CLI is RUN via execFileSync (real exit codes). Anti-tautology: the
// not-found match is verified against a string the helper never authored (the harness's
// own real error text), and a non-not-found error string must NOT classify.
//
// Run:        node --test workflows/pipeline-meritocracy-c6.test.mjs
// Full suite (GLOB form -- bare `node --test workflows/` errors MODULE_NOT_FOUND on Node v25):
//   node --test 'workflows/*.test.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  isAgentTypeNotFoundError,
  extractMissingAgentType,
  agentUnavailableBundle,
  expectedAgentTypesForTier,
} from './agenttype-precheck.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const abs = (rel) => join(root, rel)

const PIPE = 'workflows/worker-pipeline.js'
const PIPE_SRC = read(PIPE)
const LIB = 'workflows/agenttype-precheck.mjs'
const PRECHECK_CLI = 'scripts/agenttype_precheck.mjs'
const COCKPIT = 'skills/cockpit/SKILL.md'

// The em-dash character the kernel style rule forbids (U+2014). Built from bytes so
// THIS test file's own source never carries the literal char it sweeps for.
const EM_DASH = Buffer.from([0xe2, 0x80, 0x94]).toString('utf8')

// The harness's REAL not-found error text (verbatim from the agents-do-not-hot-reload
// memory + the chunk-3 live crash). The helper must match THIS, not a string it wrote.
const REAL_NOT_FOUND =
  "agent type 'meritocracy-judge' not found. Available agents: build-agent, build-agent-heavy, chunk-reviewer, fixer"

// ---------------------------------------------------------------------------
// AC1 (part 1): the PURE classifier + bundle-builder
// ---------------------------------------------------------------------------

test('AC1: isAgentTypeNotFoundError matches the harness real not-found error text', () => {
  assert.equal(isAgentTypeNotFoundError(new Error(REAL_NOT_FOUND)), true)
  // robust: matches the message whether it arrives as an Error or a bare string
  assert.equal(isAgentTypeNotFoundError(REAL_NOT_FOUND), true)
  // matches the minimal form too (no "Available agents" tail)
  assert.equal(isAgentTypeNotFoundError(new Error("agent type 'fixer-heavy' not found")), true)
})

test('AC1 anti-tautology: a NON-not-found error does NOT classify as not-found', () => {
  // A real error (a thrown TypeError from inside the agent, a timeout, a schema
  // violation) must NOT be swallowed as agenttype-unavailable.
  assert.equal(isAgentTypeNotFoundError(new Error('schema validation failed: missing field commitSha')), false)
  assert.equal(isAgentTypeNotFoundError(new Error('fetch failed: ETIMEDOUT')), false)
  assert.equal(isAgentTypeNotFoundError(new Error("Tool 'agent' is not available")), false)
  assert.equal(isAgentTypeNotFoundError(null), false)
  assert.equal(isAgentTypeNotFoundError(undefined), false)
})

test('AC1: extractMissingAgentType pulls the agentType name out of the error', () => {
  assert.equal(extractMissingAgentType(new Error(REAL_NOT_FOUND)), 'meritocracy-judge')
  assert.equal(extractMissingAgentType(new Error("agent type 'fixer-heavy' not found")), 'fixer-heavy')
  // a non-not-found error yields null (nothing to extract)
  assert.equal(extractMissingAgentType(new Error('boom')), null)
})

test('AC1: agentUnavailableBundle builds the terminal failed bundle with buildOutcome preserved', () => {
  const buildOutcome = { committed: true, reviewSha: 'abc123', status: 'review', message: '' }
  const b = agentUnavailableBundle({
    chunkId: 7,
    worktree: '/tmp/wt',
    branch: 'feat/x-chunk-7',
    agentType: 'meritocracy-judge',
    buildOutcome,
    phase: 'JUDGE',
  })
  // status maps to the cockpit's only quarantine status
  assert.equal(b.status, 'failed', 'status must be failed (the cockpit routes only awaiting-review|failed)')
  // the named, recoverable reason
  assert.equal(b.review.reason, 'agenttype-unavailable', 'reason names the relaunch condition')
  // the missing agentType is named
  assert.equal(b.review.agentType, 'meritocracy-judge')
  // buildOutcome is PRESERVED verbatim (so a committed build is reported, not orphaned)
  assert.deepEqual(b.buildOutcome, buildOutcome, 'buildOutcome must ride the bundle so the COO can recover the orphan')
  // identity fields carried through for the cockpit relay
  assert.equal(b.chunkId, 7)
  assert.equal(b.worktree, '/tmp/wt')
})

test('Edge: agentUnavailableBundle reports build-did-commit so the COO can recover the orphan', () => {
  // The whole point: the not-found crash happened AFTER the build committed. The
  // failed bundle must carry the committed sha so the orphan is recoverable, not lost.
  const buildOutcome = { committed: true, reviewSha: 'deadbeef', status: 'review', message: '' }
  const b = agentUnavailableBundle({ chunkId: 3, agentType: 'meritocracy-judge', buildOutcome, phase: 'JUDGE' })
  assert.equal(b.buildOutcome.committed, true)
  assert.equal(b.buildOutcome.reviewSha, 'deadbeef')
  // and the human-readable failure reason names the relaunch condition
  assert.match(
    String(b.review.failureReason || ''),
    /agent type|not found|registration|relaunch/i,
    'the failure reason must name the not-found / registration-lag relaunch condition',
  )
})

// ---------------------------------------------------------------------------
// AC1 (part 2): the LIVE pipeline -- a throwing stub yields the bundle, not a throw
// ---------------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Build a runnable AsyncFunction from the launchable .js, minus the top-level
// `export const meta = { ... }` literal (export is illegal inside a function body).
// Constructing it ALSO parse-validates the source (the constructor throws on a syntax
// error) -- this is the AC5 parse-validation hook.
function workflowFn() {
  const body = PIPE_SRC.replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\n\}\n/, '')
  return new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)
}

// A stub harness whose build-agent commits (advances HEAD past baseRef) but whose
// JUDGE dispatch throws the not-found error -- the exact chunk-3 shape.
function makeHarness({ judgeThrows, judgeError } = {}) {
  const dispatches = []
  const agent = async (prompt, opts) => {
    const at = (opts && opts.agentType) || null
    const label = (opts && opts.label) || null
    dispatches.push({ agentType: at, label, phase: opts && opts.phase })
    // BUILD: report a green commit that advanced past baseRef
    if (opts && opts.phase === 'BUILD') {
      return {
        branch: 'feat/x-chunk-6', green: true, commitSha: 'COMMIT_SHA',
        redStateRecord: 'red', summary: 's', explanation: 'e', proof: 'p',
        specUpdateSummary: 'u', recallEvidence: { searchTerms: 'x', surfacedEntries: 'none relevant' },
        recallVerify: [],
      }
    }
    // REVIEW reviewers: clean
    if (opts && opts.phase === 'REVIEW') {
      return { ran: true, clean: true, findings: [], note: 'none' }
    }
    // JUDGE / fixer: throw the configured error on the judge dispatch. baseArgs.tier
    // is 'heavy', so chunk 9's judgeFor dial dispatches 'meritocracy-judge-heavy'
    // (the heavy-tier judge file), not the base 'meritocracy-judge'.
    if (at === 'meritocracy-judge-heavy' && judgeThrows) {
      throw (judgeError || new Error(REAL_NOT_FOUND))
    }
    if (at === 'meritocracy-judge-heavy') {
      return { verdict: 'CLEAN', fixList: [], issueLog: [], issueLogPath: '/tmp/log' }
    }
    return {}
  }
  const parallel = async (fns) => Promise.all(fns.map((f) => f()))
  const phase = () => {}
  const log = () => {}
  return { agent, parallel, phase, log, dispatches }
}

const baseArgs = {
  chunkId: 6,
  specSlug: 'pipeline-meritocracy',
  branch: 'feat/pipeline-meritocracy-chunk-6',
  worktree: '/tmp/wt-chunk-6',
  taskStatement: 't',
  acceptanceCriteria: 'a',
  tier: 'heavy',
  // baseRef present + a commitSha that differs => committed (partial-ground-truth path)
  baseRef: 'BASE_SHA',
}

test('AC1 LIVE: a JUDGE not-found throw yields the terminal failed bundle, NOT an uncaught throw', async () => {
  const h = makeHarness({ judgeThrows: true })
  const fn = workflowFn()
  let bundle
  await assert.doesNotReject(
    async () => { bundle = await fn(baseArgs, h.agent, h.parallel, h.phase, h.log) },
    'the not-found error must be caught and turned into a bundle, never thrown uncaught',
  )
  assert.ok(bundle, 'the pipeline must RETURN a bundle')
  assert.equal(bundle.status, 'failed', 'a not-found dispatch maps to the failed status')
  assert.equal(bundle.review.reason, 'agenttype-unavailable', 'the bundle names the agenttype-unavailable reason')
  assert.equal(bundle.review.agentType, 'meritocracy-judge', 'the bundle names the missing agentType')
  // buildOutcome PRESERVED: the build committed (HEAD advanced past baseRef)
  assert.ok(bundle.buildOutcome, 'buildOutcome must ride the failed bundle')
  assert.equal(bundle.buildOutcome.committed, true, 'the committed build must be reported, not orphaned')
})

test('Edge LIVE: a NON-not-found JUDGE error still PROPAGATES (real errors are not swallowed)', async () => {
  const realError = new Error('judge schema validation failed: verdict missing')
  const h = makeHarness({ judgeThrows: true, judgeError: realError })
  const fn = workflowFn()
  await assert.rejects(
    async () => { await fn(baseArgs, h.agent, h.parallel, h.phase, h.log) },
    /schema validation failed/,
    'a non-agenttype error must propagate -- only `agent type X not found` is caught',
  )
})

// ---------------------------------------------------------------------------
// AC5: worker-pipeline.js parse-validates + the inlined lockstep copy
// ---------------------------------------------------------------------------

test('AC5: worker-pipeline.js parse-validates as an AsyncFunction (the new wrap is valid JS)', () => {
  assert.doesNotThrow(() => workflowFn(), 'building the AsyncFunction must not throw a SyntaxError')
})

test('AC5 lockstep: worker-pipeline.js inlines the not-found classifier (lockstep with the lib)', () => {
  // The Workflow sandbox has no module resolution, so the classifier must be inlined.
  assert.ok(
    /function isAgentTypeNotFoundError/.test(PIPE_SRC),
    `${PIPE} must inline isAgentTypeNotFoundError (lockstep copy of the lib).`,
  )
  assert.ok(
    /agenttype-unavailable/.test(PIPE_SRC),
    `${PIPE} must build the agenttype-unavailable failed bundle inline.`,
  )
})

test('AC5 lockstep: the inlined classifier names agenttype-precheck.mjs as the canonical source', () => {
  // The lockstep discipline (a-workflow-script-s-verbatim-inlined-lib-copy): the inline
  // copy must point at its canonical lib so a future editor keeps the two in lockstep.
  assert.match(PIPE_SRC, /agenttype-precheck\.mjs/, `${PIPE} must reference the canonical lib path in a lockstep comment.`)
})

// ---------------------------------------------------------------------------
// AC1 enumeration + Edge: expectedAgentTypesForTier
// ---------------------------------------------------------------------------

test('AC2: expectedAgentTypesForTier(default) enumerates the default pipeline agentTypes', () => {
  const types = expectedAgentTypesForTier('default')
  assert.ok(Array.isArray(types))
  for (const t of ['build-agent', 'chunk-reviewer', 'meritocracy-judge', 'fixer']) {
    assert.ok(types.includes(t), `default tier must enumerate ${t}`)
  }
  // default must NOT pull in the heavy-only files
  assert.ok(!types.includes('build-agent-heavy'), 'default tier must not enumerate build-agent-heavy')
})

test('Edge: expectedAgentTypesForTier(heavy) enumerates the -heavy variants', () => {
  const types = expectedAgentTypesForTier('heavy')
  // chunk 9 made the judge chunk-tier-matched (judgeFor): heavy enumerates
  // meritocracy-judge-heavy, not the base meritocracy-judge.
  for (const t of ['build-agent-heavy', 'chunk-reviewer-heavy', 'meritocracy-judge-heavy', 'fixer-heavy']) {
    assert.ok(types.includes(t), `heavy tier must enumerate ${t}`)
  }
})

// The fixer is NOT chunk-tier-matched: fixerFor(findings) in tier-dispatch.mjs dials
// the fixer agentType by the FIX-tier (the MAX [FIX:<C|B|A|S>] rank across the judge's
// fixList), independent of the chunk's BUILD tier. So a default-tier chunk whose
// fixList carries a [FIX:A]/[FIX:S] finding dispatches `fixer-heavy`, and a heavy-tier
// chunk with only [FIX:C]/[FIX:B] findings dispatches plain `fixer`. BOTH fixer files
// are therefore reachable from EITHER tier, so the precheck must enumerate BOTH
// variants regardless of tier -- otherwise a missing/unmerged agents/fixer-heavy.md
// PASSES the default precheck, then the chunk builds + commits + reviews and fails at
// the fixer dispatch: exactly the costly post-commit path the pre-launch loud-reject
// precheck exists to prevent.
test('BUG: expectedAgentTypesForTier enumerates BOTH fixer variants (fixer is FIX-tier-dialed, not chunk-tier-dialed)', () => {
  for (const tier of ['default', 'heavy']) {
    const types = expectedAgentTypesForTier(tier)
    assert.ok(
      types.includes('fixer'),
      `tier '${tier}' must enumerate 'fixer' -- a chunk with only [FIX:C/B] findings dispatches plain fixer regardless of build tier`,
    )
    assert.ok(
      types.includes('fixer-heavy'),
      `tier '${tier}' must enumerate 'fixer-heavy' -- a chunk with a [FIX:A/S] finding dispatches fixer-heavy regardless of build tier`,
    )
  }
})

// ---------------------------------------------------------------------------
// AC2: the precheck CLI (real exit codes)
// ---------------------------------------------------------------------------

test('AC2: scripts/agenttype_precheck.mjs exists and is executable', () => {
  assert.ok(existsSync(abs(PRECHECK_CLI)), `${PRECHECK_CLI} must exist`)
  const mode = statSync(abs(PRECHECK_CLI)).mode
  assert.ok((mode & 0o111) !== 0, `${PRECHECK_CLI} must be executable (chmod +x)`)
})

test('AC2: precheck exits 0 when all agent files are present (default + heavy)', () => {
  for (const tier of ['default', 'heavy']) {
    // execFileSync throws on a non-zero exit; a clean run returns the stdout.
    assert.doesNotThrow(
      () => execFileSync('node', [abs(PRECHECK_CLI), tier], { cwd: root, encoding: 'utf8' }),
      `precheck ${tier} must exit 0 when every agents/<name>.md is present`,
    )
  }
})

test('AC2: precheck exits NON-ZERO naming the missing file when an agent file is absent', () => {
  // Point the precheck at an empty temp dir (no agents/) via --agents-dir so no file
  // is found; it must exit non-zero AND name a missing agentType.
  let threw = false
  let stderr = ''
  try {
    execFileSync('node', [abs(PRECHECK_CLI), 'heavy', '--agents-dir', '/tmp/__nonexistent_agents_dir__'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    threw = true
    stderr = String(e.stderr || '') + String(e.stdout || '')
  }
  assert.ok(threw, 'precheck must exit non-zero when an agent file is missing')
  assert.match(stderr, /meritocracy-judge|build-agent-heavy/, 'the non-zero output must NAME a missing agentType')
})

// ---------------------------------------------------------------------------
// AC3: cockpit SKILL.md documents the precheck call + the bootstrap rule
// ---------------------------------------------------------------------------

test('AC3: cockpit SKILL.md documents the agenttype_precheck call in the pre-launch step', () => {
  const doc = read(COCKPIT)
  assert.match(doc, /agenttype_precheck/, 'cockpit SKILL.md must name the precheck script')
})

test('AC3: cockpit SKILL.md documents the BOOTSTRAP live-registration rule', () => {
  const doc = read(COCKPIT)
  // The rule: a new agentType added in an earlier chunk must be confirmed registered
  // (the harness "New agent types now available" signal) before launching a dependent
  // chunk whose pipeline dispatches it, because the Workflow snapshots its registry at launch.
  assert.match(doc, /New agent types now available/,
    'cockpit SKILL.md must name the harness live-registration signal')
  assert.match(doc, /snapshot/i, 'cockpit SKILL.md must explain the Workflow registry snapshot-at-launch reason')
})

// ---------------------------------------------------------------------------
// AC4: 0 em-dashes in the new artifacts
// ---------------------------------------------------------------------------

test('AC4: the new lib, the precheck CLI, and the test carry 0 em-dashes', () => {
  for (const rel of [LIB, PRECHECK_CLI]) {
    assert.ok(!read(rel).includes(EM_DASH), `${rel} must carry 0 em-dashes`)
  }
})
