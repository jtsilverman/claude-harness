// grader-workflow-lib.mjs -- the TESTABLE source of truth for the grader's
// deterministic, agent-free machinery (chunk llr-D1).
//
// This file is the importable copy of the PURE helpers + the structured-return
// schemas the grader needs: segment + manifest (SEGMENT phase), the return-shape
// assembly (docFaults grouped by target file), and the FLAGS/ROUTED agent schemas.
// It is unit-tested directly (workflows/grader-workflow.test.mjs) because the
// launchable Workflow script (workflows/grader-workflow.js) runs its body under the
// Workflow harness globals (agent/parallel/phase/log) and so cannot be plain-imported
// under `node --test`. The launchable .js INLINES these helpers verbatim (the Workflow
// sandbox has no module resolution) and must stay byte-for-byte in lockstep with this
// file -- the test asserts both files define the same helper functions.
//
// Why a lib + an inlined copy (and not one file): the Workflow harness rejects any
// export other than `export const meta`, so the launchable script cannot itself export
// the helpers for a test to import. The in-repo convention (session-grader.mjs /
// session-grader-lib.mjs) resolves this with a dual-file lockstep: lib = testable
// truth, launchable = meta + inlined body.
//
// Plain JavaScript, ES module. No filesystem WRITES anywhere in the grader path --
// the SEGMENT phase only READS the archive to build the manifest; all side effects
// (memory/doc/ledger writes) are executed by the COO after the workflow returns.

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---- Segmentation thresholds (the spec contract) ---------------------------
// A whole transcript file <= SEGMENT_CHAR_LIMIT chars is one segment; a larger one
// splits at message boundaries into ~WINDOW_CHAR_TARGET-char windows that OVERLAP by
// OVERLAP_MESSAGES messages. (~150k / ~100k / 5 per the fable-review §B grader internals.)
export const SEGMENT_CHAR_LIMIT = 150000
export const WINDOW_CHAR_TARGET = 100000
export const OVERLAP_MESSAGES = 5

// ---- SEGMENT: list archive transcripts, window, emit a manifest ------------
//
// On-disk layout (verified against specs/three-loop-rebuild/sessions/):
//   sessions/<id>/<id>.jsonl                       -- the COO transcript (one per session)
//   sessions/<id>/<id>/subagents/**/agent-*.jsonl  -- per-subagent transcripts (incl.
//                                                     nested under subagents/workflows/wf_*/)
// Each JSONL line is one message record, so a "message boundary" is the newline
// between records: windowing splits on whole lines, never mid-line.
//
// Returns a flat manifest array, one entry per segment:
//   { segment_id, path, charOffsets:{start,end}, messageRange:{startMsg,endMsg}, role }
// role is 'coo' for the session COO log, 'subagent' otherwise (so the FLAG phase can
// route the role-matched conformance doc; D2 sharpens that routing).

// ---- Conformance-doc routing: derive the conformance doc path from a subagent's
// .meta.json sidecar (a sibling file next to the .jsonl, with the same stem but
// .meta.json extension). The routing table (per fable-review §B grader internals):
//   agentType starts with 'build-agent' -> disciplines/worker-discipline.md, rules/git-discipline.md
//   agentType starts with 'chunk-reviewer' OR 'spec-drift-slop-reviewer' -> disciplines/review-contract.md
//     (dual-match: the reviewer was renamed in C8; pre-rename session archives carry
//      the OLD agentType in their sidecars, so both names must still route correctly.)
//   role === 'coo' -> coo/coo-sop.md
//   all other agentTypes (Explore, workflow-subagent, etc.) -> null
//
// Returns the conformance doc path(s) as a comma-separated string, or null when the
// agent has no matching conformance doc (utility agents, absent sidecar).
// build-agent* returns two paths (worker-discipline + git-discipline) as one string.
export function deriveConformanceDoc(jsonlPath, role) {
  if (role === 'coo') return 'coo/coo-sop.md'
  // Read the .meta.json sidecar sibling: same directory, same stem, .meta.json ext.
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  let agentType = null
  let label = null
  try {
    const raw = readFileSync(metaPath, 'utf8')
    const parsed = JSON.parse(raw)
    agentType = parsed.agentType || null
    label = parsed.label || null
  } catch {
    // Absent or unreadable sidecar -> null (safe fallback per AC4)
    return null
  }
  // Ship-review Stage reviewers are INLINE agents with no agentType; identified only by
  // label. Route them to review-contract (they are reviewer-role agents).
  if (!agentType && label && SHIP_REVIEWER_LABELS.has(label)) return 'disciplines/review-contract.md'
  if (!agentType) return null
  // AC4: build-agent* routes to BOTH worker-discipline (the primary build contract) AND
  // git-discipline (branch/commit/no-bypass rules every build-agent must follow).
  if (agentType.startsWith('build-agent')) return 'disciplines/worker-discipline.md, rules/git-discipline.md'
  // C8 DUAL-MATCH: the reviewer was renamed spec-drift-slop-reviewer{,-heavy} ->
  // chunk-reviewer{,-heavy}. Pre-rename session archives carry the OLD name in their
  // .meta.json sidecars, so BOTH names route to review-contract (old archives still grade).
  if (agentType.startsWith('chunk-reviewer') || agentType.startsWith('spec-drift-slop-reviewer')) return 'disciplines/review-contract.md'
  // All other agent types (Explore, workflow-subagent, etc.) -> null
  return null
}

// ---- SCOPE FILTER (chunk grader-scope + grader-scope-ship-reviewers) --------
//
// The grader grades only HIGH-SIGNAL segments: COO windows + A/S-tier pipeline
// segments (build + fixer + reviewer) + ship-review Stage reviewers (identified by
// LABEL, not agentType, because they are inline agents with no agentType field).
// Everything else is noise the slow loop should not pay to grade: B/C pipelines
// (their identical-body A/S variants are already graded, so the prompt/doc is
// covered), the narrow utility agents (memory/diagram/demo), the ship UTILITY agents
// (diagram-refresh/stage3-demo), and -- critically -- the grader's OWN subagents
// (grader-flagger/grader-judge), so the grader never recursively grades itself.
//
// Tier is derived from agentType because the agent-FILE name encodes it:
//   build-agent-max = S, build-agent-heavy = A, build-agent (base) = B, build-agent-light = C
//   fixer-heavy / chunk-reviewer-heavy serve A/S; fixer / fixer-light / chunk-reviewer serve B/C
// So the A/S-variant allow-list is an EXACT-match set of agentType names (the base
// and -light variants are deliberately absent -> excluded). agentType comes from the
// SAME .meta.json sidecar deriveConformanceDoc reads (see deriveAgentType below).
//
// Ship-review Stage reviewers have NO agentType (they are INLINE agents launched
// inside ship-review-workflow.js). They are identified by LABEL in their .meta.json
// sidecar (see deriveLabel below). The ship UTILITY agents (diagram-refresh,
// stage3-demo) also carry labels but are NOT included.

// The exact agentType names that are A/S-tier pipeline variants (the only INCLUDED
// subagent types). Exact-match, not prefix-match: 'build-agent' (base, B) and
// 'build-agent-light' (C) must NOT match, so a prefix test on 'build-agent' would
// wrongly include them. Likewise 'fixer' must not match 'fixer-heavy' via prefix.
const AS_TIER_AGENT_TYPES = new Set([
  'build-agent-heavy',   // A-tier build
  'build-agent-max',     // S-tier build
  'fixer-heavy',         // A/S fixer
  'chunk-reviewer-heavy', // A/S reviewer
])

// The ship-review-workflow Stage reviewer labels that are INCLUDED in grading.
// These are INLINE agents (no agentType); identified only by the 'label' field in
// their .meta.json sidecar. Ship UTILITY agents (diagram-refresh, stage3-demo) are
// NOT in this set and remain excluded. grill-me is a SKILL run in the COO session ->
// already covered by COO windows.
const SHIP_REVIEWER_LABELS = new Set([
  'stage1-live-run',  // opus live-run gate (ship-review-workflow Stage 1)
  'stage2-review',    // opus full-spec reviewer (ship-review-workflow Stage 2)
  'stage2-codex',     // Codex cross-model lens (ship-review-workflow Stage 2)
])

// segmentInScope(agentType, role, label?) -> boolean. The per-segment scope predicate:
//   role === 'coo'                          -> true  (ALL COO windows kept, any tier)
//   agentType in the A/S-variant allow-list -> true  (A/S pipelines graded whole)
//   label in SHIP_REVIEWER_LABELS           -> true  (ship-review Stage reviewers)
//   everything else                         -> false (B/C, memory/diagram/demo,
//                                                      grader-flagger/judge, ship utility, null)
// NOTE: grader-workflow session COO logs are filtered by isGraderWorkflowSession BEFORE
// this predicate runs in buildSegmentManifest (the COO-include branch is not sufficient
// to exclude them -- the session-level check gates it upstream).
export function segmentInScope(agentType, role, label) {
  if (role === 'coo') return true
  if (AS_TIER_AGENT_TYPES.has(agentType)) return true
  if (label && SHIP_REVIEWER_LABELS.has(label)) return true
  return false
}

// isGraderWorkflowSession(cooLogPath) -> boolean. Detects whether a COO-level transcript
// belongs to a grader-workflow run (AC5: grader-workflow runs are EXCLUDED). A grader
// session is identified by the presence of grader-flagger or grader-judge agents in the
// session's subagent directory. The subagent dir lives alongside the COO log:
//   <sessionDir>/<id>.jsonl  -> <sessionDir>/<id>/subagents/**/*.meta.json
// If ANY .meta.json sidecar under that dir carries agentType 'grader-flagger' or
// 'grader-judge', the session is a grader-workflow run. Absent / unreadable dir -> false
// (not a grader-workflow session; fail open: unknown sessions are graded, not skipped).
const GRADER_SESSION_AGENT_TYPES = new Set(['grader-flagger', 'grader-judge'])
export function isGraderWorkflowSession(cooLogPath) {
  // Derive the subagent dir: <sessDir>/<id>/subagents, where the COO log is
  // <sessDir>/<id>.jsonl and <sessDir>/<id>/ is the session directory sibling.
  const sessionSubDir = cooLogPath.replace(/\.jsonl$/, '')
  const subagentsDir = join(sessionSubDir, 'subagents')
  return _hasGraderAgent(subagentsDir)
}

// Walk subagentsDir recursively; return true as soon as a grader-agent meta.json is found.
function _hasGraderAgent(dir) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (_hasGraderAgent(p)) return true
    } else if (e.isFile() && e.name.endsWith('.meta.json')) {
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'))
        if (GRADER_SESSION_AGENT_TYPES.has(parsed.agentType)) return true
      } catch { /* unreadable sidecar -> skip */ }
    }
  }
  return false
}

// isSpecCollabOnward(segment) -> boolean. The spec-collab BOUNDARY: only segments
// from spec-collab onward are graded; pre-spec-lock chatter is dropped. Best-effort
// when the archive is already spec-scoped (the on-disk layout is sessions/<spec>/...,
// so the boundary is usually a no-op), but the logic exists and is testable: a segment
// explicitly marked { preSpecCollab: true } is excluded; everything else defaults to
// kept (an already-spec-scoped archive carries no pre-collab segments to drop).
export function isSpecCollabOnward(segment) {
  return !(segment && segment.preSpecCollab === true)
}

// deriveAgentType(jsonlPath) -> string|null. Read the agentType from a subagent's
// .meta.json sidecar (same source deriveConformanceDoc uses for routing). Absent or
// unreadable sidecar -> null (which segmentInScope treats as out-of-scope).
export function deriveAgentType(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'))
    return parsed.agentType || null
  } catch {
    return null
  }
}

// deriveLabel(jsonlPath) -> string|null. Read the label field from a subagent's
// .meta.json sidecar (mirrors deriveAgentType). Ship-review Stage reviewers are
// INLINE agents with no agentType; their label field identifies them. Absent or
// unreadable sidecar -> null (which segmentInScope treats as out-of-scope).
export function deriveLabel(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'))
    return parsed.label || null
  } catch {
    return null
  }
}

// Recursively collect every *.jsonl transcript path under a session archive dir.
function listTranscriptFiles(sessionArchiveDir) {
  const out = []
  let sessionIds = []
  try {
    sessionIds = readdirSync(sessionArchiveDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return out
  }
  for (const sid of sessionIds) {
    const sessDir = join(sessionArchiveDir, sid)
    // The COO transcript: sessions/<id>/<id>.jsonl
    const cooLog = join(sessDir, `${sid}.jsonl`)
    try {
      if (statSync(cooLog).isFile()) out.push({ path: cooLog, role: 'coo' })
    } catch { /* no COO log for this session */ }
    // Subagent transcripts: sessions/<id>/<id>/subagents/**/agent-*.jsonl
    walkSubagents(join(sessDir, sid, 'subagents'), out)
  }
  return out
}

function walkSubagents(dir, out) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      walkSubagents(p, out)
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push({ path: p, role: 'subagent' })
    }
  }
}

// Split one transcript's text into overlapping windows at message (line) boundaries.
// Whole file <= SEGMENT_CHAR_LIMIT -> a single whole-file window. Otherwise greedily
// accumulate messages into ~WINDOW_CHAR_TARGET-char windows; each next window starts
// OVERLAP_MESSAGES messages before the previous window ended (inclusive overlap), so
// a finding straddling a window boundary is seen whole by at least one flagger.
export function windowTranscript(path, text) {
  // Messages = non-empty lines (the trailing newline yields one empty tail token).
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const messages = lines
  const totalChars = text.length

  // Char offset of the START of each message (cumulative), plus a final end offset.
  // +1 per line for the newline separator, matching how the file is laid out.
  const startOffset = new Array(messages.length + 1)
  startOffset[0] = 0
  for (let i = 0; i < messages.length; i++) {
    startOffset[i + 1] = startOffset[i] + messages[i].length + 1 // + '\n'
  }

  // Whole-file segment: the file fits under the cap. The split below is NOT gated on
  // message count -- an oversized transcript with very few (even <= OVERLAP_MESSAGES)
  // messages must still window. The forward-progress guard in the loop (always at
  // least one message forward) keeps the overlap math safe for few-message files; an
  // empty file is the only message-count short-circuit, to avoid windowing nothing.
  if (totalChars <= SEGMENT_CHAR_LIMIT || messages.length === 0) {
    return [{
      path,
      charOffsets: { start: 0, end: totalChars },
      messageRange: { startMsg: 0, endMsg: Math.max(0, messages.length - 1) },
    }]
  }

  const windows = []
  let startMsg = 0
  while (startMsg < messages.length) {
    // Grow the window to ~WINDOW_CHAR_TARGET chars, always at least one message (a
    // single message may itself exceed the target; it still goes in whole, never split
    // mid-message).
    let endMsg = startMsg
    let acc = messages[startMsg].length + 1
    while (endMsg + 1 < messages.length && acc + messages[endMsg + 1].length + 1 <= WINDOW_CHAR_TARGET) {
      endMsg++
      acc += messages[endMsg].length + 1
    }
    windows.push({
      path,
      charOffsets: { start: startOffset[startMsg], end: startOffset[endMsg + 1] },
      messageRange: { startMsg, endMsg },
    })
    if (endMsg >= messages.length - 1) break // covered the final message
    // Next window starts OVERLAP_MESSAGES messages before this one ended (inclusive
    // overlap of exactly OVERLAP_MESSAGES messages) -- BUT never before this window's
    // own start, and always at least one message forward, so a window holding a single
    // oversized message (endMsg == startMsg) still advances instead of looping.
    const overlapStart = endMsg - (OVERLAP_MESSAGES - 1)
    startMsg = Math.max(overlapStart, startMsg + 1)
  }
  return windows
}

// Build the full segment manifest over a session archive dir.
export function buildSegmentManifest(sessionArchiveDir) {
  const files = listTranscriptFiles(sessionArchiveDir)
  const manifest = []
  for (const f of files) {
    // GRADER-WORKFLOW EXCLUSION (AC5): before the scope predicate, drop COO logs that
    // belong to a grader-workflow session. A grader session is detected by the presence
    // of grader-flagger or grader-judge agents in the session's subagent directory.
    // This check gates upstream of segmentInScope: the coo-include branch would otherwise
    // unconditionally pass all COO logs, including grader-workflow COO logs.
    if (f.role === 'coo' && isGraderWorkflowSession(f.path)) continue
    // SCOPE FILTER (chunk grader-scope + grader-scope-ship-reviewers): grade only COO
    // windows + A/S-tier pipeline segments + ship-review Stage reviewers (by label).
    // Derive agentType and label from the .meta.json sidecar (COO logs have no sidecar
    // and are kept by the role==='coo' branch), then drop out-of-scope transcripts
    // before any windowing/read so they never reach the manifest.
    const agentType = f.role === 'coo' ? null : deriveAgentType(f.path)
    const label = f.role === 'coo' ? null : deriveLabel(f.path)
    if (!segmentInScope(agentType, f.role, label)) continue
    // BOUNDARY (chunk grader-scope): drop pre-spec-collab segments. No-op for an
    // already-spec-scoped archive (no file carries the marker), but the boundary is
    // wired here, not just declared, so a marked record would be dropped.
    if (!isSpecCollabOnward(f)) continue
    let text = ''
    try {
      text = readFileSync(f.path, 'utf8')
    } catch {
      continue // unreadable transcript -> skip rather than abort the whole grade
    }
    const windows = windowTranscript(f.path, text)
    const conformanceDoc = deriveConformanceDoc(f.path, f.role)
    windows.forEach((w, idx) => {
      manifest.push({
        segment_id: `${f.path}#${idx}`,
        path: f.path,
        role: f.role,
        charOffsets: w.charOffsets,
        messageRange: w.messageRange,
        conformanceDoc,
      })
    })
  }
  return manifest
}

// ---- BUNDLING (chunk grader-efficiency): two layers + a haiku front-end -----
//
// The grader's pipeline is SEGMENT -> PRE-BUNDLE -> SUMMARIZE(haiku) ->
// FLAG(sonnet, bundled) -> JUDGE(opus). Two configurable group sizes shrink the
// fan-out: one HAIKU summarizer reads N small segments (preBundleSegments), then
// one SONNET flagger reads K summaries (bundleSummaries). Both are PURE grouping
// functions (no fs, no agents); the launchable inlines them verbatim (lockstep).

// preBundleSegments(manifest, maxPerBundle, charCap) -> bundles[]
//   Group the in-scope manifest's segments into size-capped bundles so ONE haiku
//   summarizer reads several small segments instead of one-per-segment. A bundle
//   holds at most maxPerBundle segments AND at most charCap chars (the char budget
//   keeps a haiku call from being overrun); a single segment is NEVER split across
//   bundles. A lone segment larger than charCap still goes in WHOLE (one per bundle):
//   a bundle always holds at least one segment even when it overruns the cap.
//   Each bundle: { bundle_id, segments: [<manifest entry>...] }.
export function preBundleSegments(manifest, maxPerBundle, charCap) {
  const segs = Array.isArray(manifest) ? manifest : []
  const segChars = (s) => (s && s.charOffsets ? (s.charOffsets.end - s.charOffsets.start) : 0)
  const bundles = []
  let cur = []
  let curChars = 0
  for (const seg of segs) {
    const c = segChars(seg)
    // Start a new bundle when adding this segment would exceed EITHER cap -- but only
    // if the current bundle already holds at least one segment (never emit an empty
    // bundle, and never split a single oversized segment off into nothing).
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
//   Group S per-segment summaries into bundles so ONE sonnet flagger reads at most K
//   summaries AND at most charCap serialized chars per bundle (~200k tokens at 4 chars/tok
//   when charCap=800000). Both limits bind independently: whichever fires first cuts the
//   bundle. A lone summary that exceeds charCap still goes in WHOLE (one per bundle),
//   matching preBundleSegments' single-oversized-item behavior.
//   Each bundle: { bundle_id, summaries: [<summary>...] }.
export function bundleSummaries(summaries, K, charCap) {
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

// ---- Return-shape assembly: group doc-faults by target file ----------------
//
// The judge emits doc-fault findings each naming ONE target file+section. The COO
// fires one redesigner per file (all that file's findings = one rewrite), so the
// assembled return groups findings BY target file -- preventing same-file races.
export function groupDocFaultsByFile(findings) {
  const byFile = new Map()
  for (const f of findings || []) {
    const key = f.targetFile || '(unknown)'
    if (!byFile.has(key)) byFile.set(key, { targetFile: key, findings: [] })
    byFile.get(key).findings.push(f)
  }
  return Array.from(byFile.values())
}

// ---- Agent return schemas (JSON-Schema, threaded to agent() as `schema`) ----
//
// FLAGS_SCHEMA -- one flagger's output over its summary-bundle. The flagger LOCALIZES
// only: each flag carries { segment_id, evidence_ref, what_caught_my_eye }. The judge
// assigns severity and the violated rule against the dereferenced raw slice (one place,
// not re-derived from a flagger guess). Truth-calibrated: a flagger that finds nothing
// returns flags:[] (zero flags is a valid, expected result).
export const FLAGS_SCHEMA = {
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
export const SUMMARIES_SCHEMA = {
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

// ---- Apply functions: COO sole-writer calls these to apply grader return data ----
//
// These are PURE functions (no fs access). The grader WORKFLOW returns readerModelUpdates
// and corpusAppend; the COO applies them to the two coo/ files sole-writer at ship by
// calling these functions and writing the returned strings to disk.
//
// applyReaderModelUpdates(currentContent, readerModelUpdates) -> newContent
//   readerModelUpdates: [{ concept, move: 'Known'|'Frontier', quote }]
//   got-it -> Known (and removes from Frontier if present = graduation)
//   whats-X-again -> Frontier (and removes from Known if present)
//   dedup across updates and against existing entries; idempotent on re-apply.
//
// applyCorpusAppend(currentContent, corpusAppend) -> newContent
//   corpusAppend: [{ quote, context }]
//   Appends voice samples (deduped by quote) to the ## Voice samples section.

// Parse a markdown document into sections. Returns array of
// { heading: string|null, body: string, start: number, end: number }.
// The first entry (if content precedes the first ## heading) has heading:null.
function _parseSections(content) {
  const sections = []
  // Find all '## Heading' lines (at start of line).
  const headingRe = /^(## [^\n]+)\n/gm
  let lastEnd = 0
  let lastHeading = null
  let lastStart = 0
  let match
  while ((match = headingRe.exec(content)) !== null) {
    // Close previous section
    sections.push({ heading: lastHeading, body: content.slice(lastEnd, match.index), start: lastStart, end: match.index })
    lastHeading = match[1].replace(/^## /, '')
    lastStart = match.index
    lastEnd = match.index + match[0].length // body starts after the heading line
  }
  // Final section runs to EOF
  sections.push({ heading: lastHeading, body: content.slice(lastEnd), start: lastStart, end: content.length })
  return sections
}

// Extract bullet items ('- <item>') from a section body string.
function _extractSectionItems(sectionBody) {
  if (!sectionBody) return []
  return sectionBody.split('\n')
    .filter((l) => l.trimStart().startsWith('- '))
    .map((l) => l.trimStart().slice(2).trim())
}

// Rewrite one section's item list (bullet lines), preserving non-bullet prose.
// Returns the full reconstructed document string.
function _rewriteSectionItems(content, headingName, newItems) {
  const sections = _parseSections(content)
  const target = sections.find((s) => s.heading === headingName)
  if (!target) return content

  const oldBody = target.body
  // Preserve non-item lines (prose, comments, blank lines).
  const nonItemLines = oldBody.split('\n').filter((l) => !l.trimStart().startsWith('- '))
  // Trim trailing blank lines from non-item block.
  while (nonItemLines.length && nonItemLines[nonItemLines.length - 1].trim() === '') nonItemLines.pop()

  const itemBlock = newItems.map((item) => `- ${item}`).join('\n')
  const newBody = (nonItemLines.length ? nonItemLines.join('\n') + '\n\n' : '\n') + itemBlock + '\n'

  // The heading line that was matched ends at the oldBody start; we need to reconstruct:
  // everything before the old body + heading line + new body + everything after old body.
  // heading line = '## <name>\n' (length = headingName.length + 4: '## ' + '\n')
  const headingLineLen = headingName.length + 4 // '## ' (3) + '\n' (1)
  const bodyStart = target.start + headingLineLen
  return content.slice(0, bodyStart) + newBody + content.slice(target.end)
}

export function applyReaderModelUpdates(currentContent, readerModelUpdates) {
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

// applyCorpusAppend: append new voice samples (deduped by quote) to ## Voice samples.
// If the section is absent, appends one before EOF.
export function applyCorpusAppend(currentContent, corpusAppend) {
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

// applyLedgerLines(currentContent, ledgerLines) -> newContent
//   ledgerLines: Array of pre-formatted bullet strings. Each line must already be
//   a formatted string (e.g. "- 2026-06-21 slug [sev/fault/scope] ... -> target").
//   Non-string items are rejected (callers must format before passing). Appends
//   lines not already present (dedup by exact string match); idempotent on re-apply.
//   Lines are appended verbatim, each as a bare text line (no bullet prefix added
//   here -- the caller supplies the bullet). If the content is empty, lines are
//   appended after a trailing newline.
export function applyLedgerLines(currentContent, ledgerLines) {
  if (!ledgerLines || ledgerLines.length === 0) return currentContent
  // Only string items accepted; non-strings are filtered out (callers must format).
  const serialized = ledgerLines
    .filter((l) => typeof l === 'string' && l !== undefined && l !== null)
  const existing = new Set(currentContent.split('\n'))
  const toAppend = serialized.filter((l) => !existing.has(l))
  if (toAppend.length === 0) return currentContent
  const tail = currentContent.endsWith('\n') ? '' : '\n'
  return currentContent + tail + toAppend.join('\n') + '\n'
}

// ROUTED_SCHEMA -- the judge's single routed output. The five keys are the workflow's
// return contract: memoryCandidates, docFaults (grouped by target file),
// readerModelUpdates, corpusAppend, ledgerLines.
export const ROUTED_SCHEMA = {
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
