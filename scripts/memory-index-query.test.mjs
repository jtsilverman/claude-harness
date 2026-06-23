// Test for lean-system-rebuild chunk B4: the hybrid RRF query + query CLI on memory-index.mjs.
//
// WHAT B4 ADDS (the contract, from the chunk task + acceptance criteria):
//   - queryHybrid(db, queryText, {scope, k=8}) -> fuses queryFts (bm25 top ~20 active in-scope)
//     and cosineTopK (top ~20) via Reciprocal Rank Fusion (score = sum 1/(60+rank) across the
//     two ranked lists), returns the fused top ~k. status='active' only. scope = the given scope
//     UNION 'global' (union when in a workspace; global-only when scope IS global). STRUCTURAL
//     rows (the MEMORY.md MOC + the per-bucket INDEX.md files) are filtered OUT by a PATH/SLUG
//     predicate (id='MEMORY' OR id LIKE '%/INDEX' OR '%/index'), NOT by kind='reference' (there
//     are genuine kind='reference' memories a blunt kind-drop would wrongly hide).
//   - a `query` CLI subcommand: node memory-index.mjs query "<text>" --scope <s> [--db PATH]
//     emits ranked JSON (array of {id, ...}) to stdout. Read-only.
//
// ANTI-TAUTOLOGY: every expected value is FIXED from the chunk task + the RRF math, never read
//   back from the code-to-be-written. The fusion fixture is engineered (and was verified by an
//   independent prototype against queryFts/cosineTopK BEFORE this test) so that:
//     - `target` shares the FTS keyword AND the cosine-dominant token -> present on BOTH ranked
//       lists -> RRF score = 1/(60+ftsRank) + 1/(60+cosRank), the SUM of two terms;
//     - `bmdecoy` matches the FTS keyword strongly (FTS rank 0) but its embedding is swamped so
//       it falls OUT of the cosine top-K -> RRF score = a SINGLE term 1/(60+ftsRank);
//     - `cosdecoy` is cosine-present but contains NO >2-char query keyword -> ABSENT from the FTS
//       leg -> RRF score = a SINGLE term 1/(60+cosRank).
//   The provable property of RRF (independent of the implementation): a both-axes entry sums two
//   terms and MUST out-score a single-axis #1 that contributes one term. We assert that ordering,
//   not any score read from the code.
//
// FIREWALL: builds a FIXTURE store in a tmpdir + a tmpdir db; never touches the live store/db.
//
// Run: node --test scripts/memory-index-query.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { rebuild, queryHybrid, cosineTopK, queryFts } from './memory-index.mjs'

const SCRIPT = fileURLToPath(new URL('./memory-index.mjs', import.meta.url))

function fm(title, desc, { status = 'active', kind = 'pattern', superseded_by = '' } = {}) {
  return `---
kind: ${kind}
status: ${status}
${superseded_by ? `superseded_by: ${superseded_by}\n` : ''}title: ${title}
description: ${desc}
tags: []
importance: 5
created_at: 2026-06-01T00:00:00Z
updated_at: 2026-06-01T00:00:00Z
---
${desc}
`
}

function freshDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'memidxq-db-')), 'index.db')
}

// =========================================================================================
// AC1: queryHybrid fuses bm25 + cosine via RRF; a both-axes-mid entry beats a single-axis #1.
// =========================================================================================
test('B4 AC1: RRF fusion ranks a both-axes entry ABOVE a single-axis #1 (not single-axis passthrough)', async () => {
  // Fixture engineered against the embedder/bm25 math (verified by a standalone prototype):
  //   query keyword (FTS) = "alpha"; cosine query is "zz"-dominant so a row's cosine rank is
  //   driven by zz-weight, NOT by sharing "alpha".
  const store = mkdtempSync(join(tmpdir(), 'memidxq-store-'))
  const queryText = 'alpha zz zz zz zz zz zz zz zz'

  // target: has alpha (FTS) AND the zz-dominant signal (cosine) -> present on BOTH lists.
  writeFileSync(join(store, 'target.md'), fm('target', 'alpha zz zz zz zz zz zz zz zz'))
  // bmdecoy: alpha only -> FTS rank 0, but its alpha-only embedding is far from the zz-dominant
  //   query, so the zz-rich fillers below bury it OUT of the cosine top-K -> single-axis (FTS).
  writeFileSync(join(store, 'bmdecoy.md'), fm('bmdecoy', 'alpha alpha alpha'))
  // cosdecoy: zz only -> cosine-present, but "zz" is 2 chars so it is NOT an FTS keyword ->
  //   ABSENT from the FTS leg -> single-axis (cosine).
  writeFileSync(join(store, 'cosdecoy.md'), fm('cosdecoy', 'zz zz zz zz zz zz zz zz zz'))
  // 20 zz-rich fillers: high cosine (push bmdecoy out of cosine top-K), FTS-invisible (no >2char
  //   query keyword) so they do not crowd the FTS leg around the named decoys.
  for (let i = 0; i < 20; i++) writeFileSync(join(store, `f${i}.md`), fm(`f${i}`, 'zz zz zz zz zz zz zz'))

  const dbPath = freshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  const hits = queryHybrid(db, queryText, { scope: 'global', k: 8 })
  const ids = hits.map(h => h.id)
  const rrf = Object.fromEntries(hits.map(h => [h.id, h.rrf]))

  // target (sums two RRF terms) must out-rank BOTH single-axis decoys (each one term).
  assert.ok(ids.includes('target'), 'target must be in the fused results')
  assert.ok(ids.includes('bmdecoy'), 'the FTS-only decoy must still surface (single-axis)')
  assert.ok(ids.includes('cosdecoy'), 'the cosine-only decoy must still surface (single-axis)')
  assert.ok(rrf['target'] > rrf['bmdecoy'],
    `fusion must beat the FTS-#1 single-axis decoy (target ${rrf['target']} > bmdecoy ${rrf['bmdecoy']})`)
  assert.ok(rrf['target'] > rrf['cosdecoy'],
    `fusion must beat the cosine-#1 single-axis decoy (target ${rrf['target']} > cosdecoy ${rrf['cosdecoy']})`)
  assert.equal(ids[0], 'target', 'the both-axes entry fuses to the TOP, proving fusion not passthrough')

  db.close()
  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// AC1: a status='superseded' row is NEVER returned (active-only).
// =========================================================================================
test('B4 AC1: a superseded row is never returned by queryHybrid', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidxq-store-'))
  // An ACTIVE row and a SUPERSEDED row that BOTH strongly match the query keyword.
  writeFileSync(join(store, 'live.md'), fm('live note', 'sqlite fts5 ranking is active and current'))
  writeFileSync(join(store, 'old.md'),
    fm('old note', 'sqlite fts5 ranking superseded historical note',
      { status: 'superseded', superseded_by: 'live' }))

  const dbPath = freshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  const ids = queryHybrid(db, 'sqlite fts5 ranking', { scope: 'global', k: 8 }).map(h => h.id)
  assert.ok(ids.includes('live'), 'the active row must surface')
  assert.ok(!ids.includes('old'), 'the superseded row must NEVER surface, even on a strong keyword match')

  db.close()
  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// AC1: scope = workspace UNION global -- the union returns BOTH a global and a workspace row.
// =========================================================================================
test('B4 AC1: scope union returns both global and active-workspace rows', async () => {
  const globalStore = mkdtempSync(join(tmpdir(), 'memidxq-gstore-'))
  const wsStore = mkdtempSync(join(tmpdir(), 'memidxq-wstore-'))
  writeFileSync(join(globalStore, 'global-rule.md'), fm('global rule', 'concurrency lock serialize writes pattern'))
  writeFileSync(join(wsStore, 'ws-rule.md'), fm('workspace rule', 'concurrency lock serialize writes in this project'))

  // One shared db, two scopes (mirrors the memory-agent build pattern).
  const dbPath = freshDbPath()
  await rebuild({ storePath: globalStore, dbPath, scope: 'global' })
  await rebuild({ storePath: wsStore, dbPath, scope: 'workspace:proj' })
  const db = new DatabaseSync(dbPath)

  // Querying in a workspace scope unions with global.
  const idsUnion = queryHybrid(db, 'concurrency lock serialize writes', { scope: 'workspace:proj', k: 8 }).map(h => h.id)
  assert.ok(idsUnion.includes('global-rule'), 'union must include the GLOBAL row')
  assert.ok(idsUnion.includes('ws-rule'), 'union must include the active-WORKSPACE row')

  // Querying in global scope returns global-only (no workspace leak).
  const idsGlobal = queryHybrid(db, 'concurrency lock serialize writes', { scope: 'global', k: 8 }).map(h => h.id)
  assert.ok(idsGlobal.includes('global-rule'), 'global query returns the global row')
  assert.ok(!idsGlobal.includes('ws-rule'), 'a pure-global query must NOT return workspace rows')

  db.close()
  rmSync(globalStore, { recursive: true, force: true })
  rmSync(wsStore, { recursive: true, force: true })
})

// =========================================================================================
// AC4 STRUCTURAL-FILTER: MEMORY.md + per-bucket INDEX.md are filtered out by PATH/SLUG, while a
// GENUINE kind='reference' memory is KEPT (a blunt kind-drop would wrongly hide it).
// =========================================================================================
test('B4 AC4: structural rows (MEMORY, */INDEX) are filtered by slug; genuine kind=reference survives', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidxq-store-'))
  // Structural MOC + bucket INDEX (the permissive B1 walker indexes these as active rows).
  writeFileSync(join(store, 'MEMORY.md'), fm('Memory index', 'retrieval index moc bucket descriptions for recall'))
  // build a nested patterns/<bucket>/INDEX.md so its slug is "patterns/<bucket>/INDEX".
  const bucketDir = join(store, 'patterns', 'retrieval-bucket')
  mkdirSync(bucketDir, { recursive: true })
  writeFileSync(join(bucketDir, 'INDEX.md'),
    fm('Bucket index', 'retrieval index entry list for the retrieval bucket'))
  // a GENUINE kind='reference' memory (NOT structural) that ALSO matches the query.
  writeFileSync(join(store, 'reference_retrieval_pipeline.md'),
    fm('Retrieval pipeline reference', 'retrieval index pipeline reference notes', { kind: 'reference' }))
  // a normal pattern that matches too, so the query returns something either way.
  writeFileSync(join(store, 'real-pattern.md'), fm('real pattern', 'retrieval index ranking pattern'))

  const dbPath = freshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  const ids = queryHybrid(db, 'retrieval index', { scope: 'global', k: 8 }).map(h => h.id)
  assert.ok(!ids.includes('MEMORY'), 'the MEMORY.md MOC must be filtered out')
  assert.ok(!ids.includes('patterns/retrieval-bucket/INDEX'), 'a bucket INDEX.md must be filtered out')
  assert.ok(ids.includes('reference_retrieval_pipeline'),
    'a GENUINE kind=reference memory must be KEPT (the filter is by slug, not by kind)')
  assert.ok(ids.includes('real-pattern'), 'a normal pattern must surface')

  db.close()
  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// AC2: the `query` CLI subcommand emits ranked JSON to stdout (reachable from the skill).
// =========================================================================================
test('B4 AC2: `query` CLI emits ranked JSON array of hits from the index', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidxq-store-'))
  writeFileSync(join(store, 'a.md'), fm('alpha entry', 'alpha beta gamma retrieval ranking'))
  writeFileSync(join(store, 'b.md'), fm('delta entry', 'completely unrelated gardening tomatoes'))

  const dbPath = freshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const out = execFileSync('node',
    [SCRIPT, 'query', 'alpha beta gamma retrieval', '--scope', 'global', '--db', dbPath],
    { encoding: 'utf8' })

  // stdout must PARSE as JSON (don't claim JSON valid without parsing it) and be a ranked array.
  const parsed = JSON.parse(out)
  assert.ok(Array.isArray(parsed), 'CLI must emit a JSON array')
  assert.ok(parsed.length >= 1, 'CLI must return at least one hit for a matching query')
  assert.equal(parsed[0].id, 'a', 'the matching entry ranks first')
  assert.ok('rrf' in parsed[0], 'each hit carries its fused rrf score')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// FIREWALL: the query CLI is read-only -- it never creates the live db and never touches it.
// =========================================================================================
test('B4 firewall: a fixture-db query leaves no trace at the live ~/.claude/memory-index.db path', async () => {
  const liveDb = join(homedir(), '.claude', 'memory-index.db')
  const liveExistedBefore = existsSync(liveDb)

  const store = mkdtempSync(join(tmpdir(), 'memidxq-store-'))
  writeFileSync(join(store, 'x.md'), fm('x', 'firewall token unique zzzfirewall'))
  const dbPath = freshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  execFileSync('node', [SCRIPT, 'query', 'firewall token zzzfirewall', '--scope', 'global', '--db', dbPath],
    { encoding: 'utf8' })

  // The query against a tmpdir db must not have created the live db if it was absent.
  assert.equal(existsSync(liveDb), liveExistedBefore,
    'querying a fixture db must not create or alter the live db file presence')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// P2 BUG: structural rows must be filtered BEFORE the top-20 cutoff, not after.
// When structural rows (MEMORY.md, INDEX.md) appear in cosineTopK/queryFts results, they
// consume one of the k slots before the slice. A real entry that would have ranked at
// position k is excluded. Filtering after (at fusion) removes the structural from the
// output but the real entry's slot was already lost.
//
// Test: k=1, MEMORY.md is the best cosine match. Currently cosineTopK(k=1) returns the
// structural MEMORY entry. After the fix (filter before slice), the structural entry is
// excluded and the next-best real entry surfaces. Same for queryFts.
// =========================================================================================
test('P2 BUG: cosineTopK filters structural before slice so structural does not consume a slot', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidxq-structural-slot-'))
  // MEMORY.md: same content as query -> cosine = 1.0 (perfect match, rank 0).
  writeFileSync(join(store, 'MEMORY.md'),
    fm('Memory index', 'slot consume structural leak detect test unique token xqzq'))
  // Real entry: slightly different -> cosine < 1.0 but should be returned when structural filtered.
  writeFileSync(join(store, 'real-entry.md'),
    fm('real entry', 'slot consume structural leak detect test token xqzq real pattern'))

  const dbPath = freshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  // k=1: with the bug, cosineTopK returns [MEMORY] (structural, best cosine match).
  // After the fix, MEMORY is filtered before slice -> [real-entry] surfaces instead.
  const top1 = cosineTopK(db, 'slot consume structural leak detect test unique token xqzq', 1, { scope: 'global' })
  assert.equal(top1.length, 1, 'cosineTopK(k=1) must return 1 result')
  assert.notEqual(top1[0].id, 'MEMORY',
    'cosineTopK must NOT return the structural MEMORY entry (structural must be filtered BEFORE the k=1 slice)')
  assert.equal(top1[0].id, 'real-entry',
    'cosineTopK must return the real entry when structural is filtered before slice')

  db.close()
  rmSync(store, { recursive: true, force: true })
})

test('P2 BUG: queryFts filters structural before limit so structural does not consume a slot', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidxq-structural-fts-slot-'))
  // MEMORY.md gets the query keywords repeated (high TF -> best bm25 rank = rank 0 in raw SQL).
  // Verified empirically by raw SQL: 'fxzq slottest retrieval' x3 pushes MEMORY to bm25 rank 0
  // (rank -0.0000052 vs real-fts-entry's -0.0000044; lower=better in bm25).
  // With the bug, queryFts(limit=1) would return MEMORY (consuming the slot). After the fix,
  // structural is filtered before the slice -> real-fts-entry surfaces as the top non-structural result.
  writeFileSync(join(store, 'MEMORY.md'),
    fm('Memory index', 'fxzq slottest retrieval fxzq slottest retrieval fxzq slottest retrieval'))
  // Real entry: query keywords present once -> bm25 rank 1 (behind MEMORY in raw SQL),
  // but should become rank 0 after structural is filtered.
  writeFileSync(join(store, 'real-fts-entry.md'),
    fm('real fts entry', 'fxzq slottest retrieval pattern rule'))

  const dbPath = freshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  // limit=1: after the fix, structural is filtered before the slice.
  // real-fts-entry is the top non-structural bm25 result and must surface.
  const ftsHits = queryFts(db, 'slottest fxzq retrieval', { scope: 'global', limit: 1 })
  assert.equal(ftsHits.length, 1, 'queryFts(limit=1) must return 1 result')
  assert.notEqual(ftsHits[0].id, 'MEMORY',
    'queryFts must NOT return the structural MEMORY entry (structural is filtered before the limit slice)')
  assert.equal(ftsHits[0].id, 'real-fts-entry',
    'queryFts must return the real entry when structural is filtered before the limit cutoff')

  db.close()
  rmSync(store, { recursive: true, force: true })
})
