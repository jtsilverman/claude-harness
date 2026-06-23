// memory-agent.mjs -- the lean-system memory-agent EXECUTION (chunk B3b).
//
// ENACTS the reconcile playbook the standing prompt agents/memory-agent.md describes in words
// and annex 4A (specs/lean-system-design-fable-review.md Part 4 A) specifies. The memory-agent
// is the single, SERIALIZED, sole writer of the memory store. Per RAW lesson candidate this
// module runs the write path:
//
//   SEARCH    top-5 similar ACTIVE entries over scope UNION global, RRF-fused over the B1
//             memory-index primitives (queryFts BM25 + cosineTopK), status='active'.
//   THRESHOLD cheap pre-filter ONLY (never the decision): zero BM25 hits AND best cosine < 0.60
//             => write NEW and skip the LLM reconcile. The floor decides "worth asking the LLM",
//             not the disposition.
//   RECONCILE one structured LLM call behind a MOCKABLE/INJECTABLE seam (reconcileFn): the
//             candidate + each hit's body in, per-hit relations + ONE decision out
//             (NEW | MERGE_INTO:id | SUPERSEDE:id | EXTEND:id | DROP_DUP:id). In tests the seam
//             returns a canned decision; in production it shells to `claude -p --model sonnet`.
//   EXECUTE   NEW -> write file + reindex; EXTEND/MERGE_INTO -> rewrite target body IN PLACE
//             (sharpen, no new file), bump updated_at, reindex; SUPERSEDE -> write new entry +
//             flip OLD status:superseded + set superseded_by + reindex BOTH + NO dir move;
//             DROP_DUP -> ack only.
//   RETURN    a per-candidate disposition ack { disposition, entry_id }.
//
// SERIALIZATION: withDbLock takes an EXCLUSIVE lock on the .db so only one memory-agent batch
// writes at a time per scope. Node has no native flock(2) and macOS has no flock(1), so the
// lock is an exclusive LOCKFILE (fs.openSync(path,'wx') => atomic O_CREAT|O_EXCL) with a
// bounded busy-wait retry, released by unlinking in a finally.
//
// TIER S -- an unattended sole-writer that rewrites human-authored memory bodies and flips
// supersessions IN PLACE: months of interleaved writes are practically irreversible. So:
//   - the markdown FILE is the source of truth; it is written/rewritten BEFORE the (derived,
//     disposable) index is rebuilt -- a crash leaves a recoverable on-disk artifact, never a
//     "done" index over a lost file (persist-artifact-before-status-write pattern);
//   - every in-place BODY rewrite backs the target up to a `.bak-YYYYMMDD-HHMMSS` sibling
//     first (atomic-rewrite-must-backup-target-first pattern);
//   - untouched entries stay byte-unchanged: flips/bumps edit ONLY the affected frontmatter
//     lines, never re-serialize the whole file.
//
// FIREWALL: callers pass explicit storePath + dbPath; the memory-index defaults point at the
// LIVE store/db, so a missing path would corrupt the real store. Tests pass a fixture store.

import {
  readFileSync, writeFileSync, copyFileSync, mkdirSync, openSync, closeSync, unlinkSync, existsSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { rebuild, queryFts, cosineTopK } from './memory-index.mjs'
import { DatabaseSync } from 'node:sqlite'

// ===== frontmatter read + surgical edit ==================================================
// A small reader that returns { meta, body, fmRaw } where fmRaw is the EXACT frontmatter text
// (between the --- fences) so a surgical line edit can preserve every untouched field byte for
// byte. Re-serializing the whole frontmatter would risk dropping unknown fields and changing
// untouched bytes -- the playbook forbids that ("untouched entries stay byte-unchanged").
function readEntry(file) {
  const raw = readFileSync(file, 'utf8')
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: raw, fmRaw: null, raw }
  const fmRaw = m[1]
  const body = m[2]
  const meta = {}
  for (const line of fmRaw.split('\n')) {
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body, fmRaw, raw }
}

// Set or insert a single scalar frontmatter field, editing ONLY that field's line (or
// appending it if absent). Returns the new frontmatter text. Quotes the value only when it
// contains characters that would break a bare YAML scalar.
function setFrontmatterField(fmRaw, key, value) {
  const v = /[:#]|^\s|\s$/.test(String(value)) ? JSON.stringify(String(value)) : String(value)
  const lines = fmRaw.split('\n')
  const re = new RegExp(`^${key}:\\s*`)
  let found = false
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { lines[i] = `${key}: ${v}`; found = true; break }
  }
  if (!found) lines.push(`${key}: ${v}`)
  return lines.join('\n')
}

// Reassemble a markdown entry from a (possibly edited) frontmatter block + body.
function assemble(fmRaw, body) {
  return `---\n${fmRaw}\n---\n${body}`
}

// A collision-free backup suffix, e.g. .bak-20260612-100000.123Z-0, derived from `now` plus
// a process-local monotonic counter. The counter makes two writes at the same millisecond
// produce distinct names; the timestamp keeps them human-readable and sortable.
let _bakCounter = 0
function bakSuffix(nowIso) {
  const d = new Date(nowIso)
  const p = n => String(n).padStart(2, '0')
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0')
  const seq = _bakCounter++
  return `.bak-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.${ms}Z-${seq}`
}

// ===== entry file authoring ==============================================================
// Serialize a brand-new entry's frontmatter from the drafted field set, in the schema's key
// order. Only NEW files are fully serialized here; existing files are edited surgically.
function serializeNewEntry({ kind, status = 'active', superseded_by, title, description, tags = [], importance = 5, created_at, updated_at }, body) {
  const tagsJson = JSON.stringify(tags)
  const fmLines = [
    `kind: ${kind}`,
    `status: ${status}`,
  ]
  if (superseded_by) fmLines.push(`superseded_by: ${superseded_by}`)
  fmLines.push(
    `title: ${/[:#]/.test(title) ? JSON.stringify(title) : title}`,
    `description: ${/[:#]/.test(description) ? JSON.stringify(description) : description}`,
    `tags: ${tagsJson}`,
    `importance: ${importance}`,
    `created_at: ${created_at}`,
    `updated_at: ${updated_at}`,
  )
  const bodyText = body.endsWith('\n') ? body : body + '\n'
  return `---\n${fmLines.join('\n')}\n---\n${bodyText}`
}

// id -> absolute file path under the store (id is the store-relative slug; mirror B1).
// Guards against path traversal: throws if the resolved path escapes the store root.
function fileForId(storePath, id) {
  const file = join(storePath, ...id.split('/')) + '.md'
  const storeRoot = resolve(storePath)
  const resolved = resolve(file)
  if (!resolved.startsWith(storeRoot + '/') && resolved !== storeRoot) {
    throw new Error(`memory-agent: path traversal detected -- id "${id}" would escape the store root`)
  }
  return file
}

// Write an entry file, creating parent dirs. The FILE is the source of truth and is always
// written before the index rebuild.
function writeEntryFile(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

// ===== exclusive .db lock (flock without flock) ==========================================
// Acquire an exclusive lock for a .db by atomically creating a sibling lockfile (O_EXCL).
// `wx` => fail if it exists, so exactly one holder wins; a loser busy-waits (bounded) until
// the holder unlinks it in its finally. Async-aware: between attempts we yield to the event
// loop, so two concurrent in-process callers serialize correctly (not just cross-process).
export async function withDbLock(dbPath, fn, { timeoutMs = 10000, pollMs = 5 } = {}) {
  const lockPath = dbPath + '.lock'
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let fd
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx') // atomic O_CREAT|O_EXCL: throws EEXIST if held
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (Date.now() > deadline) throw new Error(`memory-agent: timed out acquiring lock on ${lockPath}`)
      await new Promise(r => setTimeout(r, pollMs))
    }
  }
  try {
    closeSync(fd)
    return await fn()
  } finally {
    try { unlinkSync(lockPath) } catch { /* already gone */ }
  }
}

// ===== SEARCH: RRF-fused top-K over BM25 + cosine, scope UNION global =====================
// Reciprocal Rank Fusion: for each result list, score each id by 1/(60+rank) (rank 0-based),
// then sum an id's scores across lists. Robust to the two lists' incomparable score scales
// (bm25 is a negative-ish rank, cosine is [-1,1]). Searches scope AND global (a workspace
// candidate can still collide with a global rule), de-dupes by id, returns the top `limit`
// each carrying its best cosine (for the threshold pre-filter) and whether it had a BM25 hit.
const RRF_K = 60
function searchSimilar(db, queryText, keywords, { scope = 'global', globalScope = 'global', limit = 5 } = {}) {
  const scopes = scope === globalScope ? [scope] : [scope, globalScope]

  const ftsRows = []
  const cosRows = []
  for (const s of scopes) {
    // queryFts MATCH throws on empty/degenerate keyword strings; guard it.
    if (keywords && keywords.trim()) {
      try { ftsRows.push(...queryFts(db, keywords, { scope: s, limit: 20 })) } catch { /* no FTS match */ }
    }
    cosRows.push(...cosineTopK(db, queryText, 20, { scope: s }))
  }

  // best-bm25-rank and best-cosine per id
  const ftsRank = new Map()
  ftsRows.sort((a, b) => a.rank - b.rank)
  ftsRows.forEach((r, i) => { if (!ftsRank.has(r.id)) ftsRank.set(r.id, i) })

  const cosRank = new Map()
  const cosScore = new Map()
  cosRows.sort((a, b) => b.score - a.score)
  cosRows.forEach((r, i) => {
    if (!cosRank.has(r.id)) cosRank.set(r.id, i)
    if (!cosScore.has(r.id) || r.score > cosScore.get(r.id)) cosScore.set(r.id, r.score)
  })

  const ids = new Set([...ftsRank.keys(), ...cosRank.keys()])
  const fused = []
  for (const id of ids) {
    let score = 0
    if (ftsRank.has(id)) score += 1 / (RRF_K + ftsRank.get(id))
    if (cosRank.has(id)) score += 1 / (RRF_K + cosRank.get(id))
    fused.push({
      id,
      rrf: score,
      hasBm25: ftsRank.has(id),
      cosine: cosScore.has(id) ? cosScore.get(id) : -1,
    })
  }
  fused.sort((a, b) => b.rrf - a.rrf)
  return {
    hits: fused.slice(0, limit),
    anyBm25: ftsRank.size > 0,
    bestCosine: fused.length ? Math.max(...fused.map(h => h.cosine)) : -1,
  }
}

// keyword extraction for the BM25 leg: alnum tokens, deduped, OR-joined for an FTS5 MATCH.
function keywordsFrom(text) {
  const toks = [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 2))]
  return toks.join(' OR ')
}

// Load an active entry's full body from the index, for the LLM reconcile call.
function hitBodies(db, hits) {
  return hits.map(h => {
    const row = db.prepare('SELECT id, title, description, body FROM entries WHERE id = ?').get(h.id)
    return { id: h.id, title: row?.title ?? '', description: row?.description ?? '', body: row?.body ?? '', cosine: h.cosine }
  })
}

const COSINE_FLOOR = 0.60

// ===== EXECUTE the decision ==============================================================
// Pure file authoring (the db is derived; reconcile reindexes from the files afterward). All
// writes assume the caller already holds the .db lock. File-before-reindex on every branch.
//
// storePath     = candidate's write-scope store (NEW entries go here).
// targetStorePath = store where the TARGET entry lives (may differ from storePath when a
//                   workspace candidate targets a global entry via MERGE_INTO / SUPERSEDE).
//                   Defaults to storePath when scope == globalScope (purely global run).
function executeDecision({ decision, storePath, targetStorePath, candidate, seamResult, now }) {
  const _targetStore = targetStorePath || storePath
  const verb = decision.split(':')[0]
  const targetId = decision.includes(':') ? decision.slice(decision.indexOf(':') + 1) : null

  if (verb === 'NEW') {
    const draft = candidate.draft || seamResult?.newEntry
    if (!draft || !draft.id) throw new Error('memory-agent NEW: no drafted entry (id/title/body) to write')
    const file = fileForId(storePath, draft.id)
    if (existsSync(file)) throw new Error(`memory-agent NEW: entry already exists at ${file} -- cannot overwrite with NEW; use EXTEND or MERGE_INTO to update an existing entry`)
    const content = serializeNewEntry(
      { ...draft, status: 'active', created_at: draft.created_at || now, updated_at: now },
      draft.body,
    )
    writeEntryFile(file, content)            // FILE first
    return { ack: { disposition: 'wrote_new', entry_id: draft.id } }
  }

  if (verb === 'EXTEND' || verb === 'MERGE_INTO') {
    // The target entry lives in _targetStore (may be globalStorePath for workspace candidates
    // whose hit was in the global scope -- scope-aware routing, finding 2).
    const file = fileForId(_targetStore, targetId)
    const entry = readEntry(file)
    if (entry.fmRaw == null) throw new Error(`memory-agent ${verb}: target ${targetId} has no frontmatter`)
    // Tier S: back up the human-authored body BEFORE the in-place rewrite.
    copyFileSync(file, file + bakSuffix(now))
    const newBody = seamResult?.mergedBody ?? seamResult?.body
    if (newBody == null) throw new Error(`memory-agent ${verb}: seam returned no merged body`)
    const bodyText = newBody.endsWith('\n') ? newBody : newBody + '\n'
    const fm = setFrontmatterField(entry.fmRaw, 'updated_at', now)
    writeEntryFile(file, assemble(fm, bodyText))   // FILE first
    return { ack: { disposition: `merged_into:${targetId}`, entry_id: targetId } }
  }

  if (verb === 'SUPERSEDE') {
    const ne = seamResult?.newEntry
    if (!ne || !ne.id) throw new Error('memory-agent SUPERSEDE: seam returned no replacement entry')
    // Validate the OLD target exists BEFORE writing anything (no partial writes).
    // Old entry may be in _targetStore (global) while the new entry goes to storePath (candidate scope).
    const oldFile = fileForId(_targetStore, targetId)
    if (!existsSync(oldFile)) throw new Error(`memory-agent SUPERSEDE: old target "${targetId}" does not exist at ${oldFile} -- cannot supersede a nonexistent entry`)
    // 1. write the NEW replacement entry (file first, into the candidate's store).
    const newFile = fileForId(storePath, ne.id)
    writeEntryFile(newFile, serializeNewEntry(
      { ...ne, status: 'active', created_at: ne.created_at || now, updated_at: now }, ne.body,
    ))
    // 2. flip the OLD entry IN PLACE: status -> superseded, superseded_by -> new id. Edit only
    //    those two frontmatter lines; NO directory move, NO file removal (provenance stays).
    const oldEntry = readEntry(oldFile)
    if (oldEntry.fmRaw == null) throw new Error(`memory-agent SUPERSEDE: old ${targetId} has no frontmatter`)
    let fm = setFrontmatterField(oldEntry.fmRaw, 'status', 'superseded')
    fm = setFrontmatterField(fm, 'superseded_by', ne.id)
    fm = setFrontmatterField(fm, 'updated_at', now)
    writeEntryFile(oldFile, assemble(fm, oldEntry.body))
    return { ack: { disposition: `superseded:${targetId}`, entry_id: ne.id } }
  }

  if (verb === 'DROP_DUP') {
    // Nothing was written, so there is nothing to reindex -- skip the rebuild.
    return { ack: { disposition: 'dropped_dup', entry_id: targetId }, reindex: false }
  }

  throw new Error(`memory-agent: unknown decision verb "${verb}"`)
}

// ===== production reconcile seam =========================================================
// The INJECTABLE seam that drives live reconcile calls: shells to `claude -p --model sonnet`
// with a JSON-formatted prompt containing the candidate + each hit's body, and parses the
// structured JSON response. Tests pass a canned stub instead; this export is the production
// implementation callers wire in when running outside a test harness.
//
// Expected JSON output shape from claude (the prompt instructs this):
//   { relations: [{ id, relation }], decision, mergedBody?, newEntry? }
// where decision is one of: NEW | MERGE_INTO:<id> | SUPERSEDE:<id> | EXTEND:<id> | DROP_DUP:<id>
export function productionReconcileFn(candidate, hitBodies) {
  const prompt = JSON.stringify({
    task: 'memory-reconcile',
    instructions: [
      'You are the memory-agent reconciler. Given a RAW lesson candidate and a list of similar active memory entries, decide how to reconcile the candidate with the existing store.',
      'For each hit, assess the relation: duplicate | same-rule-better-stated | extends | contradicts | unrelated.',
      'Then emit ONE decision: NEW | MERGE_INTO:<id> | SUPERSEDE:<id> | EXTEND:<id> | DROP_DUP:<id>.',
      'Rules: MERGE_INTO if candidate duplicates or improves an existing rule (rewrite that entry body); SUPERSEDE if candidate contradicts an existing rule (write a new entry, flip old status); EXTEND if candidate adds a genuinely new sub-rule; DROP_DUP if it is an exact duplicate; NEW if unrelated to all hits.',
      'For MERGE_INTO/EXTEND: include mergedBody (the sharpened body text for the target).',
      'For SUPERSEDE: include newEntry { id, kind, title, description, tags, importance, body }.',
      'Respond with ONLY a JSON object matching: { relations: [{id, relation}], decision, mergedBody?, newEntry? }',
    ].join('\n'),
    candidate,
    hits: hitBodies,
  })

  // Truly async: use spawn (not spawnSync) so the event loop is never blocked.
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', 'claude-sonnet-4-5', '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    proc.on('error', err => reject(new Error(`memory-agent productionReconcileFn: failed to spawn claude: ${err.message}`)))
    proc.on('close', code => {
      if (code !== 0) { reject(new Error(`memory-agent productionReconcileFn: claude exited ${code}: ${stderr}`)); return }
      let parsed
      try {
        // claude --output-format json wraps the response; extract the result field if present.
        const outer = JSON.parse(stdout)
        parsed = typeof outer.result === 'string' ? JSON.parse(outer.result) : outer
      } catch (e) {
        reject(new Error(`memory-agent productionReconcileFn: failed to parse claude output as JSON: ${e.message}\nOutput: ${stdout}`)); return
      }
      if (!parsed.decision) { reject(new Error(`memory-agent productionReconcileFn: claude response missing 'decision' field: ${JSON.stringify(parsed)}`)); return }
      resolve(parsed)
    })
    proc.stdin.end(prompt)
  })
}

// ===== reconcile: the per-candidate pipeline =============================================
// SEARCH -> THRESHOLD -> (RECONCILE) -> EXECUTE -> ack. Wraps EXECUTE (and the read-side
// search over the same db) in the exclusive .db lock so concurrent batches serialize.
//
// globalStorePath: when scope != globalScope, the path to the GLOBAL store. A MERGE_INTO or
//   SUPERSEDE targeting a global entry must write to globalStorePath, not storePath, so the
//   file is found and updated in the right location (scope-aware routing, finding 2).
//   Defaults to storePath when scope == globalScope (purely global run; one store).
export async function reconcile(candidate, { dbPath, storePath, scope = 'global', globalScope = 'global', globalStorePath, reconcileFn, now = new Date().toISOString() } = {}) {
  // When scope is already global there is only one store; no cross-scope routing needed.
  const _globalStorePath = globalStorePath || storePath
  return withDbLock(dbPath, async () => {
    const db = new DatabaseSync(dbPath)
    let result
    try {
      const queryText = candidate.draft?.description || candidate.raw_lesson || ''
      const keywords = keywordsFrom(queryText)
      const { hits, anyBm25, bestCosine } = searchSimilar(db, queryText, keywords, { scope, globalScope, limit: 5 })

      let decision, seamResult
      // THRESHOLD: zero BM25 hits AND best cosine below the floor => NEW, skip the LLM reconcile.
      if (!anyBm25 && bestCosine < COSINE_FLOOR) {
        decision = 'NEW'
        seamResult = null
      } else {
        seamResult = await reconcileFn(candidate, hitBodies(db, hits))
        decision = seamResult.decision
      }

      // Scope-aware store routing: for EXTEND/MERGE_INTO/SUPERSEDE, the target entry may live
      // in the global store even when the candidate is workspace-scoped. Look up the target's
      // scope in the DB to pick the right store root for reads/writes of the existing entry.
      let targetStorePath = storePath
      const verb = decision.split(':')[0]
      const targetId = decision.includes(':') ? decision.slice(decision.indexOf(':') + 1) : null
      if (targetId && (verb === 'EXTEND' || verb === 'MERGE_INTO' || verb === 'SUPERSEDE')) {
        const row = db.prepare('SELECT scope FROM entries WHERE id = ?').get(targetId)
        if (row && row.scope === globalScope && scope !== globalScope) {
          targetStorePath = _globalStorePath
        }
      }

      result = executeDecision({ decision, storePath, targetStorePath, candidate, seamResult, now })
    } finally {
      db.close()
    }

    // Reindex AFTER the file write (the file is the source of truth; the db is derived). rebuild
    // is content-hash idempotent and re-indexes every changed file, incl. a frontmatter-only flip.
    // When the target was in global, also rebuild the global scope so both scopes are current.
    if (result.reindex !== false) {
      await rebuild({ storePath, dbPath, scope })
      if (scope !== globalScope && _globalStorePath !== storePath) {
        await rebuild({ storePath: _globalStorePath, dbPath, scope: globalScope })
      }
    }
    return result.ack
  })
}

// ===== read-verify actions (the self-cleaning path) ======================================
// A recallVerify action names its target, so it skips DRAFT + SEARCH. `supersede` writes a
// corrected replacement and flips the old entry (reuse SUPERSEDE execute); `delete` flips the
// entry's status to archived (no file removal, provenance stays).
export async function runReadVerify(action, { dbPath, storePath, scope = 'global', now = new Date().toISOString() } = {}) {
  return withDbLock(dbPath, async () => {
    let ack
    if (action.action === 'supersede') {
      const res = executeDecision({
        decision: `SUPERSEDE:${action.entry_id}`, storePath,
        candidate: {}, seamResult: { newEntry: action.newEntry }, now,
      })
      ack = res.ack
    } else if (action.action === 'delete') {
      const file = fileForId(storePath, action.entry_id)
      const entry = readEntry(file)
      if (entry.fmRaw == null) throw new Error(`memory-agent delete: ${action.entry_id} has no frontmatter`)
      let fm = setFrontmatterField(entry.fmRaw, 'status', 'archived')
      fm = setFrontmatterField(fm, 'updated_at', now)
      writeEntryFile(file, assemble(fm, entry.body))
      ack = { disposition: `archived:${action.entry_id}`, entry_id: action.entry_id }
    } else {
      throw new Error(`memory-agent read-verify: unknown action "${action.action}"`)
    }
    await rebuild({ storePath, dbPath, scope })
    return ack
  })
}
