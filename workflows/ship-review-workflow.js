export const meta = {
  name: 'ship-review-workflow',
  description: 'The SEQUENTIAL ship funnel the thin ship-spec skill fires before any merge to main, now SPLIT into a re-runnable GATE phase and a run-once ARTIFACT phase. GATE phase: Stage-1 live-run (drive the built system end-to-end; empirical gate) -> ONLY IF IT PASSES Stage-2 full-spec code review (Opus reviewer alongside a Codex lens). A failing Stage-1 STOPS the funnel (C4 fix: sequential, never parallel; do not spend the deep review on something that does not run). ARTIFACT phase (args.artifactsOnly): the diagram-refresher + the demo-assembler, fired ONCE on the final clean gate pass against the as-built system. args.gatesOnly returns after Stage-2 with no artifacts so a fix re-runs only the gates. Returns everything as data ({ stage1, stage2, diagrams, demo, stopped, phase }); writes NOTHING -- the COO presents the demo, takes the CEO GO, and executes every side effect.',
  phases: [
    { title: 'STAGE1', detail: 'one live-run agent (opus) drives the built system end-to-end on real input and returns a runs-correctly verdict + evidence; fail -> the funnel stops here', model: 'opus' },
    { title: 'STAGE2', detail: 'only if Stage-1 passed: full-spec code review (one opus reviewer over the aggregate diff vs the spec goal + non-goals, alongside one agent shelling to scripts/codex-review.sh for the cross-model lens). Gates only; the diagram refresh is NOT in this barrier anymore (it moved to the run-once artifact phase)', model: 'opus' },
    { title: 'REFRESH', detail: 'artifact phase only (args.artifactsOnly): the ONE self-sufficient diagram-refresher dispatch, judged against the as-built (final) system, run once after the final clean gate pass', model: 'sonnet' },
    { title: 'DEMO', detail: 'artifact phase only: one demo-assembler (sonnet) drafts the Stage-3 narrated demonstration from the final Stage-1 evidence + Stage-2 verdict (threaded in by the COO) for the CEO go/no-go', model: 'sonnet' },
  ],
}

// ============================================================================
// ship-review-workflow.js -- the launchable Workflow script the thin `ship-spec`
// skill fires at ship (E1). args: { specSlug, specPath, project, branch, baseRef,
// topTier, specTrio, whatShipped, conventionsRef, gatesOnly, artifactsOnly,
// stage1Evidence, stage2Verdict }.
//
// Operating model (COO / workers): the operator = CEO (vision + verdict); the COO (the
// long-running main session) ORCHESTRATES and is the SOLE WRITER of shared state.
// This workflow is a worker funnel: every agent it spawns DRAFTS or REPORTS only.
// It writes NOTHING -- Workflow scripts have no filesystem access by design; the
// COO applies every side effect (vault writes, archive, merge, grader trigger,
// redesign commits) after this returns.
//
// TWO PHASES (coo-simplification C3). The funnel is split so a fix re-runs only
// the cheap gates, not the two expensive artifact producers the fix did not
// invalidate:
//   * GATE phase (default, and args.gatesOnly): Stage-1 live-run -> Stage-2
//     review + Codex. With args.gatesOnly it RETURNS after Stage-2 -- no diagram
//     refresh, no demo -- so a Stage-2 fix re-runs only this phase.
//   * ARTIFACT phase (args.artifactsOnly): the diagram-refresher + the demo,
//     fired ONCE on the final clean gate pass. It does NOT re-run Stage-1/Stage-2;
//     the COO threads in the final stage1Evidence + stage2Verdict via args.
// With neither flag the body runs the gates THEN the artifacts in one pass
// (the back-compatible linear path); the COO uses the two flags to phase a ship.
//
// THE FUNNEL IS SEQUENTIAL (C4 fix). Stage-1 is the empirical gate: drive the
// built system end-to-end on real input. Stage-2 is the analytical gate: the
// deep full-spec review. Stage-1 GATES Stage-2 -- a build that does not run is
// not worth the deep review, so a failing Stage-1 returns immediately with
// stopped: 'stage1-failed' and the COO routes back to the fix-loop. Within
// Stage-2 the reviewer and the Codex lens run in one barrier (independent reads
// that both only matter for a build that runs); that intra-barrier concurrency
// does not touch the Stage-1 -> Stage-2 sequence.
//
// THE DIAGRAM REFRESH IS ONE DISPATCH (G1), now in the ARTIFACT phase. The COO
// does no per-diagram detection or dispatch: one self-sufficient
// `diagram-refresher` agent receives just project + what-shipped + the
// conventions reference, itself lists the project's diagrams, judges each
// stale-or-current against the AS-BUILT (final) system, refreshes the stale set,
// and returns the whole set as drafts. Judging against the as-built system is
// MORE correct run-once-at-end than mid-gate-loop. (The old fan-out of one
// refresher per pre-detected diagram, with a capture-drafter arm, is retired
// from this path: capture now flows through the grader -- C5 fix.)
//
// Mirrors grader-workflow.js / worker-pipeline.js conventions: a pure-literal
// `export const meta` split off and validated separately; the body runs in an
// async context (top-level await + return are fine); `args` may arrive as a
// parsed object OR a JSON string, so it is normalized at the top. Plain
// JavaScript, no imports (the harness body is not a module surface);
// Date.now()/Math.random are unavailable in this context and are not used.
// ============================================================================

// args may arrive as a parsed object or a JSON string (the Workflow `args`
// field has no declared schema type). Tolerate both, as grader-workflow.js does.
let a = args || {}
if (typeof a === 'string') {
  try { a = JSON.parse(a) } catch (e) { a = {} }
}

const specSlug = a.specSlug || '(unspecified spec)'
const specPath = a.specPath || '~/.claude/specs/current.md'
const project = a.project || '(unspecified project)'
const branch = a.branch || '(unspecified feature branch)'
const baseRef = a.baseRef || 'main'

// The spec's top tier scales review depth (S-tier spec -> deepest effort on
// both lenses; the Codex flag maps tier -> model+effort inside codex-review.sh).
const topTier = a.topTier || 'B'

// The spec trio: the spec's overall current-state + changes + end-state, which
// the full-spec review receives alongside the whole feat-vs-main diff.
const specTrio = a.specTrio || null

// One-paragraph summary of what shipped, threaded to the diagram refresher and
// the demo assembler so both work from the same ship story.
const whatShipped = a.whatShipped || '(no what-shipped summary provided)'

// The diagram conventions reference the self-sufficient refresher follows.
const conventionsRef = a.conventionsRef || '~/Documents/brain/wiki/diagram-conventions.md'

// Phase selectors (coo-simplification C3). gatesOnly returns after Stage-2 (a fix
// re-runs only the gates); artifactsOnly runs ONLY the run-once artifact phase
// (diagram refresh + demo) against the final clean gate result. With neither set,
// the body runs gates then artifacts in one linear pass (back-compat).
const gatesOnly = a.gatesOnly === true
const artifactsOnly = a.artifactsOnly === true

// The artifact phase does NOT re-run the gates; the COO threads the final clean
// gate result in so the demo drafts from the same evidence the gates produced.
const finalStage1Evidence = a.stage1Evidence != null ? a.stage1Evidence : '(stage-1 evidence not threaded)'
const finalStage2Verdict = a.stage2Verdict != null ? a.stage2Verdict : '(stage-2 verdict not threaded)'

// Operating-model context threaded into every agent prompt.
const operatingModel = [
  `Operating model: the operator is the CEO (vision + verdict). The COO (the long-running`,
  `main session) orchestrates and is the SOLE WRITER of shared state. You are a`,
  `WORKER: you report or draft only and write NOTHING shared (no vault, no memory,`,
  `no specs/, no commits). The COO applies every side effect after this funnel returns.`,
].join('\n')

const specContext = [
  `Spec being shipped: ${specSlug} (${specPath})`,
  `Project: ${project}`,
  `Feature branch: ${branch} (review against ${baseRef})`,
  `Spec top tier: ${topTier}`,
  specTrio ? `Spec trio (current-state / changes / end-state):\n${JSON.stringify(specTrio, null, 2)}` : `Spec trio: (not threaded; read the spec at ${specPath})`,
].join('\n')

// ---- Agent return schemas ---------------------------------------------------

// STAGE1_SCHEMA -- the live-run verdict. Empirical, not analytical: the agent
// RAN the system and reports what it observed, with evidence per claim.
const STAGE1_SCHEMA = {
  type: 'object',
  required: ['verdict', 'evidence', 'failures'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'], description: 'pass = the built system ran end-to-end correctly on real input; fail = it did not (any crash, wrong output, or unrunnable entry point)' },
    evidence: { type: 'string', description: 'what was run and what was observed: the commands/flows driven, real input used, observed output. Live evidence the Stage-3 demo can embed; never "looks right"' },
    failures: {
      type: 'array',
      description: 'one entry per observed failure; EMPTY on a pass',
      items: {
        type: 'object',
        required: ['what', 'evidence'],
        additionalProperties: false,
        properties: {
          what: { type: 'string', description: 'the failure in one line' },
          evidence: { type: 'string', description: 'the observed output/stack/wrong value proving it' },
        },
      },
    },
  },
}

// STAGE2_REVIEW_SCHEMA -- the full-spec reviewer's findings. Truth-calibrated:
// CLEAN is the expected result for a sound build; every finding carries evidence.
const STAGE2_REVIEW_SCHEMA = {
  type: 'object',
  required: ['result', 'findings'],
  additionalProperties: false,
  properties: {
    result: { type: 'string', enum: ['CLEAN', 'FINDINGS'], description: 'CLEAN = no real findings; FINDINGS = at least one evidenced finding below' },
    findings: {
      type: 'array',
      description: 'integration/coherence/mirror-surface findings against the spec goal + non-goals; EMPTY on CLEAN',
      items: {
        type: 'object',
        required: ['what', 'where', 'severity', 'evidence'],
        additionalProperties: false,
        properties: {
          what: { type: 'string', description: 'the finding in one line' },
          where: { type: 'string', description: 'file:line or surface' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'blast radius' },
          evidence: { type: 'string', description: 'the quoted code/diff hunk proving it; no finding without evidence' },
        },
      },
    },
  },
}

// CODEX_SCHEMA -- the cross-model lens. The agent shells to scripts/codex-review.sh
// and reports its parsed output verbatim (RESULT: CLEAN / RESULT: FINDINGS=n).
const CODEX_SCHEMA = {
  type: 'object',
  required: ['result', 'findings'],
  additionalProperties: false,
  properties: {
    result: { type: 'string', enum: ['CLEAN', 'FINDINGS', 'ERROR'], description: 'parsed from the script RESULT line; ERROR when the script could not run (exit >= 2)' },
    findings: { type: 'array', items: { type: 'string' }, description: 'the [P<n>] finding lines verbatim; EMPTY on CLEAN or ERROR' },
    note: { type: 'string', description: 'on ERROR, what failed (command + observed output); otherwise "none"' },
  },
}

// REFRESH_SCHEMA -- the self-sufficient diagram refresh of the WHOLE project set
// in one dispatch. The agent lists, judges, refreshes, and returns; the COO
// applies the drafts sole-writer.
const REFRESH_SCHEMA = {
  type: 'object',
  required: ['listed', 'judgedStale', 'diagrams', 'note'],
  additionalProperties: false,
  properties: {
    listed: { type: 'integer', description: 'how many project diagrams the agent found when it listed them itself' },
    judgedStale: { type: 'integer', description: 'how many of those it judged stale against the as-built system' },
    diagrams: {
      type: 'array',
      description: 'one draft per STALE diagram (current diagrams are reported in the counts, not redrawn); EMPTY when nothing is stale',
      items: {
        type: 'object',
        required: ['name', 'status', 'mermaid', 'prose', 'note'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'the diagram page name (e.g. L3-worker-pipeline) so the COO can map it to its vault path' },
          status: { type: 'string', enum: ['new', 'updated'], description: 'new = a gap the agent filled; updated = a stale diagram redrawn' },
          mermaid: { type: 'string', description: 'the redrawn Mermaid body, drafted from the as-built code' },
          prose: { type: 'string', description: 'the refreshed plain-English companion paragraph' },
          note: { type: 'string', description: 'apply-time caveat (frontmatter to bump, a gap) or "none"' },
        },
      },
    },
    note: { type: 'string', description: 'anything the COO needs at apply time, or "none"' },
  },
}

// DEMO_SCHEMA -- the drafted Stage-3 narrated demonstration.
const DEMO_SCHEMA = {
  type: 'object',
  required: ['narration', 'evidenceRefs', 'note'],
  additionalProperties: false,
  properties: {
    narration: { type: 'string', description: 'the four-beat story (we took this / did that / got this result / which means this), plain English, every technical term unpacked' },
    evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'pointers to the evidence behind each result claim (captured run output, paths, worked examples)' },
    note: { type: 'string', description: 'any gap the COO should know before presenting, or "none"' },
  },
}

// ============================================================================
// ARTIFACT PHASE -- the run-once producers (diagram refresh + demo). Fired ONCE
// on the final clean gate pass, never re-run on a fix. Sources its inputs from
// the threaded-in final gate result (stage1Evidence + stage2Verdict), so it does
// NOT re-run Stage-1 or Stage-2. Returns { diagrams, demo }.
// ============================================================================
async function runArtifactPhase(stage1Evidence, stage2Verdict) {
  phase('REFRESH')
  const refresh = await agent(
    [
      `You are the self-sufficient diagram-refresher dispatch of the ship funnel for spec "${specSlug}".`,
      operatingModel,
      ``,
      specContext,
      ``,
      `What shipped: ${whatShipped}`,
      `Conventions reference: ${conventionsRef}`,
      ``,
      `This is the run-once ARTIFACT phase, fired after the final clean gate pass.`,
      `Follow your standing contract (agents/diagram-refresher.md): list the project's`,
      `diagram pages yourself, judge each stale-or-current against the AS-BUILT (final)`,
      `system, refresh the stale ones, and return the whole set as drafts in one pass.`,
      `Echo the listed / judgedStale counts so the COO can see the sweep happened even`,
      `when nothing was stale. Draft only; the COO applies your drafts to the vault.`,
    ].join('\n'),
    { agentType: 'diagram-refresher', label: 'diagram-refresh', phase: 'REFRESH', schema: REFRESH_SCHEMA }
  )

  phase('DEMO')
  const demo = await agent(
    [
      `You are the demo-assembler drafting the Stage-3 demonstration for the ship of spec "${specSlug}".`,
      operatingModel,
      ``,
      specContext,
      ``,
      `PULL path: the ask is "demonstrate what this spec shipped" for the CEO go/no-go;`,
      `the scope is the spec's shipped surfaces. What shipped: ${whatShipped}`,
      ``,
      `Source your evidence from the final clean gate result rather than re-running everything:`,
      `Stage-1 live evidence:\n${JSON.stringify(stage1Evidence)}`,
      `Stage-2 review verdict: ${stage2Verdict}.`,
      ``,
      `Draft the four-beat narration (we took this / did that / got this result / which`,
      `means this) per your standing contract (agents/demo-assembler.md), plain English,`,
      `every technical term unpacked, each result claim backed by an evidence ref.`,
    ].join('\n'),
    { agentType: 'demo-assembler', label: 'stage3-demo', phase: 'DEMO', schema: DEMO_SCHEMA }
  )

  return {
    diagrams: refresh || { listed: 0, judgedStale: 0, diagrams: [], note: 'refresh arm returned nothing' },
    demo: demo || null,
  }
}

// ARTIFACT-ONLY ENTRY (coo-simplification C3). The COO fires this ONCE after the
// final clean gate pass, threading the final gate result in. It runs ONLY the
// run-once producers -- no Stage-1, no Stage-2 -- so a re-run never reaches here.
if (artifactsOnly) {
  const artifacts = await runArtifactPhase(finalStage1Evidence, finalStage2Verdict)
  return {
    stage1: null,
    stage2: null,
    diagrams: artifacts.diagrams,
    demo: artifacts.demo,
    stopped: null,
    phase: 'artifacts',
  }
}

// ============================================================================
// STAGE1 -- the live run-through. Empirical gate, one opus agent.
// ============================================================================
phase('STAGE1')
const stage1 = await agent(
  [
    `You are the Stage-1 LIVE-RUN gate of the ship funnel for spec "${specSlug}".`,
    operatingModel,
    ``,
    specContext,
    ``,
    `Drive the BUILT system end-to-end on real input and observe whether it runs`,
    `correctly. This is the empirical gate before any deep review: actually invoke`,
    `the shipped entry points (commands, scripts, workflows, hooks) on realistic`,
    `input and read the actual output. Reading the code is not running it; "looks`,
    `right" is not evidence. Review depth scales with the spec tier (${topTier}).`,
    ``,
    `Verdict discipline: "pass" requires every driven flow to have run correctly,`,
    `with the observed output quoted in evidence. ANY crash, wrong output, or`,
    `unrunnable entry point is a "fail" with one failures[] entry per problem.`,
    `Truth-calibrated: report what IS; do not manufacture failures and do not`,
    `paper over one.`,
  ].join('\n'),
  { label: 'stage1-live-run', phase: 'STAGE1', model: 'opus', schema: STAGE1_SCHEMA }
)

// THE GATE (C4 fix). A failing Stage-1 stops the funnel: no Stage-2 review, no
// diagram refresh, no demo. Return immediately with the explicit stopped marker
// so the COO routes back to the fix-loop and re-runs the funnel after the fix.
if (!stage1 || stage1.verdict !== 'pass') {
  return {
    stage1: stage1 || { verdict: 'fail', evidence: 'stage-1 agent returned nothing', failures: [{ what: 'no stage-1 return', evidence: 'empty agent result' }] },
    stage2: null,
    diagrams: null,
    demo: null,
    stopped: 'stage1-failed',
    phase: 'gates',
  }
}

// ============================================================================
// STAGE2 -- the deep review, only on a passing Stage-1. One barrier, two
// independent read-only arms: the opus full-spec reviewer and the Codex lens.
// The diagram refresh moved OUT of this barrier into the run-once artifact phase
// (coo-simplification C3) so a Stage-2 fix re-run never re-fires it.
// ============================================================================
phase('STAGE2')
const [review, codex] = await parallel([
  () => agent(
    [
      `You are the Stage-2 FULL-SPEC code reviewer of the ship funnel for spec "${specSlug}".`,
      operatingModel,
      ``,
      specContext,
      ``,
      `Stage-1 (the live run) already passed. Your job is the analytical gate: review`,
      `the AGGREGATE diff of the whole spec (git diff ${baseRef}...${branch}, or the`,
      `equivalent in the named worktree) against the spec's goal and non-goals. You are`,
      `the first reviewer to see the whole diff at once -- each per-chunk reviewer saw`,
      `only its own chunk -- so look specifically for what only the aggregate view shows:`,
      `integration and coherence gaps between chunks, mirror-surface drift (a value or`,
      `name restated across files where one restatement kept the old value), scope creep`,
      `against the non-goals, and dead code the spec's changes obsoleted but no chunk deleted.`,
      ``,
      `Truth-calibrated: CLEAN is the expected, correct result for a sound build; do not`,
      `manufacture findings. Every finding carries concrete evidence (the quoted hunk or`,
      `file:line). Review depth scales with the spec tier (${topTier}).`,
    ].join('\n'),
    { label: 'stage2-review', phase: 'STAGE2', model: 'opus', schema: STAGE2_REVIEW_SCHEMA }
  ),
  () => agent(
    [
      `You are the Stage-2 cross-model Codex lens of the ship funnel for spec "${specSlug}".`,
      operatingModel,
      ``,
      specContext,
      ``,
      `Stage-1 (the live run) already passed. Run the external Codex reviewer over the`,
      `spec's aggregate changes and report its parsed output verbatim:`,
      ``,
      `  scripts/codex-review.sh --base ${baseRef} --tier ${topTier} < /dev/null`,
      ``,
      `Run it from the repo root of the feature branch. The < /dev/null redirect is`,
      `mandatory (codex exec blocks forever on an open stdin pipe in non-interactive`,
      `contexts). Parse the output: RESULT: CLEAN -> result CLEAN; RESULT: FINDINGS=<n>`,
      `-> result FINDINGS with each [P<n>] line verbatim in findings. If the script`,
      `errors (exit >= 2) or the codex CLI is unavailable, return result ERROR with the`,
      `observed command output in note -- never fabricate a CLEAN.`,
    ].join('\n'),
    { label: 'stage2-codex', phase: 'STAGE2', model: 'sonnet', schema: CODEX_SCHEMA }
  ),
])

// GATES-ONLY RETURN (coo-simplification C3). When the COO is re-running the gates
// after a fix, it returns here -- after Stage-2, before any artifact producer. No
// diagram refresh, no demo: the fix did not invalidate them, so they are not re-run.
// The COO fires the artifact phase ONCE after the gates finally come back clean.
if (gatesOnly) {
  return {
    stage1,
    stage2: { review: review || null, codex: codex || null },
    diagrams: null,
    demo: null,
    stopped: null,
    phase: 'gates',
  }
}

// ============================================================================
// DEFAULT LINEAR PASS -- neither flag set: run the gates, then the run-once
// artifact phase, in one pass (the back-compatible single-shot ship). The demo
// drafts from THIS pass's Stage-1 evidence + Stage-2 verdict.
// ============================================================================
const stage2Verdict = `${review ? review.result : '(missing)'} (${review && review.findings ? review.findings.length : 0} findings); Codex lens: ${codex ? codex.result : '(missing)'}`
const artifacts = await runArtifactPhase(stage1.evidence, stage2Verdict)

// Assemble the return. Pure data; the COO presents the demo, takes the CEO GO,
// and only then merges, applies the diagram drafts, triggers the grader, and
// runs the redesign step (all documented in skills/ship-spec/SKILL.md).
return {
  stage1,
  stage2: { review: review || null, codex: codex || null },
  diagrams: artifacts.diagrams,
  demo: artifacts.demo,
  stopped: null,
  phase: 'full',
}
