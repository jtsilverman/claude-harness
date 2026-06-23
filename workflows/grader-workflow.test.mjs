// grader-workflow.test.mjs -- RED for chunk llr-D3: wire real agentType dispatch
// (grader-flagger + grader-judge), migrate FLAGS_SCHEMA to richer shape, route
// conformance docs via prompt string, pin data-delivery to prompt (not opts).
//
// CONTRACT under test (from specs/lean-system-design.md §9 D3 + fable-review Part 4
// §B grader internals + §D(iii) judge->redesigner report schema):
//
//   (D1-AC1) SEGMENT + manifest run over a session archive and produce ONE segment per
//            transcript when the file is <=~150k chars, else windowed splits at message
//            boundaries (~100k-char windows) with a 5-MESSAGE overlap. [PRESERVED from D1]
//   (D1-AC2-count) SUPERSEDED by grader-efficiency: flagger count is now per
//                  SUMMARY-BUNDLE (FEWER than segment count); one HAIKU summarizer per
//                  SEGMENT-BUNDLE precedes it. See the grader-efficiency EFF-AC1/AC3 block.
//   (D1-AC2-manifest-throws) An absent/empty manifest THROWS. [PRESERVED from D1]
//   (D1-AC3-return-keys) Workflow returns exactly the 5 contract keys. [PRESERVED from D1]
//   (D1-AC3-groupByFile) groupDocFaultsByFile groups by targetFile. [PRESERVED from D1]
//   (D1-AC3-no-writes)  Launchable performs no fs writes. [PRESERVED from D1]
//
//   (D3-AC1) FLAGS_SCHEMA in BOTH grader-workflow-lib.mjs AND grader-workflow.js
//            requires {what_happened,evidence,rule_cited,severity}. The OLD 'what'
//            field must not appear as required in either file. additionalProperties:false.
//            severity enum: low|medium|high. [NEW -- schema migration]
//   (D3-AC2) FLAG phase dispatches agentType:'grader-flagger'; JUDGE phase dispatches
//            agentType:'grader-judge'. No inline model strings on those calls.
//            Dead flagPrompt/judgePrompt builder stubs removed. [NEW -- agentType dispatch]
//   (D3-AC3) DATA RIDES IN PROMPT STRING. Each flagger's prompt string carries its
//            segment descriptor + conformanceDoc path. The judge's prompt string carries
//            flagResults + manifest JSON. Custom opts keys do NOT carry this data. [NEW]
//   (D3-AC4) Conformance-doc routing: manifest entries carry conformanceDoc derived
//            from .meta.json sidecar: build-agent* -> worker-discipline+git-discipline,
//            chunk-reviewer* OR spec-drift-slop-reviewer* (C8 dual-match) -> review-contract, coo -> coo-sop, other -> null.
//   (D3-AC5) Judge return + report shape: the defensive re-grouping does NOT strip
//            redesigner-report fields (scope, why_doc_fault, desired_behavior, etc.)
//            when the judge already grouped by file. [NEW]
//   (D3-AC6) Real archive segmentation with mocked dispatch is green. flagResults +
//            manifest appear in the judge's prompt string (data-delivery pin). [NEW]
//
// ARCHITECTURE (the in-repo dual-file lockstep convention -- see session-grader.mjs /
// session-grader-lib.mjs): the PURE helpers live in grader-workflow-lib.mjs (testable
// source of truth) and are INLINED verbatim into grader-workflow.js (launchable body).
// This test imports ONLY the lib and exercises the launchable by stripping
// `export const meta` and running the rest as an AsyncFunction with stub harness globals.
//
// Run: node --test workflows/grader-workflow.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const LIB = 'workflows/grader-workflow-lib.mjs'
const WORKFLOW = 'workflows/grader-workflow.js'

// Namespace import of the lib. A missing EXPORT reads as `undefined` and fails its
// own assertion; a missing MODULE (the RED state, before the lib exists) is tolerated
// so each test fails on ITS assertion rather than aborting the whole file at load.
let lib = {}
try {
  lib = await import(new URL('./grader-workflow-lib.mjs', import.meta.url))
} catch (e) {
  // lib not built yet -> leave it as {}; every lib.* read is undefined and each test
  // fails on its own assertion (a valid RED on the assertion, not a load error).
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// The window-overlap invariant, asserted against REALITY rather than over-asserted.
// Consecutive windows overlap by exactly OVERLAP_MESSAGES messages EXCEPT where the
// forward-progress guard fires: when the previous window held a SINGLE message that
// itself exceeded WINDOW_CHAR_TARGET (it cannot be split mid-message), the next window
// is forced one message forward, so the overlap may be LESS than OVERLAP_MESSAGES. In
// either case the windows must make forward progress (cur starts after prev started).
// Source: real oversized-message transcripts yield <5-message overlap on 56/311
// transitions; a flat "overlap == 5 for ALL pairs" over-asserts and fails on reality.
function assertWindowOverlapInvariant(windows, OVERLAP_MESSAGES, WINDOW_CHAR_TARGET) {
  for (let i = 1; i < windows.length; i++) {
    const prev = windows[i - 1]
    const cur = windows[i]
    assert.ok(prev.messageRange && cur.messageRange, 'split windows carry a messageRange {startMsg,endMsg}')
    const overlap = prev.messageRange.endMsg - cur.messageRange.startMsg + 1
    assert.ok(cur.messageRange.startMsg > prev.messageRange.startMsg, `windows must make forward progress (prev ${JSON.stringify(prev.messageRange)}, cur ${JSON.stringify(cur.messageRange)})`)
    const prevSpan = prev.charOffsets.end - prev.charOffsets.start
    const prevIsSingleOversized = prev.messageRange.startMsg === prev.messageRange.endMsg && prevSpan > WINDOW_CHAR_TARGET
    if (prevIsSingleOversized) {
      // Forward-progress exception: overlap may be < OVERLAP_MESSAGES, never more.
      assert.ok(overlap <= OVERLAP_MESSAGES, `forward-progress overlap must not exceed ${OVERLAP_MESSAGES}, got ${overlap}`)
    } else {
      assert.equal(overlap, OVERLAP_MESSAGES, `consecutive windows overlap by exactly ${OVERLAP_MESSAGES} messages, got ${overlap} (prev ${JSON.stringify(prev.messageRange)}, cur ${JSON.stringify(cur.messageRange)})`)
    }
  }
}

// Build a runnable AsyncFunction from the launchable .js, minus the top-level
// `export const meta = { ... }` literal (export is illegal inside a function body).
function workflowFn() {
  const src = read(WORKFLOW)
  const body = src.replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\n\}\n/, '')
  return new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)
}

// ---------------------------------------------------------------------------
// Synthetic archive: one COO log (<150k, single segment) + one big subagent
// transcript (>150k, splits into overlapping windows). Message boundary = the
// newline between JSONL records (each line is one message), matching the real
// on-disk layout (sessions/<id>/<id>.jsonl + sessions/<id>/<id>/subagents/**.jsonl).
// ---------------------------------------------------------------------------
function buildSyntheticArchive() {
  const base = mkdtempSync(join(tmpdir(), 'grader-arch-'))
  const sid = 'synth-session-0001'
  const sessDir = join(base, sid)
  const innerDir = join(sessDir, sid)
  const subDir = join(innerDir, 'subagents')
  mkdirSync(subDir, { recursive: true })

  // COO log: 10 lines * ~5k chars = ~50k chars => <=150k => ONE segment.
  const cooLine = (i) => JSON.stringify({ type: 'message', role: i % 2 ? 'assistant' : 'user', i, pad: 'x'.repeat(5000) })
  const cooLines = Array.from({ length: 10 }, (_, i) => cooLine(i))
  writeFileSync(join(sessDir, `${sid}.jsonl`), cooLines.join('\n') + '\n')

  // Big subagent transcript: 60 lines * ~5k chars = ~300k chars => >150k => splits
  // into ~100k windows at message boundaries with a 5-message overlap. It carries an
  // A/S-variant agentType sidecar so the grader-scope filter KEEPS it (a sidecar-less
  // subagent is now out of scope; these windowing/dispatch tests need it in-scope).
  const subLine = (i) => JSON.stringify({ type: 'message', role: i % 2 ? 'assistant' : 'user', i, pad: 'y'.repeat(5000) })
  const subLines = Array.from({ length: 60 }, (_, i) => subLine(i))
  writeFileSync(join(subDir, 'agent-abc123.jsonl'), subLines.join('\n') + '\n')
  writeFileSync(join(subDir, 'agent-abc123.meta.json'), JSON.stringify({ agentType: 'build-agent-heavy', description: 'A-tier build', toolUseId: 'tu-abc123' }))

  return { dir: base, cooLineCount: 10, subLineCount: 60 }
}

// ---------------------------------------------------------------------------
// stubSummariesFromPrompt -- test helper for SUMMARIZE mocks.
// The SUMMARIZE validation (F2 fix) now requires every manifest segment_id to
// appear in the flattened summaries. SUMMARIZE mocks that return a single summary
// with opts.label (the bundle_id) break because bundle_id != segment_id.
// This helper extracts the segment_ids embedded in the summarizer prompt string
// (the prompt embeds each segment as "Segment: <segment_id>") and returns a
// valid { summaries: [...] } response covering every segment in the bundle.
// ---------------------------------------------------------------------------
function stubSummariesFromPrompt(prompt) {
  const ids = Array.from(prompt.matchAll(/^Segment: (.+)$/gm), (m) => m[1].trim())
  if (ids.length === 0) return { summaries: [] }
  return { summaries: ids.map((id) => ({ segment_id: id, summary: 'stub', evidence_refs: [] })) }
}

// ===========================================================================
// AC1 -- SEGMENT + manifest: one segment per <=150k transcript; >150k splits
// into ~100k message-boundary windows with a 5-message overlap. [PRESERVED from D1]
// ===========================================================================

test('AC1: pure segment helpers are exported with the documented thresholds', () => {
  assert.equal(typeof lib.buildSegmentManifest, 'function', 'lib must export buildSegmentManifest(sessionArchiveDir)')
  assert.equal(typeof lib.windowTranscript, 'function', 'lib must export windowTranscript(path, text)')
  // Threshold constants are part of the spec contract (~150k whole-file cap, ~100k
  // window target, 5-message overlap). Assert they exist and sit in the spec ranges.
  assert.ok(lib.SEGMENT_CHAR_LIMIT >= 100000 && lib.SEGMENT_CHAR_LIMIT <= 200000, `SEGMENT_CHAR_LIMIT ~150k, got ${lib.SEGMENT_CHAR_LIMIT}`)
  assert.ok(lib.WINDOW_CHAR_TARGET >= 80000 && lib.WINDOW_CHAR_TARGET <= 120000, `WINDOW_CHAR_TARGET ~100k, got ${lib.WINDOW_CHAR_TARGET}`)
  assert.equal(lib.OVERLAP_MESSAGES, 5, `OVERLAP_MESSAGES must be 5, got ${lib.OVERLAP_MESSAGES}`)
})

test('AC1: a <=150k transcript yields exactly one whole-file segment', () => {
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  assert.ok(Array.isArray(manifest), 'manifest must be an array of segment entries')

  // Find the COO-log segments (the small <150k file). It must be ONE segment whose
  // charOffsets span the whole file (start 0).
  const cooSegs = manifest.filter((s) => s.path.endsWith(`${'synth-session-0001'}.jsonl`))
  assert.equal(cooSegs.length, 1, `the <150k COO log must be a single whole-file segment, got ${cooSegs.length}`)
  assert.equal(cooSegs[0].charOffsets.start, 0, 'whole-file segment starts at offset 0')
  assert.ok(cooSegs[0].segment_id, 'every segment carries a segment_id')
})

test('AC1: a >150k transcript splits into >=2 windows with a 5-message overlap', () => {
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)

  // The 300k subagent transcript must split into at least 2 windows.
  const subSegs = manifest.filter((s) => s.path.endsWith('agent-abc123.jsonl'))
  assert.ok(subSegs.length >= 2, `a >150k transcript must split into >=2 windows, got ${subSegs.length}`)

  // Windows must cover the file in order and OVERLAP by 5 messages -- EXCEPT where the
  // forward-progress guard fires on a single oversized message (then overlap may be
  // less). The manifest carries per-window message-index + char bounds so the invariant
  // is checkable without re-reading. (These fixtures use uniform ~5k-char messages, so
  // no single message exceeds the window target and every pair overlaps by exactly 5;
  // the invariant helper additionally tolerates the real-data forward-progress case.)
  assertWindowOverlapInvariant(subSegs, lib.OVERLAP_MESSAGES, lib.WINDOW_CHAR_TARGET)

  // The split also covers the whole file: first window starts at message 0, last
  // window ends at the final message.
  assert.equal(subSegs[0].messageRange.startMsg, 0, 'first window starts at message 0')
  assert.equal(subSegs[subSegs.length - 1].messageRange.endMsg, arch.subLineCount - 1, 'last window ends at the final message')
})

test('AC1: windowTranscript splits a >150k text at message boundaries with 5-msg overlap', () => {
  // Direct unit test of the windowing primitive over a hand-built text, expected
  // values hand-computed from the byte budget (anti-tautology).
  const msg = (i) => JSON.stringify({ i, pad: 'z'.repeat(5000) })   // ~5k chars/line
  const lines = Array.from({ length: 60 }, (_, i) => msg(i))        // ~300k total
  const text = lines.join('\n') + '\n'
  const windows = lib.windowTranscript('/fake/path.jsonl', text)
  assert.ok(windows.length >= 2, `~300k text must produce >=2 windows, got ${windows.length}`)
  assertWindowOverlapInvariant(windows, lib.OVERLAP_MESSAGES, lib.WINDOW_CHAR_TARGET)
})

test('AC1: a >150k transcript with FEW messages still windows (split is not gated on message count)', () => {
  // Forward-progress edge: a transcript can exceed SEGMENT_CHAR_LIMIT with very few
  // (<= OVERLAP_MESSAGES) messages -- e.g. 3 enormous messages. Splitting must NOT be
  // gated on message count; an oversized few-message file must still produce >1 window
  // (each window holds at least one message; a single oversized message goes in whole).
  const big = (i) => JSON.stringify({ i, pad: 'q'.repeat(80000) })  // ~80k chars/message
  const lines = Array.from({ length: 3 }, (_, i) => big(i))         // 3 messages, ~240k total
  const text = lines.join('\n') + '\n'
  assert.ok(text.length > lib.SEGMENT_CHAR_LIMIT, 'fixture must exceed the whole-file cap to exercise the split')
  assert.ok(lines.length <= lib.OVERLAP_MESSAGES, 'fixture must have few messages (<= overlap) to exercise the gate')
  const windows = lib.windowTranscript('/fake/big.jsonl', text)
  assert.ok(windows.length >= 2, `an oversized few-message transcript must still split, got ${windows.length} window(s)`)
  // Coverage: first window starts at message 0, last ends at the final message.
  assert.equal(windows[0].messageRange.startMsg, 0, 'first window starts at message 0')
  assert.equal(windows[windows.length - 1].messageRange.endMsg, lines.length - 1, 'last window ends at the final message')
})

test('AC1: SEGMENT runs over the real three-loop-rebuild archive when present', () => {
  // The real archive lives in the home tree and is NOT git-tracked, so it is absent
  // from the worktree; skip gracefully when absent (the synthetic fixtures above are
  // the hermetic proof). When present, assert real >150k files split and small ones do not.
  const homeArchive = join(process.env.HOME || '', '.claude/specs/three-loop-rebuild/sessions')
  if (!existsSync(homeArchive)) return
  const manifest = lib.buildSegmentManifest(homeArchive)
  assert.ok(manifest.length > 0, 'real archive must produce >=1 segment')
  // At least one transcript in the real archive exceeds 150k (the 3.5MB COO log), so
  // the manifest must contain at least one multi-window file.
  const byPath = {}
  for (const s of manifest) byPath[s.path] = (byPath[s.path] || 0) + 1
  const anyMultiWindow = Object.values(byPath).some((n) => n >= 2)
  assert.ok(anyMultiWindow, 'the real archive has >150k transcripts that must split into multiple windows')
})

// ===========================================================================
// D3-AC1 -- FLAGS_SCHEMA migration: {what_happened, evidence, rule_cited, severity}
// Old 'what' field must not appear as required in EITHER file.
// ===========================================================================

test('D3-AC1 (superseded by C4): FLAGS_SCHEMA in lib is localization-only {segment_id, evidence_ref, what_caught_my_eye}', () => {
  // SUPERSEDED by coo-simplification chunk 4: the flagger no longer assigns rule_cited or
  // severity (the judge does, against the raw slice). The flag item now localizes only.
  assert.ok(lib.FLAGS_SCHEMA, 'lib must export FLAGS_SCHEMA')
  const flagItems = lib.FLAGS_SCHEMA.properties && lib.FLAGS_SCHEMA.properties.flags && lib.FLAGS_SCHEMA.properties.flags.items
  assert.ok(flagItems, 'FLAGS_SCHEMA.properties.flags.items must be defined')
  const required = (flagItems.required || []).slice().sort()
  assert.deepEqual(required, ['evidence_ref', 'segment_id', 'what_caught_my_eye'],
    `flags.items must require exactly the localization fields, got required=${JSON.stringify(required)}`)
  assert.ok(!required.includes('rule_cited'), `flags.items must NOT require 'rule_cited' (judge assigns it)`)
  assert.ok(!required.includes('severity'), `flags.items must NOT require 'severity' (judge assigns it)`)
  assert.equal(flagItems.additionalProperties, false, 'flags.items must have additionalProperties:false')
})

test('D3-AC1 (superseded by C4): FLAGS_SCHEMA in grader-workflow.js (inlined) is localization-only', () => {
  // The INLINED copy in the launchable .js must match the lib's localization-only shape.
  const src = read(WORKFLOW)
  assert.ok(/['"]evidence_ref['"]/.test(src), "launchable .js must contain 'evidence_ref' in its inlined FLAGS_SCHEMA")
  assert.ok(/['"]what_caught_my_eye['"]/.test(src), "launchable .js must contain 'what_caught_my_eye' in its inlined FLAGS_SCHEMA")
  // The old flagger-assigned fields must not be in the flags.items.required array.
  const m = src.match(/flags[\s\S]{0,400}?items[\s\S]{0,200}?required:\s*\[([^\]]+)\]/)
  assert.ok(m && !/rule_cited|severity|what_happened/.test(m[1]),
    "launchable .js flags.items.required must not carry rule_cited/severity/what_happened (localization-only)")
})

test('D3-AC1 (superseded by C4): repo-wide grep finds no flag schema still requiring the old flagger-assigned fields', () => {
  // Mirror-surface trap: both grader-workflow.js and grader-workflow-lib.mjs must have
  // migrated to the localization-only flag shape. Grep both flags.items.required arrays.
  for (const [name, src] of [['lib', read(LIB)], ['workflow', read(WORKFLOW)]]) {
    const m = src.match(/flags[\s\S]{0,400}?items[\s\S]{0,200}?required:\s*\[([^\]]+)\]/)
    assert.ok(m, `${name} must have a flags.items.required array`)
    assert.ok(!/rule_cited|severity|what_happened|['"]what['"](?!\s*_)/.test(m[1]),
      `${name} FLAGS_SCHEMA flags.items.required still carries an old flagger-assigned field: ${m[1]}`)
  }
})

// ===========================================================================
// D3-AC2 -- agentType dispatch: grader-flagger on FLAG, grader-judge on JUDGE.
// Dead inline-model-only comments removed. No model strings on those calls.
// ===========================================================================

test('D3-AC2: FLAG phase dispatches agentType grader-flagger; JUDGE dispatches agentType grader-judge', async () => {
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const segCount = manifest.length
  assert.ok(segCount >= 2, 'synthetic archive should yield multiple segments for a meaningful dispatch check')

  const summarizeSpawns = []
  const flagSpawns = []
  const judgeSpawns = []
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') {
      summarizeSpawns.push({ prompt, opts })
      return stubSummariesFromPrompt(prompt)
    }
    if (opts && opts.phase === 'FLAG') {
      flagSpawns.push({ prompt, opts })
      return { flags: [], jake_signals: [] }
    }
    if (opts && opts.phase === 'JUDGE') {
      judgeSpawns.push({ prompt, opts })
      return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const phase = () => {}
  const log = () => {}

  await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, phase, log)

  // With the two bundling layers, the FLAG fan-out is per SUMMARY-BUNDLE (not per
  // segment): fewer flaggers than segments, at least one, exactly one judge.
  assert.ok(summarizeSpawns.length >= 1, `at least one summarizer runs, got ${summarizeSpawns.length}`)
  assert.ok(flagSpawns.length >= 1 && flagSpawns.length <= segCount,
    `flagger count (${flagSpawns.length}) is per summary-bundle: >=1 and <= segment count (${segCount})`)
  assert.equal(judgeSpawns.length, 1, `exactly one judge runs, got ${judgeSpawns.length}`)

  // The agentType must be present on every SUMMARIZE/FLAG/JUDGE spawn, with NO inline model.
  for (const s of summarizeSpawns) {
    assert.equal(s.opts.agentType, 'grader-summarizer', `each summarizer spawn must use agentType:'grader-summarizer', got ${s.opts.agentType}`)
    assert.equal(s.opts.model, undefined, `summarizer opts must not carry model (agent def supplies haiku), got ${s.opts.model}`)
  }
  for (const s of flagSpawns) {
    assert.equal(s.opts.agentType, 'grader-flagger', `each flagger spawn must use agentType:'grader-flagger', got ${s.opts.agentType}`)
    // model must NOT be set in opts (the agent def frontmatter supplies it)
    assert.equal(s.opts.model, undefined, `flagger opts must not carry model (agent def supplies it), got ${s.opts.model}`)
  }
  assert.equal(judgeSpawns[0].opts.agentType, 'grader-judge', `judge spawn must use agentType:'grader-judge', got ${judgeSpawns[0].opts.agentType}`)
  assert.equal(judgeSpawns[0].opts.model, undefined, `judge opts must not carry model (agent def supplies it), got ${judgeSpawns[0].opts.model}`)
})

test('D3-AC2: dead inline flagPrompt/judgePrompt builder functions are removed from the launchable', () => {
  const src = read(WORKFLOW)
  // The D1 inline standalone function bodies (flagPrompt and judgePrompt as named
  // function declarations used only as model-only dispatch stubs) must be deleted.
  // The D3 slim payload-builder functions ARE allowed (they assemble the prompt string),
  // but they must be CALLED from agent() dispatch with agentType, not be model-only stubs.
  // Check: the D1 comment markers are removed.
  assert.ok(!/D1 dispatches MODEL-ONLY/.test(src), 'D1 MODEL-ONLY dispatch comment must be removed')
  assert.ok(!/D2 swaps in agentType/.test(src), 'D2 swaps agentType comment must be removed (D2 landed)')
  // Verify agentType appears in the actual FLAG and JUDGE dispatch calls
  assert.ok(/agentType:\s*['"]grader-flagger['"]/.test(src), "launchable must dispatch agentType:'grader-flagger' in FLAG phase")
  assert.ok(/agentType:\s*['"]grader-judge['"]/.test(src), "launchable must dispatch agentType:'grader-judge' in JUDGE phase")
})

test('D3-AC2 (superseded by C4): the FLAGS + ROUTED schemas are exported with the localization flag shape', () => {
  assert.ok(lib.FLAGS_SCHEMA && lib.FLAGS_SCHEMA.type === 'object', 'FLAGS_SCHEMA is an object schema')
  // C4 flag shape: flags [{segment_id, evidence_ref, what_caught_my_eye}] + jake_signals
  const fp = lib.FLAGS_SCHEMA.properties || {}
  assert.ok(fp.segment_id && fp.flags && fp.jake_signals, 'FLAGS_SCHEMA carries segment_id, flags, jake_signals')
  // The flag item must have the localization-only required fields
  const flagItemReq = (fp.flags && fp.flags.items && fp.flags.items.required) || []
  assert.ok(flagItemReq.includes('evidence_ref'), "flag item must require 'evidence_ref'")
  assert.ok(flagItemReq.includes('what_caught_my_eye'), "flag item must require 'what_caught_my_eye'")

  assert.ok(lib.ROUTED_SCHEMA && lib.ROUTED_SCHEMA.type === 'object', 'ROUTED_SCHEMA is an object schema')
  const rp = lib.ROUTED_SCHEMA.properties || {}
  for (const k of ['memoryCandidates', 'docFaults', 'readerModelUpdates', 'corpusAppend', 'ledgerLines']) {
    assert.ok(rp[k], `ROUTED_SCHEMA must carry the ${k} key`)
  }
})

// ===========================================================================
// D3-AC3 -- DATA RIDES IN PROMPT STRING (the prior-attempt bug prevention).
// Each flagger's prompt string carries segment descriptor + conformanceDoc path.
// The judge's prompt string carries flagResults + manifest JSON.
// Custom opts keys do NOT carry this data.
// ===========================================================================

test('D3-AC3: each summarizer prompt string carries every bundled segment\'s segment_id, path, role, charOffsets, messageRange', async () => {
  // With PRE-BUNDLE, the per-segment descriptor now rides in the SUMMARIZER prompt
  // (one haiku summarizer per segment-bundle) -- not the flagger, which reads summaries.
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  assert.ok(manifest.length >= 2, 'need multiple segments to check per-segment prompt data')

  const summarizePrompts = []
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') {
      summarizePrompts.push({ prompt, opts })
      return stubSummariesFromPrompt(prompt)
    }
    if (opts && opts.phase === 'FLAG') {
      return { flags: [], jake_signals: [] }
    }
    if (opts && opts.phase === 'JUDGE') {
      return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})

  // Every segment's descriptor must appear in SOME summarizer prompt (one per bundle).
  const allSummarizeText = summarizePrompts.map((p) => p.prompt).join('\n@@@\n')
  for (const seg of manifest) {
    assert.ok(allSummarizeText.includes(seg.segment_id), `summarizer prompt must contain segment_id='${seg.segment_id}'`)
    assert.ok(allSummarizeText.includes(seg.path), `summarizer prompt must contain path='${seg.path}'`)
    assert.ok(allSummarizeText.includes(seg.role), `summarizer prompt must contain role='${seg.role}'`)
    assert.ok(allSummarizeText.includes(String(seg.charOffsets.start)), `summarizer prompt must contain charOffsets.start=${seg.charOffsets.start}`)
    assert.ok(allSummarizeText.includes(String(seg.charOffsets.end)), `summarizer prompt must contain charOffsets.end=${seg.charOffsets.end}`)
    assert.ok(allSummarizeText.includes(String(seg.messageRange.startMsg)), `summarizer prompt must contain messageRange.startMsg=${seg.messageRange.startMsg}`)
  }
  // Confirm segment data is NOT silently shunted to opts keys instead.
  for (const p of summarizePrompts) {
    assert.ok(typeof p.prompt === 'string', 'agent() first arg must be a string (the prompt)')
    assert.equal(p.opts.conformanceDoc, undefined, 'conformanceDoc must NOT be a custom opts key (harness ignores it)')
    assert.equal(p.opts.segmentDescriptor, undefined, 'segmentDescriptor must NOT be a custom opts key')
    assert.equal(p.opts.manifest, undefined, 'manifest must NOT be a custom opts key on SUMMARIZE dispatch')
  }
})

test('D3-AC3: the judge prompt string carries flagResults JSON and manifest JSON', async () => {
  // The judge receives all flagger outputs + the segment manifest in its PROMPT STRING,
  // not via custom opts keys. This is the prior-attempt bug prevention (AC3 + AC6).
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)

  const fakeFlags = [
    { segment_id: 'seg0', flags: [{ what_happened: 'test', evidence: 'e', rule_cited: 'r', severity: 'low' }], jake_signals: [] },
    { segment_id: 'seg1', flags: [], jake_signals: [] },
  ]
  let judgePrompt = null
  let judgeOpts = null
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') return stubSummariesFromPrompt(prompt)
    if (opts && opts.phase === 'FLAG') {
      return { flags: [], jake_signals: [] }
    }
    if (opts && opts.phase === 'JUDGE') {
      judgePrompt = prompt
      judgeOpts = opts
      return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})

  assert.ok(judgePrompt !== null, 'judge must have been called')
  assert.ok(typeof judgePrompt === 'string', 'judge prompt must be a string')

  // flagResults must appear in the judge's PROMPT STRING as JSON, not opts.
  // We verify that the judge prompt contains at least one segment_id from the flagResults.
  // (The actual content varies by archive, but segment_ids from the manifest must be there.)
  for (const seg of manifest) {
    // Each segment's segment_id may appear in flagResults[].segment_id within the prompt.
    // Rather than asserting exact JSON, assert the judge prompt contains the manifest's segment paths
    // (the manifest JSON embed) OR the flagResults embed.
    assert.ok(
      judgePrompt.includes(seg.path) || judgePrompt.includes(seg.segment_id),
      `judge prompt must contain segment path or id from manifest/flagResults for segment ${seg.segment_id}`
    )
  }
  // The critical no-opts-data guard: flagResults and manifest must not be custom opts keys.
  assert.equal(judgeOpts && judgeOpts.flagResults, undefined, 'flagResults must NOT be a custom opts key on JUDGE dispatch (harness ignores it)')
  assert.equal(judgeOpts && judgeOpts.manifest, undefined, 'manifest must NOT be a custom opts key on JUDGE dispatch (harness ignores it)')
})

// ===========================================================================
// D3-AC4 -- Conformance-doc routing: manifest entries carry conformanceDoc derived
// from .meta.json sidecar. buildSegmentManifest reads the sidecar (when present).
// build-agent* -> worker-discipline+git-discipline
// chunk-reviewer* OR spec-drift-slop-reviewer* (C8 dual-match) -> review-contract
// coo role -> coo-sop
// unknown/utility (Explore, workflow-subagent, null/absent) -> null
// ===========================================================================

test('D3-AC4: buildSegmentManifest reads .meta.json sidecars and sets conformanceDoc on subagent entries', () => {
  // Build a synthetic archive with .meta.json sidecars alongside the subagent .jsonl files.
  const base = mkdtempSync(join(tmpdir(), 'grader-meta-'))
  const sid = 'meta-session-0001'
  const sessDir = join(base, sid)
  const innerDir = join(sessDir, sid)
  const subDir = join(innerDir, 'subagents')
  mkdirSync(subDir, { recursive: true })

  // COO log: small file.
  const cooLine = (i) => JSON.stringify({ i, pad: 'x'.repeat(100) })
  writeFileSync(join(sessDir, `${sid}.jsonl`), Array.from({length:3}, (_,i)=>cooLine(i)).join('\n') + '\n')

  // build-agent-heavy subagent + its .meta.json sidecar (A-tier: IN scope after the
  // grader-scope filter, so it appears in the manifest and we can assert its routing).
  const buildAgentJSONL = join(subDir, 'agent-build.jsonl')
  writeFileSync(buildAgentJSONL, '{"type":"msg"}\n')
  writeFileSync(join(subDir, 'agent-build.meta.json'), JSON.stringify({ agentType: 'build-agent-heavy', description: 'builds chunk 1', toolUseId: 'tu1' }))

  // chunk-reviewer-heavy subagent + sidecar (A/S reviewer: IN scope after the filter).
  const newReviewerJSONL = join(subDir, 'agent-review-new.jsonl')
  writeFileSync(newReviewerJSONL, '{"type":"msg"}\n')
  writeFileSync(join(subDir, 'agent-review-new.meta.json'), JSON.stringify({ agentType: 'chunk-reviewer-heavy', description: 'reviews chunk 2', toolUseId: 'tu2b' }))

  const manifest = lib.buildSegmentManifest(base)

  // COO log segment: conformanceDoc should be 'coo-sop' path
  const cooSeg = manifest.find((s) => s.path.includes(`${sid}.jsonl`) && !s.path.includes('subagents'))
  assert.ok(cooSeg, 'COO log must produce a segment')
  assert.ok(cooSeg.conformanceDoc !== undefined, 'COO log segment must have conformanceDoc field')
  assert.ok(
    cooSeg.conformanceDoc === null || (typeof cooSeg.conformanceDoc === 'string' && /coo-?sop/i.test(cooSeg.conformanceDoc)),
    `COO segment conformanceDoc must reference coo-sop or be null, got: ${JSON.stringify(cooSeg.conformanceDoc)}`
  )

  // build-agent-heavy segment: conformanceDoc should reference BOTH worker-discipline AND
  // git-discipline (build-agent* -> worker-discipline + git-discipline).
  const buildSeg = manifest.find((s) => s.path === buildAgentJSONL)
  assert.ok(buildSeg, 'build-agent-heavy transcript must produce a segment (in scope)')
  assert.ok(
    typeof buildSeg.conformanceDoc === 'string' && /worker.?discipline/i.test(buildSeg.conformanceDoc),
    `build-agent segment conformanceDoc must reference worker-discipline, got: ${JSON.stringify(buildSeg.conformanceDoc)}`
  )
  assert.ok(
    typeof buildSeg.conformanceDoc === 'string' && /git.?discipline/i.test(buildSeg.conformanceDoc),
    `build-agent segment conformanceDoc must ALSO reference git-discipline (worker-discipline + git-discipline), got: ${JSON.stringify(buildSeg.conformanceDoc)}`
  )

  // chunk-reviewer-heavy segment (NEW name): conformanceDoc references review-contract.
  const newReviewSeg = manifest.find((s) => s.path === newReviewerJSONL)
  assert.ok(newReviewSeg, 'chunk-reviewer-heavy transcript must produce a segment (in scope)')
  assert.ok(
    typeof newReviewSeg.conformanceDoc === 'string' && /review.?contract/i.test(newReviewSeg.conformanceDoc),
    `chunk-reviewer (new name) conformanceDoc must reference review-contract, got: ${JSON.stringify(newReviewSeg.conformanceDoc)}`
  )

  // The conformance-doc ROUTING for agentTypes that the grader-scope filter excludes
  // (B-tier build-agent, the OLD spec-drift-slop-reviewer name via C8 dual-match,
  // unknown/utility types, and no-sidecar) is still exercised directly on
  // deriveConformanceDoc -- those segments no longer reach the manifest, but the routing
  // function that the manifest delegates to must still map them correctly.
  assert.match(lib.deriveConformanceDoc('/x/agent-b.jsonl', 'coo'), /coo-?sop/i, 'coo role -> coo-sop')
})

test('D3-AC4: deriveConformanceDoc routing holds for agentTypes the scope filter excludes', () => {
  // The grader-scope filter drops B-tier build-agent, the OLD spec-drift-slop-reviewer
  // name, utility types, and no-sidecar segments from the MANIFEST -- but the
  // conformance-doc routing function must still map every one of them correctly (it is
  // the same function the manifest delegates to for in-scope segments). Exercised here
  // directly on deriveConformanceDoc with real sidecars, since those segments no longer
  // appear in the manifest to assert against.
  const base = mkdtempSync(join(tmpdir(), 'grader-route-'))
  const mk = (key, agentType) => {
    const jsonl = join(base, `agent-${key}.jsonl`)
    writeFileSync(jsonl, '{"type":"msg"}\n')
    if (agentType !== undefined) writeFileSync(join(base, `agent-${key}.meta.json`), JSON.stringify({ agentType }))
    return jsonl
  }
  // B-tier build-agent (base): still routes to worker-discipline + git-discipline.
  const bBuild = lib.deriveConformanceDoc(mk('bbuild', 'build-agent'), 'subagent')
  assert.ok(/worker.?discipline/i.test(bBuild) && /git.?discipline/i.test(bBuild),
    `build-agent (base) must route to worker-discipline + git-discipline, got: ${JSON.stringify(bBuild)}`)
  // OLD reviewer name (C8 dual-match): still routes to review-contract.
  const oldRev = lib.deriveConformanceDoc(mk('oldrev', 'spec-drift-slop-reviewer'), 'subagent')
  assert.ok(/review.?contract/i.test(oldRev), `spec-drift-slop-reviewer (old name) must route to review-contract, got: ${JSON.stringify(oldRev)}`)
  // Unknown/utility agentType -> null.
  assert.equal(lib.deriveConformanceDoc(mk('util', 'workflow-subagent'), 'subagent'), null, 'utility agentType -> null')
  // No sidecar -> null.
  assert.equal(lib.deriveConformanceDoc(mk('nometa', undefined), 'subagent'), null, 'absent sidecar -> null')
})

test('D3-AC4: summarizer prompt string carries the conformanceDoc path when set', async () => {
  // When a manifest entry has a non-null conformanceDoc, the SUMMARIZER's prompt string
  // must include that path as context (the summarizer now carries the per-segment
  // descriptor + conformanceDoc; the flagger reads the resulting summaries).
  const base = mkdtempSync(join(tmpdir(), 'grader-cd-'))
  const sid = 'cd-session-0001'
  const sessDir = join(base, sid)
  const innerDir = join(sessDir, sid)
  const subDir = join(innerDir, 'subagents')
  mkdirSync(subDir, { recursive: true })

  // Build a small build-agent-heavy subagent (A-tier: IN scope) with a sidecar so the
  // segment survives the grader-scope filter and carries a non-null conformanceDoc.
  const agentJSONL = join(subDir, 'agent-ba.jsonl')
  writeFileSync(agentJSONL, '{"type":"msg"}\n')
  writeFileSync(join(subDir, 'agent-ba.meta.json'), JSON.stringify({ agentType: 'build-agent-heavy', description: 'ba', toolUseId: 'tuba' }))

  const manifest = lib.buildSegmentManifest(base)
  const baSeg = manifest.find((s) => s.path === agentJSONL)
  assert.ok(baSeg, 'build-agent transcript must produce a segment')
  assert.ok(baSeg.conformanceDoc && typeof baSeg.conformanceDoc === 'string', 'build-agent segment must have a non-null conformanceDoc')

  const summarizePrompts = []
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') { summarizePrompts.push({ prompt, opts }); return stubSummariesFromPrompt(prompt) }
    if (opts && opts.phase === 'FLAG') return { flags: [], jake_signals: [] }
    if (opts && opts.phase === 'JUDGE') return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  await workflowFn()({ sessionArchiveDir: base, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})

  // The build-agent segment's conformanceDoc must appear in SOME summarizer prompt (its bundle).
  const allText = summarizePrompts.map((p) => p.prompt).join('\n@@@\n')
  assert.ok(allText.includes(baSeg.segment_id), 'a summarizer must cover the build-agent segment')
  assert.ok(allText.includes(baSeg.conformanceDoc),
    `summarizer prompt must include the conformanceDoc path '${baSeg.conformanceDoc}'`)
})

// ===========================================================================
// D3-AC5 -- Judge return + report shape: defensive re-grouping must NOT strip
// redesigner-report fields (scope, why_doc_fault, desired_behavior, constraints,
// siblings, output_contract) when the judge already grouped by file.
// ===========================================================================

test('D3-AC5: groupDocFaultsByFile is idempotent and preserves redesigner report fields when already grouped', async () => {
  // The judge emits the full redesigner-report shape per target file.
  // The workflow's defensive re-grouping must NOT strip those extra fields.
  const judgeGroupedDocFaults = [
    {
      targetFile: 'coo/communication-discipline.md',
      scope: 'global',
      findings: [
        { id: 'f1', what_happened: 'agent skipped RED', evidence: 'quote here', why_doc_fault: 'doc says X but agent did Y', desired_behavior: 'should do Z' },
      ],
      constraints: 'Sharpen, don\'t expand.',
      siblings: ['rules/taste-profile.md'],
      output_contract: 'full replacement file body',
    },
    {
      targetFile: 'disciplines/worker-discipline.md',
      scope: 'global',
      findings: [
        { id: 'f2', what_happened: 'no refactor step', evidence: 'q2', why_doc_fault: 'doc missing step', desired_behavior: 'include step' },
      ],
      constraints: 'Sharpen, don\'t expand.',
      siblings: [],
      output_contract: 'full replacement file body',
    },
  ]

  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)

  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') return stubSummariesFromPrompt(prompt)
    if (opts && opts.phase === 'JUDGE') {
      return {
        memoryCandidates: [],
        docFaults: judgeGroupedDocFaults, // judge already grouped by file
        readerModelUpdates: [],
        corpusAppend: [],
        ledgerLines: [],
      }
    }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  const result = await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})

  assert.equal(result.docFaults.length, 2, `judge-grouped docFaults must pass through as 2 entries (one per file), got ${result.docFaults.length}`)

  const aiEntry = result.docFaults.find((d) => d.targetFile === 'coo/communication-discipline.md')
  assert.ok(aiEntry, 'coo/communication-discipline.md entry must survive the re-grouping path')
  assert.equal(aiEntry.scope, 'global', 'scope field must be preserved by the re-grouping path')
  assert.ok(Array.isArray(aiEntry.findings), 'findings array must be preserved')
  assert.equal(aiEntry.findings[0].why_doc_fault, 'doc says X but agent did Y', 'why_doc_fault finding field must be preserved')
  assert.equal(aiEntry.findings[0].desired_behavior, 'should do Z', 'desired_behavior finding field must be preserved')
  assert.equal(aiEntry.findings[0].id, 'f1', 'finding id must be preserved')
  assert.equal(aiEntry.constraints, 'Sharpen, don\'t expand.', 'constraints field must be preserved')
  assert.deepEqual(aiEntry.siblings, ['rules/taste-profile.md'], 'siblings field must be preserved')
  assert.equal(aiEntry.output_contract, 'full replacement file body', 'output_contract field must be preserved')
})

test('D3-AC5: the workflow returns exactly the 5 contract keys', async () => {
  const arch = buildSyntheticArchive()
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') return stubSummariesFromPrompt(prompt)
    if (opts && opts.phase === 'JUDGE') {
      return {
        memoryCandidates: [],
        docFaults: [{ targetFile: 'rules/ai-discipline.md', findings: [{ what_happened: 'x', evidence: 'y', rule_cited: 'z', severity: 'low' }] }],
        readerModelUpdates: [],
        corpusAppend: [],
        ledgerLines: [],
      }
    }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const manifest = lib.buildSegmentManifest(arch.dir)
  const result = await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})

  const keys = Object.keys(result).sort()
  assert.deepEqual(keys, ['corpusAppend', 'docFaults', 'ledgerLines', 'memoryCandidates', 'readerModelUpdates'],
    `return must be exactly the 5 contract keys, got ${JSON.stringify(keys)}`)
})

test('D3-AC5: docFaults come back grouped BY target file (assembled, not flat)', () => {
  // The pure return-shape assembler groups raw doc-fault findings by their target
  // file so the COO can fire one redesigner per file (prevents same-file races).
  assert.equal(typeof lib.groupDocFaultsByFile, 'function', 'lib must export groupDocFaultsByFile(findings)')
  const grouped = lib.groupDocFaultsByFile([
    { targetFile: 'rules/ai-discipline.md', what_happened: 'a', evidence: 'e1', rule_cited: 'r1', severity: 'low' },
    { targetFile: 'rules/git-discipline.md', what_happened: 'b', evidence: 'e2', rule_cited: 'r2', severity: 'high' },
    { targetFile: 'rules/ai-discipline.md', what_happened: 'c', evidence: 'e3', rule_cited: 'r3', severity: 'low' },
  ])
  // Two distinct target files => two groups; ai-discipline has 2 findings folded together.
  assert.equal(grouped.length, 2, `3 findings across 2 files => 2 groups, got ${grouped.length}`)
  const ai = grouped.find((g) => g.targetFile === 'rules/ai-discipline.md')
  assert.ok(ai, 'a group must key on rules/ai-discipline.md')
  assert.equal(ai.findings.length, 2, `the two ai-discipline findings fold into one group, got ${ai.findings.length}`)
})

test('D3-AC5: the launchable workflow performs NO filesystem writes (static guard)', () => {
  // The AC3 contract is "writes NOTHING to disk" -- the COO executes side effects.
  // SEGMENT legitimately READS the archive (list transcript files + compute char
  // offsets), so a read primitive (readdirSync/readFileSync) is allowed; only WRITE
  // primitives are forbidden.
  const src = read(WORKFLOW)
  assert.ok(!/writeFileSync|writeFile\b|appendFileSync|appendFile\b|mkdirSync|mkdir\b|rmSync|\brm\b|unlinkSync|unlink\b|rmdirSync|createWriteStream/.test(src),
    'workflow must call no fs WRITE primitive (it returns data; the COO writes)')
  const fsImport = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]node:fs['"]/)
  if (fsImport) {
    const names = fsImport[1].split(',').map((s) => s.trim()).filter(Boolean)
    const writers = names.filter((n) => /write|append|mkdir|rm|unlink|create.*stream/i.test(n))
    assert.deepEqual(writers, [], `workflow imports fs WRITE names: ${JSON.stringify(writers)}`)
  }
})

// ===========================================================================
// D3-AC6 -- Full integration: real archive segmentation with mocked dispatch.
// Specifically pins data-delivery: flagResults + manifest in judge's prompt string.
// ===========================================================================

test('D3-AC6: real archive segmentation with mocked dispatch produces valid manifest and green workflow', () => {
  // Run buildSegmentManifest over the real three-loop-rebuild archive (when present).
  // Do NOT fire live agents -- the mock returns valid stub data. This validates
  // the full segmentation + conformance-doc routing chain over real files.
  const homeArchive = join(process.env.HOME || '', '.claude/specs/three-loop-rebuild/sessions')
  if (!existsSync(homeArchive)) {
    // Skip gracefully when the real archive is absent from the test environment.
    return
  }
  const manifest = lib.buildSegmentManifest(homeArchive)
  assert.ok(manifest.length > 0, 'real archive must produce >=1 segment')
  // Every segment must have the required fields including conformanceDoc (may be null for utility agents)
  for (const seg of manifest) {
    assert.ok(seg.segment_id, `every segment must have a segment_id, got: ${JSON.stringify(seg)}`)
    assert.ok(seg.path, `every segment must have a path`)
    assert.ok(seg.role === 'coo' || seg.role === 'subagent', `role must be coo or subagent, got: ${seg.role}`)
    assert.ok('conformanceDoc' in seg, `every segment must have a conformanceDoc field (may be null)`)
  }
})

test('D3-AC6: judge prompt string data-delivery pin -- flagResults and manifest embedded as JSON', async () => {
  // This is the explicit AC6 data-delivery pin: assert that the judge receives
  // flagResults + manifest via its PROMPT STRING, not via opts keys.
  // Uses a synthetic archive for hermeticity.
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  assert.ok(manifest.length >= 1, 'need at least one segment')

  // Capture every agent() call.
  const allCalls = []
  const agentMock = async (prompt, opts) => {
    allCalls.push({ prompt, opts })
    if (opts && opts.phase === 'SUMMARIZE') return stubSummariesFromPrompt(prompt)
    if (opts && opts.phase === 'FLAG') return { flags: [], jake_signals: [] }
    if (opts && opts.phase === 'JUDGE') return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})

  const judgeCalls = allCalls.filter((c) => c.opts && c.opts.phase === 'JUDGE')
  assert.equal(judgeCalls.length, 1, 'exactly one judge call must occur')

  const judgeCall = judgeCalls[0]
  const jp = judgeCall.prompt

  // The judge prompt must embed the manifest (at minimum, each segment's segment_id or path must appear)
  let manifestFound = 0
  for (const seg of manifest) {
    if (jp.includes(seg.segment_id) || jp.includes(seg.path)) manifestFound++
  }
  assert.ok(manifestFound > 0, `judge prompt must embed manifest data (segment_ids or paths); found 0 of ${manifest.length}`)

  // Confirm the critical AC3/AC6 invariant: flagResults and manifest are NOT opts keys.
  assert.equal(judgeCall.opts.flagResults, undefined,
    'flagResults must NOT appear as a custom opts key on JUDGE dispatch -- data must ride in the prompt string')
  assert.equal(judgeCall.opts.manifest, undefined,
    'manifest must NOT appear as a custom opts key on JUDGE dispatch -- data must ride in the prompt string')
  // Verify the judge prompt contains JSON-like content (segment_ids are echoed by flaggers)
  assert.ok(jp.length > 50, 'judge prompt must be a non-trivial string carrying the flagResults and manifest data')
})

// ===========================================================================
// Dual-file lockstep: the launchable .js inlines the lib helpers verbatim and
// keeps EXACTLY ONE export (export const meta). [PRESERVED from D1]
// ===========================================================================

test('lockstep: the launchable .js keeps exactly one export (export const meta)', () => {
  const src = read(WORKFLOW)
  const exportCount = (src.match(/^export\s/gm) || []).length
  assert.equal(exportCount, 1, `the Workflow harness rejects non-meta exports; expected exactly 1 export, got ${exportCount}`)
  assert.ok(/export\s+const\s+meta\s*=/.test(src), 'the one export must be `export const meta`')
})

test('lockstep: the inlined return-shape helper matches the lib source of truth', () => {
  const wf = read(WORKFLOW)
  const libSrc = read(LIB)
  // groupDocFaultsByFile is INLINED verbatim into the launchable AND defined in the lib.
  assert.ok(/function\s+groupDocFaultsByFile\b/.test(wf), 'launchable must inline function groupDocFaultsByFile')
  assert.ok(/function\s+groupDocFaultsByFile\b/.test(libSrc), 'lib must define function groupDocFaultsByFile')
  // The SEGMENT helpers (buildSegmentManifest / windowTranscript) live ONLY in the lib
  // -- the CALLER (COO) runs them; the launchable consumes the manifest via args.
  for (const name of ['buildSegmentManifest', 'windowTranscript']) {
    assert.ok(new RegExp(`export\\s+function\\s+${name}\\b`).test(libSrc), `lib must export ${name} for the caller`)
    assert.ok(!new RegExp(`function\\s+${name}\\b`).test(wf), `launchable must NOT define ${name} (fs-free; caller builds the manifest)`)
  }
})

test('lockstep (superseded by C4): FLAGS_SCHEMA in launchable and lib both use the localization field names', () => {
  const wf = read(WORKFLOW)
  const libSrc = read(LIB)
  // Both must contain the localization flag fields evidence_ref + what_caught_my_eye.
  assert.ok(/evidence_ref/.test(wf), 'launchable must have evidence_ref in its FLAGS_SCHEMA')
  assert.ok(/evidence_ref/.test(libSrc), 'lib must have evidence_ref in its FLAGS_SCHEMA')
  assert.ok(/what_caught_my_eye/.test(wf), 'launchable must have what_caught_my_eye in its FLAGS_SCHEMA')
  assert.ok(/what_caught_my_eye/.test(libSrc), 'lib must have what_caught_my_eye in its FLAGS_SCHEMA')
})

// ===========================================================================
// D4-AC1 -- applyReaderModelUpdates(currentContent, readerModelUpdates) -> newContent
// got-it update -> adds/moves concept to Known section (removes from Frontier = graduation)
// whats-X-again update -> adds/moves concept to Frontier section
// dedup across updates + against existing entries; idempotent on re-apply.
// ===========================================================================

// Helper: extract the body of a markdown section (between ## Heading and the next ## or EOF).
// Index-based (avoids JS multiline-$ gotcha: $ in (?=...) matches end-of-line, not end-of-string).
function extractSection(content, heading) {
  const headingPrefix = `## ${heading}`
  const headingLineRe = new RegExp(`^## ${heading}[^\\n]*\\n`, 'm')
  const m = headingLineRe.exec(content)
  if (!m) return null
  const bodyStart = m.index + m[0].length
  const rest = content.slice(bodyStart)
  // Find the next ## heading
  const nextHeading = /^## /m.exec(rest)
  return nextHeading ? rest.slice(0, nextHeading.index) : rest
}

test('D4-AC1: applyReaderModelUpdates is exported from grader-workflow-lib.mjs', () => {
  assert.equal(typeof lib.applyReaderModelUpdates, 'function',
    'lib must export applyReaderModelUpdates(currentContent, readerModelUpdates)')
})

test('D4-AC1: applyReaderModelUpdates adds a got-it concept to the Known section', () => {
  const content = `# Reader Model\n\n## Known\n\n- exit code\n\n## Frontier\n\n- CEO/worker model\n`
  const updates = [{ concept: 'new-concept', move: 'Known', quote: 'got it now' }]
  const result = lib.applyReaderModelUpdates(content, updates)
  const known = extractSection(result, 'Known')
  assert.ok(known && known.includes('new-concept'), `Known section must contain 'new-concept', got: ${known}`)
})

test('D4-AC1: applyReaderModelUpdates graduation -- got-it moves concept from Frontier to Known', () => {
  const content = `# Reader Model\n\n## Known\n\n- exit code\n\n## Frontier\n\n- CEO/worker model\n- playbook iteration\n`
  const updates = [{ concept: 'CEO/worker model', move: 'Known', quote: 'got it' }]
  const result = lib.applyReaderModelUpdates(content, updates)
  const known = extractSection(result, 'Known')
  const frontier = extractSection(result, 'Frontier')
  assert.ok(known && known.includes('CEO/worker model'),
    `Known section must contain graduated concept, got: ${known}`)
  assert.ok(frontier && !frontier.includes('CEO/worker model'),
    `Frontier section must NOT contain graduated concept, got: ${frontier}`)
})

test('D4-AC1: applyReaderModelUpdates adds a whats-X-again concept to Frontier', () => {
  const content = `# Reader Model\n\n## Known\n\n- exit code\n\n## Frontier\n\n- CEO/worker model\n`
  const updates = [{ concept: 'altitude curation', move: 'Frontier', quote: 'what is that' }]
  const result = lib.applyReaderModelUpdates(content, updates)
  const frontier = extractSection(result, 'Frontier')
  assert.ok(frontier && frontier.includes('altitude curation'),
    `Frontier section must contain 'altitude curation', got: ${frontier}`)
})

test('D4-AC1: applyReaderModelUpdates does NOT duplicate a concept already in Known', () => {
  const content = `# Reader Model\n\n## Known\n\n- exit code\n\n## Frontier\n\n- CEO/worker model\n`
  const updates = [{ concept: 'exit code', move: 'Known', quote: 'yes' }]
  const result = lib.applyReaderModelUpdates(content, updates)
  const known = extractSection(result, 'Known')
  const matches = (known || '').split('\n').filter((l) => l.includes('exit code'))
  assert.equal(matches.length, 1, `Known section must have exactly one 'exit code' entry, got ${matches.length}: ${known}`)
})

test('D4-AC1: applyReaderModelUpdates does NOT duplicate a concept already in Frontier', () => {
  const content = `# Reader Model\n\n## Known\n\n- exit code\n\n## Frontier\n\n- CEO/worker model\n`
  const updates = [{ concept: 'CEO/worker model', move: 'Frontier', quote: 'still unclear' }]
  const result = lib.applyReaderModelUpdates(content, updates)
  const frontier = extractSection(result, 'Frontier')
  const matches = (frontier || '').split('\n').filter((l) => l.includes('CEO/worker model'))
  assert.equal(matches.length, 1, `Frontier must have exactly one 'CEO/worker model' entry, got ${matches.length}: ${frontier}`)
})

test('D4-AC1: applyReaderModelUpdates is idempotent -- re-applying same updates produces identical output', () => {
  const content = `# Reader Model\n\n## Known\n\n- exit code\n\n## Frontier\n\n- CEO/worker model\n`
  const updates = [
    { concept: 'new-thing', move: 'Known', quote: 'got it' },
    { concept: 'other-thing', move: 'Frontier', quote: 'confused' },
  ]
  const once = lib.applyReaderModelUpdates(content, updates)
  const twice = lib.applyReaderModelUpdates(once, updates)
  assert.equal(once, twice, 'applyReaderModelUpdates must be idempotent: applying same updates twice produces identical output')
})

test('D4-AC1: applyReaderModelUpdates deduplicates within the updates array itself', () => {
  // Two updates for the same concept with same move should produce exactly one entry
  const content = `# Reader Model\n\n## Known\n\n- exit code\n\n## Frontier\n\n- CEO/worker model\n`
  const updates = [
    { concept: 'dup-concept', move: 'Known', quote: 'first' },
    { concept: 'dup-concept', move: 'Known', quote: 'second' },
  ]
  const result = lib.applyReaderModelUpdates(content, updates)
  const known = extractSection(result, 'Known')
  const matches = (known || '').split('\n').filter((l) => l.includes('dup-concept'))
  assert.equal(matches.length, 1, `Known section must have exactly one 'dup-concept' entry even with duplicate updates, got ${matches.length}: ${known}`)
})

// ===========================================================================
// D4-AC2 -- applyCorpusAppend(currentContent, corpusAppend) -> newContent
// Appends voice samples (deduped by quote) to the corpus voice-sample section.
// ===========================================================================

test('D4-AC2: applyCorpusAppend is exported from grader-workflow-lib.mjs', () => {
  assert.equal(typeof lib.applyCorpusAppend, 'function',
    'lib must export applyCorpusAppend(currentContent, corpusAppend)')
})

test('D4-AC2: applyCorpusAppend appends a new voice sample to the corpus', () => {
  const content = `# the operator corpus\n\n## Voice samples\n\n<!-- grader-maintained: voice samples appended below -->\n`
  const samples = [{ quote: 'ship it means finish completely', context: 'shipping directive' }]
  const result = lib.applyCorpusAppend(content, samples)
  assert.ok(result.includes('ship it means finish completely'),
    `result must contain the appended quote, got: ${result}`)
})

test('D4-AC2: applyCorpusAppend does NOT duplicate an existing quote', () => {
  const content = `# the operator corpus\n\n## Voice samples\n\n<!-- grader-maintained -->\n- ship it means finish completely (shipping directive)\n`
  const samples = [{ quote: 'ship it means finish completely', context: 'shipping directive' }]
  const result = lib.applyCorpusAppend(content, samples)
  const matches = result.split('\n').filter((l) => l.includes('ship it means finish completely'))
  assert.equal(matches.length, 1, `quote must appear exactly once after dedup, got ${matches.length} lines: ${result}`)
})

test('D4-AC2: applyCorpusAppend deduplicates by quote -- same quote with different context is NOT re-appended', () => {
  // existing entry has quote "ship it" with context "old-ctx" stored as "ship it (old-ctx)"
  // new sample has same quote "ship it" but different context "new-ctx"
  // dedup-by-quote contract: quote is the key, so this is a duplicate and must NOT be appended
  const content = `# the operator corpus\n\n## Voice samples\n\n<!-- grader-maintained -->\n- ship it (old-ctx)\n`
  const samples = [{ quote: 'ship it', context: 'new-ctx' }]
  const result = lib.applyCorpusAppend(content, samples)
  const quoteLines = result.split('\n').filter((l) => l.trimStart().startsWith('- ship it'))
  assert.equal(quoteLines.length, 1,
    `same quote with different context must NOT be appended (dedup-by-quote), got ${quoteLines.length} lines: ${result}`)
})

test('D4-AC2: applyCorpusAppend is idempotent -- re-applying same samples produces identical output', () => {
  const content = `# the operator corpus\n\n## Voice samples\n\n<!-- grader-maintained -->\n`
  const samples = [
    { quote: 'first sample', context: 'ctx1' },
    { quote: 'second sample', context: 'ctx2' },
  ]
  const once = lib.applyCorpusAppend(content, samples)
  const twice = lib.applyCorpusAppend(once, samples)
  assert.equal(once, twice, 'applyCorpusAppend must be idempotent: applying same samples twice produces identical output')
})

// ===========================================================================
// D4-AC3 -- file structure: coo/reader-model.md has Known + Frontier sections;
// coo/voice-corpus.md has a Voice samples section.
// ===========================================================================

test('D4-AC3: coo/reader-model.md contains a Known section and a Frontier section', () => {
  const content = read('coo/reader-model.md')
  assert.ok(/^## Known\b/m.test(content), 'coo/reader-model.md must have a ## Known section')
  assert.ok(/^## Frontier\b/m.test(content), 'coo/reader-model.md must have a ## Frontier section')
})

test('D4-AC3: coo/voice-corpus.md contains a Voice samples section', () => {
  const content = read('coo/voice-corpus.md')
  assert.ok(/^## Voice samples\b/m.test(content), 'coo/voice-corpus.md must have a ## Voice samples section')
})

// ===========================================================================
// D4-AC4 -- no regression: workflow return still carries EXACTLY the 5 keys.
// Both pure fns are lib-only (no fs access from workflow). COO applies sole-writer.
// ===========================================================================

test('D4-AC4: ROUTED_SCHEMA still requires exactly the 5 contract keys', () => {
  assert.ok(lib.ROUTED_SCHEMA, 'lib must export ROUTED_SCHEMA')
  const required = lib.ROUTED_SCHEMA.required || []
  const sorted = required.slice().sort()
  assert.deepEqual(sorted, ['corpusAppend', 'docFaults', 'ledgerLines', 'memoryCandidates', 'readerModelUpdates'],
    `ROUTED_SCHEMA required must be exactly the 5 contract keys, got ${JSON.stringify(sorted)}`)
})

test('D4-AC4: lib documents COO sole-writer pattern in a comment (apply fns have no fs access)', () => {
  const libSrc = read(LIB)
  // The lib comment must indicate these are pure fns and the COO applies them sole-writer.
  assert.ok(
    /applyReaderModelUpdates/.test(libSrc) && /applyCorpusAppend/.test(libSrc),
    'lib must define both applyReaderModelUpdates and applyCorpusAppend'
  )
  // No fs write calls in the lib export of these functions (they are PURE)
  // Verify: the functions do not import or call any fs write primitive.
  assert.ok(!/writeFileSync|appendFileSync|writeFile\b|appendFile\b/.test(libSrc),
    'lib must not contain any fs write primitives (pure functions; COO writes)')
})

// ===========================================================================
// D4-AC5 -- lockstep: applyReaderModelUpdates + applyCorpusAppend are exported from
// lib AND their function bodies are inlined verbatim in grader-workflow.js.
// ===========================================================================

test('D4-AC5: applyReaderModelUpdates and applyCorpusAppend are defined in grader-workflow.js (lockstep)', () => {
  const wf = read(WORKFLOW)
  assert.ok(/function\s+applyReaderModelUpdates\b/.test(wf),
    "launchable grader-workflow.js must inline function applyReaderModelUpdates (lockstep with lib)")
  assert.ok(/function\s+applyCorpusAppend\b/.test(wf),
    "launchable grader-workflow.js must inline function applyCorpusAppend (lockstep with lib)")
})

// Helper: extract a named function body from source text, strip `export` keyword,
// strip single-line comments, and collapse whitespace for a normalized comparison.
// This is intentionally lenient on formatting (single vs multi-line chains) but strict
// on semantics (dead locals must not appear in one file but not the other).
function normalizeBody(src, fnName) {
  // Match 'export function fnName' or 'function fnName'
  const startRe = new RegExp(`(?:export\\s+)?function\\s+${fnName}\\b`)
  const startMatch = startRe.exec(src)
  if (!startMatch) return null
  let depth = 0
  let i = startMatch.index
  let started = false
  while (i < src.length) {
    if (src[i] === '{') { depth++; started = true }
    else if (src[i] === '}') { depth-- }
    if (started && depth === 0) { i++; break }
    i++
  }
  let body = src.slice(startMatch.index, i)
  // Strip leading `export ` so lib and wf bodies can be compared
  body = body.replace(/^export\s+/, '')
  // Strip single-line comments (// ...) -- catches the dead-variable comment lines too
  body = body.replace(/\/\/[^\n]*/g, '')
  // Collapse all whitespace runs to a single space and trim
  body = body.replace(/\s+/g, ' ').trim()
  return body
}

test('D4-AC5: applyCorpusAppend body in grader-workflow.js matches lib (normalized lockstep)', () => {
  const libSrc = read(LIB)
  const wfSrc = read(WORKFLOW)
  const libBody = normalizeBody(libSrc, 'applyCorpusAppend')
  const wfBody = normalizeBody(wfSrc, 'applyCorpusAppend')
  assert.ok(libBody !== null, 'lib must define applyCorpusAppend')
  assert.ok(wfBody !== null, 'workflow must define applyCorpusAppend')
  assert.equal(libBody, wfBody,
    'applyCorpusAppend body must be identical (normalized) in both files -- divergence means lockstep is broken')
})

test('D4-AC5: applyReaderModelUpdates body in grader-workflow.js matches lib (normalized lockstep)', () => {
  const libSrc = read(LIB)
  const wfSrc = read(WORKFLOW)
  const libBody = normalizeBody(libSrc, 'applyReaderModelUpdates')
  const wfBody = normalizeBody(wfSrc, 'applyReaderModelUpdates')
  assert.ok(libBody !== null, 'lib must define applyReaderModelUpdates')
  assert.ok(wfBody !== null, 'workflow must define applyReaderModelUpdates')
  assert.equal(libBody, wfBody,
    'applyReaderModelUpdates body must be identical (normalized) in both files -- divergence means lockstep is broken')
})

// ===========================================================================
// grader-scope -- per-segment SCOPE FILTER on buildSegmentManifest.
// The grader must grade only HIGH-SIGNAL segments: COO windows + A/S-tier
// pipeline segments (build+fixer+reviewer). B/C pipelines, memory/diagram/demo
// agents, and the grader's OWN sessions (no self-grade recursion) are excluded.
// Tier is derived from agentType (the agent-FILE name encodes tier):
//   build-agent-max=S, build-agent-heavy=A, build-agent(base)=B, build-agent-light=C
//   fixer-heavy / chunk-reviewer-heavy serve A/S; fixer / fixer-light / chunk-reviewer serve B/C
// agentType source = THE SAME .meta.json sidecar deriveConformanceDoc already reads.
// ===========================================================================

// Build an archive whose subagents span the full agentType spectrum: A/S variants
// (kept), B/C variants (dropped), utility agents (dropped), the grader's own
// subagents (dropped). Each subagent gets a .meta.json sidecar carrying its agentType,
// matching the real on-disk layout. Returns the dir + the per-agentType jsonl paths.
function buildScopeArchive() {
  const base = mkdtempSync(join(tmpdir(), 'grader-scope-'))

  // --- Session 1: the main non-grader session (COO log INCLUDED, AC3) ---
  const sid = 'scope-session-0001'
  const sessDir = join(base, sid)
  const innerDir = join(sessDir, sid)
  const subDir = join(innerDir, 'subagents')
  mkdirSync(subDir, { recursive: true })

  // COO log (role=='coo'): always INCLUDED regardless of tier (AC3).
  const cooLine = (i) => JSON.stringify({ i, pad: 'x'.repeat(100) })
  writeFileSync(join(sessDir, `${sid}.jsonl`), Array.from({ length: 3 }, (_, i) => cooLine(i)).join('\n') + '\n')

  // Each subagent: a tiny jsonl + a .meta.json sidecar with its agentType.
  const paths = {}
  const mk = (key, agentType, dir) => {
    const d = dir || subDir
    const jsonl = join(d, `agent-${key}.jsonl`)
    writeFileSync(jsonl, '{"type":"msg"}\n')
    writeFileSync(join(d, `agent-${key}.meta.json`), JSON.stringify({ agentType, description: key, toolUseId: `tu-${key}` }))
    paths[key] = jsonl
  }

  // --- A/S-tier pipeline variants: INCLUDED (AC1) ---
  mk('buildHeavy', 'build-agent-heavy')        // A-tier build
  mk('buildMax', 'build-agent-max')            // S-tier build
  mk('fixerHeavy', 'fixer-heavy')              // A/S fixer
  mk('reviewerHeavy', 'chunk-reviewer-heavy')  // A/S reviewer

  // --- B/C-tier pipeline variants: EXCLUDED (AC2) ---
  mk('buildBase', 'build-agent')               // B-tier build (base)
  mk('buildLight', 'build-agent-light')        // C-tier build
  mk('fixerBase', 'fixer')                     // B/C fixer
  mk('fixerLight', 'fixer-light')              // B/C fixer
  mk('reviewerBase', 'chunk-reviewer')         // B/C reviewer

  // --- non-pipeline agents: EXCLUDED (AC4) ---
  mk('memory', 'memory-agent')
  mk('diagram', 'diagram-refresher')
  mk('demo', 'demo-assembler')

  // --- Session 2: grader-workflow session (COO log EXCLUDED, AC5 workflow-run arm) ---
  // Grader-flagger and grader-judge live in their OWN grader-workflow session, not in
  // the main session above. Their presence in the subagent dir of session 2 identifies
  // session 2's COO log as a grader-workflow run (isGraderWorkflowSession returns true).
  // They must ALSO be excluded as subagents (segmentInScope returns false for them).
  const gsid = 'grader-session-0001'
  const gSessDir = join(base, gsid)
  const gSubDir = join(gSessDir, gsid, 'subagents')
  mkdirSync(gSubDir, { recursive: true })
  writeFileSync(join(gSessDir, `${gsid}.jsonl`), '{"type":"msg"}\n')
  paths.graderCooLog = join(gSessDir, `${gsid}.jsonl`)

  mk('flagger', 'grader-flagger', gSubDir)
  mk('judge', 'grader-judge', gSubDir)

  return { dir: base, sid, paths }
}

test('grader-scope: lib exports the segmentInScope predicate', () => {
  assert.equal(typeof lib.segmentInScope, 'function',
    'lib must export segmentInScope(agentType, role) -> boolean (the per-segment scope filter)')
})

test('grader-scope AC1: A/S-tier pipeline variants (build/fixer/reviewer) are INCLUDED', () => {
  const arch = buildScopeArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const present = (p) => manifest.some((s) => s.path === p)
  for (const key of ['buildHeavy', 'buildMax', 'fixerHeavy', 'reviewerHeavy']) {
    assert.ok(present(arch.paths[key]),
      `A/S-tier variant '${key}' (${arch.paths[key]}) must be INCLUDED in the manifest`)
  }
})

test('grader-scope AC2: B/C-tier pipeline variants are EXCLUDED', () => {
  const arch = buildScopeArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const present = (p) => manifest.some((s) => s.path === p)
  for (const key of ['buildBase', 'buildLight', 'fixerBase', 'fixerLight', 'reviewerBase']) {
    assert.ok(!present(arch.paths[key]),
      `B/C-tier variant '${key}' (${arch.paths[key]}) must be EXCLUDED from the manifest`)
  }
})

test('grader-scope AC3: every role==coo segment is INCLUDED regardless of tier', () => {
  const arch = buildScopeArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const cooSegs = manifest.filter((s) => s.role === 'coo')
  assert.ok(cooSegs.length >= 1, 'the COO log must produce at least one INCLUDED coo segment')
  // Predicate-level: coo is in scope even when agentType is null/absent.
  assert.equal(lib.segmentInScope(null, 'coo'), true, 'segmentInScope(null, "coo") must be true (all COO windows kept)')
})

test('grader-scope AC4: memory-agent, diagram-refresher, demo-assembler are EXCLUDED', () => {
  const arch = buildScopeArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const present = (p) => manifest.some((s) => s.path === p)
  for (const key of ['memory', 'diagram', 'demo']) {
    assert.ok(!present(arch.paths[key]),
      `non-pipeline agent '${key}' (${arch.paths[key]}) must be EXCLUDED`)
  }
})

test('grader-scope AC5: grader-flagger + grader-judge are EXCLUDED (no self-grade recursion)', () => {
  const arch = buildScopeArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const present = (p) => manifest.some((s) => s.path === p)
  for (const key of ['flagger', 'judge']) {
    assert.ok(!present(arch.paths[key]),
      `the grader's own subagent '${key}' (${arch.paths[key]}) must be EXCLUDED (no self-grade)`)
  }
  // Predicate-level pin on the exact agentTypes.
  assert.equal(lib.segmentInScope('grader-flagger', 'subagent'), false, 'grader-flagger must be out of scope')
  assert.equal(lib.segmentInScope('grader-judge', 'subagent'), false, 'grader-judge must be out of scope')
  // The grader-workflow SESSION COO log (identified by its subagents containing grader agents)
  // must also be EXCLUDED (no self-grade recursion for the whole session, not just its subagents).
  assert.ok(!present(arch.paths.graderCooLog),
    `grader-workflow session COO log (${arch.paths.graderCooLog}) must be EXCLUDED (isGraderWorkflowSession)`)
})

test('grader-scope: the manifest is EXACTLY the COO + A/S-variant segments (whole include/exclude set)', () => {
  // Anti-tautology: assert the complete partition, not just spot checks. The kept set
  // is precisely { all coo segments } UNION { the 4 A/S-variant subagent segments }.
  const arch = buildScopeArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const keptSubPaths = manifest.filter((s) => s.role === 'subagent').map((s) => s.path).sort()
  const expected = ['buildHeavy', 'buildMax', 'fixerHeavy', 'reviewerHeavy'].map((k) => arch.paths[k]).sort()
  assert.deepEqual(keptSubPaths, expected,
    `subagent segments must be EXACTLY the 4 A/S variants, got ${JSON.stringify(keptSubPaths)}`)
  // And at least one coo segment survives.
  assert.ok(manifest.some((s) => s.role === 'coo'), 'COO segments must survive the filter')
})

test('grader-scope: segmentInScope predicate maps each agentType to the right verdict', () => {
  // Direct predicate truth table -- expected values decided from the spec, not the impl.
  const inScope = ['build-agent-heavy', 'build-agent-max', 'fixer-heavy', 'chunk-reviewer-heavy']
  const outScope = [
    'build-agent', 'build-agent-light', 'fixer', 'fixer-light', 'chunk-reviewer',
    'memory-agent', 'diagram-refresher', 'demo-assembler',
    'grader-flagger', 'grader-judge', 'Explore', 'workflow-subagent', null,
  ]
  for (const at of inScope) assert.equal(lib.segmentInScope(at, 'subagent'), true, `${at} must be IN scope`)
  for (const at of outScope) assert.equal(lib.segmentInScope(at, 'subagent'), false, `${at} must be OUT of scope`)
})

test('grader-scope AC6: spec-collab boundary logic exists and excludes pre-spec-collab segments', () => {
  // Best-effort if the archive is already spec-scoped, but the boundary logic must EXIST
  // and be testable. The lib exposes isSpecCollabOnward(record) -> boolean: a segment is
  // kept only from spec-collab onward; pre-spec-collab chatter is dropped.
  assert.equal(typeof lib.isSpecCollabOnward, 'function',
    'lib must export isSpecCollabOnward(segment) -> boolean (the spec-collab boundary)')
  // A segment explicitly marked pre-spec-collab is excluded.
  assert.equal(lib.isSpecCollabOnward({ preSpecCollab: true }), false,
    'a pre-spec-collab segment must be excluded by the boundary')
  // A normal (spec-scoped) segment is kept (best-effort default for already-scoped archives).
  assert.equal(lib.isSpecCollabOnward({ preSpecCollab: false }), true,
    'a spec-collab-onward segment must be kept')
  assert.equal(lib.isSpecCollabOnward({}), true,
    'an unmarked segment defaults to kept (archive already spec-scoped)')
})

test('grader-scope AC5: grader-workflow RUNS (COO log for a grader-workflow session) are EXCLUDED', () => {
  // AC5 says: "grader-flagger + grader-judge segments AND grader-workflow runs are
  // EXCLUDED (no self-grade recursion)". A grader-workflow session is identified by its
  // subagent directory containing grader-flagger or grader-judge agents. The COO log for
  // such a session must be excluded even though role==='coo' (the coo-include branch in
  // segmentInScope is NOT sufficient; grader-workflow COO logs must be filtered out before
  // the scope predicate).
  //
  // Archive shape:
  //   sessions/
  //     normal-session/                   <- normal COO session -> INCLUDED
  //       normal-session.jsonl
  //     grader-session/                   <- grader-workflow session -> EXCLUDED
  //       grader-session.jsonl            <- its COO log (must be excluded)
  //       grader-session/subagents/
  //         agent-flagger.jsonl           <- grader-flagger (always excluded as subagent)
  //         agent-flagger.meta.json
  //         agent-judge.jsonl             <- grader-judge (always excluded as subagent)
  //         agent-judge.meta.json

  const base = mkdtempSync(join(tmpdir(), 'grader-ac5-workflow-'))

  // --- normal COO session (must be INCLUDED) ---
  const normId = 'normal-session'
  const normSessDir = join(base, normId)
  mkdirSync(normSessDir, { recursive: true })
  writeFileSync(join(normSessDir, `${normId}.jsonl`), '{"type":"msg"}\n')
  const normCooPath = join(normSessDir, `${normId}.jsonl`)

  // --- grader-workflow COO session (must be EXCLUDED) ---
  const gId = 'grader-session'
  const gSessDir = join(base, gId)
  const gSubDir = join(gSessDir, gId, 'subagents')
  mkdirSync(gSubDir, { recursive: true })
  writeFileSync(join(gSessDir, `${gId}.jsonl`), '{"type":"msg"}\n')
  const graderCooPath = join(gSessDir, `${gId}.jsonl`)
  // The subagent directory contains grader-flagger + grader-judge agents, identifying
  // this session as a grader-workflow run.
  writeFileSync(join(gSubDir, 'agent-flagger.jsonl'), '{"type":"msg"}\n')
  writeFileSync(join(gSubDir, 'agent-flagger.meta.json'), JSON.stringify({ agentType: 'grader-flagger' }))
  writeFileSync(join(gSubDir, 'agent-judge.jsonl'), '{"type":"msg"}\n')
  writeFileSync(join(gSubDir, 'agent-judge.meta.json'), JSON.stringify({ agentType: 'grader-judge' }))

  const manifest = lib.buildSegmentManifest(base)
  const paths = manifest.map((s) => s.path)

  assert.ok(paths.includes(normCooPath),
    `normal COO session (${normCooPath}) must be INCLUDED in the manifest`)
  assert.ok(!paths.includes(graderCooPath),
    `grader-workflow COO log (${graderCooPath}) must be EXCLUDED (no self-grade recursion for grader-workflow run)`)
})

// ===========================================================================
// grader-efficiency -- TWO bundling layers + a haiku front-end.
//
// CONTRACT under test (chunk grader-efficiency, RE-DISPATCH expanded):
// The pipeline becomes SEGMENT -> PRE-BUNDLE -> SUMMARIZE(haiku) -> FLAG(sonnet,
// bundled) -> JUDGE(opus). Two configurable group sizes (segment maxPerBundle,
// summary K) and a char budget on the segment bundles.
//
//   (EFF-AC1) preBundleSegments(manifest, maxPerBundle, charCap) is a pure lib fn that
//             groups in-scope segments into size-capped bundles (<= maxPerBundle members
//             AND <= charCap chars; never splits a segment across bundles). The launchable
//             dispatches ONE haiku summarizer per segment-bundle -> M segments yield
//             < M haiku dispatches for maxPerBundle > 1.
//   (EFF-AC2) agents/grader-summarizer.md exists, model: haiku, pure extraction (no
//             judgment/grading/proposals), and instructs per-segment evidence refs keyed
//             by segment_id so a downstream flag maps back to a specific segment's raw slice.
//   (EFF-AC3) bundleSummaries(summaries, K) is a pure lib fn grouping S summaries into
//             ceil(S/K) bundles; the launchable dispatches ONE sonnet grader-flagger per
//             summary-bundle (not per segment/summary).
//   (EFF-AC4) the opus grader-judge still dereferences each flag to the RAW transcript
//             slice via Read (judges ground truth, not summaries) AND the 5-key routed
//             return + the grader-scope filter (COO + A/S) are UNCHANGED.
//   (EFF-AC5) full suite green (the whole file).
//
// Both new pure fns are lib-only AND inlined verbatim into the launchable .js (the
// dual-file lockstep convention); the launchable calls them from its dispatch path.
// ===========================================================================

// EFF-AC1 ------------------------------------------------------------------

test('EFF-AC1: lib exports preBundleSegments(manifest, maxPerBundle, charCap)', () => {
  assert.equal(typeof lib.preBundleSegments, 'function',
    'lib must export preBundleSegments(manifest, maxPerBundle, charCap) -> bundles[]')
})

test('EFF-AC1: preBundleSegments groups M segments into < M bundles for maxPerBundle > 1', () => {
  // 6 small segments, maxPerBundle 3, generous charCap -> ceil(6/3) = 2 bundles (< 6).
  const seg = (i) => ({
    segment_id: `s${i}`, path: `/p/${i}.jsonl`, role: 'subagent',
    charOffsets: { start: 0, end: 100 }, messageRange: { startMsg: 0, endMsg: 1 },
    conformanceDoc: 'disciplines/worker-discipline.md',
  })
  const manifest = Array.from({ length: 6 }, (_, i) => seg(i))
  const bundles = lib.preBundleSegments(manifest, 3, 1_000_000)
  assert.ok(Array.isArray(bundles), 'preBundleSegments returns an array of bundles')
  assert.ok(bundles.length < manifest.length,
    `M=${manifest.length} segments must yield < M bundles for maxPerBundle>1, got ${bundles.length}`)
  assert.equal(bundles.length, 2, `ceil(6/3) = 2 bundles, got ${bundles.length}`)
  // Each bundle holds at most maxPerBundle segments.
  for (const b of bundles) {
    assert.ok(Array.isArray(b.segments), 'each bundle carries a .segments array')
    assert.ok(b.segments.length <= 3, `no bundle exceeds maxPerBundle=3, got ${b.segments.length}`)
  }
  // Every segment lands in exactly one bundle (no split, no drop, no duplication).
  const flat = bundles.flatMap((b) => b.segments.map((s) => s.segment_id)).sort()
  assert.deepEqual(flat, manifest.map((s) => s.segment_id).sort(),
    'every segment must appear in exactly one bundle (no split across bundles, no drop)')
})

test('EFF-AC1: preBundleSegments respects the char budget (a bundle never exceeds charCap)', () => {
  // Each segment is ~600 chars (end - start). charCap 1000 admits at most 1 per bundle
  // even though maxPerBundle is 5 -> the char budget, not the count, caps these bundles.
  const seg = (i) => ({
    segment_id: `s${i}`, path: `/p/${i}.jsonl`, role: 'subagent',
    charOffsets: { start: 0, end: 600 }, messageRange: { startMsg: 0, endMsg: 1 },
    conformanceDoc: null,
  })
  const manifest = Array.from({ length: 4 }, (_, i) => seg(i))
  const bundles = lib.preBundleSegments(manifest, 5, 1000)
  // 600-char segments under a 1000 cap -> one per bundle (a second would be 1200 > 1000).
  assert.equal(bundles.length, 4, `char budget must force 1 segment/bundle, got ${bundles.length} bundles`)
  for (const b of bundles) {
    const sum = b.segments.reduce((acc, s) => acc + (s.charOffsets.end - s.charOffsets.start), 0)
    assert.ok(sum <= 1000, `bundle char total ${sum} must be <= charCap 1000`)
  }
})

test('EFF-AC1: preBundleSegments never splits a single oversized segment across bundles', () => {
  // A lone segment larger than charCap still goes in whole (one segment per bundle, never
  // split): a bundle always holds >= 1 segment even if it overruns the cap.
  const big = {
    segment_id: 'big', path: '/p/big.jsonl', role: 'subagent',
    charOffsets: { start: 0, end: 50_000 }, messageRange: { startMsg: 0, endMsg: 9 },
    conformanceDoc: null,
  }
  const bundles = lib.preBundleSegments([big], 3, 1000)
  assert.equal(bundles.length, 1, 'one oversized segment -> exactly one bundle')
  assert.equal(bundles[0].segments.length, 1, 'the oversized segment is kept whole in its bundle')
  assert.equal(bundles[0].segments[0].segment_id, 'big', 'the segment is not split')
})

test('EFF-AC1: the launchable dispatches ONE haiku grader-summarizer per segment-bundle', async () => {
  // M segments -> < M haiku summarizer dispatches; one per PRE-BUNDLE bundle.
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const segCount = manifest.length
  assert.ok(segCount >= 2, 'need multiple segments so bundling reduces the dispatch count')

  const summarizeSpawns = []
  const flagSpawns = []
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') {
      summarizeSpawns.push({ prompt, opts })
      // A summarizer returns a summary per segment in its bundle (stubSummariesFromPrompt
      // parses the bundle's segment_ids from the prompt so every manifest segment is covered).
      return stubSummariesFromPrompt(prompt)
    }
    if (opts && opts.phase === 'FLAG') {
      flagSpawns.push({ prompt, opts })
      return { flags: [], jake_signals: [] }
    }
    if (opts && opts.phase === 'JUDGE') {
      return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})

  assert.ok(summarizeSpawns.length >= 1, 'at least one summarizer must run')
  assert.ok(summarizeSpawns.length < segCount,
    `haiku summarizer dispatches (${summarizeSpawns.length}) must be FEWER than segment count (${segCount}) -- pre-bundling`)
  for (const s of summarizeSpawns) {
    assert.equal(s.opts.agentType, 'grader-summarizer',
      `each summarizer spawn must use agentType:'grader-summarizer', got ${s.opts.agentType}`)
    assert.equal(s.opts.model, undefined, 'summarizer opts must not carry model (agent def supplies haiku)')
  }
})

test('EFF-AC1: launchable wires agentType grader-summarizer on a SUMMARIZE phase + calls preBundleSegments', () => {
  const src = read(WORKFLOW)
  assert.ok(/agentType:\s*['"]grader-summarizer['"]/.test(src),
    "launchable must dispatch agentType:'grader-summarizer' for the haiku SUMMARIZE stage")
  assert.ok(/preBundleSegments\s*\(/.test(src),
    'launchable must call preBundleSegments to group segments before the summarize fan-out')
  assert.ok(/SUMMARIZE/.test(src), 'launchable must declare a SUMMARIZE phase')
})

// EFF-AC2 ------------------------------------------------------------------

test('EFF-AC2: agents/grader-summarizer.md exists with model: haiku', () => {
  const content = read('agents/grader-summarizer.md')
  assert.ok(/^name:\s*grader-summarizer\s*$/m.test(content), 'frontmatter name must be grader-summarizer')
  assert.ok(/^model:\s*haiku\s*$/m.test(content), 'grader-summarizer must be model: haiku')
})

test('EFF-AC2: grader-summarizer is pure extraction -- no judgment/grading/proposals', () => {
  const content = read('agents/grader-summarizer.md')
  assert.ok(/pure extraction/i.test(content), 'the agent must state it does PURE EXTRACTION')
  // The hard no-judgment boundary: it must explicitly disclaim grading / judgment / proposals.
  assert.ok(/no\s+judgment|NO judgment/i.test(content), 'must disclaim judgment')
  assert.ok(/grad(e|ing)/i.test(content) && /no\s+grad|NO grad/i.test(content), 'must disclaim grading')
  assert.ok(/proposal|recommend/i.test(content), 'must disclaim proposals/recommendations')
})

test('EFF-AC2: grader-summarizer retains per-segment evidence refs keyed by segment_id', () => {
  const content = read('agents/grader-summarizer.md')
  // The summary must retain a per-segment evidence ref keyed by segment_id so a downstream
  // flag still maps back to a SPECIFIC segment's raw slice (the dereference invariant).
  assert.ok(/segment_id/.test(content), 'the agent must key its extraction by segment_id')
  assert.ok(/evidence/i.test(content), 'the agent must cite evidence refs')
  assert.ok(/tool.?call|message ref|message index/i.test(content),
    'evidence refs must be tool-call indices / message refs (so the judge can dereference the raw slice)')
})

// EFF-AC3 ------------------------------------------------------------------

test('EFF-AC3: lib exports bundleSummaries(summaries, K)', () => {
  assert.equal(typeof lib.bundleSummaries, 'function',
    'lib must export bundleSummaries(summaries, K) -> bundles[]')
})

test('EFF-AC3: bundleSummaries groups S summaries into ceil(S/K) bundles', () => {
  const summaries = Array.from({ length: 7 }, (_, i) => ({ segment_id: `s${i}`, summary: `x${i}`, evidence_refs: [] }))
  const bundles = lib.bundleSummaries(summaries, 3)
  assert.ok(Array.isArray(bundles), 'bundleSummaries returns an array')
  assert.equal(bundles.length, Math.ceil(7 / 3), `7 summaries, K=3 -> ceil(7/3) = 3 bundles, got ${bundles.length}`)
  // Every summary lands in exactly one bundle (no drop, no duplication).
  const flat = bundles.flatMap((b) => b.summaries.map((s) => s.segment_id)).sort((a, b) => a.localeCompare(b))
  assert.deepEqual(flat, summaries.map((s) => s.segment_id).sort((a, b) => a.localeCompare(b)),
    'every summary must appear in exactly one bundle')
  for (const b of bundles) assert.ok(b.summaries.length <= 3, `no bundle exceeds K=3, got ${b.summaries.length}`)
})

test('EFF-AC3: the launchable dispatches ONE sonnet grader-flagger per summary-bundle', async () => {
  // S summaries bundled by K -> ceil(S/K) flagger dispatches, NOT one per segment/summary.
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const segCount = manifest.length

  const flagSpawns = []
  let summarizerCalls = 0
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') {
      summarizerCalls++
      // Parse segment_ids from the prompt so the F2 validation (all segments must be
      // summarized) passes; stubSummariesFromPrompt returns one summary per bundled segment.
      return stubSummariesFromPrompt(prompt)
    }
    if (opts && opts.phase === 'FLAG') {
      flagSpawns.push({ prompt, opts })
      return { flags: [], jake_signals: [] }
    }
    if (opts && opts.phase === 'JUDGE') {
      return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})

  assert.ok(flagSpawns.length >= 1, 'at least one flagger must run')
  // Flagger count must be the summary-bundle count, which is <= summarizerCalls and
  // strictly fewer than the per-segment count when there is more than one segment.
  assert.ok(flagSpawns.length <= summarizerCalls,
    `flagger (summary-bundle) count (${flagSpawns.length}) must not exceed summarizer count (${summarizerCalls})`)
  assert.ok(flagSpawns.length < segCount || segCount === 1,
    `flagger dispatches (${flagSpawns.length}) must be FEWER than segment count (${segCount}) -- summaries bundle`)
  for (const s of flagSpawns) {
    assert.equal(s.opts.agentType, 'grader-flagger', `each flagger must use agentType:'grader-flagger', got ${s.opts.agentType}`)
  }
})

test('EFF-AC3: launchable calls bundleSummaries before the FLAG fan-out', () => {
  const src = read(WORKFLOW)
  assert.ok(/bundleSummaries\s*\(/.test(src), 'launchable must call bundleSummaries to group summaries before flagging')
})

// EFF-AC2/AC3 lockstep: both new pure fns live in lib AND are inlined in the launchable.
test('EFF lockstep: preBundleSegments + bundleSummaries are in lib AND inlined in the launchable', () => {
  const wf = read(WORKFLOW)
  const libSrc = read(LIB)
  for (const name of ['preBundleSegments', 'bundleSummaries']) {
    assert.ok(new RegExp(`export\\s+function\\s+${name}\\b`).test(libSrc), `lib must export ${name}`)
    assert.ok(new RegExp(`function\\s+${name}\\b`).test(wf), `launchable must inline ${name} (dual-file lockstep)`)
  }
})

test('EFF lockstep: preBundleSegments body matches between lib and launchable (normalized)', () => {
  const libBody = normalizeBody(read(LIB), 'preBundleSegments')
  const wfBody = normalizeBody(read(WORKFLOW), 'preBundleSegments')
  assert.ok(libBody && wfBody, 'both files must define preBundleSegments')
  assert.equal(libBody, wfBody, 'preBundleSegments must be byte-identical (normalized) in both files')
})

test('EFF lockstep: bundleSummaries body matches between lib and launchable (normalized)', () => {
  const libBody = normalizeBody(read(LIB), 'bundleSummaries')
  const wfBody = normalizeBody(read(WORKFLOW), 'bundleSummaries')
  assert.ok(libBody && wfBody, 'both files must define bundleSummaries')
  assert.equal(libBody, wfBody, 'bundleSummaries must be byte-identical (normalized) in both files')
})

// EFF-AC4 ------------------------------------------------------------------

test('EFF-AC4: the opus grader-judge still dereferences each flag to the RAW transcript slice via Read', () => {
  // The judge agent contract must keep the raw-slice dereference (it judges ground truth,
  // not the haiku summaries). This is the load-bearing invariant the two bundling layers
  // must NOT break: per-segment evidence refs survive both bundling layers so the judge
  // can still Read the raw slice.
  const judge = read('agents/grader-judge.md')
  assert.ok(/DEREFERENCE/i.test(judge), 'grader-judge must still DEREFERENCE flags to the raw transcript')
  assert.ok(/raw (transcript )?slice/i.test(judge), 'grader-judge must read the RAW transcript slice')
  assert.ok(/\bRead\b/.test(judge), 'grader-judge must use Read to pull the raw slice')
  // The judge must NOT be told to judge from summaries (ground truth, not the summary).
  assert.ok(/ground truth/i.test(judge), 'grader-judge must judge against ground truth, not summaries')
})

test('EFF-AC4: the judge prompt still carries the manifest so it can dereference raw slices', async () => {
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  let judgePrompt = null
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') return stubSummariesFromPrompt(prompt)
    if (opts && opts.phase === 'FLAG') return { flags: [], jake_signals: [] }
    if (opts && opts.phase === 'JUDGE') { judgePrompt = prompt; return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] } }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})
  assert.ok(judgePrompt, 'judge must run')
  // The manifest (segment_id -> path) must still be in the judge prompt for dereferencing.
  let found = 0
  for (const seg of manifest) if (judgePrompt.includes(seg.path) || judgePrompt.includes(seg.segment_id)) found++
  assert.ok(found > 0, `judge prompt must embed the manifest (segment paths/ids) for raw-slice dereference, found 0 of ${manifest.length}`)
})

test('EFF-AC4: the 5-key routed return is UNCHANGED through the new pipeline', async () => {
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') return stubSummariesFromPrompt(prompt)
    if (opts && opts.phase === 'FLAG') return { flags: [], jake_signals: [] }
    if (opts && opts.phase === 'JUDGE') {
      return {
        memoryCandidates: [],
        docFaults: [{ targetFile: 'coo/coo-sop.md', findings: [{ id: 'f1', what_happened: 'x', evidence: 'y', why_doc_fault: 'z', desired_behavior: 'w' }] }],
        readerModelUpdates: [], corpusAppend: [], ledgerLines: [],
      }
    }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const result = await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})
  const keys = Object.keys(result).sort()
  assert.deepEqual(keys, ['corpusAppend', 'docFaults', 'ledgerLines', 'memoryCandidates', 'readerModelUpdates'],
    `return must STILL be exactly the 5 contract keys after the bundling rewire, got ${JSON.stringify(keys)}`)
  // docFault grouping survives unchanged.
  assert.equal(result.docFaults.length, 1, 'docFaults still grouped by file')
  assert.equal(result.docFaults[0].findings[0].why_doc_fault, 'z', 'redesigner-report fields preserved through the rewire')
})

test('EFF-AC4: the grader-scope filter (COO + A/S) is UNCHANGED', () => {
  // The bundling rewire must not touch the scope predicate. Spot-pin the partition.
  assert.equal(lib.segmentInScope(null, 'coo'), true, 'COO still in scope')
  assert.equal(lib.segmentInScope('build-agent-heavy', 'subagent'), true, 'A-tier build still in scope')
  assert.equal(lib.segmentInScope('build-agent', 'subagent'), false, 'B-tier build still out of scope')
  assert.equal(lib.segmentInScope('grader-summarizer', 'subagent'), false,
    'the new grader-summarizer must be OUT of scope (no self-grade recursion on the grader front-end)')
  assert.equal(lib.segmentInScope('grader-flagger', 'subagent'), false, 'grader-flagger still out of scope')
})

// ===========================================================================
// FIXER FINDINGS -- grader-efficiency review findings, round 1
// Finding 1 (P1): flagPrompt must include conformance doc paths per segment
// Finding 2 (P2): workflow must validate every bundled segment has a summary
// Finding 3 (BUG): grader-judge.md "What you receive" must describe the new
//   per-flag segment_id schema (flags[].segment_id, NOT top-level segment_id).
// ===========================================================================

test('FIXER-F1: flagger prompt must include conformance doc paths for each segment', async () => {
  // Pin: the flagPrompt must carry conformance doc paths so the flagger can
  // cite rule_cited from the right doc. Summaries alone (no conformance_doc
  // field) leave the flagger unable to identify which rule was violated.
  const base = mkdtempSync(join(tmpdir(), 'grader-f1-'))
  const sid = 'f1-session'
  const sessDir = join(base, sid)
  const innerDir = join(sessDir, sid)
  const subDir = join(innerDir, 'subagents')
  mkdirSync(subDir, { recursive: true })

  // A build-agent-heavy transcript: has a conformanceDoc (worker-discipline.md).
  const agentJSONL = join(subDir, 'agent-ba.jsonl')
  writeFileSync(agentJSONL, '{"type":"msg"}\n')
  writeFileSync(join(subDir, 'agent-ba.meta.json'), JSON.stringify({ agentType: 'build-agent-heavy', description: 'ba', toolUseId: 'tu-ba' }))

  const manifest = lib.buildSegmentManifest(base)
  const baSeg = manifest.find((s) => s.path === agentJSONL)
  assert.ok(baSeg && baSeg.conformanceDoc, 'build-agent segment must have a non-null conformanceDoc')

  const flagPrompts = []
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') return { summaries: [{ segment_id: baSeg.segment_id, summary: 's', evidence_refs: [] }] }
    if (opts && opts.phase === 'FLAG') { flagPrompts.push(prompt); return { flags: [], jake_signals: [] } }
    if (opts && opts.phase === 'JUDGE') return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  await workflowFn()({ sessionArchiveDir: base, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})

  assert.ok(flagPrompts.length >= 1, 'at least one flag prompt must be generated')
  const allFlagText = flagPrompts.join('\n')
  assert.ok(allFlagText.includes(baSeg.conformanceDoc),
    `flagger prompt must include the conformanceDoc path '${baSeg.conformanceDoc}' so the flagger can cite rules from it; got: ${allFlagText.slice(0, 500)}`)
})

test('FIXER-F2: retry pass re-requests exactly the missing segment_ids, merges recovered summaries, and fails-open on still-missing', async () => {
  // Contract (chunk-1 retry): when the first SUMMARIZE pass omits N segment_ids,
  // the workflow must:
  //   (a) fire a SECOND SUMMARIZE pass that re-requests ONLY those missing ids
  //       (preBundleSegments over the missing subset),
  //   (b) merge the recovered summaries so the combined set covers all segments,
  //   (c) fail-open if some remain missing after the retry: LOG them, do NOT throw,
  //       and the workflow must still complete and return the 5 contract keys.
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  assert.ok(manifest.length >= 2, 'need at least two segments for this test')

  // normSegId mirrors the normalization in the workflow (stem#N form).
  function normId(id) {
    const str = String(id || '')
    const hashIdx = str.lastIndexOf('#')
    const left = hashIdx >= 0 ? str.slice(0, hashIdx) : str
    const suffix = hashIdx >= 0 ? str.slice(hashIdx) : ''
    const base = left.split('/').pop().replace(/\.jsonl$/i, '')
    return base + suffix
  }

  const allNormIds = manifest.map((s) => normId(s.segment_id))
  // first-pass: cover ONLY the first segment_id; the rest are "missing".
  const coveredOnFirst = new Set([allNormIds[0]])
  const missingAfterFirst = allNormIds.filter((id) => !coveredOnFirst.has(id))
  assert.ok(missingAfterFirst.length >= 1, 'fixture must produce at least one missing id')

  const firstPassSummarizePrompts = []
  const retryPassSummarizePrompts = []
  const flagPrompts = []
  let summarizeRound = 0
  const loggedMessages = []

  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') {
      summarizeRound++
      if (summarizeRound <= Math.ceil(manifest.length / 6) + 1) {
        // First-pass rounds: return only the first segment_id.
        firstPassSummarizePrompts.push(prompt)
        const ids = Array.from(prompt.matchAll(/^Segment: (.+)$/gm), (m) => m[1].trim())
        // Only return a summary for the first segment seen in the very first call.
        const toReturn = ids.filter((id) => coveredOnFirst.has(normId(id)))
        return { summaries: toReturn.map((id) => ({ segment_id: id, summary: 'first-pass stub', evidence_refs: [] })) }
      } else {
        // Retry pass: the workflow re-bundles the missing segments and dispatches again.
        // Record which segment_ids were requested in the retry.
        retryPassSummarizePrompts.push(prompt)
        // Return summaries for whatever is requested (full recovery).
        const ids = Array.from(prompt.matchAll(/^Segment: (.+)$/gm), (m) => m[1].trim())
        return { summaries: ids.map((id) => ({ segment_id: id, summary: 'retry stub', evidence_refs: [] })) }
      }
    }
    if (opts && opts.phase === 'FLAG') {
      flagPrompts.push(prompt)
      return { flags: [], jake_signals: [] }
    }
    if (opts && opts.phase === 'JUDGE') return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const logMock = (msg) => { loggedMessages.push(msg) }

  // (c) fail-open: the workflow must NOT throw even if some are still missing after retry.
  // With a full-recovery retry mock, the workflow completes with all summaries covered.
  // We test fail-open separately below; here we test the recovery path.
  const result = await workflowFn()(
    { sessionArchiveDir: arch.dir, specSlug: 'synth', manifest },
    agentMock, parallel, () => {}, logMock
  )

  // (a) The retry pass must have fired (at least one SUMMARIZE call after the first-pass rounds).
  assert.ok(retryPassSummarizePrompts.length >= 1,
    `retry SUMMARIZE pass must fire for missing segment_ids; got ${retryPassSummarizePrompts.length} retry calls (first-pass calls: ${firstPassSummarizePrompts.length})`)

  // (a) The retry prompt must request ONLY the missing segment_ids, not the already-covered ones.
  const retryText = retryPassSummarizePrompts.join('\n')
  const retryRequestedIds = Array.from(retryText.matchAll(/^Segment: (.+)$/gm), (m) => normId(m[1].trim()))
  for (const id of retryRequestedIds) {
    assert.ok(!coveredOnFirst.has(id),
      `retry must re-request ONLY missing ids; got already-covered id '${id}' in retry prompt`)
  }
  for (const id of missingAfterFirst) {
    // At least one of the missing ids must appear in the retry prompts (the retry bundles the missing subset).
    const found = retryRequestedIds.some((r) => r === id)
    assert.ok(found, `retry must request missing id '${id}'; retry requested: ${JSON.stringify(retryRequestedIds)}`)
  }

  // (b) merged summaries cover all segments: the FLAG phase must receive prompts
  // that include every recovered segment_id (normalized for format-independence).
  // This pins that summaries.push(...retrySummaries) actually merges recovered
  // summaries into the list passed downstream, not into a local copy.
  assert.ok(flagPrompts.length >= 1,
    'FLAG phase must have been invoked (merged summaries must be passed downstream)')
  // Extract all segment_ids appearing in the FLAG prompts and normalize them.
  const flagSegIds = new Set(
    flagPrompts.flatMap((p) => Array.from(p.matchAll(/"segment_id"\s*:\s*"([^"]+)"/g), (m) => normId(m[1])))
  )
  for (const id of missingAfterFirst) {
    assert.ok(flagSegIds.has(id),
      `merged summaries must cover recovered id '${id}' in the FLAG prompt (normalized); ` +
      `FLAG prompt segment_ids found: ${JSON.stringify(Array.from(flagSegIds))}`)
  }

  // (c) The workflow must complete (not throw) and return the 5 contract keys.
  assert.ok(result && typeof result === 'object', 'workflow must return a result object (fail-open: no throw)')
  const keys = Object.keys(result).sort()
  assert.deepEqual(keys, ['corpusAppend', 'docFaults', 'ledgerLines', 'memoryCandidates', 'readerModelUpdates'],
    `workflow must return the 5 contract keys even after a retry; got ${JSON.stringify(keys)}`)
})

test('FIXER-F2: still-missing segment_ids after retry are logged, not thrown (fail-open preserved)', async () => {
  // When the retry also fails to produce summaries for some ids, the workflow must
  // log (not throw) and still return the 5 contract keys.
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  assert.ok(manifest.length >= 2, 'need at least two segments for this test')

  const loggedMessages = []
  const logMock = (msg) => { loggedMessages.push(msg) }

  // Both first-pass and retry return NO summaries (worst case: total failure).
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') return { summaries: [] }
    if (opts && opts.phase === 'FLAG') return { flags: [], jake_signals: [] }
    if (opts && opts.phase === 'JUDGE') return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  // Must NOT throw -- fail-open means the workflow completes even with unrecoverable missing ids.
  let result
  let threw = false
  try {
    result = await workflowFn()(
      { sessionArchiveDir: arch.dir, specSlug: 'synth', manifest },
      agentMock, parallel, () => {}, logMock
    )
  } catch (e) {
    threw = true
  }

  assert.equal(threw, false,
    'workflow must NOT throw when segment_ids remain missing after retry (fail-open: log and continue)')

  // The workflow must still return the 5 contract keys.
  assert.ok(result && typeof result === 'object', 'workflow must return a result object even with all summaries missing')
  const keys = Object.keys(result).sort()
  assert.deepEqual(keys, ['corpusAppend', 'docFaults', 'ledgerLines', 'memoryCandidates', 'readerModelUpdates'],
    `workflow must return the 5 contract keys on fail-open; got ${JSON.stringify(keys)}`)

  // The still-missing ids must have been logged.
  // At minimum the log must mention the missing ids or "missing" concept.
  const mentionsMissing = loggedMessages.some((m) =>
    /missing|segment/i.test(String(m))
  )
  assert.ok(mentionsMissing,
    `workflow must log the still-missing segment_ids after retry; logged: ${JSON.stringify(loggedMessages)}`)
})

test('FIXER-P1: retry SUMMARIZE pass must use original full-path segment_ids, not normalized short-form', async () => {
  // Pin: the retry builds missingManifest from the original manifest (full-path segment_ids),
  // not from manifestNorm (normalized short-form). This ensures:
  //   (a) the retry prompt shows the same segment_id format as the first-pass prompt
  //       (full path: /path/to/session.jsonl#N), preserving resume cache-hit compatibility
  //   (b) no information is lost at the prompt layer (the path is still visible to the haiku)
  //
  // If missingManifest is built from manifestNorm, the retry prompt shows
  // "Segment: session#N" instead of "Segment: /full/path/session.jsonl#N".
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  assert.ok(manifest.length >= 2, 'need at least two segments for this test')

  // All original segment_ids should be full paths (absolute paths with .jsonl#N suffix).
  for (const seg of manifest) {
    assert.ok(seg.segment_id.startsWith('/'),
      `manifest segment_id must be an absolute path: ${seg.segment_id}`)
  }

  const allOrigIds = manifest.map((s) => s.segment_id)
  // First-pass: cover only the first segment_id; the rest are "missing".
  const coveredOnFirst = new Set([allOrigIds[0]])

  const retryPrompts = []
  let summarizeRound = 0

  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') {
      summarizeRound++
      if (summarizeRound <= Math.ceil(manifest.length / 6) + 1) {
        // First-pass: return only the first segment_id (full path form).
        const ids = Array.from(prompt.matchAll(/^Segment: (.+)$/gm), (m) => m[1].trim())
        const toReturn = ids.filter((id) => coveredOnFirst.has(id))
        return { summaries: toReturn.map((id) => ({ segment_id: id, summary: 'first-pass stub', evidence_refs: [] })) }
      } else {
        // Retry pass.
        retryPrompts.push(prompt)
        const ids = Array.from(prompt.matchAll(/^Segment: (.+)$/gm), (m) => m[1].trim())
        return { summaries: ids.map((id) => ({ segment_id: id, summary: 'retry stub', evidence_refs: [] })) }
      }
    }
    if (opts && opts.phase === 'FLAG') return { flags: [], jake_signals: [] }
    if (opts && opts.phase === 'JUDGE') return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))

  await workflowFn()(
    { sessionArchiveDir: arch.dir, specSlug: 'synth', manifest },
    agentMock, parallel, () => {}, () => {}
  )

  assert.ok(retryPrompts.length >= 1, 'retry SUMMARIZE pass must have fired')

  // The retry prompt must show full-path segment_ids (starting with '/'), not short-form.
  const retryText = retryPrompts.join('\n')
  const retrySegmentLines = Array.from(retryText.matchAll(/^Segment: (.+)$/gm), (m) => m[1].trim())
  assert.ok(retrySegmentLines.length >= 1, 'retry prompt must contain at least one Segment: line')
  for (const id of retrySegmentLines) {
    assert.ok(id.startsWith('/'),
      `retry prompt Segment: lines must use full-path segment_ids (starting with '/'); got: '${id}'. ` +
      `The retry must build missingManifest from the original manifest, not manifestNorm.`)
  }
})

test('FIXER-F3: grader-judge.md "What you receive" must describe per-flag segment_id (flags[].segment_id)', () => {
  // Pin: the chunk moved segment_id from the top-level flagger return
  // ({ segment_id, flags, jake_signals }) into each flag item (flags[].segment_id).
  // The judge's "What you receive" section must reflect this new shape so the judge
  // knows to extract segment_id from each flag, not from a top-level field.
  const judge = read('agents/grader-judge.md')

  // The old schema said "{ segment_id, flags, jake_signals } per segment" -- that
  // must no longer be the primary description in "What you receive".
  assert.ok(
    !/`\{\s*segment_id,\s*flags,\s*jake_signals\s*\}`/.test(judge),
    'grader-judge.md must not describe the old top-level segment_id schema ({ segment_id, flags, jake_signals })'
  )

  // The new schema: flags[].segment_id carries the per-segment reference.
  assert.ok(
    /flags\[.*\]\.segment_id|each flag.*segment_id|segment_id.*each flag|per.flag.*segment_id/i.test(judge),
    'grader-judge.md must describe that segment_id is on each flag item (flags[].segment_id), not top-level'
  )
})

// ===========================================================================
// FIXER ROUND 2 -- grader-efficiency review finding
// Finding: grader-flagger.md standing instructions still describe the OLD
// per-segment input/output shape after the workflow moved to bundled summaries.
// ===========================================================================

test('FIXER-R2-F1: grader-flagger.md must NOT describe the old per-segment dispatch shape', () => {
  // Pin: after the grader-efficiency chunk, the flagger receives a BUNDLE of haiku
  // summaries (one flagger per summary-bundle, NOT one per raw segment). The frontmatter
  // description must NOT say "one per segment" and the return must NOT have a top-level
  // segment_id field (segment_id now lives on each flag item: flags[].segment_id).
  const flagger = read('agents/grader-flagger.md')

  // (a) The frontmatter description must not describe the old "one per segment" dispatch.
  assert.ok(
    !/one per segment in parallel/i.test(flagger),
    'grader-flagger.md frontmatter description must not say "one per segment in parallel" (now one per summary-bundle)'
  )

  // (b) "What you receive" must not describe the old raw-segment input shape.
  // Old text: "A segment descriptor + conformance doc"
  assert.ok(
    !/A segment descriptor \+ conformance doc/i.test(flagger),
    'grader-flagger.md "What you receive" must not describe the old per-segment input ("A segment descriptor + conformance doc")'
  )

  // (c) "What you do" must not say "Read your segment from path" (the flagger no longer
  // reads raw segments; it reads haiku-extracted summaries from the prompt).
  assert.ok(
    !/Read your segment from `?path`?/i.test(flagger),
    'grader-flagger.md "What you do" must not tell the flagger to "Read your segment from path" (reads summaries, not raw segments)'
  )

  // (d) Return section must not emit a top-level segment_id (it moved to flags[].segment_id).
  // Old: `{ segment_id, flags: [...], jake_signals: [...] }` as the primary return shape.
  assert.ok(
    !/^`\{\s*segment_id,\s*flags:/m.test(flagger),
    'grader-flagger.md Return section must not emit a top-level segment_id as the primary return shape'
  )
})

test('FIXER-R2-F1: grader-flagger.md must describe the new bundled-summary input shape', () => {
  // Pin: the new flagger receives a BUNDLE of haiku summaries, each keyed by segment_id
  // with evidence refs. The agent doc must describe this new input so the flagger knows
  // what to read and how to emit flags with per-flag segment_id.
  const flagger = read('agents/grader-flagger.md')

  // (a) Must describe that it receives summaries (not raw segments).
  assert.ok(
    /summar/i.test(flagger),
    'grader-flagger.md must describe that it receives summaries (haiku-extracted)'
  )

  // (b) Each flag must carry segment_id (so the judge can dereference the raw slice).
  assert.ok(
    /segment_id/.test(flagger),
    'grader-flagger.md Flag shape must carry segment_id on each flag item (flags[].segment_id)'
  )

  // (c) The flag shape block must include segment_id as a required field.
  // The old flag shape lacked segment_id; it was only on the return envelope.
  assert.ok(
    /segment_id.*what_happened|what_happened.*segment_id|segment_id:.*<|`segment_id`/i.test(flagger),
    'grader-flagger.md Flag shape must include segment_id as a field (so each flag carries its source segment)'
  )
})

// ===========================================================================
// grader-scope-ship-reviewers -- extend segmentInScope to include ship-review-
// workflow Stage reviewers by LABEL.
//
// CONTRACT (chunk grader-scope-ship-reviewers):
//   AC1: a segment whose LABEL is one of {stage1-live-run, stage2-review,
//        stage2-codex} is INCLUDED (the ship-review reviewers).
//   AC2: a segment whose label is a ship UTILITY agent (diagram-refresh,
//        stage3-demo) is still EXCLUDED.
//   AC3: all existing inclusions (role==='coo'; agentType in
//        {build-agent-heavy, build-agent-max, fixer-heavy, chunk-reviewer-heavy})
//        and exclusions (B/C variants, memory-agent, diagram-refresher,
//        demo-assembler, grader-flagger/judge, pre-spec-collab) are UNCHANGED.
//   AC4: full suite green; grader-workflow-lib.mjs <-> grader-workflow.js
//        inline copy kept in lockstep (deriveLabel + SHIP_REVIEWER_LABELS).
//
// Labels come from the .meta.json sidecar (same source as agentType). A new
// deriveLabel(jsonlPath) helper mirrors deriveAgentType.  segmentInScope gains
// an optional third 'label' parameter; the buildSegmentManifest call site
// passes deriveLabel(f.path) to wire in the real label.
// ===========================================================================

// Build a synthetic archive that contains ship-review Stage reviewer agents
// (label-identified, no agentType) alongside existing agentType-identified agents.
// Each agent has a .meta.json sidecar with the relevant fields.
function buildShipReviewArchive() {
  const base = mkdtempSync(join(tmpdir(), 'grader-ship-review-'))
  const sid = 'ship-review-session-0001'
  const sessDir = join(base, sid)
  const innerDir = join(sessDir, sid)
  const subDir = join(innerDir, 'subagents')
  mkdirSync(subDir, { recursive: true })

  // COO log (small).
  writeFileSync(join(sessDir, `${sid}.jsonl`), '{"type":"msg"}\n')

  // Helper: write a subagent with a given label and/or agentType in its sidecar.
  const paths = {}
  const mk = (key, meta) => {
    const jsonl = join(subDir, `agent-${key}.jsonl`)
    writeFileSync(jsonl, '{"type":"msg"}\n')
    writeFileSync(join(subDir, `agent-${key}.meta.json`), JSON.stringify(meta))
    paths[key] = jsonl
    return jsonl
  }

  // Ship-review REVIEWER labels: INCLUDED (AC1).
  mk('liveRun',    { label: 'stage1-live-run',  description: 'live-run gate' })
  mk('reviewFull', { label: 'stage2-review',    description: 'full-spec reviewer' })
  mk('codex',      { label: 'stage2-codex',     description: 'Codex cross-model' })

  // Ship UTILITY labels: EXCLUDED (AC2).
  mk('diagramRefresh', { label: 'diagram-refresh', description: 'diagram utility' })
  mk('stageDemo',      { label: 'stage3-demo',     description: 'demo assembler' })

  // Existing A/S agentType variants (regression guard -- must still be INCLUDED).
  mk('buildHeavy',    { agentType: 'build-agent-heavy' })
  mk('reviewerHeavy', { agentType: 'chunk-reviewer-heavy' })

  // Existing B/C agentType variants (regression guard -- must still be EXCLUDED).
  mk('buildBase',  { agentType: 'build-agent' })
  mk('buildLight', { agentType: 'build-agent-light' })

  return { dir: base, sid, paths }
}

test('grader-scope-ship-reviewers: lib exports deriveLabel(jsonlPath) -> string|null', () => {
  // AC4 pre-req: the helper must be exported so callers can derive the label
  // from a .meta.json sidecar, mirroring deriveAgentType.
  assert.equal(typeof lib.deriveLabel, 'function',
    'lib must export deriveLabel(jsonlPath) -> string|null')
})

test('grader-scope-ship-reviewers AC1: stage1-live-run/stage2-review/stage2-codex labels are INCLUDED by segmentInScope', () => {
  // Direct predicate test -- expected from spec, not from impl.
  // segmentInScope gains an optional third `label` param; these three labels
  // must return true regardless of agentType (which is absent for inline agents).
  for (const label of ['stage1-live-run', 'stage2-review', 'stage2-codex']) {
    assert.equal(
      lib.segmentInScope(null, 'subagent', label),
      true,
      `segmentInScope(null, 'subagent', '${label}') must be true (ship-review reviewer)`
    )
  }
})

test('grader-scope-ship-reviewers AC2: diagram-refresh and stage3-demo labels are EXCLUDED by segmentInScope', () => {
  // Ship UTILITY agents stay excluded even when a label is present.
  for (const label of ['diagram-refresh', 'stage3-demo']) {
    assert.equal(
      lib.segmentInScope(null, 'subagent', label),
      false,
      `segmentInScope(null, 'subagent', '${label}') must be false (ship utility agent)`
    )
  }
})

test('grader-scope-ship-reviewers AC3: existing A/S agentType inclusions are UNCHANGED (regression guard)', () => {
  // Passing label=null/undefined must not break the existing agentType-based logic.
  for (const at of ['build-agent-heavy', 'build-agent-max', 'fixer-heavy', 'chunk-reviewer-heavy']) {
    assert.equal(lib.segmentInScope(at, 'subagent', null), true, `${at} (no label) must still be IN scope`)
    assert.equal(lib.segmentInScope(at, 'subagent', undefined), true, `${at} (undefined label) must still be IN scope`)
  }
})

test('grader-scope-ship-reviewers AC3: existing B/C and utility exclusions are UNCHANGED (regression guard)', () => {
  // A label of null/undefined must not flip B/C or utility agents to included.
  const outScope = [
    'build-agent', 'build-agent-light', 'fixer', 'fixer-light', 'chunk-reviewer',
    'memory-agent', 'diagram-refresher', 'demo-assembler', 'grader-flagger', 'grader-judge',
  ]
  for (const at of outScope) {
    assert.equal(lib.segmentInScope(at, 'subagent', null), false,
      `${at} (no label) must still be OUT of scope`)
  }
})

test('grader-scope-ship-reviewers AC3: coo role inclusion is UNCHANGED regardless of label', () => {
  // COO windows are always in scope. A label argument must not change this.
  assert.equal(lib.segmentInScope(null, 'coo', null), true, 'coo with null label must be IN scope')
  assert.equal(lib.segmentInScope(null, 'coo', 'stage2-review'), true, 'coo with reviewer label must be IN scope')
})

test('grader-scope-ship-reviewers: buildSegmentManifest INCLUDES ship-review reviewer agents (label-driven)', () => {
  // Integration test: the label flows from the .meta.json sidecar through deriveLabel
  // into segmentInScope; the manifest must contain the three reviewer paths.
  const arch = buildShipReviewArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const presentPaths = new Set(manifest.map((s) => s.path))

  for (const key of ['liveRun', 'reviewFull', 'codex']) {
    assert.ok(presentPaths.has(arch.paths[key]),
      `ship-review reviewer '${key}' (${arch.paths[key]}) must be INCLUDED in the manifest (label-based)`)
  }
})

test('grader-scope-ship-reviewers: buildSegmentManifest EXCLUDES ship utility agents (label-driven)', () => {
  const arch = buildShipReviewArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const presentPaths = new Set(manifest.map((s) => s.path))

  for (const key of ['diagramRefresh', 'stageDemo']) {
    assert.ok(!presentPaths.has(arch.paths[key]),
      `ship utility agent '${key}' (${arch.paths[key]}) must be EXCLUDED from the manifest`)
  }
})

test('grader-scope-ship-reviewers: buildSegmentManifest A/S agentType agents still INCLUDED (regression guard)', () => {
  const arch = buildShipReviewArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const presentPaths = new Set(manifest.map((s) => s.path))

  for (const key of ['buildHeavy', 'reviewerHeavy']) {
    assert.ok(presentPaths.has(arch.paths[key]),
      `A/S agentType agent '${key}' must still be INCLUDED in the manifest (regression guard)`)
  }
})

test('grader-scope-ship-reviewers: buildSegmentManifest B/C agentType agents still EXCLUDED (regression guard)', () => {
  const arch = buildShipReviewArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  const presentPaths = new Set(manifest.map((s) => s.path))

  for (const key of ['buildBase', 'buildLight']) {
    assert.ok(!presentPaths.has(arch.paths[key]),
      `B/C agentType agent '${key}' must still be EXCLUDED from the manifest (regression guard)`)
  }
})

test('grader-scope-ship-reviewers AC4: deriveLabel reads the label field from the .meta.json sidecar', () => {
  // deriveLabel mirrors deriveAgentType: reads <stem>.meta.json, returns label or null.
  const base = mkdtempSync(join(tmpdir(), 'grader-derivelabel-'))
  const mkSidecar = (key, meta) => {
    const jsonl = join(base, `${key}.jsonl`)
    writeFileSync(jsonl, '{"type":"msg"}\n')
    writeFileSync(join(base, `${key}.meta.json`), JSON.stringify(meta))
    return jsonl
  }
  // Sidecar with a label field.
  const withLabel = mkSidecar('reviewer', { label: 'stage2-review', description: 'x' })
  assert.equal(lib.deriveLabel(withLabel), 'stage2-review',
    'deriveLabel must return the label field from the .meta.json sidecar')

  // Sidecar without a label field (agentType-only agent).
  const noLabel = mkSidecar('build', { agentType: 'build-agent-heavy' })
  assert.equal(lib.deriveLabel(noLabel), null,
    'deriveLabel must return null when the sidecar has no label field')

  // Absent sidecar -> null.
  const noSidecar = join(base, 'nosidecar.jsonl')
  writeFileSync(noSidecar, '{"type":"msg"}\n')
  assert.equal(lib.deriveLabel(noSidecar), null,
    'deriveLabel must return null when no sidecar exists')
})

test('grader-scope-ship-reviewers AC4: grader-workflow.js (inline copy) references SHIP_REVIEWER_LABELS or equivalent label allow-set', () => {
  // Lockstep check: the launchable inline copy must also contain the label-based
  // inclusion logic. Assert that the label allow-set appears in the launchable source.
  const src = read(WORKFLOW)
  assert.ok(
    /stage1-live-run/.test(src) && /stage2-review/.test(src) && /stage2-codex/.test(src),
    "grader-workflow.js (inline copy) must contain the ship-reviewer label allow-set values (stage1-live-run, stage2-review, stage2-codex)"
  )
})

test('grader-scope-ship-reviewers AC4: deriveLabel is defined in grader-workflow.js (lockstep)', () => {
  // The lockstep convention: every helper in the lib that buildSegmentManifest
  // delegates to (and that the launchable inline copy uses) must appear in the
  // launchable as well.  deriveLabel is not needed in the launchable itself (the
  // COO calls buildSegmentManifest from the lib), but SHIP_REVIEWER_LABELS or
  // its equivalent must still be inlined so the launchable's segmentInScope works.
  const src = read(WORKFLOW)
  assert.ok(
    /deriveLabel\b/.test(src) || (/stage1-live-run/.test(src) && /stage2-review/.test(src)),
    "grader-workflow.js must either define deriveLabel or inline the label-based scope logic"
  )
})

// ---------------------------------------------------------------------------
// Finding 1 (fixer): ship-review reviewer segments must receive a non-null
// conformanceDoc (disciplines/review-contract.md). Previously deriveConformanceDoc
// returned null for inline agents with no agentType, even when their label was
// stage1-live-run / stage2-review / stage2-codex.
// ---------------------------------------------------------------------------

test('fixer-finding1: deriveConformanceDoc routes ship-reviewer labels to review-contract', () => {
  // Each of the three ship-reviewer labels, with no agentType in the sidecar, must
  // route to disciplines/review-contract.md via deriveConformanceDoc. Expected from
  // spec (reviewers -> review-contract); not derived from current broken impl.
  const base = mkdtempSync(join(tmpdir(), 'grader-f1-conformance-'))
  const mk = (key, meta) => {
    const jsonl = join(base, `agent-${key}.jsonl`)
    writeFileSync(jsonl, '{"type":"msg"}\n')
    writeFileSync(join(base, `agent-${key}.meta.json`), JSON.stringify(meta))
    return jsonl
  }
  for (const label of ['stage1-live-run', 'stage2-review', 'stage2-codex']) {
    const p = mk(label, { label, description: `ship reviewer ${label}` })
    const doc = lib.deriveConformanceDoc(p, 'subagent')
    assert.ok(
      typeof doc === 'string' && /review.?contract/i.test(doc),
      `deriveConformanceDoc for label '${label}' (no agentType) must return review-contract, got: ${JSON.stringify(doc)}`
    )
  }
})

test('fixer-finding1: buildSegmentManifest ship-reviewer entries carry conformanceDoc review-contract', () => {
  // Integration: the manifest entry for a ship-reviewer segment must have
  // conformanceDoc referencing review-contract (not null). Uses the existing
  // buildShipReviewArchive helper which creates sidecar-identified reviewer paths.
  const arch = buildShipReviewArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)

  for (const key of ['liveRun', 'reviewFull', 'codex']) {
    const seg = manifest.find((s) => s.path === arch.paths[key])
    assert.ok(seg, `ship-reviewer '${key}' must be in the manifest`)
    assert.ok(
      typeof seg.conformanceDoc === 'string' && /review.?contract/i.test(seg.conformanceDoc),
      `ship-reviewer '${key}' manifest entry must have conformanceDoc=review-contract, got: ${JSON.stringify(seg.conformanceDoc)}`
    )
  }
})

// ===========================================================================
// Chunk 2 -- applyLedgerLines + apply-grade-side-effects.mjs + ship-spec split
//
// CONTRACT (chunk 2 of employed-system-tuning):
//   AC1: applyLedgerLines(currentContent, ledgerLines) is exported from lib.
//        Appends new ledger lines; deduplicates an identical re-apply (idempotent).
//   AC2: workflows/apply-grade-side-effects.mjs exists; run against a fixture
//        grade JSON it updates corpus, reader-model, and ledger files; idempotent
//        on re-run (a second run produces identical output files).
//   AC3: The script emits a stderr diagnostic for each file it applies.
//        Diagnostics are gated behind a --verbose flag: absent the flag, stderr
//        is empty; with --verbose, one line per applied file appears on stderr.
//        On an error path (unreadable file), the script emits an error to stderr
//        and exits non-zero -- even without --verbose (errors always surface).
//   AC4: ship-spec SKILL.md Step 5 item 3 separates the auto-apply path
//        (corpus/reader-model/ledger via apply-grade-side-effects) from the
//        adjudicated path (memoryCandidates + docFaults). The note "a manual
//        re-grade reuses ship-spec's inline-manifest path (buildSegmentManifest ->
//        args.manifest), never a hand-rolled loader agent" appears in the doc.
// ===========================================================================

import { spawnSync } from 'node:child_process'
import { writeFileSync as _writeFileSyncAC, readFileSync as _readFileSyncAC } from 'node:fs'
import { join as _joinAC } from 'node:path'

// Fixture builder: minimal grade-result JSON + three target files.
// Returns { dir, gradeFile, corpusFile, readerFile, ledgerFile }.
function buildGradeFixture() {
  const dir = mkdtempSync(_joinAC(tmpdir(), 'employed-chunk2-'))
  const gradeFile = _joinAC(dir, 'grade.json')
  const corpusFile = _joinAC(dir, 'voice-corpus.md')
  const readerFile = _joinAC(dir, 'reader-model.md')
  const ledgerFile = _joinAC(dir, 'ledger.md')

  // Minimal grade-result JSON with one entry per apply key.
  _writeFileSyncAC(gradeFile, JSON.stringify({
    corpusAppend: [{ quote: 'ship it fast', context: 'velocity directive' }],
    readerModelUpdates: [{ concept: 'trunk-based-dev', move: 'Known', quote: 'got it' }],
    ledgerLines: ['2026-06-14 | chunk2-test | ledger-applied | test fixture'],
  }))

  // Minimal target files with the sections the apply-fns look for.
  _writeFileSyncAC(corpusFile, '# the operator corpus\n\n## Voice samples\n\n<!-- grader-maintained -->\n')
  _writeFileSyncAC(readerFile, '# Reader Model\n\n## Known\n\n- exit code\n\n## Frontier\n\n- old-frontier\n')
  _writeFileSyncAC(ledgerFile, '# Slow-loop ledger\n\n## Entries\n\n')

  return { dir, gradeFile, corpusFile, readerFile, ledgerFile }
}

// ---------------------------------------------------------------------------
// AC1 -- applyLedgerLines(currentContent, ledgerLines) -> newContent
// Appends new ledger lines; deduplicates identical re-apply; idempotent.
// ---------------------------------------------------------------------------

test('AC1: applyLedgerLines is exported from grader-workflow-lib.mjs', () => {
  assert.equal(typeof lib.applyLedgerLines, 'function',
    'lib must export applyLedgerLines(currentContent, ledgerLines) -> newContent')
})

test('AC1: applyLedgerLines appends new ledger lines to the file content', () => {
  const content = '# Slow-loop ledger\n\n## Entries\n\n'
  const lines = [
    '2026-06-14 | chunk2 | applied | first line',
    '2026-06-14 | chunk2 | applied | second line',
  ]
  const result = lib.applyLedgerLines(content, lines)
  for (const line of lines) {
    assert.ok(result.includes(line),
      `result must contain appended ledger line: "${line}", got:\n${result}`)
  }
})

test('AC1: applyLedgerLines deduplicates -- an identical re-apply does NOT add a second copy', () => {
  const content = '# Slow-loop ledger\n\n## Entries\n\n'
  const lines = ['2026-06-14 | chunk2 | applied | dedup test']

  const once = lib.applyLedgerLines(content, lines)
  const twice = lib.applyLedgerLines(once, lines)

  // The line must appear exactly once in the twice-applied output.
  const matches = twice.split('\n').filter((l) => l.includes('dedup test'))
  assert.equal(matches.length, 1,
    `identical re-apply must not add a second copy; got ${matches.length} occurrences:\n${twice}`)
})

test('AC1: applyLedgerLines is idempotent -- applying same lines twice yields identical output', () => {
  const content = '# Slow-loop ledger\n\n## Entries\n\n'
  const lines = [
    '2026-06-14 | chunk2 | applied | line-a',
    '2026-06-14 | chunk2 | applied | line-b',
  ]
  const once = lib.applyLedgerLines(content, lines)
  const twice = lib.applyLedgerLines(once, lines)
  assert.equal(once, twice,
    'applyLedgerLines must be idempotent: applying same lines twice produces identical output')
})

test('FIXER-P1: applyLedgerLines accepts only pre-formatted string lines; non-string items are silently filtered', () => {
  // Pin: ROUTED_SCHEMA now declares ledgerLines items as { type: 'string' }, so the LLM
  // returns pre-formatted bullet strings. Objects are filtered (not JSON-stringified).
  const content = '# Slow-loop ledger\n\n'
  const lines = [
    '- 2026-06-14 chunk2 [medium/doc/global] structured-entry as a real bullet -> target',
    { date: '2026-06-14', spec: 'chunk2', event: 'structured-entry' }, // non-string: filtered
  ]
  const result = lib.applyLedgerLines(content, lines)
  // Must NOT contain "[object Object]" (the old coercion artifact).
  assert.ok(
    !result.includes('[object Object]'),
    `applyLedgerLines must not append "[object Object]"; got:\n${result}`
  )
  // The string line must be appended.
  assert.ok(
    result.includes('structured-entry as a real bullet'),
    `applyLedgerLines must append string lines; got:\n${result}`
  )
  // The object must NOT appear serialized as JSON (it is filtered, not JSON.stringify'd).
  assert.ok(
    !result.includes('"date"'),
    `applyLedgerLines must filter non-string items, not JSON-serialize them; got:\n${result}`
  )
})

test('FIXER-F1: grader-workflow.js ROUTED_SCHEMA ledgerLines.items must be string type (not object)', () => {
  // Pin: the live judge's ROUTED_SCHEMA in grader-workflow.js must declare
  // ledgerLines.items as { type: 'string' } so the judge returns pre-formatted
  // bullet strings (matching applyLedgerLines contract). If items stays as
  // { type: 'object' }, the judge returns objects that applyLedgerLines silently
  // filters, producing an empty ledger.
  const src = read(WORKFLOW)
  // Find the ledgerLines block in ROUTED_SCHEMA. The pattern captures the items
  // type inside the ledgerLines property definition.
  const m = src.match(/ledgerLines[\s\S]{0,300}?items:\s*\{[^}]*type:\s*['"](\w+)['"]/)
  assert.ok(m, 'grader-workflow.js ROUTED_SCHEMA must have a ledgerLines.items block with a type')
  assert.equal(m[1], 'string',
    `grader-workflow.js ROUTED_SCHEMA ledgerLines.items.type must be 'string', got '${m[1]}'. ` +
    'The live judge returns items of this type; if it is object, all ledger lines are silently filtered.')
})

// ---------------------------------------------------------------------------
// AC2 -- apply-grade-side-effects.mjs script: reads grade JSON, updates 3 files,
// idempotent on re-run.
// ---------------------------------------------------------------------------

test('AC2: workflows/apply-grade-side-effects.mjs exists as a script', () => {
  const scriptPath = _joinAC(here, 'apply-grade-side-effects.mjs')
  // The script file must exist; this is the primary existence check.
  assert.ok(existsSync(scriptPath),
    `workflows/apply-grade-side-effects.mjs must exist (not found at ${scriptPath})`)
})

test('AC2: apply-grade-side-effects.mjs updates corpus, reader-model, and ledger from a fixture grade JSON', () => {
  const fix = buildGradeFixture()
  const scriptPath = _joinAC(here, 'apply-grade-side-effects.mjs')

  const result = spawnSync(process.execPath, [
    scriptPath,
    '--grade', fix.gradeFile,
    '--corpus', fix.corpusFile,
    '--reader-model', fix.readerFile,
    '--ledger', fix.ledgerFile,
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0,
    `script must exit 0 on success; got ${result.status}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)

  // Corpus must contain the appended voice sample.
  const corpus = _readFileSyncAC(fix.corpusFile, 'utf8')
  assert.ok(corpus.includes('ship it fast'),
    `corpus file must contain appended voice sample 'ship it fast', got:\n${corpus}`)

  // Reader-model must contain the new Known entry.
  const reader = _readFileSyncAC(fix.readerFile, 'utf8')
  assert.ok(reader.includes('trunk-based-dev'),
    `reader-model file must contain new Known concept 'trunk-based-dev', got:\n${reader}`)

  // Ledger must contain the new line.
  const ledger = _readFileSyncAC(fix.ledgerFile, 'utf8')
  assert.ok(ledger.includes('chunk2-test'),
    `ledger file must contain appended line with 'chunk2-test', got:\n${ledger}`)
})

test('AC2: apply-grade-side-effects.mjs is idempotent -- a second run produces identical file content', () => {
  const fix = buildGradeFixture()
  const scriptPath = _joinAC(here, 'apply-grade-side-effects.mjs')
  const args = [
    scriptPath,
    '--grade', fix.gradeFile,
    '--corpus', fix.corpusFile,
    '--reader-model', fix.readerFile,
    '--ledger', fix.ledgerFile,
  ]

  // First run.
  const r1 = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.equal(r1.status, 0, `first run must exit 0; stderr:\n${r1.stderr}`)

  // Capture content after first run.
  const corpus1 = _readFileSyncAC(fix.corpusFile, 'utf8')
  const reader1 = _readFileSyncAC(fix.readerFile, 'utf8')
  const ledger1 = _readFileSyncAC(fix.ledgerFile, 'utf8')

  // Second run (re-apply same grade JSON).
  const r2 = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.equal(r2.status, 0, `second run must exit 0; stderr:\n${r2.stderr}`)

  // Content must be identical (idempotent).
  assert.equal(_readFileSyncAC(fix.corpusFile, 'utf8'), corpus1, 'corpus must be identical after second run (idempotent)')
  assert.equal(_readFileSyncAC(fix.readerFile, 'utf8'), reader1, 'reader-model must be identical after second run (idempotent)')
  assert.equal(_readFileSyncAC(fix.ledgerFile, 'utf8'), ledger1, 'ledger must be identical after second run (idempotent)')
})

test('FIXER-P2: when a target file is unreadable mid-run, already-applied files must NOT be modified', () => {
  // Pin: the half-applied failure mode. If corpus applies but reader-model is unreadable,
  // corpus must remain UNCHANGED (the error exits before any write).
  const fix = buildGradeFixture()
  const scriptPath = _joinAC(here, 'apply-grade-side-effects.mjs')

  // Capture corpus content BEFORE the failing run.
  const corpusBefore = _readFileSyncAC(fix.corpusFile, 'utf8')

  // Pass a bad reader-model path (does not exist) -- corpus is listed first, reader-model second.
  const result = spawnSync(process.execPath, [
    scriptPath,
    '--grade', fix.gradeFile,
    '--corpus', fix.corpusFile,
    '--reader-model', _joinAC(fix.dir, 'nonexistent-reader.md'),  // does not exist
    '--ledger', fix.ledgerFile,
  ], { encoding: 'utf8' })

  // Must exit non-zero.
  assert.notEqual(result.status, 0,
    `script must exit non-zero when a target file is unreadable; got status ${result.status}`)

  // Corpus must be UNCHANGED (half-apply must not happen).
  const corpusAfter = _readFileSyncAC(fix.corpusFile, 'utf8')
  assert.equal(corpusAfter, corpusBefore,
    `corpus must be unchanged when reader-model is unreadable (no half-apply); corpus changed from:\n${corpusBefore}\nto:\n${corpusAfter}`)
})

// ---------------------------------------------------------------------------
// AC3 -- Stderr diagnostics: gated behind --verbose.
// Without --verbose: stderr is empty on success.
// With --verbose: one diagnostic line per applied file on stderr.
// Error path: unreadable file -> stderr error + non-zero exit (always, no flag needed).
// ---------------------------------------------------------------------------

test('AC3: without --verbose, the script emits nothing to stderr on a successful run', () => {
  const fix = buildGradeFixture()
  const scriptPath = _joinAC(here, 'apply-grade-side-effects.mjs')

  const result = spawnSync(process.execPath, [
    scriptPath,
    '--grade', fix.gradeFile,
    '--corpus', fix.corpusFile,
    '--reader-model', fix.readerFile,
    '--ledger', fix.ledgerFile,
    // No --verbose flag.
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0, `script must exit 0; stderr:\n${result.stderr}`)
  assert.equal(result.stderr.trim(), '',
    `without --verbose, stderr must be empty on success; got:\n${result.stderr}`)
})

test('AC3: with --verbose, the script emits one diagnostic line per applied file on stderr', () => {
  const fix = buildGradeFixture()
  const scriptPath = _joinAC(here, 'apply-grade-side-effects.mjs')

  const result = spawnSync(process.execPath, [
    scriptPath,
    '--grade', fix.gradeFile,
    '--corpus', fix.corpusFile,
    '--reader-model', fix.readerFile,
    '--ledger', fix.ledgerFile,
    '--verbose',
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0, `script must exit 0 with --verbose; stderr:\n${result.stderr}`)

  // There are three target files (corpus, reader-model, ledger) -> at least 3 diagnostic lines.
  const stderrLines = result.stderr.split('\n').filter((l) => l.trim() !== '')
  assert.ok(stderrLines.length >= 3,
    `--verbose must emit at least 3 diagnostic lines (one per applied file), got ${stderrLines.length}:\n${result.stderr}`)
})

test('AC3: on an unreadable corpus file, the script emits an error to stderr and exits non-zero', () => {
  const fix = buildGradeFixture()
  const scriptPath = _joinAC(here, 'apply-grade-side-effects.mjs')

  // Use a non-existent path for the corpus file -> unreadable.
  const result = spawnSync(process.execPath, [
    scriptPath,
    '--grade', fix.gradeFile,
    '--corpus', _joinAC(fix.dir, 'nonexistent-corpus.md'),  // does not exist
    '--reader-model', fix.readerFile,
    '--ledger', fix.ledgerFile,
    // No --verbose: errors must surface even without the flag.
  ], { encoding: 'utf8' })

  assert.notEqual(result.status, 0,
    `script must exit non-zero on an error path; got status ${result.status}`)
  assert.ok(result.stderr.trim().length > 0,
    `script must emit an error message to stderr on error path; got empty stderr`)
})

// ---------------------------------------------------------------------------
// AC4 -- ship-spec SKILL.md Step 5 item 3: split into auto-apply + adjudicated.
// The regrade no-hand-roll note must also be present.
// ---------------------------------------------------------------------------

test('AC4: ship-spec SKILL.md Step 5 item 3 separates auto-apply (corpus/reader-model/ledger) from adjudicated (memory/docFaults)', () => {
  const skillContent = readFileSync(_joinAC(root, 'skills/ship-spec/SKILL.md'), 'utf8')

  // The step must mention apply-grade-side-effects (the auto-apply script).
  assert.ok(
    /apply-grade-side-effects/.test(skillContent),
    'ship-spec SKILL.md must reference apply-grade-side-effects for the auto-apply path'
  )

  // The step must preserve the adjudicated path (memoryCandidates -> Step 5.5, docFaults -> Step 6).
  assert.ok(
    /memoryCandidates/.test(skillContent) && /docFaults/.test(skillContent),
    'ship-spec SKILL.md must still name the adjudicated paths (memoryCandidates, docFaults)'
  )

  // The split must be explicit: the auto-apply path and the adjudicated path are described
  // as distinct actions, not bundled in one "The COO executes..." sentence.
  // Test: the script is described as the mechanism for corpus/reader-model/ledger separately
  // from the adjudicated memory/docFaults path.
  assert.ok(
    /auto.?appl|automatically apply|mechanical/i.test(skillContent),
    'ship-spec SKILL.md Step 5 item 3 must indicate the corpus/reader-model/ledger path is automatic/mechanical'
  )
})

test('AC4: ship-spec SKILL.md carries the regrade no-hand-roll note (inline-manifest path, not a loader agent)', () => {
  const skillContent = readFileSync(_joinAC(root, 'skills/ship-spec/SKILL.md'), 'utf8')

  // The no-hand-roll note must reference the inline-manifest path (buildSegmentManifest -> args.manifest).
  assert.ok(
    /hand.?roll|hand roll/i.test(skillContent),
    'ship-spec SKILL.md must contain the no-hand-roll regrade note'
  )
  // And it must reference the manifest path (buildSegmentManifest or args.manifest).
  assert.ok(
    /buildSegmentManifest|args\.manifest/.test(skillContent),
    'ship-spec SKILL.md must reference the inline-manifest path (buildSegmentManifest or args.manifest) in the regrade note'
  )
})

// ===========================================================================
// CHUNK-10 -- raise SUMMARIES_PER_FLAG_BUNDLE, restructure flagPrompt with XML
// item tags + rule anchor top+bottom, raise grader-flagger effort to high.
//
// CONTRACT (chunk 10 acceptance criteria):
//
//   (C10-AC1) SUMMARIES_PER_FLAG_BUNDLE in the launchable is 100; bundleSummaries
//             with 250 summaries at K=100 yields ceil(250/100)=3 bundles (not 32).
//             SEGMENT_BUNDLE_CHAR_CAP is unchanged at 250000.
//
//   (C10-AC2) flagPrompt output contains XML <item> tags wrapping each summary
//             AND the rule block (divergence rules) appears both BEFORE (top) and
//             AFTER (bottom) the items -- verified against a synthetic bundle.
//
//   (C10-AC3) agents/grader-flagger.md frontmatter has effort: high
//             (not medium -- the 90.3% MRCR regime requires reasoning-on).
// ===========================================================================

// C10-AC1 ------------------------------------------------------------------

test('C10-AC1: SUMMARIES_PER_FLAG_BUNDLE in the launchable is 100 (not 8)', () => {
  const src = read(WORKFLOW)
  // Must declare SUMMARIES_PER_FLAG_BUNDLE = 100 (the evidence-based ~120k-tok bundle size).
  assert.ok(
    /const\s+SUMMARIES_PER_FLAG_BUNDLE\s*=\s*100\b/.test(src),
    'launchable must set SUMMARIES_PER_FLAG_BUNDLE = 100 for the ~120k input-token target; got: ' +
    (src.match(/SUMMARIES_PER_FLAG_BUNDLE\s*=\s*\d+/) || ['(not found)'])[0]
  )
})

test('C10-AC1: bundleSummaries(250 summaries, K=100) produces ceil(250/100)=3 bundles', () => {
  const summaries = Array.from({ length: 250 }, (_, i) => ({
    segment_id: `seg-${i}`,
    summary: `Summary for segment ${i}`,
    evidence_refs: [`tool_call ${i}`],
  }))
  const bundles = lib.bundleSummaries(summaries, 100)
  assert.ok(Array.isArray(bundles), 'bundleSummaries must return an array')
  assert.equal(bundles.length, 3,
    `250 summaries at K=100 must yield ceil(250/100)=3 bundles, got ${bundles.length}`)
  // Every summary must land in exactly one bundle.
  const flat = bundles.flatMap((b) => b.summaries.map((s) => s.segment_id)).sort()
  assert.deepEqual(
    flat,
    summaries.map((s) => s.segment_id).sort(),
    'every summary must appear in exactly one bundle (no drop, no duplication)'
  )
  // No bundle exceeds K=100.
  for (const b of bundles) {
    assert.ok(b.summaries.length <= 100, `no bundle exceeds K=100, got ${b.summaries.length}`)
  }
})

test('C10-AC1: SEGMENT_BUNDLE_CHAR_CAP is unchanged at 250000', () => {
  const src = read(WORKFLOW)
  assert.ok(
    /const\s+SEGMENT_BUNDLE_CHAR_CAP\s*=\s*250000\b/.test(src),
    'SEGMENT_BUNDLE_CHAR_CAP must remain 250000 (haiku width unchanged); got: ' +
    (src.match(/SEGMENT_BUNDLE_CHAR_CAP\s*=\s*\d+/) || ['(not found)'])[0]
  )
})

// C10-AC2 ------------------------------------------------------------------

test('C10-AC2: flagPrompt wraps each summary in XML <item> tags', async () => {
  // Build a synthetic 3-summary bundle and run flagPrompt from the launchable.
  // We extract the flagPrompt fn by running the launchable as an AsyncFunction
  // with a probe that intercepts the FLAG dispatch.
  const summaryBundle = {
    bundle_id: 'test-bundle-0',
    summaries: [
      { segment_id: 'seg-a', summary: 'Alpha summary', evidence_refs: [], conformance_doc: null },
      { segment_id: 'seg-b', summary: 'Beta summary', evidence_refs: [], conformance_doc: null },
      { segment_id: 'seg-c', summary: 'Gamma summary', evidence_refs: [], conformance_doc: null },
    ],
  }

  // Intercept flagPrompt output by capturing the prompt passed to the FLAG agent.
  // We use workflowFn() with a synthetic archive so the FLAG phase runs once.
  let capturedFlagPrompt = null
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)

  // We need a tight mock that runs bundleSummaries with the stub and captures the FLAG prompt.
  // Run the workflow and capture the first FLAG phase prompt.
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') return stubSummariesFromPrompt(prompt)
    if (opts && opts.phase === 'FLAG') {
      if (capturedFlagPrompt === null) capturedFlagPrompt = prompt
      return { flags: [], jake_signals: [] }
    }
    if (opts && opts.phase === 'JUDGE') {
      return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    }
    return {}
  }
  const parallelFn = (fns) => Promise.all(fns.map((f) => f()))

  await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'c10-test', manifest }, agentMock, parallelFn, () => {}, () => {})

  assert.ok(capturedFlagPrompt !== null, 'at least one FLAG prompt must have been captured')
  assert.ok(
    /<item\b/.test(capturedFlagPrompt),
    'flagPrompt must wrap each summary item in XML <item ...> tags; got prompt (first 500 chars): ' +
    capturedFlagPrompt.slice(0, 500)
  )
})

test('C10-AC2: flagPrompt rule block appears both BEFORE and AFTER the item list', async () => {
  // Run the same workflow capture and verify: the divergence rule instruction text
  // appears above the <item> block AND is restated below it (top + bottom anchoring).
  let capturedFlagPrompt = null
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)

  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') return stubSummariesFromPrompt(prompt)
    if (opts && opts.phase === 'FLAG') {
      if (capturedFlagPrompt === null) capturedFlagPrompt = prompt
      return { flags: [], jake_signals: [] }
    }
    if (opts && opts.phase === 'JUDGE') {
      return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    }
    return {}
  }
  const parallelFn = (fns) => Promise.all(fns.map((f) => f()))

  await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'c10-test', manifest }, agentMock, parallelFn, () => {}, () => {})

  assert.ok(capturedFlagPrompt !== null, 'at least one FLAG prompt must have been captured')

  // The rule block must appear BEFORE and AFTER the items.
  // Detect: first occurrence of a rule/instruction keyword before <item> AND after </items> or last </item>.
  const firstItemIdx = capturedFlagPrompt.indexOf('<item')
  const lastItemCloseIdx = capturedFlagPrompt.lastIndexOf('</item>')
  assert.ok(firstItemIdx > -1, 'prompt must contain at least one <item> opening tag')
  assert.ok(lastItemCloseIdx > -1, 'prompt must contain at least one </item> closing tag')

  const beforeItems = capturedFlagPrompt.slice(0, firstItemIdx)
  const afterItems = capturedFlagPrompt.slice(lastItemCloseIdx)

  // The divergence rule instruction must appear before the item list.
  assert.ok(
    /diverge|conformance|flag|rule/i.test(beforeItems),
    'flagPrompt must state divergence rules BEFORE the item list (rule block at top); before-items excerpt: ' +
    beforeItems.slice(0, 300)
  )
  // And the rule must be restated after the items (tail anchor).
  assert.ok(
    /diverge|conformance|flag|rule/i.test(afterItems),
    'flagPrompt must restate divergence rules AFTER the item list (rule block at bottom); after-items excerpt: ' +
    afterItems.slice(0, 300)
  )
})

// C10-AC4: 200k hard stop -- bundleSummaries must never return a bundle whose
// serialized JSON exceeds 800k chars (~200k tokens at ~4 chars/tok). When
// summaries are large enough that K=100 would bust the cap, the cap must cut
// the bundle short (cap binds before count). -------------------------------------

test('C10-AC4 (lib): bundleSummaries respects 200k-token char cap; oversized bundle is capped', () => {
  // Each summary is ~8500 chars (= ~2125 tokens). 100 of them = ~850k chars > 800k cap.
  // Expect the cap to fire and each bundle to hold ~94 or fewer summaries.
  const bigSummary = (i) => ({
    segment_id: `seg-big-${i}`,
    summary: 'x'.repeat(8400),  // ~8400 chars per summary
    evidence_refs: [`tool_call ${i}`],
  })
  const summaries = Array.from({ length: 200 }, (_, i) => bigSummary(i))
  const CHAR_CAP = 800000  // 200k tokens * ~4 chars/tok
  const K = 100
  const bundles = lib.bundleSummaries(summaries, K, CHAR_CAP)
  assert.ok(Array.isArray(bundles), 'bundleSummaries must return an array')
  // Each bundle must not exceed CHAR_CAP when serialized
  for (const b of bundles) {
    const serialized = JSON.stringify(b.summaries)
    assert.ok(
      serialized.length <= CHAR_CAP,
      `no bundle may exceed ${CHAR_CAP} chars (~200k tokens); bundle has ${serialized.length} chars with ${b.summaries.length} summaries`
    )
  }
  // Must be more than 2 bundles (cap fired, not just count split)
  const expectedCountOnly = Math.ceil(200 / K)  // = 2
  assert.ok(
    bundles.length >= expectedCountOnly,
    `with cap binding, must produce >= ${expectedCountOnly} bundles; got ${bundles.length}`
  )
})

test('C10-AC4 (launchable): bundleSummaries in the launchable also respects char cap -- cap binds before count', () => {
  // The launchable's bundleSummaries must be called with MAX_SUMMARY_BUNDLE_CHARS (cap constant).
  // Verify both: the constant is passed to bundleSummaries, and bundleSummaries accepts charCap.
  const src = read(WORKFLOW)
  // The call site must pass a cap argument to bundleSummaries
  assert.ok(
    /bundleSummaries\s*\(\s*summaries\s*,\s*SUMMARIES_PER_FLAG_BUNDLE\s*,\s*MAX_SUMMARY_BUNDLE_CHARS\s*\)/.test(src),
    'launchable must call bundleSummaries(summaries, SUMMARIES_PER_FLAG_BUNDLE, MAX_SUMMARY_BUNDLE_CHARS) -- cap constant must be threaded in'
  )
})

test('C10-AC4: MAX_SUMMARY_BUNDLE_CHARS constant is present in the launchable at 800000', () => {
  const src = read(WORKFLOW)
  assert.ok(
    /(?:MAX_SUMMARY_BUNDLE_CHARS|SUMMARY_BUNDLE_CHAR_CAP)\s*=\s*800000\b/.test(src),
    'launchable must define a 200k-token char cap constant at 800000 (MAX_SUMMARY_BUNDLE_CHARS or SUMMARY_BUNDLE_CHAR_CAP)'
  )
})

// C10-AC4b: fewer summaries than one bundle -> one bundle, unchanged ---------------

test('C10-AC4b: bundleSummaries with 0 summaries returns [] (empty)', () => {
  const bundles = lib.bundleSummaries([], 100, 800000)
  assert.ok(Array.isArray(bundles), 'bundleSummaries must return an array for empty input')
  assert.equal(bundles.length, 0, 'zero summaries must produce zero bundles')
})

test('C10-AC4b: bundleSummaries with 1 summary returns exactly one bundle', () => {
  const summaries = [{ segment_id: 'seg-only', summary: 'Only summary', evidence_refs: [] }]
  const bundles = lib.bundleSummaries(summaries, 100, 800000)
  assert.ok(Array.isArray(bundles), 'bundleSummaries must return an array')
  assert.equal(bundles.length, 1, 'one summary must produce exactly one bundle')
  assert.equal(bundles[0].summaries.length, 1, 'the single bundle must contain the one summary')
  assert.equal(bundles[0].summaries[0].segment_id, 'seg-only', 'the summary is passed through unchanged')
})

test('C10-AC4b: bundleSummaries with fewer than K summaries returns exactly one bundle', () => {
  // K=100; 47 summaries < K -> must stay in one bundle
  const summaries = Array.from({ length: 47 }, (_, i) => ({ segment_id: `seg-${i}`, summary: `s${i}`, evidence_refs: [] }))
  const bundles = lib.bundleSummaries(summaries, 100, 800000)
  assert.equal(bundles.length, 1, `47 summaries at K=100 must produce exactly 1 bundle, got ${bundles.length}`)
  assert.equal(bundles[0].summaries.length, 47, 'the single bundle must contain all 47 summaries')
})

// C10-AC5: documented per-summary token measurement in code ----------------------

test('C10-AC5: grader-workflow.js contains a documented per-summary token measurement comment', () => {
  const src = read(WORKFLOW)
  // Must contain a comment documenting the token measurement:
  // the archive used, the measured average, and the resulting K choice.
  // Acceptable patterns: "tokens/summary", "tok/summary", "tokens per summary",
  // "tok per summary", "chars per summary", "estimated tokens", or "token measurement".
  assert.ok(
    /tokens?\/summary|tok\s*\/\s*summary|tokens?\s+per\s+summary|estimated\s+tokens?|token\s+measurement|chars?\s+per\s+summary/i.test(src),
    'grader-workflow.js must contain a comment documenting the per-summary token measurement that backs the K=100 bundle size; found no such comment'
  )
  // Must also reference the measurement source (an archive directory, command, or session)
  assert.ok(
    /lean-system-rebuild|archived-session|_archived|measurement|counted|wc -|node -e|char.*count|token.*count/i.test(src),
    'the documented measurement must name the archive or method used to count tokens/chars per summary'
  )
})

// C10-AC3 ------------------------------------------------------------------

test('C10-AC3: agents/grader-flagger.md frontmatter has effort: high', () => {
  const src = read('agents/grader-flagger.md')
  // The frontmatter effort field must be 'high', not 'medium'.
  // YAML frontmatter: lines between opening and closing ---.
  const fmMatch = src.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(fmMatch, 'grader-flagger.md must have YAML frontmatter (--- ... ---)')
  const frontmatter = fmMatch[1]
  assert.ok(
    /^effort:\s*high\s*$/m.test(frontmatter),
    'grader-flagger.md frontmatter must set effort: high (not medium); frontmatter: ' + frontmatter
  )
})

// ===========================================================================
// coo-simplification CHUNK 4 -- grader slimming (4->3 agents, redesigner->edits)
//
// CONTRACT (specs/current.md chunk 4):
//   C4-AC1: the SEGMENT agent apparatus is GONE from grader-workflow.js:
//           SEGMENT_SCHEMA, segmentPrompt, the SEGMENT_ARCHIVE_DIR env-var-quoting
//           block, the segmentCount truncation witness, and the count-assert. The COO
//           builds the manifest via Bash (buildSegmentManifest) and passes args.manifest;
//           the COO-bash manifest path is documented in ship-spec Step 5.
//   C4-AC2: the flagger localizes only -- FLAGS_SCHEMA flag items require exactly
//           {segment_id, evidence_ref, what_caught_my_eye} and carry NO severity and NO
//           rule_cited (the judge assigns both against the raw slice). The judge's
//           dereference + 5-key return contract is UNCHANGED.
//   C4-AC3: redesigner-max.md output_contract is exact-match edits
//           {finding_id, exact_old_text, new_text}[] (not a full-file body); a redesign
//           applies via Edit and a non-matching exact_old_text fails loud.
//   C4-AC4: a grade runs end-to-end on a sample 3-agent-type archive and routes the 5 keys.
// ===========================================================================

// C4-AC1 -- the SEGMENT agent apparatus is deleted; COO-bash manifest path documented.

test('C4-AC1: SEGMENT_SCHEMA, segmentPrompt, and the truncation witness are ABSENT from grader-workflow.js', () => {
  const src = read(WORKFLOW)
  assert.ok(!/SEGMENT_SCHEMA/.test(src), 'grader-workflow.js must not define SEGMENT_SCHEMA (SEGMENT agent dropped)')
  assert.ok(!/function\s+segmentPrompt\b|segmentPrompt\s*\(/.test(src), 'grader-workflow.js must not define or call segmentPrompt')
  assert.ok(!/SEGMENT_ARCHIVE_DIR/.test(src), 'grader-workflow.js must not contain the SEGMENT_ARCHIVE_DIR env-var-quoting block')
  assert.ok(!/segmentCount/.test(src), 'grader-workflow.js must not contain the segmentCount truncation witness')
  // No SEGMENT-agent dispatch: a SEGMENT phase with a sonnet model schema:SEGMENT_SCHEMA is gone.
  assert.ok(!/phase\(['"]SEGMENT['"]\)/.test(src), 'grader-workflow.js must not run a SEGMENT phase (manifest is built COO-side)')
  assert.ok(!/TRUNCATION for spec/.test(src), 'the count-assert / truncation-throw block must be removed')
})

test('C4-AC1: an absent/empty manifest still THROWS loud (no silent partial grade, no self-build)', async () => {
  // The chunk removes the SEGMENT self-build path; an empty manifest must still fail
  // loud (a clean grade of nothing masquerading as graded-found-nothing is the hazard).
  const agentMock = async () => ({})
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  await assert.rejects(
    workflowFn()({ sessionArchiveDir: '/nonexistent', specSlug: 'synth' }, agentMock, parallel, () => {}, () => {}),
    /nothing to grade|args\.manifest/i,
    'an absent manifest must throw (build the manifest COO-side and pass args.manifest)'
  )
})

test('C4-AC1: ship-spec Step 5 documents the COO-bash manifest path (buildSegmentManifest -> args.manifest)', () => {
  const skill = readFileSync(_joinAC(root, 'skills/ship-spec/SKILL.md'), 'utf8')
  // Step 5 must instruct the COO to build the manifest via Bash and pass args.manifest.
  assert.ok(/args\.manifest/.test(skill), 'ship-spec Step 5 must reference passing args.manifest')
  assert.ok(/buildSegmentManifest/.test(skill), 'ship-spec Step 5 must reference buildSegmentManifest (the COO-bash build)')
  // The old SEGMENT-agent self-build narrative must be gone (no "SEGMENT agent" building the manifest internally).
  assert.ok(!/SEGMENT agent/.test(skill), 'ship-spec must not describe a SEGMENT agent building the manifest internally (dropped)')
})

// C4-AC2 -- the flagger localizes only: {segment_id, evidence_ref, what_caught_my_eye};
// no severity, no rule_cited. Judge contract unchanged.

test('C4-AC2: FLAGS_SCHEMA (lib) flag items require {segment_id, evidence_ref, what_caught_my_eye} only', () => {
  assert.ok(lib.FLAGS_SCHEMA, 'lib must export FLAGS_SCHEMA')
  const items = lib.FLAGS_SCHEMA.properties.flags.items
  const required = (items.required || []).slice().sort()
  assert.deepEqual(required, ['evidence_ref', 'segment_id', 'what_caught_my_eye'],
    `flag items must require exactly segment_id, evidence_ref, what_caught_my_eye, got ${JSON.stringify(required)}`)
  assert.equal(items.additionalProperties, false, 'flag items must have additionalProperties:false')
  // The dropped fields must not be in the properties at all (localization-only).
  assert.ok(!items.properties.severity, 'flag items must NOT carry severity (judge assigns against raw)')
  assert.ok(!items.properties.rule_cited, 'flag items must NOT carry rule_cited (judge assigns against raw)')
  assert.ok(!items.properties.what_happened, 'flag items must NOT carry what_happened (renamed to what_caught_my_eye)')
})

test('C4-AC2: FLAGS_SCHEMA (inlined launchable) matches the lib localization-only shape', () => {
  const wf = read(WORKFLOW)
  const libSrc = read(LIB)
  for (const src of [wf, libSrc]) {
    assert.ok(/evidence_ref/.test(src), 'both files must carry evidence_ref in FLAGS_SCHEMA')
    assert.ok(/what_caught_my_eye/.test(src), 'both files must carry what_caught_my_eye in FLAGS_SCHEMA')
  }
  // The dropped fields must not appear as flag-item schema keys in EITHER file.
  // (severity/rule_cited may still appear in the JUDGE's ledgerLines description, so we
  // scope the check to the flags.items.required arrays.)
  for (const [name, src] of [['launchable', wf], ['lib', libSrc]]) {
    const m = src.match(/flags[\s\S]{0,400}?items[\s\S]{0,200}?required:\s*\[([^\]]+)\]/)
    assert.ok(m, `${name} must have a flags.items.required array`)
    assert.ok(!/rule_cited|severity|what_happened/.test(m[1]),
      `${name} flags.items.required must not contain rule_cited/severity/what_happened, got ${m[1]}`)
  }
})

test('C4-AC2: the judge dereference + 5-key return contract is UNCHANGED through the slimmer flagger', async () => {
  // The flagger now emits localization-only flags; the judge still dereferences each flag
  // to the raw slice and returns exactly the 5 routed keys. Pin the judge prompt still
  // carries the manifest (dereference map) and the return is the 5-key shape.
  const arch = buildSyntheticArchive()
  const manifest = lib.buildSegmentManifest(arch.dir)
  let judgePrompt = null
  const agentMock = async (prompt, opts) => {
    if (opts && opts.phase === 'SUMMARIZE') return stubSummariesFromPrompt(prompt)
    if (opts && opts.phase === 'FLAG') {
      return { flags: [{ segment_id: manifest[0].segment_id, evidence_ref: 'tool#3', what_caught_my_eye: 'skipped RED' }], jake_signals: [] }
    }
    if (opts && opts.phase === 'JUDGE') {
      judgePrompt = prompt
      return { memoryCandidates: [], docFaults: [], readerModelUpdates: [], corpusAppend: [], ledgerLines: [] }
    }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const result = await workflowFn()({ sessionArchiveDir: arch.dir, specSlug: 'synth', manifest }, agentMock, parallel, () => {}, () => {})

  assert.ok(judgePrompt && manifest.some((s) => judgePrompt.includes(s.segment_id) || judgePrompt.includes(s.path)),
    'judge prompt must still carry the manifest dereference map')
  assert.deepEqual(Object.keys(result).sort(),
    ['corpusAppend', 'docFaults', 'ledgerLines', 'memoryCandidates', 'readerModelUpdates'],
    'judge return must still be exactly the 5 routed keys')
})

test('C4-AC2: grader-flagger.md describes localization only (evidence_ref + what_caught_my_eye, no severity/rule_cited)', () => {
  const flagger = read('agents/grader-flagger.md')
  assert.ok(/evidence_ref/.test(flagger), 'grader-flagger.md must describe evidence_ref')
  assert.ok(/what_caught_my_eye/.test(flagger), 'grader-flagger.md must describe what_caught_my_eye')
  // The flag SHAPE block must not assign severity or rule_cited.
  assert.ok(!/^\s*severity:/m.test(flagger), 'grader-flagger.md flag shape must not assign severity (judge does, against raw)')
  assert.ok(!/^\s*rule_cited:/m.test(flagger), 'grader-flagger.md flag shape must not assign rule_cited (judge does, against raw)')
})

test('C4-AC2: grader-judge.md "What you receive" describes the localization-only flag shape and the judge assigns severity/rule against raw', () => {
  const judge = read('agents/grader-judge.md')
  // The judge must know each flag is {segment_id, evidence_ref, what_caught_my_eye}.
  assert.ok(/evidence_ref/.test(judge), 'grader-judge.md must describe the flag evidence_ref it receives')
  assert.ok(/what_caught_my_eye/.test(judge), 'grader-judge.md must describe what_caught_my_eye')
  // The old flag shape ({ segment_id, what_happened, evidence, rule_cited, severity }) must be gone.
  assert.ok(!/\{\s*segment_id,\s*what_happened,\s*evidence,\s*rule_cited,\s*severity\s*\}/.test(judge),
    'grader-judge.md must not describe the old flagger-assigned rule_cited+severity shape')
})

// C4-AC3 -- redesigner exact-match edits; non-matching exact_old_text fails loud.

test('C4-AC3: redesigner-max.md output_contract is exact-match edits {finding_id, exact_old_text, new_text}[]', () => {
  const rd = read('agents/redesigner-max.md')
  assert.ok(/exact_old_text/.test(rd), 'redesigner-max.md must describe exact_old_text')
  assert.ok(/new_text/.test(rd), 'redesigner-max.md must describe new_text')
  assert.ok(/finding_id/.test(rd), 'redesigner-max.md must describe finding_id on each edit')
  // The full-file-body return contract is replaced.
  assert.ok(!/full_replacement_body/.test(rd), 'redesigner-max.md must not return full_replacement_body (replaced by exact-match edits)')
  assert.ok(!/full replacement file body/.test(rd), 'redesigner-max.md must not describe a "full replacement file body" output contract')
  // It must say a non-matching old_text fails loud.
  assert.ok(/fail.?loud|non.?matching|must match exactly|aborts the commit/i.test(rd),
    'redesigner-max.md must state that a non-matching exact_old_text fails loud / aborts the commit')
})

test('C4-AC3: a redesigner edit list applies via exact-match Edit; a non-matching old_text fails loud', () => {
  // The COO applies each edit as an exact-match string replace (the Edit-tool semantics).
  // Model the apply locally: replace exact_old_text with new_text; a non-matching
  // old_text must throw (the over-reach guard). A matching list composes to the full change.
  function applyExactEdit(content, edit) {
    if (!content.includes(edit.exact_old_text)) {
      throw new Error(`redesigner edit ${edit.finding_id}: exact_old_text not found (fail loud, abort commit): ${JSON.stringify(edit.exact_old_text)}`)
    }
    return content.replace(edit.exact_old_text, edit.new_text)
  }
  const original = 'line one\nthe quick brown fox\nline three\n'
  // A composing edit list: two edits land the full intended change.
  const edits = [
    { finding_id: 0, exact_old_text: 'the quick brown fox', new_text: 'the slow red fox' },
    { finding_id: 1, exact_old_text: 'line three', new_text: 'line 3' },
  ]
  let result = original
  for (const e of edits) result = applyExactEdit(result, e)
  assert.equal(result, 'line one\nthe slow red fox\nline 3\n', 'a composing edit list applies to the full intended change')

  // A non-matching old_text fails loud (the over-reach / drift guard).
  assert.throws(
    () => applyExactEdit(original, { finding_id: 2, exact_old_text: 'TEXT THAT IS NOT PRESENT', new_text: 'x' }),
    /fail loud|not found|abort/i,
    'a non-matching exact_old_text must throw (the edit aborts; no silent over-reach)'
  )
})

// C4-AC4 -- end-to-end grade over a 3-agent-type sample archive routes the 5 keys.

test('C4-AC4: a grade runs end-to-end over a 3-agent-type archive and routes the 5 keys', async () => {
  // Sample archive with three agent types: a COO log (coo), a build-agent-heavy (A-tier),
  // a chunk-reviewer-heavy (A-tier reviewer). The COO builds the manifest via the lib
  // and passes it as args.manifest (the only manifest path now).
  const base = mkdtempSync(join(tmpdir(), 'grader-c4-e2e-'))
  const sid = 'c4-session-0001'
  const sessDir = join(base, sid)
  const subDir = join(sessDir, sid, 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(sessDir, `${sid}.jsonl`), '{"type":"msg"}\n')        // coo
  writeFileSync(join(subDir, 'agent-ba.jsonl'), '{"type":"msg"}\n')
  writeFileSync(join(subDir, 'agent-ba.meta.json'), JSON.stringify({ agentType: 'build-agent-heavy', description: 'b' }))
  writeFileSync(join(subDir, 'agent-rv.jsonl'), '{"type":"msg"}\n')
  writeFileSync(join(subDir, 'agent-rv.meta.json'), JSON.stringify({ agentType: 'chunk-reviewer-heavy', description: 'r' }))

  const manifest = lib.buildSegmentManifest(base)   // COO-bash build
  assert.ok(manifest.length >= 3, `sample archive must yield >=3 in-scope segments (coo + 2 A-tier), got ${manifest.length}`)

  const spawnedTypes = new Set()
  const agentMock = async (prompt, opts) => {
    if (opts) spawnedTypes.add(opts.agentType || opts.phase)
    if (opts && opts.phase === 'SUMMARIZE') return stubSummariesFromPrompt(prompt)
    if (opts && opts.phase === 'FLAG') {
      return { flags: [{ segment_id: manifest[0].segment_id, evidence_ref: 'tool#1', what_caught_my_eye: 'note' }], jake_signals: [] }
    }
    if (opts && opts.phase === 'JUDGE') {
      return {
        memoryCandidates: [],
        docFaults: [{ targetFile: 'agents/grader-flagger.md', findings: [{ id: 0, what_happened: 'x', evidence: 'y', why_doc_fault: 'z', desired_behavior: 'w' }] }],
        readerModelUpdates: [],
        corpusAppend: [],
        ledgerLines: [{ what_happened: 'x', fault: 'doc', target: 'agents/grader-flagger.md', scope: 'global', severity: 'low' }],
      }
    }
    return {}
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const result = await workflowFn()({ specSlug: 'c4-e2e', manifest }, agentMock, parallel, () => {}, () => {})

  // Exactly THREE agent types run (summarizer, flagger, judge) -- no SEGMENT agent.
  assert.ok(spawnedTypes.has('grader-summarizer'), 'summarizer must run')
  assert.ok(spawnedTypes.has('grader-flagger'), 'flagger must run')
  assert.ok(spawnedTypes.has('grader-judge'), 'judge must run')
  assert.ok(!spawnedTypes.has('SEGMENT') && !spawnedTypes.has('segment'), 'NO SEGMENT agent runs (manifest built COO-side)')

  // The 5 routed keys come back.
  assert.deepEqual(Object.keys(result).sort(),
    ['corpusAppend', 'docFaults', 'ledgerLines', 'memoryCandidates', 'readerModelUpdates'],
    'the grade must route exactly the 5 keys')
  assert.equal(result.docFaults.length, 1, 'the doc-fault routes through')
  assert.equal(result.ledgerLines.length, 1, 'the ledger line routes through')
})
