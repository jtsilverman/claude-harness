export const meta = {
  name: 'grader-workflow',
  description: 'The slow-loop grader: SEGMENT a finished spec\'s session archive into context-sized windows (pure JS), PRE-BUNDLE the in-scope segments and fan out one HAIKU grader-summarizer per segment-bundle (pure extraction, per-segment evidence refs retained), BUNDLE the summaries and fan out one SONNET grader-flagger per summary-bundle to spot where the system diverged from its conformance doc, then funnel every flag to ONE grader-judge agent (opus) that dereferences each flag to the RAW transcript slice, clusters, root-causes (memory-fault vs doc-fault), scope-routes, and groups doc-faults by target file. RETURNS routed findings as pure data ({ memoryCandidates, docFaults grouped-by-file, readerModelUpdates, corpusAppend, ledgerLines }); writes NOTHING -- the COO executes side effects. The B3-memory path is STUBBED so D1 closes before B3b.',
  phases: [
    { title: 'SUMMARIZE', detail: 'pre-bundle the in-scope segments (preBundleSegments: size + char capped), then parallel: ONE haiku grader-summarizer per segment-bundle does PURE EXTRACTION into a per-segment, evidence-cited summary (keyed by segment_id so a flag still maps to a raw slice). No judgment. The COO builds the manifest via Bash (buildSegmentManifest) and passes args.manifest -- there is no SEGMENT agent.', model: 'haiku (via agent def)' },
    { title: 'FLAG', detail: 'bundle the summaries (bundleSummaries: K per bundle), then parallel: ONE grader-flagger agent per summary-bundle flags divergences with evidence + lifts jake_signals; truth-calibrated, zero flags is a valid result', model: 'sonnet (via agent def)' },
    { title: 'JUDGE', detail: 'ONE grader-judge agent (opus): DEREFERENCE each flag to the raw transcript slice, cluster flags on the same event, root-cause each (memory-fault vs doc-fault), scope-route global vs workspace, group doc-faults BY target file; returns the 5-key routed data', model: 'opus (via agent def)' },
  ],
}

// ============================================================================
// grader-workflow.js -- the launchable Workflow script the `ship-spec` skill fires
// at ship (E1) over a FINISHED spec's session archive. args: { manifest, specSlug }
// (manifest is required -- built COO-side via buildSegmentManifest and passed in).
//
// Operating model (COO / workers): the operator = CEO (vision + verdict); the cockpit
// (the COO -- the long-running main session) ORCHESTRATES and is the SOLE WRITER
// of shared state. This workflow is a worker fan-out: it fans out flagger/judge
// workers that DRAFT only and RETURNS routed findings as structured data. It writes
// NOTHING -- Workflow scripts have no filesystem access by design; the COO applies
// every side effect (memory, doc rewrites, ledger append, reader-model, voice-corpus)
// after this returns.
//
// THE MANIFEST SEAM (built COO-side, passed as args.manifest). The Workflow harness has
// NO filesystem or module access from the script BODY (session-grader.mjs: "NO
// filesystem/bash access: the digest arrives via args"). So the COO builds the segment
// manifest BEFORE invoking this workflow -- it runs the pure helper buildSegmentManifest
// (exported from grader-workflow-lib.mjs) over the archive dir via Bash and passes the
// result as `args.manifest`. There is no SEGMENT agent: routing a multi-KB manifest array
// through an agent StructuredOutput return was a truncation hazard, and the COO already has
// Bash + node access to run buildSegmentManifest directly. The manifest carries
// { segment_id, path, charOffsets, messageRange, role } -- paths + offsets, NOT raw
// content, so each summarizer reads its own slice off disk. An empty/absent manifest
// throws loud (nothing to grade) rather than silently grading a partial.
//
// DUAL-FILE LOCKSTEP. The pure helper groupDocFaultsByFile + the FLAGS/ROUTED schemas
// below are INLINED VERBATIM from the testable source of truth
// workflows/grader-workflow-lib.mjs (the Workflow sandbox has no module resolution,
// and the harness rejects any export other than `export const meta`, so the launchable
// cannot import or re-export them). buildSegmentManifest / windowTranscript live ONLY
// in the lib (the caller runs them; this script never reads fs). The two files must
// stay in lockstep -- the unit test asserts both define the shared helpers. When you
// change a shared helper, change it in BOTH files.
//
// Mirrors worker-pipeline.js conventions: a pure-literal
// `export const meta` split off and validated separately; the body runs in an async
// context (top-level await + return are fine); `args` may arrive as a parsed object OR
// a JSON string, so it is normalized at the top. Plain JavaScript, not TypeScript.
// NO `import` statements (the harness body is not a module surface); Date.now()/
// Math.random are unavailable in this context and are not used.
// ============================================================================

// args may arrive as a parsed object or a JSON string (the Workflow `args` field has
// no declared schema type). Tolerate both (same normalization as the sibling workflow files).
let a = args || {}
if (typeof a === 'string') {
  try { a = JSON.parse(a) } catch (e) { a = {} }
}

const specSlug = a.specSlug || '(unspecified spec)'

// ---- SEGMENT manifest source (built COO-side, passed as args.manifest) -------

// The manifest is built COO-side and arrives as args.manifest: the COO runs the pure
// helper buildSegmentManifest (exported from grader-workflow-lib.mjs) over the archive
// dir via Bash + node and passes the result here. Each entry:
// { segment_id, path, role, charOffsets:{start,end}, messageRange:{startMsg,endMsg} }
// -- paths + offsets, NOT raw content (so each summarizer reads its own slice off disk).
//
// An EMPTY/absent manifest means there is nothing to grade. Grading nothing and returning
// an empty result silently masquerades as "graded, found nothing", hiding a real gap from
// the COO, so reject it loudly instead (fail loud, not tolerant). The COO builds the
// manifest BEFORE invoking the workflow, so an empty manifest is a build-gap to surface,
// never a clean grade.
const manifest = Array.isArray(a.manifest) ? a.manifest : []
if (manifest.length === 0) {
  throw new Error(
    `grader-workflow: nothing to grade for spec "${specSlug}" -- the COO must build the segment ` +
    `manifest via Bash (buildSegmentManifest from grader-workflow-lib.mjs) and pass it as a ` +
    `non-empty args.manifest. An empty/absent manifest is a build gap, not a clean grade.`
  )
}

// ---- SCOPE FILTER constants (INLINED from grader-workflow-lib.mjs; lockstep) -
// The manifest is built COO-side (args.manifest) using grader-workflow-lib.mjs's
// buildSegmentManifest +
// segmentInScope + deriveLabel -- the scope filter runs INSIDE buildSegmentManifest,
// not in this script body. These constants and the deriveLabel helper are inlined here
// for lockstep documentation -- the workflow itself does not call segmentInScope at
// runtime (it receives an already-filtered manifest), but any change to the scope
// filter in the lib must be mirrored here.
//
// Ship-review Stage reviewer labels (INCLUDED): inline agents with no agentType,
// identified by label in their .meta.json sidecar (chunk grader-scope-ship-reviewers).
// Ship UTILITY agents (diagram-refresh, stage3-demo) are NOT in this set.
const SHIP_REVIEWER_LABELS = new Set([
  'stage1-live-run',  // opus live-run gate
  'stage2-review',    // opus full-spec reviewer
  'stage2-codex',     // Codex cross-model lens
])

// deriveLabel(jsonlPath) -> string|null. Mirrors deriveAgentType.
// INLINED VERBATIM from grader-workflow-lib.mjs (keep in lockstep).
// NOTE: not called at workflow runtime (the manifest is built COO-side and supplied as
// args.manifest); inlined for lockstep documentation so the scope filter is visible in
// both files.
function deriveLabel(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'))
    return parsed.label || null
  } catch {
    return null
  }
}

// ---- BUNDLE-SIZE DIALS (chunk grader-efficiency) ----------------------------
// Two configurable group sizes shrink the fan-out: SEGMENTS_PER_BUNDLE small
// segments per haiku summarizer; SUMMARIES_PER_FLAG_BUNDLE summaries per sonnet
// flagger. SEGMENT_BUNDLE_CHAR_CAP bounds a haiku call so it is not overrun.
//
// Per-summary token measurement (AC5, chunk 10):
//   Measured archive: _archived-sessions/lean-system-rebuild (312 segments, avg 84k chars/segment)
//   Method: buildSegmentManifest() on the archive (node -e with grader-workflow-lib.mjs)
//   Haiku compression ratio: ~1/15 to 1/50 of segment chars -> 1700-5600 chars/summary
//   Estimated tokens/summary: 425-1400 tok (at 4 chars/tok), midpoint ~912 tok
//   At K=100: estimated input tokens 42k-140k, targeting ~91k (safe under 120k target)
//   200k-token hard stop = 800000 chars (MAX_SUMMARY_BUNDLE_CHARS); cap binds before count
//   so no single bundle exceeds 200k tokens even if individual summaries are at the large end.
const SEGMENTS_PER_BUNDLE = 6
const SEGMENT_BUNDLE_CHAR_CAP = 250000
const SUMMARIES_PER_FLAG_BUNDLE = 100
// Hard stop: 200k input tokens in chars (4 chars/tok). Bundles with fewer summaries
// are never padded; oversized bundles are split at this boundary before the K limit.
const MAX_SUMMARY_BUNDLE_CHARS = 800000

// preBundleSegments(manifest, maxPerBundle, charCap) -> bundles[]
// INLINED VERBATIM from grader-workflow-lib.mjs (keep in lockstep).
function preBundleSegments(manifest, maxPerBundle, charCap) {
  const segs = Array.isArray(manifest) ? manifest : []
  const segChars = (s) => (s && s.charOffsets ? (s.charOffsets.end - s.charOffsets.start) : 0)
  const bundles = []
  let cur = []
  let curChars = 0
  for (const seg of segs) {
    const c = segChars(seg)
    if (cur.length > 0 && (cur.length >= maxPerBundle || curChars + c > charCap)) {
      bundles.push({ bundle_id: `bundle-${bundles.length}`, segments: cur })
      cur = []
      curChars = 0
    }
    cur.push(seg)
    curChars += c
  }
  if (cur.length > 0) bundles.push({ bundle_id: `bundle-${bundles.length}`, segments: cur })
  return bundles
}

// bundleSummaries(summaries, K, charCap) -> bundles[]
// INLINED VERBATIM from grader-workflow-lib.mjs (keep in lockstep).
function bundleSummaries(summaries, K, charCap) {
  const all = Array.isArray(summaries) ? summaries : []
  const size = K > 0 ? K : 1
  const cap = charCap > 0 ? charCap : Infinity
  const bundles = []
  let cur = []
  let curChars = 0
  for (const s of all) {
    const c = JSON.stringify(s).length
    if (cur.length > 0 && (cur.length >= size || curChars + c > cap)) {
      bundles.push({ bundle_id: `summary-bundle-${bundles.length}`, summaries: cur })
      cur = []
      curChars = 0
    }
    cur.push(s)
    curChars += c
  }
  if (cur.length > 0) bundles.push({ bundle_id: `summary-bundle-${bundles.length}`, summaries: cur })
  return bundles
}

// Group doc-fault findings by target file (one redesigner dispatch per file).
// INLINED VERBATIM from grader-workflow-lib.mjs (keep in lockstep).
function groupDocFaultsByFile(findings) {
  const byFile = new Map()
  for (const f of findings || []) {
    const key = f.targetFile || '(unknown)'
    if (!byFile.has(key)) byFile.set(key, { targetFile: key, findings: [] })
    byFile.get(key).findings.push(f)
  }
  return Array.from(byFile.values())
}

// ---- Apply functions: COO sole-writer calls these to apply grader return data ----
// INLINED VERBATIM from grader-workflow-lib.mjs (keep in lockstep).
// These are PURE functions (no fs access). The COO applies them at ship sole-writer.

function _parseSections(content) {
  const sections = []
  const headingRe = /^(## [^\n]+)\n/gm
  let lastEnd = 0; let lastHeading = null; let lastStart = 0; let match
  while ((match = headingRe.exec(content)) !== null) {
    sections.push({ heading: lastHeading, body: content.slice(lastEnd, match.index), start: lastStart, end: match.index })
    lastHeading = match[1].replace(/^## /, '')
    lastStart = match.index
    lastEnd = match.index + match[0].length
  }
  sections.push({ heading: lastHeading, body: content.slice(lastEnd), start: lastStart, end: content.length })
  return sections
}

function _extractSectionItems(sectionBody) {
  if (!sectionBody) return []
  return sectionBody.split('\n').filter((l) => l.trimStart().startsWith('- ')).map((l) => l.trimStart().slice(2).trim())
}

function _rewriteSectionItems(content, headingName, newItems) {
  const sections = _parseSections(content)
  const target = sections.find((s) => s.heading === headingName)
  if (!target) return content
  const oldBody = target.body
  const nonItemLines = oldBody.split('\n').filter((l) => !l.trimStart().startsWith('- '))
  while (nonItemLines.length && nonItemLines[nonItemLines.length - 1].trim() === '') nonItemLines.pop()
  const itemBlock = newItems.map((item) => `- ${item}`).join('\n')
  const newBody = (nonItemLines.length ? nonItemLines.join('\n') + '\n\n' : '\n') + itemBlock + '\n'
  const headingLineLen = headingName.length + 4
  const bodyStart = target.start + headingLineLen
  return content.slice(0, bodyStart) + newBody + content.slice(target.end)
}

function applyReaderModelUpdates(currentContent, readerModelUpdates) {
  if (!readerModelUpdates || readerModelUpdates.length === 0) return currentContent
  const sections = _parseSections(currentContent)
  const knownSec = sections.find((s) => s.heading && s.heading.startsWith('Known'))
  const frontierSec = sections.find((s) => s.heading && s.heading.startsWith('Frontier'))
  const knownItems = new Set(_extractSectionItems(knownSec ? knownSec.body : ''))
  const frontierItems = new Set(_extractSectionItems(frontierSec ? frontierSec.body : ''))
  const conceptMove = new Map()
  for (const u of readerModelUpdates) {
    if (u && u.concept && (u.move === 'Known' || u.move === 'Frontier')) conceptMove.set(u.concept, u.move)
  }
  for (const [concept, move] of conceptMove) {
    if (move === 'Known') { knownItems.add(concept); frontierItems.delete(concept) }
    else { frontierItems.add(concept); knownItems.delete(concept) }
  }
  const knownHeading = knownSec ? knownSec.heading : 'Known'
  const frontierHeading = frontierSec ? frontierSec.heading : 'Frontier'
  let result = _rewriteSectionItems(currentContent, knownHeading, Array.from(knownItems))
  result = _rewriteSectionItems(result, frontierHeading, Array.from(frontierItems))
  return result
}

function applyCorpusAppend(currentContent, corpusAppend) {
  if (!corpusAppend || corpusAppend.length === 0) return currentContent
  const sections = _parseSections(currentContent)
  const voiceSec = sections.find((s) => s.heading && s.heading.startsWith('Voice samples'))
  const existingBody = voiceSec ? voiceSec.body : ''
  const existingItems = new Set(
    existingBody.split('\n').filter((l) => l.trimStart().startsWith('- ')).map((l) => l.trimStart().slice(2).trim())
  )
  // Build existing-quotes set: strip context suffix to get the bare quote key.
  const existingQuotes = new Set([...existingItems].map((item) => {
    const i = item.lastIndexOf(' (')
    return (i > 0 && item.endsWith(')')) ? item.slice(0, i) : item
  }))
  const toAppend = []
  for (const s of corpusAppend) {
    if (!s || !s.quote) continue
    const fullItem = s.context ? `${s.quote} (${s.context})` : s.quote
    if (!existingQuotes.has(s.quote)) toAppend.push(fullItem)
  }
  if (toAppend.length === 0) return currentContent
  const newLines = toAppend.map((item) => `- ${item}`).join('\n') + '\n'
  if (voiceSec) {
    return currentContent.slice(0, voiceSec.end) + newLines + currentContent.slice(voiceSec.end)
  }
  return currentContent + `\n## Voice samples\n\n<!-- grader-maintained: voice samples appended below -->\n` + newLines
}

// ---- Agent return schemas (INLINED from grader-workflow-lib.mjs; lockstep) --
const FLAGS_SCHEMA = {
  type: 'object',
  required: ['flags', 'jake_signals'],
  additionalProperties: false,
  properties: {
    segment_id: { type: 'string', description: 'optional bundle echo; with the FLAG-bundle layer ONE flagger covers many segments, so the per-segment ref now lives on each flag (flags[].segment_id), not here' },
    flags: {
      type: 'array',
      description: 'where the system diverged from its own discipline; EMPTY is a valid, expected result for a clean summary-bundle',
      items: {
        type: 'object',
        required: ['segment_id', 'evidence_ref', 'what_caught_my_eye'],
        additionalProperties: false,
        properties: {
          segment_id: { type: 'string', description: 'the segment this flag came from (carried through both bundling layers so the judge can dereference its RAW transcript slice)' },
          evidence_ref: { type: 'string', description: 'the cited evidence ref (tool-call idx / message ref) the judge dereferences to the RAW transcript slice (no flag without a segment_id + evidence_ref)' },
          what_caught_my_eye: { type: 'string', description: 'the localization note: what in the summary looked like a possible divergence, one line. The flagger LOCALIZES only; the judge assigns severity + the violated rule against the raw slice.' },
        },
      },
    },
    jake_signals: {
      type: 'array',
      description: 'reader-model + voice-corpus signals lifted from the operator\'s own words across the bundle; EMPTY is valid',
      items: {
        type: 'object',
        required: ['quote', 'signal'],
        additionalProperties: false,
        properties: {
          quote: { type: 'string', description: 'the operator\'s verbatim words' },
          signal: { type: 'string', enum: ['whats-X-again', 'got-it', 'voice'], description: 'whats-X-again = a re-explanation need (Frontier); got-it = a landed concept (Known); voice = a phrasing worth the voice-corpus' },
        },
      },
    },
  },
}

// SUMMARIES_SCHEMA -- one haiku summarizer's output over its segment-bundle: one
// pure-extraction summary per segment, keyed by segment_id, each retaining the
// evidence refs that let a downstream flag map to a specific segment's raw slice.
const SUMMARIES_SCHEMA = {
  type: 'object',
  required: ['summaries'],
  additionalProperties: false,
  properties: {
    summaries: {
      type: 'array',
      description: 'one per segment in the bundle; each retains segment_id + evidence refs (PURE EXTRACTION, no judgment)',
      items: {
        type: 'object',
        required: ['segment_id', 'summary', 'evidence_refs'],
        additionalProperties: false,
        properties: {
          segment_id: { type: 'string', description: 'the segment this summary extracts (keyed so a flag maps back to its raw slice)' },
          summary: { type: 'string', description: 'the structured pure-extraction summary for this segment (timeline, commits, verification, bypasses, resets, jake_signals)' },
          evidence_refs: { type: 'array', items: { type: 'string' }, description: 'the tool-call / message refs the summary cites' },
        },
      },
    },
  },
}

const ROUTED_SCHEMA = {
  type: 'object',
  required: ['memoryCandidates', 'docFaults', 'readerModelUpdates', 'corpusAppend', 'ledgerLines'],
  additionalProperties: false,
  properties: {
    memoryCandidates: {
      type: 'array',
      description: 'MEMORY-FAULT exceptions: tactical lessons the fast loop demonstrably missed, with no doc at fault. The B3-memory write path is STUBBED in D1 -- the COO applies these after B3b.',
      items: { type: 'object', additionalProperties: true },
    },
    docFaults: {
      type: 'array',
      description: 'DOC-FAULT findings GROUPED BY target file: one entry per file { targetFile, findings:[...] }, so the COO fires one redesigner per file (one rewrite, no same-file race)',
      items: {
        type: 'object',
        required: ['targetFile', 'findings'],
        additionalProperties: true,
        properties: {
          targetFile: { type: 'string', description: 'the ONE doc/skill/prompt file this group rewrites' },
          findings: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'every finding routed to this file' },
        },
      },
    },
    readerModelUpdates: {
      type: 'array',
      description: 'Known/Frontier reader-model moves derived from jake_signals (got-it -> Known, whats-X-again -> Frontier)',
      items: { type: 'object', additionalProperties: true },
    },
    corpusAppend: {
      type: 'array',
      description: 'voice-corpus voice samples (the `voice` jake_signals) to append',
      items: { type: 'object', additionalProperties: true },
    },
    ledgerLines: {
      type: 'array',
      description: 'one ledger line per routed finding (the slow-loop health record the COO appends); each item is a pre-formatted bullet string',
      items: { type: 'string' },
    },
  },
}

// ---- Slim payload-builder functions ----------------------------------------
//
// DATA RIDES IN THE PROMPT STRING (AC3). The Workflow agent() harness delivers
// per-dispatch data via the PROMPT STRING (arg 1), NOT via arbitrary custom opts
// keys (only label/phase/schema/model/agentType/isolation are honored). These slim
// builders assemble the variable payload into the prompt string; agentType supplies
// the standing instructions (agent.md).
//
// summarizePrompt -- ONE haiku summarizer per segment-bundle (PRE-BUNDLE layer).
// Carries: the bundle's segment descriptors (segment_id, path, role, charOffsets,
// messageRange) + each segment's conformanceDoc path. PURE EXTRACTION: the summarizer
// reads every segment in the bundle and returns one evidence-cited summary per segment,
// keyed by segment_id, so a downstream flag still maps to a specific segment's raw slice.
function summarizePrompt(bundle) {
  const segs = (bundle && bundle.segments) || []
  const segLines = segs.map((seg) => [
    `Segment: ${seg.segment_id}`,
    `  source: ${seg.path}`,
    `  role: ${seg.role} (${seg.role === 'coo' ? 'COO orchestration log' : 'a subagent transcript'})`,
    `  byte window: chars ${seg.charOffsets.start}-${seg.charOffsets.end}, messages ${seg.messageRange.startMsg}-${seg.messageRange.endMsg}`,
    `  conformance doc (context only, do NOT judge): ${seg.conformanceDoc || '(none)'}`,
  ].join('\n')).join('\n\n')
  return [
    `You are a grader SUMMARIZER (haiku front-end) for the shipped spec "${specSlug}".`,
    `You read a BUNDLE of ${segs.length} transcript segment(s) and do PURE EXTRACTION --`,
    `NO judgment, NO grading, NO proposals. Extract what happened and CITE evidence.`,
    ``,
    segLines,
    ``,
    `For EACH segment, read it from its source file at the byte window above and extract,`,
    `keyed by segment_id: a chronological event timeline, test-vs-code ordering, commits,`,
    `verification/test runs, git bypasses, resets, and jake_signals (the operator's own words).`,
    `Cite a per-segment evidence ref (tool-call idx / message ref / quote) for EVERY fact,`,
    `so a downstream flag still maps back to a SPECIFIC segment's raw slice. Never merge`,
    `facts across segments; never drop a segment_id.`,
    ``,
    `Return { summaries: [{ segment_id, summary, evidence_refs }] }, one entry per segment.`,
  ].join('\n')
}

// flagPrompt -- ONE flagger per SUMMARY-BUNDLE (FLAG-bundle layer). Carries the
// bundle's summaries (each retaining segment_id + evidence refs). The flagger reads
// the bundled summaries and emits flags, each carrying the segment_id + evidence ref
// it came from. Truth-calibrated per disciplines/review-contract.md: "no flags" is the
// expected, correct result.
function flagPrompt(summaryBundle) {
  const summaries = (summaryBundle && summaryBundle.summaries) || []
  // Build XML-tagged item list: each summary wrapped in <item index=N source=segment_id>.
  const itemsXml = summaries.map((s, i) =>
    `<item index=${i} source="${(s && s.segment_id) || ''}">\n${JSON.stringify(s, null, 2)}\n</item>`
  ).join('\n')
  // Rule block: stated at top AND repeated at the tail so the model never loses the
  // instruction when the item list is large (MRCR: anchoring at both ends preserves
  // recall at the 120k-token bundle size).
  const ruleBlock = [
    `LOCALIZE each place a summary LOOKS LIKE the system may have diverged from a rule in`,
    `the segment's conformance doc. You localize only -- you do NOT assign severity or name`,
    `the violated rule; the JUDGE does that against the raw slice (one place). For each flag`,
    `carry: segment_id (the source segment so the judge can dereference the raw slice),`,
    `evidence_ref (the cited ref -- tool-call idx / message ref -- NO flag without a`,
    `segment_id + evidence_ref), what_caught_my_eye (one line: what looked off).`,
    ``,
    `TRUTH-CALIBRATED: report the TRUTH, not problems. "No flags" is the EXPECTED, CORRECT`,
    `result for a clean bundle -- return flags:[] and do NOT manufacture issues. False`,
    `positives are the failure mode to avoid.`,
    ``,
    `Also lift jake_signals from the summaries' extracted jake_signals: "whats-X-again"`,
    `(Frontier), "got-it" (Known), "voice" (voice-corpus). Empty is valid.`,
    ``,
    `Return flags + jake_signals per the schema.`,
  ].join('\n')
  return [
    `You are a grader FLAGGER for the shipped spec "${specSlug}". You read a BUNDLE of`,
    `${summaries.length} per-segment SUMMARY(ies) (haiku-extracted, evidence-cited) and`,
    `report where the SYSTEM diverged from its conformance doc.`,
    ``,
    ruleBlock,
    ``,
    `Summaries (each keyed by segment_id, with its evidence refs):`,
    `<items>`,
    itemsXml,
    `</items>`,
    ``,
    `REMINDER (rule restated after items for recall):`,
    ruleBlock,
  ].join('\n')
}

// judgePrompt -- ONE judge over every flag. Carries: flagResults JSON (every
// flagger's output) + manifest JSON (segment_id -> file path + byte/message
// offsets, so the judge can dereference any flag's raw slice).
function judgePrompt(flagResults, manifest) {
  return [
    `You are the grader JUDGE (one judge, all flags) for the shipped spec "${specSlug}".`,
    ``,
    `You receive every flagger's output and the segment manifest (segment_id -> file`,
    `path + byte/message offsets) so you can dereference any flag's raw slice.`,
    ``,
    `Flagger results (${(flagResults || []).length} segments):`,
    JSON.stringify(flagResults || [], null, 2),
    ``,
    `Manifest (${(manifest || []).length} segments):`,
    JSON.stringify(manifest || [], null, 2),
    ``,
    `Do FOUR things:`,
    `  1. CLUSTER flags that point at the same event (dedupe across overlapping windows).`,
    `  2. VERDICT each cluster: a fluke -> drop. Real -> root-cause: "would a reasonable`,
    `     agent following the CURRENT doc have done this?" Yes -> MEMORY-FAULT (tactical,`,
    `     no doc at fault) -- but route to memoryCandidates ONLY when the fast loop`,
    `     demonstrably missed it; a recurring memory-fault class IS a doc-fault (fix the`,
    `     capture instructions). No -> DOC-FAULT: name ONE file + section, quote the`,
    `     failing text.`,
    `  3. SCOPE-ROUTE each finding global (~/.claude) vs workspace (a project's .claude).`,
    `  4. ROUTE: memory-faults -> memoryCandidates (NOTE: the B3-memory write path is`,
    `     STUBBED until B3b -- just emit the candidates, the COO applies them later);`,
    `     doc-faults -> grouped BY target file (one entry per file, all that file's`,
    `     findings folded together, so the COO fires one redesigner per file).`,
    ``,
    `Derive readerModelUpdates from jake_signals (got-it -> Known, whats-X-again ->`,
    `Frontier), corpusAppend from the "voice" signals, and one ledgerLine per routed`,
    `finding. Return the five keys per the schema. Truth-calibrated: an empty result on`,
    `any key is valid -- a clean spec yields few or no findings.`,
  ].join('\n')
}

// ============================================================================
// The phases. (The manifest is built COO-side and arrives as args.manifest; there is
// no SEGMENT agent. The three agent phases are SUMMARIZE, FLAG, JUDGE.)
// ============================================================================

// SUMMARIZE -- PRE-BUNDLE the in-scope segments (size + char capped), then one HAIKU
// grader-summarizer per segment-bundle. Bundling means FEWER haiku dispatches than
// segments. agentType:'grader-summarizer' supplies the standing instructions
// (agents/grader-summarizer.md, model: haiku); the prompt carries the bundle's segment
// descriptors. Each summarizer returns one PURE-EXTRACTION summary per segment, keyed
// by segment_id with its evidence refs (so a downstream flag still maps to a raw slice).
phase('SUMMARIZE')
const segmentBundles = preBundleSegments(manifest, SEGMENTS_PER_BUNDLE, SEGMENT_BUNDLE_CHAR_CAP)
const summarizeResults = await parallel(
  segmentBundles.map((bundle) => () => agent(
    summarizePrompt(bundle),
    { label: bundle.bundle_id, phase: 'SUMMARIZE', agentType: 'grader-summarizer', schema: SUMMARIES_SCHEMA }
  ))
)
// Flatten every bundle's per-segment summaries into one list (each retains segment_id).
// Enrich each summary with conformance_doc from the manifest so the downstream flagger
// knows which conformance doc to cite rules from (the haiku summarizer does pure extraction
// and does not carry this forward; it must be injected at the workflow layer).
// normSegId: haiku summarizers reliably echo segment_id as `<file-stem>#<N>` (they
// drop the directory + .jsonl extension from the manifest's absolute-path id), so an
// exact id match silently loses every multi-path segment. Normalize BOTH sides to the
// `<stem>#<N>` form (idempotent on an already-short id) so the match is path-format
// independent. The full path stays on the `path` field for raw-slice dereference.
function normSegId(id) {
  const str = String(id || '')
  const hashIdx = str.lastIndexOf('#')
  const left = hashIdx >= 0 ? str.slice(0, hashIdx) : str
  const suffix = hashIdx >= 0 ? str.slice(hashIdx) : ''
  const base = left.split('/').pop().replace(/\.jsonl$/i, '')
  return base + suffix
}
// manifest with segment_id normalized to the short form the summarizers/flaggers emit,
// used for enrichment lookup, the completeness check, and the judge's dereference map.
// (The summarizer prompts still read the ORIGINAL `manifest` above, so a resume cache-hits.)
const manifestNorm = manifest.map((s) => ({ ...s, segment_id: normSegId(s.segment_id) }))
const manifestBySegId = Object.fromEntries(manifestNorm.map((s) => [s.segment_id, s]))
const summaries = summarizeResults
  .flatMap((r) => (r && Array.isArray(r.summaries)) ? r.summaries : [])
  .map((s) => {
    const seg = manifestBySegId[normSegId(s.segment_id)]
    return seg ? { ...s, conformance_doc: seg.conformanceDoc || null } : s
  })

// Validate summarize coverage. If any segment_ids are missing their summary after
// the first pass, run ONE retry: re-bundle only the missing segments and re-dispatch
// the haiku summarizers. Merge any recovered summaries back. If some remain missing
// after the retry, fail-open (log them, do NOT throw) so the grade still completes
// with whatever summaries were recoverable.
const summarizedIds = new Set(summaries.map((s) => normSegId(s.segment_id)))
const missingIds = manifestNorm.map((s) => s.segment_id).filter((id) => !summarizedIds.has(id))
if (missingIds.length > 0) {
  // RETRY PASS: re-bundle the missing segment subset and re-run the summarizers.
  // Use original manifest entries (full-path segment_ids) so the retry prompt is
  // format-consistent with the first pass and resume cache-hit compatible.
  const missingSet = new Set(missingIds)
  const missingManifest = manifest.filter((s) => missingSet.has(normSegId(s.segment_id)))
  const retryBundles = preBundleSegments(missingManifest, SEGMENTS_PER_BUNDLE, SEGMENT_BUNDLE_CHAR_CAP)
  const retryResults = await parallel(
    retryBundles.map((bundle) => () => agent(
      summarizePrompt(bundle),
      { label: `retry-${bundle.bundle_id}`, phase: 'SUMMARIZE', agentType: 'grader-summarizer', schema: SUMMARIES_SCHEMA }
    ))
  )
  // Merge recovered summaries (with conformance_doc enrichment) into the main list.
  const retrySummaries = retryResults
    .flatMap((r) => (r && Array.isArray(r.summaries)) ? r.summaries : [])
    .map((s) => {
      const seg = manifestBySegId[normSegId(s.segment_id)]
      return seg ? { ...s, conformance_doc: seg.conformanceDoc || null } : s
    })
  summaries.push(...retrySummaries)
  // Check for still-missing ids after the retry; fail-open (log, do not throw).
  const recoveredIds = new Set(retrySummaries.map((s) => normSegId(s.segment_id)))
  const stillMissing = missingIds.filter((id) => !recoveredIds.has(id))
  if (stillMissing.length > 0) {
    log(
      `grader-workflow: ${stillMissing.length} segment(s) still missing after retry -- ` +
      `dropping and continuing (fail-open): ${stillMissing.join(', ')}`
    )
  }
}

// FLAG -- BUNDLE the summaries (K per bundle), then one SONNET grader-flagger per
// summary-bundle. Flagger count == summary-bundle count (FEWER than per-segment).
// agentType:'grader-flagger' supplies the standing instructions (agents/grader-flagger.md);
// the prompt carries the bundle's summaries (each with its segment_id + evidence refs).
phase('FLAG')
const summaryBundles = bundleSummaries(summaries, SUMMARIES_PER_FLAG_BUNDLE, MAX_SUMMARY_BUNDLE_CHARS)
const flagResults = await parallel(
  summaryBundles.map((bundle) => () => agent(
    flagPrompt(bundle),
    { label: bundle.bundle_id, phase: 'FLAG', agentType: 'grader-flagger', schema: FLAGS_SCHEMA }
  ))
)

// JUDGE -- ONE grader-judge agent over every flag + the manifest.
// agentType:'grader-judge' supplies the standing instructions (agents/grader-judge.md);
// the prompt string carries the variable payload: flagResults JSON + manifest JSON.
phase('JUDGE')
const routed = await agent(
  judgePrompt(flagResults, manifestNorm),
  { label: 'judge', phase: 'JUDGE', agentType: 'grader-judge', schema: ROUTED_SCHEMA }
)

// Assemble the return. The judge already groups doc-faults by target file per its
// prompt + schema; defensively re-group here so the return contract holds even if a
// judge emits a flat list (groupDocFaultsByFile is idempotent over already-grouped
// input only when items are flat findings, so apply it ONLY to a flat list).
const judged = routed || {}
const rawDocFaults = Array.isArray(judged.docFaults) ? judged.docFaults : []
const alreadyGrouped = rawDocFaults.length > 0 && rawDocFaults.every((d) => d && Array.isArray(d.findings))
const docFaults = alreadyGrouped ? rawDocFaults : groupDocFaultsByFile(rawDocFaults)

// NOTE (B3-memory STUB): memoryCandidates pass through as data only. The B3-memory
// write path (memory-index insert) lands at B3b; D1 emits candidates without writing.
return {
  memoryCandidates: judged.memoryCandidates || [],
  docFaults,
  readerModelUpdates: judged.readerModelUpdates || [],
  corpusAppend: judged.corpusAppend || [],
  ledgerLines: judged.ledgerLines || [],
}
