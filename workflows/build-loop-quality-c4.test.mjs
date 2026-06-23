// RED test for build-loop-quality chunk 4: align the fix-loop diff scope so the
// FIXER operates on the SAME cumulative range the P5 re-check JUDGE adjudicates.
//
// The defect (current state): worker-pipeline.js dispatches the fixer with a
// SINGLE-COMMIT diff (`git show ${sha}`), while the P5 re-check judge re-adjudicates
// the CUMULATIVE range (`git diff ${reviewSha}^..${currentSha}`). On round 2 the
// fixer cannot see the cumulative range the judge judges against, so the loop can
// churn on context the fixer never had.
//
// Pins the FULL acceptance contract:
//   AC1 ranges identical : in a 2-round-fix scenario, the diff-range STRING passed
//                          to the fixer dispatch === the diff-range STRING in the P5
//                          judge prompt for the SAME round (cumulative
//                          reviewSha^..currentSha). RED against pre-change code
//                          (fixer single-commit != judge cumulative on round 2).
//   AC2 P5 no single-line: the P5 (re-check) judge prompt carries NO single-commit
//                          `git show ${sha}` diff line -- only the cumulative range.
//   AC3 REVIEW+P2 single  : the REVIEW lenses + the INITIAL P2 judge KEEP single-commit
//                          (`git show ${reviewSha}` / `git show ${sha}` on the build
//                          commit) -- they run on the build commit by design.
//
// Test strategy (mirrors the c1/c2/llr source-level proof pattern): worker-pipeline.js
// runs the pipeline at top level on import (top-level await + Workflow host globals),
// so it cannot be imported. The prompt builders are pure template functions; we
// extract each function's BODY from source and assert the diff-range string each
// emits, rendering the `${...}` interpolations against a fixed fixture so the two
// rendered ranges can be compared character-for-character.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const PIPE = 'workflows/worker-pipeline.js'
const PIPE_SRC = read(PIPE)
const FIXER_MD = read('agents/fixer.md')

// Fixed render fixture: a deterministic worktree + the two shas of a 2-round scenario.
// reviewSha = the build commit; currentSha = after fixer round 2 landed a commit.
const WT = '/wt'
const REVIEW_SHA = 'BUILDsha'
const CURRENT_SHA = 'R2sha'

// Extract a named function's BODY (signature through its balanced closing brace) from
// the source, brace-counting from the `function NAME` declaration. Lets us scope each
// assertion to ONE function body, never a whole-file grep (a sibling function's
// `git show` would otherwise leak across the boundary).
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}`)
  assert.ok(start > -1, `${PIPE} must define function ${name}`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

// Render the `${reviewSha}` / `${worktree}` / `${sha}`-style interpolations a prompt
// line emits, against the fixture, so the produced diff-range string is concrete.
// `sha` binds the function's local diff-range parameter (`sha`/`currentSha`).
function render(line, sha) {
  return line
    .replaceAll('${worktree}', WT)
    .replaceAll('${reviewSha}', REVIEW_SHA)
    .replaceAll('${currentSha}', CURRENT_SHA)
    .replaceAll('${sha}', sha)
}

// The cumulative-range string the single-source helper `cumulativeDiffRange(sha)`
// produces, rendered against the fixture. We extract the helper's returned template
// from source so the test tracks the ONE definition both dispatch sites route through.
// Lazy (called inside each test) so a missing helper fails that test's own assertion
// with a precise message, not a module-load throw that collapses the whole file.
function cumulativeTemplate() {
  const body = fnBody(PIPE_SRC, 'cumulativeDiffRange')
  const m = body.match(/return\s+`([^`]*)`/)
  assert.ok(m, `${PIPE} cumulativeDiffRange must return a single template literal`)
  return m[1]   // e.g. `git -C ${worktree} diff ${reviewSha}^..${sha}`
}
const cumulativeRange = (sha) => render(cumulativeTemplate(), sha)

// Resolve the diff-range a function body's diff line emits, RENDERED concrete. A line
// can name the range two ways: inline (`git -C ... show/diff ...`) OR via the
// single-source helper call `cumulativeDiffRange(<arg>)`. Resolve BOTH so the
// helper-based design is tracked, not just inlined strings.
// Returns { rendered, kind } for the first diff-range line found, or null.
function diffRangeLine(body, sha) {
  for (const l of body.split('\n')) {
    const helperCall = l.match(/cumulativeDiffRange\(\s*(\w+)\s*\)/)
    if (helperCall) {
      // The helper always yields the cumulative range; render it for this sha.
      return { rendered: cumulativeRange(sha), kind: 'cumulative' }
    }
    if (/git -C [^`]*\b(show|diff)\b/.test(l)) {
      const m = l.match(/git -C [^`]*?(?:show|diff)[^`]*/)
      const raw = m[0]
      return { rendered: render(raw, sha), kind: /\bdiff\b/.test(raw) ? 'cumulative' : 'single' }
    }
  }
  return null
}

const FIXER_BODY = fnBody(PIPE_SRC, 'fixerPrompt')
const JUDGE_BODY = fnBody(PIPE_SRC, 'judgeLensPrompt')

// --- AC1: the fixer range and the P5 judge range are the IDENTICAL cumulative range ---

test('AC1: in a 2-round scenario the fixer diff-range string === the P5 judge diff-range string', () => {
  // Round 2: the fixer is dispatched on currentSha (the post-round-1 commit); the P5
  // re-check judge re-adjudicates over currentSha. Both must resolve to the SAME
  // cumulative range string `git -C /wt diff BUILDsha^..R2sha`.
  const fixerRange = diffRangeLine(FIXER_BODY, CURRENT_SHA)
  assert.ok(fixerRange, `${PIPE} fixerPrompt must emit a git diff-range line`)

  // The P5 re-check judge's committed-diff line (its cumulative branch) renders the
  // SAME helper-produced range for the same sha. That is the range the fixer must
  // MATCH. Build the expected cumulative range from the single-source helper.
  const judgeP5Range = cumulativeRange(CURRENT_SHA)

  assert.equal(
    fixerRange.rendered,
    judgeP5Range,
    `${PIPE}: the fixer dispatch diff-range must be the SAME cumulative range the P5 ` +
      `re-check judge adjudicates (reviewSha^..currentSha), not a single commit. ` +
      `fixer emitted "${fixerRange.rendered}", judge re-checks "${judgeP5Range}".`,
  )
  assert.equal(fixerRange.kind, 'cumulative',
    `${PIPE}: the fixer diff-range must be a cumulative \`git diff ...^..\` range, not \`git show\`.`)
  // The expected concrete range, so a future refactor of the helper template is caught.
  assert.equal(judgeP5Range, `git -C ${WT} diff ${REVIEW_SHA}^..${CURRENT_SHA}`,
    `${PIPE}: cumulativeDiffRange must render the cumulative branch-diff range reviewSha^..sha.`)
})

test('AC1: the P5 re-check dispatch passes the cumulative reviewSha^..currentSha range', () => {
  // The cumulative-range survival catch (llr-c2): the P5 re-check dispatch must name
  // the cumulative branch-diff range so the judge re-checks the FULL chunk
  // contribution. This is the range the fixer is now aligned to.
  assert.match(
    PIPE_SRC,
    /diff \$\{reviewSha\}\^\.\.\$\{currentSha\}/,
    `${PIPE}'s P5 re-check dispatch must name the cumulative range git ... diff ` +
      `\${reviewSha}^..\${currentSha}.`,
  )
})

// --- AC2: the P5 (re-check) judge prompt carries NO single-commit `git show ${sha}` line ---

test('AC2: the P5 re-check judge prompt emits NO single-commit `git show ${sha}` diff line', () => {
  // The bug being removed: judgeLensPrompt previously emitted, UNCONDITIONALLY, a
  // single-commit `The committed diff to judge: git ... show ${sha}` line AND (via
  // passContext) the cumulative re-adjudicate instruction. On the re-check path the
  // single-commit line is contradictory -- the judge must judge the cumulative range
  // unambiguously. The fix gates that single-commit line behind the diffMode so the
  // re-check (cumulative) path renders ONLY the cumulative range.

  // (a) The single-commit `git show ${sha}` committed-diff line must NOT be
  // unconditional -- it must sit on the non-cumulative branch of a diffMode gate.
  // We assert a single-commit committed-diff line appears ONLY where a `diffMode`
  // gate precedes it (the ternary's else-branch), never as a free-standing element.
  const SHOW_SHA = 'git -C ${worktree} show ${sha}'
  const showIdx = JUDGE_BODY.indexOf(SHOW_SHA)
  assert.ok(showIdx > -1, `${PIPE}: judgeLensPrompt still keeps a single-commit \`${SHOW_SHA}\` line (the P2 build-commit path).`)
  const gateIdx = JUDGE_BODY.indexOf('diffMode')
  assert.ok(
    gateIdx > -1 && gateIdx < showIdx,
    `${PIPE}: the single-commit \`git show \${sha}\` committed-diff line must be GATED behind ` +
      `a \`diffMode\` branch (so the P5 re-check path renders no single-commit line), not emitted unconditionally.`,
  )

  // (b) Render-level: on the re-check (cumulative) path, the judge body's FIRST
  // emitted committed-diff line resolves to the cumulative range, not single-commit.
  // The cumulative branch is first in source order in the ternary, so diffRangeLine
  // (which resolves the cumulativeDiffRange helper call) sees cumulative.
  const judgeRange = diffRangeLine(JUDGE_BODY, CURRENT_SHA)
  assert.ok(judgeRange, `${PIPE}: judgeLensPrompt must emit a committed-diff line`)
  assert.equal(judgeRange.kind, 'cumulative',
    `${PIPE}: the judge's emitted committed-diff line must be the cumulative range on the re-check path.`)
  assert.equal(judgeRange.rendered, cumulativeRange(CURRENT_SHA),
    `${PIPE}: the P5 judge's cumulative committed-diff line must render reviewSha^..currentSha (same as the fixer).`)
})

// --- AC3: REVIEW lenses + the INITIAL P2 judge KEEP single-commit (build commit) ---

test('AC3: the REVIEW lenses keep single-commit `git show ${reviewSha}` (run on the build commit)', () => {
  // The Sonnet + adversarial lenses review the chunk's ONE build commit by design.
  for (const fn of ['sonnetLensPrompt', 'adversarialLensPrompt']) {
    const body = fnBody(PIPE_SRC, fn)
    assert.match(
      body,
      /git -C \$\{worktree\} show \$\{reviewSha\}/,
      `${PIPE}: ${fn} must KEEP the single-commit \`git show \${reviewSha}\` (the build commit).`,
    )
  }
  // The Codex lens reviews the single build commit via codex-review.sh --commit ${sha}
  // (sha defaults to reviewSha) -- its single-commit signal, kept by design.
  const codex = fnBody(PIPE_SRC, 'codexLensPrompt')
  assert.match(codex, /--commit \$\{sha\}/,
    `${PIPE}: codexLensPrompt must KEEP single-commit \`--commit \${sha}\` (defaults to the build commit).`)
})

test('AC3: the INITIAL P2 judge dispatch is invoked with reviewSha + single-commit framing', () => {
  // The initial adjudication runs over the build commit. Its dispatch passes reviewSha
  // and a passContext naming the INITIAL (P2) adjudication over the build commit; it
  // must NOT name a cumulative range (there are no fixer commits yet).
  assert.match(
    PIPE_SRC,
    /judgeLensPrompt\(\s*reviewSha,\s*'This is the INITIAL adjudication \(P2\) over the build commit\.'/,
    `${PIPE}: the initial P2 judge must be dispatched over reviewSha with the build-commit framing.`,
  )
})

// --- AC: agents/fixer.md prose synced to the cumulative range ---

test('AC: agents/fixer.md does not describe the fixer diff as a single prior-round commit', () => {
  // The fixer prose previously said the diff is "the builder's or the prior round's
  // provisional commit" (a single-commit description). Sync it to the cumulative range
  // so the fixer doc and the dispatch agree.
  assert.ok(
    !/the prior round's provisional commit/.test(FIXER_MD),
    `agents/fixer.md must NOT describe the fixer diff as "the prior round's provisional commit" ` +
      `(single-commit) -- the fixer now operates on the cumulative reviewSha^..currentSha range.`,
  )
  assert.match(
    FIXER_MD,
    /cumulative/i,
    `agents/fixer.md must describe the fixer's diff as the CUMULATIVE range (aligned with the P5 judge).`,
  )
})
