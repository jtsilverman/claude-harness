// Test for lean-system-rebuild chunk B1: the memory index + rebuild + query primitives.
//
// WHAT B1 BUILDS (the contract, from the chunk task + acceptance criteria):
//   A NEW script scripts/memory-index.mjs that:
//     - creates the derived/disposable SQLite schema (entries + idx_status, entries_fts
//       FTS5 content-table + sync triggers, embeddings float32-BLOB table, tally table);
//     - exports rebuild({ storePath, dbPath, scope }) -> walks a memory store of
//       frontmatter'd .md files, parses YAML frontmatter, computes a sha256 content_hash
//       per file, upserts changed rows (keyed by id=slug), deletes vanished rows, and
//       populates a deterministic float32 embedding per entry;
//     - exports queryFts(db, keywords, {scope}) -> FTS5 MATCH returning ranked ACTIVE
//       in-scope rows ordered by bm25();
//     - exports cosineTopK(db, queryText, k, {scope}) -> brute-force JS cosine over the
//       float32 BLOB column, top-K nearest ACTIVE in-scope entries;
//     - is PARAMETERIZABLE on BOTH the store path AND the db path (so this test runs against
//       a small FIXTURE store in a tmpdir and NEVER touches the live ~/.claude memory store).
//
// CRITICAL FIREWALL: the DB is DERIVED and DISPOSABLE -- `rm` the db + rebuild must fully
//   reconstruct an identical index from the files alone. The embedding is therefore a
//   DETERMINISTIC LOCAL function of file content (no network/API): same content -> same
//   float32 vector -> reproducible rebuild. (B2 may swap in a real embedder later; the
//   model/dim columns record which embedder produced the vec, so the schema is stable.)
//
// ANTI-TAUTOLOGY: every expected value is FIXED from the chunk task + acceptance criteria,
//   never read back from the code-to-be-written:
//     - content_hash idempotency is checked by reading the content_hash of a hand-written
//       fixture file BEFORE and AFTER a no-op rebuild and asserting EQUALITY against the
//       independently-computed sha256 of that file's bytes (a SEPARATE crypto call, not the
//       script's own hash function);
//     - FTS5 ranking is checked by a query whose CORRECT top result is determined by the
//       fixture content we control (the entry whose title+body actually contains the term),
//       not by running the code first and fitting the assertion to its output;
//     - cosine top-K is checked by querying with the EXACT text of one fixture entry and
//       asserting that same entry is the nearest neighbour (an identical vector has cosine
//       ~1.0 with itself -- a property true by the math, independent of the implementation);
//     - the firewall is checked by recording the live store path and asserting the script,
//       run against a tmpdir fixture + tmpdir db, leaves NO trace at the live path.
//
// Run: node --test scripts/memory-index.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { rebuild, queryFts, cosineTopK, queryHybrid } from './memory-index.mjs'

const SCRIPT = fileURLToPath(new URL('./memory-index.mjs', import.meta.url))

// --- fixture: a handful of frontmatter'd .md files in a tmpdir store ---------------------
function makeFixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'memidx-store-'))
  // An ACTIVE pattern entry that talks about sqlite/fts5 -- the bm25 target for "fts5".
  writeFileSync(join(dir, 'fts5-content-table-triggers.md'),
`---
kind: pattern
status: active
title: FTS5 content tables need sync triggers
description: An FTS5 external-content table returns nothing on MATCH unless insert/update/delete triggers keep it synced with the base table.
tags: ["sqlite", "fts5", "triggers"]
importance: 7
created_at: 2026-06-01T00:00:00Z
updated_at: 2026-06-01T00:00:00Z
---
When you create an FTS5 virtual table with content='entries' you must add the standard
sqlite content-table sync triggers or a MATCH query over fts5 will silently return zero rows.
`)
  // A second ACTIVE entry about embeddings/cosine -- distinct keyword surface.
  writeFileSync(join(dir, 'brute-force-cosine.md'),
`---
kind: pattern
status: active
title: Brute-force cosine at small scale
description: At one thousand entries a brute-force cosine over a float32 BLOB column beats a vector extension.
tags: ["embeddings", "cosine"]
importance: 6
created_at: 2026-06-02T00:00:00Z
updated_at: 2026-06-02T00:00:00Z
---
Brute force cosine similarity in plain javascript is plenty fast over a thousand float32 vectors.
`)
  // A SUPERSEDED entry -- must be EXCLUDED from active-only query results even though it
  // contains the strong keyword "fts5".
  writeFileSync(join(dir, 'old-fts5-note.md'),
`---
kind: pattern
status: superseded
superseded_by: fts5-content-table-triggers
title: Old fts5 note
description: Stale fts5 note kept for history, superseded.
tags: ["sqlite", "fts5"]
importance: 3
created_at: 2026-05-01T00:00:00Z
updated_at: 2026-05-15T00:00:00Z
---
This old fts5 note about sqlite fts5 is superseded and should not surface in active queries.
`)
  // An entry that omits importance/status/tags -- the parser must apply schema defaults
  // (status active, importance 5, tags []) rather than failing the insert.
  writeFileSync(join(dir, 'minimal-frontmatter.md'),
`---
kind: reference
title: Minimal frontmatter entry
description: An entry whose frontmatter omits importance, status, and tags.
created_at: 2026-06-03T00:00:00Z
updated_at: 2026-06-03T00:00:00Z
---
Body about indexes and rebuilds.
`)
  return dir
}

function freshDbPath() {
  const d = mkdtempSync(join(tmpdir(), 'memidx-db-'))
  return join(d, 'memory-index.db')
}

// =========================================================================================
test('B1 acceptance: rebuild + idempotency + FTS5 bm25 + cosine top-K, on a fixture store', async (t) => {
  const store = makeFixtureStore()
  const dbPath = freshDbPath()

  // -- AC1: rebuild from the fixture store, well under 1s -----------------------------------
  const t0 = Date.now()
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const elapsed = Date.now() - t0
  assert.ok(existsSync(dbPath), 'rebuild must create the db file')
  assert.ok(elapsed < 1000, `rebuild must be well under 1s, took ${elapsed}ms`)

  // Open the built DB read-only-ish to inspect rows.
  const db = new DatabaseSync(dbPath)

  // All four fixture files become entries; defaults applied to the minimal one.
  const countRow = db.prepare('SELECT COUNT(*) AS n FROM entries').get()
  assert.equal(countRow.n, 4, 'all four fixture files must be indexed as entries')
  const minimal = db.prepare("SELECT status, importance, tags FROM entries WHERE id = ?")
    .get('minimal-frontmatter')
  assert.equal(minimal.status, 'active', 'missing status defaults to active')
  assert.equal(minimal.importance, 5, 'missing importance defaults to 5')
  assert.equal(minimal.tags, '[]', 'missing tags defaults to empty JSON array')

  // -- AC2: content_hash is the independently-computed sha256 of the WHOLE file bytes -------
  // Independent (non-tautological) hash: read the ORIGINAL file's bytes straight from disk and
  // sha256 them here, then assert the STORED content_hash equals that. Hashing the on-disk
  // source (not the stored body) makes this a genuine cross-check, and it covers frontmatter +
  // body so a frontmatter-only change still re-indexes (finding 1).
  const ftsRow = db.prepare("SELECT content_hash FROM entries WHERE id = ?")
    .get('fts5-content-table-triggers')
  const originalBytes = readFileSync(join(store, 'fts5-content-table-triggers.md'), 'utf8')
  const independentHash = createHash('sha256').update(originalBytes, 'utf8').digest('hex')
  assert.equal(ftsRow.content_hash, independentHash,
    'content_hash must be sha256 of the whole file bytes (verifiable independently from disk)')

  // -- AC2 cont.: rm the db + rebuild reproduces an identical index -------------------------
  const hashesBefore = db.prepare('SELECT id, content_hash FROM entries ORDER BY id').all()
  db.close()
  rmSync(dbPath)
  assert.ok(!existsSync(dbPath), 'db removed before second rebuild')
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db2 = new DatabaseSync(dbPath)
  const hashesAfter = db2.prepare('SELECT id, content_hash FROM entries ORDER BY id').all()
  assert.deepEqual(hashesAfter, hashesBefore,
    'rm + rebuild must reproduce the SAME id->content_hash index from the files alone')

  // Idempotent re-upsert: a SECOND rebuild over the unchanged store leaves identical hashes
  // (no spurious row churn). Same id->content_hash set proves content_hash-keyed idempotency.
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const hashesThird = db2.prepare('SELECT id, content_hash FROM entries ORDER BY id').all()
  assert.deepEqual(hashesThird, hashesAfter, 'a no-op rebuild is idempotent (same hashes)')

  // -- AC2 cont.: a vanished file's row is deleted on rebuild -------------------------------
  rmSync(join(store, 'minimal-frontmatter.md'))
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const goneRow = db2.prepare("SELECT COUNT(*) AS n FROM entries WHERE id = ?")
    .get('minimal-frontmatter')
  assert.equal(goneRow.n, 0, 'a file removed from the store must be deleted from the index')

  // -- AC3: FTS5 MATCH returns ranked ACTIVE in-scope rows ordered by bm25() ----------------
  const ftsResults = queryFts(db2, 'fts5', { scope: 'global' })
  assert.ok(Array.isArray(ftsResults) && ftsResults.length >= 1, 'fts query returns rows')
  // The superseded "old-fts5-note" must NOT appear (active-only).
  const ids = ftsResults.map(r => r.id)
  assert.ok(!ids.includes('old-fts5-note'),
    'a superseded entry must be excluded from active FTS results')
  // The strongest "fts5" match (title + body both about fts5) ranks first.
  assert.equal(ftsResults[0].id, 'fts5-content-table-triggers',
    'the entry most about fts5 must rank first by bm25()')
  // Each result carries a bm25 rank and they are sorted ascending (more-negative = better).
  for (let i = 1; i < ftsResults.length; i++) {
    assert.ok(ftsResults[i].rank >= ftsResults[i - 1].rank,
      'fts results must be sorted by bm25() rank ascending (best first)')
  }

  // -- AC4: embeddings populated as float32 BLOB; cosine top-K returns nearest --------------
  const embRow = db2.prepare('SELECT model, dim, vec FROM embeddings WHERE id = ?')
    .get('brute-force-cosine')
  assert.ok(embRow, 'every active entry has an embedding row')
  assert.ok(embRow.dim > 0, 'embedding dim is positive')
  assert.ok(embRow.vec instanceof Uint8Array, 'vec stored as a binary BLOB')
  assert.equal(embRow.vec.byteLength, embRow.dim * 4, 'BLOB length = dim * 4 bytes (float32)')

  // Query cosine with the EXACT description text of the cosine entry: an identical input
  // vector has cosine ~1.0 with its own stored vector, so that entry must be the nearest
  // neighbour. This is a property of the math, independent of the implementation details.
  const cosTop = cosineTopK(
    db2,
    'At one thousand entries a brute-force cosine over a float32 BLOB column beats a vector extension.',
    2,
    { scope: 'global' }
  )
  assert.ok(Array.isArray(cosTop) && cosTop.length >= 1, 'cosine top-K returns rows')
  assert.equal(cosTop[0].id, 'brute-force-cosine',
    'the entry whose text we queried with must be its own nearest neighbour by cosine')
  assert.ok(cosTop[0].score > 0.99,
    'cosine of an entry against its own text is ~1.0')
  // A superseded entry must not surface in cosine results either.
  assert.ok(!cosTop.map(r => r.id).includes('old-fts5-note'),
    'cosine results are active-only')

  db2.close()
  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
test('B1 firewall: rebuild never reads or writes the live ~/.claude memory store', async () => {
  // Record a sentinel "live" store path that the script must NEVER touch when given
  // explicit fixture paths. We assert no db artifact appears at the live default location.
  const store = makeFixtureStore()
  const dbPath = freshDbPath()
  const liveDefaultDb = join(process.env.HOME || '/root', '.claude', 'memory-index.db')
  const liveExistedBefore = existsSync(liveDefaultDb)

  await rebuild({ storePath: store, dbPath, scope: 'global' })

  // The script wrote ONLY to the fixture db path.
  assert.ok(existsSync(dbPath), 'fixture db created')
  const liveExistsAfter = existsSync(liveDefaultDb)
  assert.equal(liveExistsAfter, liveExistedBefore,
    'rebuild against fixture paths must NOT create/modify the live default db')

  // The fixture store dir contains only the .md files we wrote -- no db/index artifact
  // leaked into the store dir itself.
  const storeFiles = readdirSync(store)
  assert.ok(storeFiles.every(f => f.endsWith('.md')),
    'rebuild must not write index artifacts into the store directory')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// Finding 2 (robustness): the parser must accept `type:` as an alias for `kind`. The real
// store uses `type:` (under metadata:) where this schema names the column `kind`; an entry
// carrying `type:` with no `kind:` must index with that value, not silently fall to the
// default. (Full live-store frontmatter normalization is chunk B2; this just stops B1
// dropping a kind that is already present.)
test('B1: a `type:` field (no `kind:`) indexes as the entry kind', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidx-type-'))
  const dbPath = freshDbPath()
  writeFileSync(join(store, 'type-aliased.md'),
`---
type: failure
status: active
title: Entry using type not kind
description: An entry whose frontmatter carries type instead of kind.
tags: ["alias"]
importance: 5
created_at: 2026-06-01T00:00:00Z
updated_at: 2026-06-01T00:00:00Z
---
Body about a type-aliased entry.
`)
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const db = new DatabaseSync(dbPath)
  const row = db.prepare("SELECT kind FROM entries WHERE id = ?").get('type-aliased')
  assert.equal(row.kind, 'failure',
    'a `type:` field (with no `kind:`) must populate the kind column, not fall to the default')
  db.close()

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// Finding 1 (P1 bug): content_hash must cover the WHOLE file, not just the body. A
// frontmatter-ONLY change (e.g. the memory-agent flipping status: active -> superseded,
// leaving the body byte-identical) must re-index the entry on an INCREMENTAL rebuild (db
// already exists -- NOT the rm+rebuild path). If content_hash hashes the body alone, the
// changed-row detector (existing.get(id) === content_hash) sees an unchanged hash and
// SKIPS the row, so the index keeps the stale status and supersession silently fails.
test('B1: a frontmatter-only change re-indexes on an incremental rebuild (db already exists)', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidx-fm-'))
  const dbPath = freshDbPath()
  const file = join(store, 'supersede-me.md')
  const BODY = 'This body is byte-identical before and after the frontmatter flip.\n'

  // Write the entry as ACTIVE and do the FIRST rebuild (creates the db, indexes status=active).
  writeFileSync(file,
`---
kind: pattern
status: active
title: Supersede me
description: An entry whose frontmatter status flips with no body change.
tags: ["supersede"]
importance: 5
created_at: 2026-06-01T00:00:00Z
updated_at: 2026-06-01T00:00:00Z
---
${BODY}`)
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const db = new DatabaseSync(dbPath)
  const before = db.prepare("SELECT status FROM entries WHERE id = ?").get('supersede-me')
  assert.equal(before.status, 'active', 'precondition: first rebuild indexed status=active')
  db.close()

  // Flip ONLY the frontmatter status (active -> superseded). The body is byte-identical, so
  // a body-only content_hash would NOT change and the incremental rebuild would skip the row.
  writeFileSync(file,
`---
kind: pattern
status: superseded
superseded_by: some-newer-entry
title: Supersede me
description: An entry whose frontmatter status flips with no body change.
tags: ["supersede"]
importance: 5
created_at: 2026-06-01T00:00:00Z
updated_at: 2026-06-01T00:00:00Z
---
${BODY}`)

  // INCREMENTAL rebuild over the EXISTING db (no rm) -- this is the path the bug breaks.
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const db2 = new DatabaseSync(dbPath)
  const after = db2.prepare("SELECT status, superseded_by FROM entries WHERE id = ?")
    .get('supersede-me')
  assert.equal(after.status, 'superseded',
    'a frontmatter-only status flip must re-index on an incremental rebuild')
  assert.equal(after.superseded_by, 'some-newer-entry',
    'the new superseded_by field must be present after the incremental rebuild')
  db2.close()

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// Nested-metadata: ~326 live store files nest their fields under a top-level `metadata:` block
// (name/description flat, but tags/importance/type under `metadata:`). The flat-only reader
// left those tags/importance INVISIBLE to the index, so the FTS5 tags column was empty and
// tag-based retrieval (e.g. "project:vega") missed them. parseFrontmatter must descend one
// level under `metadata:` and read tags (block-list OR inline-JSON form) + importance + any
// scalar, populating the SAME meta keys the flat path uses. A flat top-level key WINS over a
// nested one (top-level is the newer canonical form).
test('nested metadata: tags (block-list) and importance under `metadata:` populate the index', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidx-nested-'))
  const dbPath = freshDbPath()

  // Block-list tags + importance nested under `metadata:` -- the dominant live-store shape.
  writeFileSync(join(store, 'nested-blocklist.md'),
`---
name: nested blocklist entry
description: An entry whose tags and importance live nested under a metadata block.
metadata:
  type: feedback
  tags:
    - project:vega
    - topic:websocket
  importance: 3
---
Body about a nested block-list metadata entry.
`)

  // Inline-JSON tags nested under `metadata:` -- the other accepted nested form.
  writeFileSync(join(store, 'nested-inline.md'),
`---
name: nested inline entry
description: An entry whose nested tags are written as an inline JSON array.
metadata:
  type: pattern
  tags: ["project:atlas", "topic:cache"]
  importance: 8
---
Body about a nested inline metadata entry.
`)

  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  // Block-list form: tags converted to the SAME inline-JSON array string the schema stores.
  const bl = db.prepare('SELECT tags, importance FROM entries WHERE id = ?').get('nested-blocklist')
  assert.equal(bl.tags, '["project:vega","topic:websocket"]',
    'nested block-list tags must be stored as the inline-JSON array string the FTS column expects')
  assert.equal(bl.importance, 3, 'nested importance must populate as an integer like the flat path')

  // Inline-JSON nested form: tags kept as the JSON array string.
  const il = db.prepare('SELECT tags, importance FROM entries WHERE id = ?').get('nested-inline')
  assert.equal(il.tags, '["project:atlas", "topic:cache"]',
    'nested inline-JSON tags must be stored as the JSON array string')
  assert.equal(il.importance, 8, 'nested inline importance must populate as an integer')

  // FTS5 tags column is now searchable for a nested-only tag value. (The term is quoted
  // because the `:` in project:vega is otherwise read as an FTS5 column qualifier.)
  const ftsHits = queryFts(db, '"project:vega"', { scope: 'global' })
  assert.ok(ftsHits.map(r => r.id).includes('nested-blocklist'),
    'a nested-only tag value (project:vega) must be retrievable via the FTS tags column')

  db.close()
  rmSync(store, { recursive: true, force: true })
})

test('nested metadata: a flat top-level key WINS over a nested one', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidx-nested-win-'))
  const dbPath = freshDbPath()

  // Both flat AND nested importance/tags present: the flat top-level value must win.
  writeFileSync(join(store, 'flat-wins.md'),
`---
name: flat wins entry
description: An entry carrying both flat and nested importance/tags.
importance: 9
tags: ["flat:winner"]
metadata:
  importance: 1
  tags:
    - nested:loser
---
Body about flat-wins precedence.
`)

  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  const row = db.prepare('SELECT tags, importance FROM entries WHERE id = ?').get('flat-wins')
  assert.equal(row.importance, 9, 'a flat top-level importance must win over the nested one')
  assert.equal(row.tags, '["flat:winner"]', 'a flat top-level tags must win over the nested one')

  db.close()
  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// C9: queryHybrid emits absolute backing-file paths so worktree body-loads work.
//
// AC1+AC2: a hit carries an absolute `path` under the store root; reading it from a
//          simulated worktree cwd (a tmpdir with no patterns/ subdir) returns non-empty body.
// AC3: an orphaned id (backing file deleted after rebuild) still emits an absolute path, but
//      existsSync on that path returns false -- caller distinguishes via existence check.
// AC4: scope=workspace UNION global -- both hits carry absolute paths under THEIR OWN store root.
// AC5: the `query` CLI subcommand emits the absolute `path` field in stdout JSON.
//
// FIREWALL: all fixture stores and dbs are in tmpdir; the live store is never touched.
// =========================================================================================

function c9Fm(title, desc, { status = 'active', kind = 'pattern' } = {}) {
  return `---
kind: ${kind}
status: ${status}
title: ${title}
description: ${desc}
tags: []
importance: 5
created_at: 2026-06-01T00:00:00Z
updated_at: 2026-06-01T00:00:00Z
---
${desc}
`
}

function c9FreshDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'c9-db-')), 'index.db')
}

test('C9 AC1+AC2: queryHybrid hit carries absolute path; reading it from a simulated worktree cwd returns non-empty body', async () => {
  const store = mkdtempSync(join(tmpdir(), 'c9-abstest-store-'))
  const entryBody = 'The real pattern body content for worktree body-load test.'
  writeFileSync(join(store, 'mypattern.md'), c9Fm('my pattern', 'worktree bodyload absolute path test token') + '\n' + entryBody)
  const dbPath = c9FreshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  const hits = queryHybrid(db, 'worktree bodyload absolute path test token', { scope: 'global', k: 4 })
  db.close()

  assert.ok(hits.length >= 1, 'at least one hit must be returned')
  const hit = hits.find(h => h.id === 'mypattern')
  assert.ok(hit, 'mypattern must be in the results')
  assert.ok('path' in hit, 'each hit must include a `path` field (chunk 9 addition)')
  assert.ok(hit.path.startsWith('/'), `path must be absolute (start with '/'); got: ${hit.path}`)
  assert.ok(hit.path.startsWith(store), `path must be under the store root; got: ${hit.path}, store: ${store}`)

  const worktreeCwd = mkdtempSync(join(tmpdir(), 'c9-fake-worktree-'))
  const savedCwd = process.cwd()
  try {
    process.chdir(worktreeCwd)
    const body = readFileSync(hit.path, 'utf8')
    assert.ok(body.length > 0, 'reading the absolute path from a simulated worktree cwd must return non-empty body')
    assert.ok(body.includes(entryBody.slice(0, 20)),
      'the body read from the absolute path must contain the real file content')
  } finally {
    process.chdir(savedCwd)
  }

  rmSync(store, { recursive: true, force: true })
  rmSync(worktreeCwd, { recursive: true, force: true })
})

test('C9 AC3: orphaned id emits absolute path but existsSync returns false (caller can distinguish)', async () => {
  const store = mkdtempSync(join(tmpdir(), 'c9-orphan-store-'))
  const entryFile = join(store, 'ghost.md')
  writeFileSync(entryFile, c9Fm('ghost pattern', 'orphan backing file ghost unique token xqzorphan'))
  const dbPath = c9FreshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  rmSync(entryFile)

  const db = new DatabaseSync(dbPath)
  const hits = queryHybrid(db, 'orphan backing file ghost unique token xqzorphan', { scope: 'global', k: 4 })
  db.close()

  const hit = hits.find(h => h.id === 'ghost')
  assert.ok(hit, 'orphaned entry must still surface in the query results (it is still active in the DB)')
  assert.ok('path' in hit, 'orphaned hit must still carry a `path` field')
  assert.ok(hit.path.startsWith('/'), 'orphaned hit path must be absolute')
  assert.ok(!existsSync(hit.path), 'orphaned hit path must NOT exist on disk (caller uses existsSync to distinguish)')

  rmSync(store, { recursive: true, force: true })
})

test('C9 AC4: scope=workspace UNION global -- both hits carry absolute paths under their own store roots', async () => {
  const globalStore = mkdtempSync(join(tmpdir(), 'c9-union-gstore-'))
  const wsStore = mkdtempSync(join(tmpdir(), 'c9-union-wstore-'))
  writeFileSync(join(globalStore, 'global-abs.md'),
    c9Fm('global pattern', 'union scope absolute path test global xqzunion'))
  writeFileSync(join(wsStore, 'ws-abs.md'),
    c9Fm('workspace pattern', 'union scope absolute path test workspace xqzunion'))

  const dbPath = c9FreshDbPath()
  await rebuild({ storePath: globalStore, dbPath, scope: 'global' })
  await rebuild({ storePath: wsStore, dbPath, scope: 'workspace:proj' })
  const db = new DatabaseSync(dbPath)

  const hits = queryHybrid(db, 'union scope absolute path test xqzunion', { scope: 'workspace:proj', k: 8 })
  db.close()

  const globalHit = hits.find(h => h.id === 'global-abs')
  const wsHit = hits.find(h => h.id === 'ws-abs')
  assert.ok(globalHit, 'global hit must surface in workspace UNION global query')
  assert.ok(wsHit, 'workspace hit must surface in workspace UNION global query')

  assert.ok('path' in globalHit, 'global hit must carry a path field')
  assert.ok('path' in wsHit, 'workspace hit must carry a path field')
  assert.ok(globalHit.path.startsWith('/'), 'global hit path must be absolute')
  assert.ok(wsHit.path.startsWith('/'), 'workspace hit path must be absolute')

  assert.ok(globalHit.path.startsWith(globalStore),
    `global hit path must be under globalStore; got: ${globalHit.path}`)
  assert.ok(wsHit.path.startsWith(wsStore),
    `workspace hit path must be under wsStore; got: ${wsHit.path}`)

  const gBody = readFileSync(globalHit.path, 'utf8')
  const wBody = readFileSync(wsHit.path, 'utf8')
  assert.ok(gBody.length > 0, 'global hit path must be readable and non-empty')
  assert.ok(wBody.length > 0, 'workspace hit path must be readable and non-empty')

  rmSync(globalStore, { recursive: true, force: true })
  rmSync(wsStore, { recursive: true, force: true })
})

test('C9 AC5: `query` CLI output includes absolute `path` field per hit', async () => {
  const store = mkdtempSync(join(tmpdir(), 'c9-cli-path-store-'))
  writeFileSync(join(store, 'clip.md'), c9Fm('clip pattern', 'cli path emission test token xqzcli'))
  const dbPath = c9FreshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const out = execFileSync('node',
    [SCRIPT, 'query', 'cli path emission test token xqzcli', '--scope', 'global', '--db', dbPath],
    { encoding: 'utf8' })

  const parsed = JSON.parse(out)
  assert.ok(Array.isArray(parsed) && parsed.length >= 1, 'CLI must return at least one hit')
  const hit = parsed.find(h => h.id === 'clip')
  assert.ok(hit, 'the clip entry must be in the CLI output')
  assert.ok('path' in hit, 'CLI output hits must include a `path` field')
  assert.ok(hit.path.startsWith('/'), `CLI path must be absolute; got: ${hit.path}`)
  assert.ok(hit.path.startsWith(store), `CLI path must be under store root; got: ${hit.path}`)

  rmSync(store, { recursive: true, force: true })
})
