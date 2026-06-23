// memory-index.mjs -- the lean-system memory index (chunk B1).
//
// Builds a DERIVED, DISPOSABLE SQLite index from a store of frontmatter'd markdown files:
// `rm` the db + rebuild always fully reconstructs it from the files alone. Supports a ranked
// FTS5 keyword query (bm25) and a brute-force cosine top-K over a float32 embedding BLOB.
//
// PARAMETERIZABLE on BOTH the store path AND the db path so it can build/test against a small
// fixture store without touching the live ~/.claude memory store. Defaults point at the real
// locations; callers override for tests / scoped builds.
//
// CLI:  node scripts/memory-index.mjs rebuild [--scope X] [--store PATH] [--db PATH]
//
// Embedding (B1): a DETERMINISTIC LOCAL hashing-trick vectorizer (model `hash-tfidf-v1`,
// 256-dim float32). Deterministic = same content -> same vector -> reproducible `rm`+rebuild
// (a network embedding API would break determinism, speed, and the no-live-systems firewall).
// The model/dim columns record which embedder produced each vec, so B2/B4 can swap in a real
// embedder later with NO schema change.

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

// ---- defaults (real locations; overridable) ---------------------------------------------
const DEFAULT_STORE = join(homedir(), '.claude', 'projects', '-Users-admin--claude', 'memory')
const DEFAULT_DB = join(homedir(), '.claude', 'memory-index.db')

const EMBED_MODEL = 'hash-tfidf-v1'
const EMBED_DIM = 256

// ---- schema (one DB per scope; derived/disposable) --------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  scope         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  importance    INTEGER NOT NULL DEFAULT 5,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  body          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status ON entries(status);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, description, tags, body,
  content='entries', content_rowid='rowid', tokenize='porter unicode61'
);

-- content-table sync triggers: keep the FTS5 index in lockstep with the base table, or a
-- MATCH query silently returns zero rows.
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, description, tags, body)
  VALUES (new.rowid, new.title, new.description, new.tags, new.body);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, description, tags, body)
  VALUES ('delete', old.rowid, old.title, old.description, old.tags, old.body);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, description, tags, body)
  VALUES ('delete', old.rowid, old.title, old.description, old.tags, old.body);
  INSERT INTO entries_fts(rowid, title, description, tags, body)
  VALUES (new.rowid, new.title, new.description, new.tags, new.body);
END;

CREATE TABLE IF NOT EXISTS embeddings (
  id    TEXT PRIMARY KEY REFERENCES entries(id),
  model TEXT NOT NULL,
  dim   INTEGER NOT NULL,
  vec   BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS tally (
  id               TEXT PRIMARY KEY REFERENCES entries(id),
  recalls          INTEGER NOT NULL DEFAULT 0,
  last_recalled_at TEXT
);

-- meta: key-value store for per-scope store roots so query can emit absolute backing-file paths.
-- key = 'store_path:<scope>', value = absolute path to the store root used at rebuild time.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

// ---- frontmatter parsing ----------------------------------------------------------------
// Minimal YAML frontmatter reader: only the scalar/list fields the schema needs. Returns
// { meta, body }. Body is everything after the closing `---`.
function parseFrontmatter(raw) {
  const meta = {}
  // Fields read from a nested `metadata:` block. Kept separate so a flat top-level key (the
  // newer canonical form) always WINS: nested values are only applied where flat is absent.
  const nested = {}
  let body = raw
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (m) {
    body = m[2]
    const lines = m[1].split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // A top-level `metadata:` block (key at column 0, no inline value) -- descend one level
      // and read the indented children into `nested`. ~326 live store files nest tags/importance
      // under this block; a flat-only reader leaves them invisible to the index.
      if (/^metadata:\s*$/.test(line)) {
        i = parseNestedMetadata(lines, i + 1, nested)
        continue
      }
      const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/)
      if (!kv) continue
      const key = kv[1]
      let val = kv[2].trim()
      // JSON-style inline array (tags: ["a","b"]) -> keep as the JSON string the schema stores.
      if (val.startsWith('[') && val.endsWith(']')) {
        meta[key] = val
        continue
      }
      // strip surrounding quotes on scalars
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      meta[key] = val
    }
  }
  // Apply nested values only where a flat top-level key did not already set one (flat wins).
  for (const key of Object.keys(nested)) {
    if (!(key in meta)) meta[key] = nested[key]
  }
  return { meta, body }
}

// Read the indented children of a top-level `metadata:` block into `out`, starting at line
// index `start`. Handles scalar children (`  key: value`), an inline-JSON tags array
// (`  tags: ["a","b"]`), and a YAML block-list (`  tags:` followed by `    - value` lines).
// A block-list is converted to the SAME inline-JSON array string the schema stores for flat
// inline tags, so it matches how the FTS tags column expects them. Returns the index of the
// last line consumed (so the caller's loop advances past the block).
function parseNestedMetadata(lines, start, out) {
  let i = start
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    // A non-indented line ends the block; step back one so the caller reprocesses it.
    if (!/^\s/.test(line)) return i - 1
    const kv = line.match(/^\s+([a-zA-Z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    let val = kv[2].trim()
    if (val === '') {
      // No inline value -- look ahead for a YAML block-list (`    - item` lines).
      const items = []
      let j = i + 1
      const childMatch = /^\s+-\s+(.*)$/
      for (; j < lines.length; j++) {
        const lm = lines[j].match(childMatch)
        if (!lm) break
        let item = lm[1].trim()
        if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
          item = item.slice(1, -1)
        }
        items.push(item)
      }
      if (items.length > 0) {
        // Convert the block-list to the inline-JSON array string the schema/FTS column expects.
        out[key] = JSON.stringify(items)
        i = j - 1
      }
      continue
    }
    // Inline JSON array (tags: ["a","b"]) -> keep as the JSON string the schema stores.
    if (val.startsWith('[') && val.endsWith(']')) {
      out[key] = val
      continue
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return i - 1
}

// store-relative path sans .md, with OS separators normalized to '/', is the slug/id.
function slugFor(storePath, filePath) {
  return relative(storePath, filePath).replace(/\.md$/, '').split(sep).join('/')
}

// recursively collect *.md files under a dir
function walkMd(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkMd(p))
    else if (ent.isFile() && ent.name.endsWith('.md')) out.push(p)
  }
  return out
}

// ---- deterministic local embedding (hashing trick) --------------------------------------
function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || [])
}

// hash a token to a stable bucket in [0, EMBED_DIM) and a sign in {-1,+1}
function hashToken(tok) {
  const h = createHash('sha1').update(tok).digest()
  const bucket = ((h[0] << 16) | (h[1] << 8) | h[2]) % EMBED_DIM
  const sign = (h[3] & 1) ? 1 : -1
  return { bucket, sign }
}

// embed text -> L2-normalized Float32Array of length EMBED_DIM
function embed(text) {
  const v = new Float32Array(EMBED_DIM)
  for (const tok of tokenize(text)) {
    const { bucket, sign } = hashToken(tok)
    v[bucket] += sign
  }
  let norm = 0
  for (let i = 0; i < EMBED_DIM; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm
  return v
}

function float32ToBlob(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

function blobToFloat32(blob) {
  // blob is a Uint8Array/Buffer; reinterpret its bytes as float32
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

function cosine(a, b) {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  // a and b are L2-normalized, so dot IS cosine; clamp for float drift.
  if (dot > 1) dot = 1
  if (dot < -1) dot = -1
  return dot
}

// ---- rebuild ----------------------------------------------------------------------------
// Walk the store, parse frontmatter, hash, upsert changed rows (by id+content_hash), delete
// vanished rows, (re)build the embedding for each touched row. DB is fully derived from files.
export async function rebuild({ storePath = DEFAULT_STORE, dbPath = DEFAULT_DB, scope = 'global' } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)

  // Record the absolute store root in meta so query can emit absolute backing-file paths.
  // Resolved at rebuild time (the store root may be a relative path from the caller).
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    `store_path:${scope}`, resolve(storePath)
  )

  // existing id -> content_hash, to skip unchanged rows (content-hash-keyed idempotency).
  const existing = new Map()
  for (const r of db.prepare('SELECT id, content_hash FROM entries WHERE scope = ?').all(scope)) {
    existing.set(r.id, r.content_hash)
  }

  let files = []
  try { files = walkMd(storePath) } catch { files = [] }

  const seen = new Set()
  const upsert = db.prepare(`
    INSERT INTO entries (id, path, scope, kind, status, superseded_by, title, description,
                         tags, importance, created_at, updated_at, content_hash, body)
    VALUES (@id, @path, @scope, @kind, @status, @superseded_by, @title, @description,
            @tags, @importance, @created_at, @updated_at, @content_hash, @body)
    ON CONFLICT(id) DO UPDATE SET
      path=@path, scope=@scope, kind=@kind, status=@status, superseded_by=@superseded_by,
      title=@title, description=@description, tags=@tags, importance=@importance,
      created_at=@created_at, updated_at=@updated_at, content_hash=@content_hash, body=@body
  `)
  const upsertEmb = db.prepare(`
    INSERT INTO embeddings (id, model, dim, vec) VALUES (@id, @model, @dim, @vec)
    ON CONFLICT(id) DO UPDATE SET model=@model, dim=@dim, vec=@vec
  `)
  const ensureTally = db.prepare('INSERT OR IGNORE INTO tally (id, recalls) VALUES (?, 0)')

  for (const file of files) {
    const raw = readFileSync(file, 'utf8')
    const { meta, body } = parseFrontmatter(raw)
    const id = slugFor(storePath, file)
    seen.add(id)
    // Hash the WHOLE raw file (frontmatter + body), not the parsed body alone: a
    // frontmatter-ONLY change (e.g. status: active -> superseded with a byte-identical body)
    // MUST change content_hash so the incremental rebuild re-indexes it. A body-only hash
    // would skip the row and the index would keep the stale frontmatter.
    const content_hash = createHash('sha256').update(raw, 'utf8').digest('hex')
    if (existing.get(id) === content_hash) continue // unchanged: idempotent skip

    const row = {
      id,
      path: relative(storePath, file).split(sep).join('/'),
      scope,
      // accept `type` as an alias for `kind` (the real store uses `type:`); prefer an
      // explicit `kind`, fall back to `type`, then the default. Full frontmatter
      // normalization across the live store is chunk B2's job, not B1's.
      kind: meta.kind || meta.type || 'reference',
      status: meta.status || 'active',
      superseded_by: meta.superseded_by || null,
      title: meta.title || id,
      description: meta.description || '',
      tags: meta.tags || '[]',
      importance: meta.importance != null && meta.importance !== '' ? Number(meta.importance) : 5,
      created_at: meta.created_at || '',
      updated_at: meta.updated_at || '',
      content_hash,
      body,
    }
    upsert.run(row)

    // Embed the description -- the schema's "primary rank surface" -- so the semantic vector
    // is a stable function of the entry's canonical summary (and a description-text query
    // matches its own entry exactly).
    const f32 = embed(row.description)
    upsertEmb.run({ id, model: EMBED_MODEL, dim: EMBED_DIM, vec: float32ToBlob(f32) })
    ensureTally.run(id)
  }

  // delete vanished rows (files removed from the store) within this scope.
  const delEntry = db.prepare('DELETE FROM entries WHERE id = ?')
  const delEmb = db.prepare('DELETE FROM embeddings WHERE id = ?')
  const delTally = db.prepare('DELETE FROM tally WHERE id = ?')
  for (const id of existing.keys()) {
    if (!seen.has(id)) { delEmb.run(id); delTally.run(id); delEntry.run(id) }
  }

  db.close()
}

// Headroom added to SQL LIMIT so structural rows don't consume real-entry slots.
// The live store has ~14-21 structural rows (MEMORY.md, bucket INDEX.md files); 25 covers that
// plus a small buffer. After fetching, structural rows are filtered before the slice to `limit`.
const STRUCTURAL_HEADROOM = 25

// ---- query: FTS5 MATCH -> ranked active in-scope by bm25() ------------------------------
export function queryFts(db, keywords, { scope = 'global', limit = 20 } = {}) {
  // Fetch limit + headroom so structural rows can't consume real-entry slots. Then filter
  // structural before slicing to the requested limit.
  const rows = db.prepare(`
    SELECT e.id AS id, e.title AS title, e.description AS description,
           bm25(entries_fts) AS rank
    FROM entries_fts
    JOIN entries e ON e.rowid = entries_fts.rowid
    WHERE entries_fts MATCH ? AND e.status = 'active' AND e.scope = ?
    ORDER BY rank
    LIMIT ?
  `).all(keywords, scope, limit + STRUCTURAL_HEADROOM)
  return rows.filter(r => !isStructuralId(r.id)).slice(0, limit)
}

// ---- query: brute-force cosine top-K over the float32 BLOB column ------------------------
export function cosineTopK(db, queryText, k = 8, { scope = 'global' } = {}) {
  const q = embed(queryText)
  const rows = db.prepare(`
    SELECT em.id AS id, em.vec AS vec, e.title AS title, e.description AS description
    FROM embeddings em
    JOIN entries e ON e.id = em.id
    WHERE e.status = 'active' AND e.scope = ?
  `).all(scope)
  const scored = rows.map(r => ({
    id: r.id, title: r.title, description: r.description,
    score: cosine(q, blobToFloat32(r.vec)),
  }))
  scored.sort((a, b) => b.score - a.score)
  // Filter structural before slice so structural rows don't consume real-entry slots in the top-k.
  return scored.filter(r => !isStructuralId(r.id)).slice(0, k)
}

// ---- query: hybrid RRF fusion over bm25 + cosine (B4, the recall Pass-1 seam) ------------
// Reciprocal Rank Fusion: for each ranked list, score each id by 1/(RRF_K+rank) (rank 0-based),
// then sum an id's scores across the two lists. Robust to the two lists' incomparable score
// scales (bm25 is a negative-ish rank, cosine is [-1,1]). A both-axes-present id sums two terms
// and out-ranks a single-axis #1 (one term) -- fusion, not single-axis passthrough.
//
// scope = the given scope UNION 'global' (a workspace candidate can still collide with a global
// rule); a pure-global scope searches global only. status='active' only (queryFts/cosineTopK
// already enforce active). STRUCTURAL rows (the MEMORY.md MOC + per-bucket INDEX.md files) are
// filtered out by a PATH/SLUG predicate -- NOT by kind='reference', because the live store has
// genuine kind='reference' memories a blunt kind-drop would wrongly hide.
const RRF_K = 60

// ---- bounded secondary signals: importance + recency -------------------------------------
// On top of the RRF relevance core, apply a SMALL multiplicative boost so importance and recency
// break ties and give a modest nudge while semantic/keyword relevance still dominates. The boost
// is a FACTOR (1 + IMPORTANCE_WEIGHT*importanceNorm + RECENCY_WEIGHT*recencyNorm) multiplied into
// the RRF score.
//   importanceNorm = (importance-5)/4 in [-1,1] (5 is neutral; 9 -> +1, 1 -> -1).
//   recencyNorm    = exp(-ageDays/RECENCY_HALFLIFE_DAYS) in (0,1] (newer -> closer to 1).
//
// WHY THE WEIGHTS ARE THIS SMALL (the dominance bound): RRF is RANK-based, so a "clearly more
// relevant" entry is only ONE rank ahead, and one rank step is a small RELATIVE gap in the score.
// Across the top-20 fused range that one-rank relative gap is ~1.25-1.64% (smallest at rank
// 19->20). For relevance to ALWAYS dominate, the maximum boost swing between any two entries must
// stay below that smallest gap. Max swing = IMPORTANCE_WEIGHT*2 + RECENCY_WEIGHT*1 (importanceNorm
// spans [-1,1] -> diff 2; recencyNorm spans (0,1] -> diff <1). With both weights at 0.003 the max
// swing is 0.006 + 0.003 = 0.009 (0.9%), safely under the ~1.25% one-rank floor: a barely-relevant
// high-importance/new entry can NEVER overtake a one-rank-more-relevant one, yet any positive
// weight still strictly breaks an EXACT relevance tie.
const IMPORTANCE_WEIGHT = 0.003
const RECENCY_WEIGHT = 0.003
const RECENCY_HALFLIFE_DAYS = 365

function importanceNorm(importance) {
  const imp = Number(importance)
  if (!Number.isFinite(imp)) return 0 // missing/garbage importance -> neutral
  const clamped = Math.max(1, Math.min(9, imp))
  return (clamped - 5) / 4
}

// recency in (0,1]: a gentle exponential decay on age from created_at. A missing/unparseable
// created_at returns 0 (no recency nudge), never a crash or a spurious "infinitely old" penalty.
function recencyNorm(createdAt, now = Date.now()) {
  if (!createdAt) return 0
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) return 0
  const ageDays = Math.max(0, (now - t) / 86400000)
  return Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS)
}

// bounded boost FACTOR for an entry's RRF relevance score. Stays within roughly [0.997, 1.006].
function boostFactor(importance, createdAt, now = Date.now()) {
  return 1 + IMPORTANCE_WEIGHT * importanceNorm(importance) + RECENCY_WEIGHT * recencyNorm(createdAt, now)
}

// keyword extraction for the BM25 leg: alnum tokens >2 chars, deduped, OR-joined for FTS5 MATCH.
// >2 chars drops generic 1-2 char noise; FTS5 MATCH throws on an empty pattern so callers guard.
function keywordsFor(text) {
  const toks = [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 2))]
  return toks.join(' OR ')
}

// A row is STRUCTURAL (an autoload MOC / bucket index, not a real memory) iff its slug is the
// top-level MEMORY or ends in /INDEX or /index. Slug-form, verified against the live index --
// the rows carry no `.md` suffix in id/path, so a `%MEMORY.md`/`%INDEX.md` predicate matches none.
function isStructuralId(id) {
  return id === 'MEMORY' || /\/INDEX$/.test(id) || /\/index$/.test(id)
}

export function queryHybrid(db, queryText, { scope = 'global', globalScope = 'global', k = 8 } = {}) {
  const scopes = scope === globalScope ? [scope] : [scope, globalScope]
  const keywords = keywordsFor(queryText)
  // One timestamp for the whole call so the recency boost is consistent across all candidates.
  const now = Date.now()

  const ftsRows = []
  const cosRows = []
  for (const s of scopes) {
    if (keywords && keywords.trim()) {
      // queryFts MATCH throws on an empty/degenerate keyword string; guard it.
      try { ftsRows.push(...queryFts(db, keywords, { scope: s, limit: 20 })) } catch { /* no FTS match */ }
    }
    cosRows.push(...cosineTopK(db, queryText, 20, { scope: s }))
  }

  // best (lowest) bm25 rank per id, DENSE-ranked by score: entries with an EQUAL bm25 value share
  // the same rank index (and thus the same RRF term). Strict positional ranking would assign two
  // byte-identical-relevance entries adjacent ranks, manufacturing a one-rank gap that the bounded
  // secondary boost is designed NOT to cross -- so the importance/recency tie-break could never
  // fire. Dense ranking makes a genuine relevance tie a genuine RRF tie, which the boost then
  // orders. A clear one-rank relevance difference still produces distinct ranks (dominance intact).
  const ftsRank = new Map()
  ftsRows.sort((a, b) => a.rank - b.rank)
  let ftsDense = -1
  let ftsPrev = null
  for (const r of ftsRows) {
    if (ftsPrev === null || r.rank !== ftsPrev) { ftsDense++; ftsPrev = r.rank }
    if (!ftsRank.has(r.id)) ftsRank.set(r.id, ftsDense)
  }

  // best (lowest) cosine rank + best cosine score per id, DENSE-ranked by score (same rationale).
  const cosRank = new Map()
  const cosScore = new Map()
  cosRows.sort((a, b) => b.score - a.score)
  let cosDense = -1
  let cosPrev = null
  for (const r of cosRows) {
    if (cosPrev === null || r.score !== cosPrev) { cosDense++; cosPrev = r.score }
    if (!cosRank.has(r.id)) cosRank.set(r.id, cosDense)
    if (!cosScore.has(r.id) || r.score > cosScore.get(r.id)) cosScore.set(r.id, r.score)
  }

  // Read store roots from meta for each scope so we can emit absolute backing-file paths.
  // A missing meta row (old DB without the meta table, or a scope never rebuilt) returns null;
  // in that case path is omitted from the hit (body-load callers must check for the field).
  const storeRootForScope = new Map()
  for (const s of scopes) {
    try {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`store_path:${s}`)
      if (row) storeRootForScope.set(s, row.value)
    } catch { /* meta table absent in legacy DBs; path field will be absent */ }
  }

  // Build id -> { path, scope } lookup so we can resolve each fused hit's absolute path.
  // entryMeta also carries importance + created_at, the inputs to the bounded secondary boost.
  // This query runs whenever there are candidate ids (NOT gated on store roots), so the boost is
  // applied even when meta has no store_path row (path is still only attached when a root exists).
  const entryMeta = new Map()
  const allIds = new Set([...ftsRank.keys(), ...cosRank.keys()])
  if (allIds.size > 0) {
    const placeholders = [...allIds].map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT id, path, scope, importance, created_at FROM entries WHERE id IN (${placeholders})`
    ).all(...allIds)
    for (const r of rows) {
      entryMeta.set(r.id, { path: r.path, scope: r.scope, importance: r.importance, created_at: r.created_at })
    }
  }

  const fused = []
  for (const id of allIds) {
    if (isStructuralId(id)) continue // drop MEMORY.md MOC + bucket INDEX.md structural rows
    let rrf = 0
    if (ftsRank.has(id)) rrf += 1 / (RRF_K + ftsRank.get(id))
    if (cosRank.has(id)) rrf += 1 / (RRF_K + cosRank.get(id))
    const em = entryMeta.get(id)
    // Bounded secondary boost: relevance (rrf) is the core; importance + recency only break ties
    // and give a small nudge. score = rrf * boostFactor; the factor stays within ~[0.94, 1.05].
    const score = rrf * boostFactor(em ? em.importance : undefined, em ? em.created_at : undefined, now)
    const hit = {
      id,
      rrf,
      score,
      hasBm25: ftsRank.has(id),
      cosine: cosScore.has(id) ? cosScore.get(id) : -1,
    }
    // Attach absolute backing-file path when the store root is known for this entry's scope.
    if (em) {
      const storeRoot = storeRootForScope.get(em.scope)
      if (storeRoot) hit.path = join(storeRoot, em.path)
    }
    fused.push(hit)
  }
  // Rank by the boosted score (relevance-dominant, importance/recency as bounded tie-breakers).
  fused.sort((a, b) => b.score - a.score)
  return fused.slice(0, k)
}

// ---- CLI --------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--scope') args.scope = argv[++i]
    else if (a === '--store') args.store = argv[++i]
    else if (a === '--db') args.db = argv[++i]
    else if (a === '--k') args.k = argv[++i]
    else args._.push(a)
  }
  return args
}

// run only when invoked directly (not when imported by the test)
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  if (cmd === 'rebuild') {
    const t0 = Date.now()
    await rebuild({ storePath: args.store, dbPath: args.db, scope: args.scope || 'global' })
    const dbUsed = args.db || DEFAULT_DB
    console.log(`memory-index rebuild: done in ${Date.now() - t0}ms -> ${dbUsed}`)
  } else if (cmd === 'query') {
    // node memory-index.mjs query "<text>" [--scope S] [--db PATH] [--k N]  -> ranked JSON on stdout.
    // READ-ONLY: opens the db read-only, emits the fused hits, writes nothing.
    const queryText = args._[1]
    if (!queryText) {
      console.error('usage: memory-index query "<text>" [--scope X] [--db PATH] [--k N]')
      process.exit(2)
    }
    const dbPath = args.db || DEFAULT_DB
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const k = args.k != null ? Number(args.k) : 8
    const hits = queryHybrid(db, queryText, { scope: args.scope || 'global', k })
    db.close()
    console.log(JSON.stringify(hits, null, 2))
  } else {
    console.error('usage: memory-index <rebuild|query> ...')
    process.exit(2)
  }
}
