// RED test for chunk C2: Subagent self-sufficiency audit + authoring convention.
//
// The A-split relocates four COO-only docs (communication-discipline,
// improvement-loop, reader-model, agent-dispatch) OUT of the worker autoload
// path. This chunk is the hard gate that guarantees no worker producing
// CEO/reviewer-facing output loses a rule it relied on, by making each
// self-carry its slice. The chunk's three acceptance criteria are:
//
//   AC1. ledgers/subagent-self-sufficiency-audit.md records a documented audit
//        verdict PER AGENT (every defined agents/*.md) plus the inline pipeline
//        stages (worker-pipeline.js CHECKPOINT/REVIEW).
//   AC2. Every CEO/reviewer-facing agent (demo-assembler,
//        chunk-reviewer, chunk-reviewer-heavy) is confirmed
//        SELF-SUFFICIENT in the ledger, AND the needed comm/altitude lines are
//        actually present in that agent's own file (the verdict must be backed
//        by the file carrying the guidance, not merely asserted).
//   AC3. The self-carry authoring convention line is present in
//        skills/writing-skills/SKILL.md (worker agents self-carry CEO-facing
//        comm guidance).
//
// This is a static-text acceptance check (the natural proof for an audit/prompt
// chunk, mirroring chunk 1's worker-return-quality.test.mjs): it reads the
// on-disk ledger, the agent files, and the skill doc as text and asserts the
// contract. It does NOT execute anything and does NOT pin exact prose -- only
// that the documented verdicts, the self-carried guidance, and the convention
// line exist, so the implementer keeps wording freedom. Agent files cannot be
// hot-reloaded mid-session, so grepping the on-disk contract IS the acceptance
// proof; the ledger IS the AC1 deliverable.
//
// Run: node --test workflows/subagent-self-sufficiency.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const LEDGER = 'ledgers/subagent-self-sufficiency-audit.md'
const CONVENTION_DOC = 'skills/writing-skills/SKILL.md'

// Agents covered by the chunk C2 self-sufficiency ledger. NOT the full agents/*.md set --
// build-agent{,-light,-heavy}, curator, prompt-reflector, session-* were added after
// chunk C2 and are not in the ledger. recall / test-author{,-light,-heavy} /
// implementer{,-light,-heavy} removed in chunk 9 (dead relay agents absorbed by
// the single build-agent in chunks 4/5).
const ALL_AGENTS = [
  'demo-assembler',
  'diagram-refresher',
  'chunk-reviewer-heavy',
  'chunk-reviewer',
]

// The CEO/reviewer-facing agents that must each be confirmed self-sufficient
// in the ledger AND self-carry the comm/altitude guidance in their own file.
const CEO_FACING = [
  { name: 'demo-assembler', file: 'agents/demo-assembler.md' },
  { name: 'chunk-reviewer', file: 'agents/chunk-reviewer.md' },
  { name: 'chunk-reviewer-heavy', file: 'agents/chunk-reviewer-heavy.md' },
]

// A per-agent verdict token the audit records. Matched case-insensitively and
// loosely so the implementer can word the classification freely
// (SELF-SUFFICIENT / NEEDS-ADDITION / N/A / NOT-CEO-FACING all qualify as "a
// documented verdict"); the point is each agent line carries a classification.
const VERDICT = /self[-\s]?suffic|needs?[-\s]addition|n\/?a\b|not[-\s]ceo|no[-\s]additions?/i

// --- AC1: the ledger exists and records a per-agent verdict for every agent ---

test('AC1: the audit ledger file exists', () => {
  assert.ok(
    existsSync(join(root, LEDGER)),
    `${LEDGER} is missing. It is the chunk's primary deliverable: the per-agent ` +
      `audit verdict trail. The audit must be written to disk, not just performed.`,
  )
})

for (const name of ALL_AGENTS) {
  test(`AC1: the ledger records a documented verdict for agent "${name}"`, () => {
    const body = existsSync(join(root, LEDGER)) ? read(LEDGER) : ''
    // The agent must be named in the ledger...
    const nameRe = new RegExp(`(^|[^-\\w])${name}(?![-\\w])`, 'm')
    assert.match(
      body,
      nameRe,
      `${LEDGER} does not name agent "${name}". The chunk must audit EVERY ` +
        `defined agents/*.md, not only the four CEO/reviewer-facing ones.`,
    )
    // ...and carry a classification verdict somewhere in the ledger.
    assert.match(
      body,
      VERDICT,
      `${LEDGER} names "${name}" but records no documented verdict ` +
        `(self-sufficient / needs-addition / not-CEO-facing). A name without a ` +
        `verdict is not an audit entry.`,
    )
  })
}

test('AC1: the ledger also audits the inline pipeline stages (CHECKPOINT/REVIEW)', () => {
  const body = existsSync(join(root, LEDGER)) ? read(LEDGER) : ''
  assert.match(
    body,
    /CHECKPOINT/,
    `${LEDGER} does not audit the inline CHECKPOINT pipeline stage. The chunk ` +
      `task audits "the inline pipeline stages (workflows/worker-pipeline.js ` +
      `CHECKPOINT/REVIEW prompts)" alongside the agents/*.md files.`,
  )
  assert.match(
    body,
    /REVIEW/,
    `${LEDGER} does not audit the inline REVIEW pipeline stage.`,
  )
})

// --- AC2: every CEO/reviewer-facing agent confirmed self-sufficient + self-carries ---

// Comm/altitude guidance the relocated communication-discipline used to supply,
// which a CEO/reviewer-facing agent must now self-carry. Matched loosely: the
// agent's own prompt must reference the altitude split (worker-level vs
// CEO-level routing) OR a plain-English / translation bar for the CEO read.
const SELF_CARRIED_COMM =
  /worker[-\s]level|ceo[-\s]level|altitude|plain[-\s]english|every technical term/i

for (const { name, file } of CEO_FACING) {
  // Anchor on the agent name's own ledger line so the reviewer-prefix collision
  // (chunk-reviewer vs ...-heavy) does not let one verdict satisfy both.
  const lineRe = new RegExp(`^.*(^|[^-\\w])${name}(?![-\\w]).*$`, 'mi')

  test(`AC2: ledger confirms "${name}" SELF-SUFFICIENT on its own line`, () => {
    const body = existsSync(join(root, LEDGER)) ? read(LEDGER) : ''
    const line = (body.match(lineRe) || [''])[0]
    assert.match(
      line,
      /self[-\s]?suffic/i,
      `${LEDGER} must confirm CEO/reviewer-facing agent "${name}" as ` +
        `SELF-SUFFICIENT (needed comm lines now present in its own prompt). ` +
        `Its ledger line was: ${JSON.stringify(line)}`,
    )
  })

  test(`AC2: "${file}" self-carries the CEO-facing comm/altitude guidance`, () => {
    const body = read(file)
    assert.match(
      body,
      SELF_CARRIED_COMM,
      `${file} does not self-carry the comm/altitude guidance it relied on ` +
        `from communication-discipline. The "self-sufficient" verdict must be ` +
        `BACKED by the file actually carrying the worker-level/CEO-level ` +
        `altitude split or the plain-English translation bar, not merely ` +
        `asserted in the ledger. After communication-discipline leaves the ` +
        `worker autoload path, this is the only place the rule survives for ` +
        `this agent.`,
    )
  })
}

// --- AC3: the self-carry authoring convention line is present ---

test('AC3: writing-skills carries the self-carry authoring convention', () => {
  const body = read(CONVENTION_DOC)
  // A one-line convention: worker/subagent agents must self-carry their
  // CEO-facing comm guidance (because the comm docs are off their autoload
  // path). Matched loosely so the implementer can word it freely, but it must
  // tie "self-carry" to comm/CEO-facing/altitude guidance to be the real line
  // and not an incidental "self-" word elsewhere.
  const CONVENTION =
    /self[-\s]?carr[\s\S]{0,80}(comm|ceo[-\s]facing|altitude|communication[-\s]discipline)/i
  assert.match(
    body,
    CONVENTION,
    `${CONVENTION_DOC} is missing the self-carry authoring convention: worker ` +
      `agents that produce CEO-facing output must self-carry the comm/altitude ` +
      `guidance in their own prompt (the four comm docs are off the worker ` +
      `autoload path). This convention is what stops future agents from ` +
      `re-introducing the reliance this chunk just audited away.`,
  )
})
