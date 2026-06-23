// Test for the bounded importance + recency boost in queryHybrid's recall ranking.
//
// WHAT THIS ADDS (the contract):
//   queryHybrid folds two BOUNDED SECONDARY signals on top of the existing BM25 + cosine RRF
//   fusion: `importance` (integer 1-9, already a stored/indexed column) and `recency` (derived
//   from the `created_at` frontmatter timestamp). These break ties and give a modest nudge, but
//   relevance MUST still dominate -- a clearly-more-relevant entry can never be outranked by a
//   barely-relevant but high-importance / newer one.
//
// ANTI-TAUTOLOGY: expected orderings are FIXED from the requirement, never read back from the
//   code. The TIE-BREAK fixtures hold relevance ~equal (byte-identical description text -> equal
//   BM25 + equal cosine -> equal RRF) so the ONLY differentiator is importance (then created_at);
//   the requirement says higher-importance-first, then newer-first. The DOMINANCE fixture makes
//   one entry strongly match the query and the other barely match, with the boost stacked AGAINST
//   the relevant one (low importance + old) and FOR the irrelevant one (importance 9 + new); the
//   requirement says relevance still wins. We assert those orderings, not any score from the code.
//
// FIREWALL: builds a FIXTURE store in a tmpdir + a tmpdir db; never touches the live store/db.
//
// Run: node --test scripts/memory-index-rank.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { rebuild, queryHybrid } from './memory-index.mjs'

// frontmatter helper with explicit importance + created_at so each fixture pins both signals.
function fm(title, desc, { importance = 5, created_at = '2026-06-01T00:00:00Z' } = {}) {
  return `---
kind: pattern
status: active
title: ${title}
description: ${desc}
tags: []
importance: ${importance}
created_at: ${created_at}
updated_at: 2026-06-01T00:00:00Z
---
${desc}
`
}

function freshDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'memidxrank-db-')), 'index.db')
}

// =========================================================================================
// TIE-BREAK (a): relevance ~equal -> the HIGHER-importance entry ranks first.
// =========================================================================================
test('TIE-BREAK importance: two ~equally-relevant entries -> higher importance ranks first', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidxrank-store-'))
  // Byte-identical description text -> equal BM25 rank AND equal cosine score -> equal RRF.
  // The ONLY difference is importance. Requirement: higher importance breaks the tie -> first.
  // Filenames are chosen so the LOW-importance entry sorts alphabetically FIRST (aaa- vs zzz-):
  // without the boost the walk-order tie-break ranks aaa-low-imp first, so this is a true RED;
  // only an importance tie-break flips zzz-high-imp to the top.
  const desc = 'concurrency lock serialize writes idempotent retry pattern'
  writeFileSync(join(store, 'aaa-low-imp.md'), fm('low imp', desc, { importance: 2 }))
  writeFileSync(join(store, 'zzz-high-imp.md'), fm('high imp', desc, { importance: 9 }))

  const dbPath = freshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  const ids = queryHybrid(db, desc, { scope: 'global', k: 8 }).map(h => h.id)
  assert.ok(ids.includes('zzz-high-imp') && ids.includes('aaa-low-imp'), 'both tied entries must surface')
  assert.equal(ids[0], 'zzz-high-imp',
    'with relevance tied, the higher-importance entry must rank first (importance breaks the tie)')

  db.close()
  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// TIE-BREAK (b): relevance ~equal AND importance equal -> the MORE-RECENT entry ranks first.
// =========================================================================================
test('TIE-BREAK recency: relevance + importance tied -> more-recent created_at ranks first', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidxrank-store-'))
  const desc = 'atomic rename temp file durable write fsync directory pattern'
  // Equal description text AND equal importance -> the ONLY differentiator is created_at.
  // Requirement: newer created_at breaks the remaining tie -> first. Filenames are chosen so
  // the OLDER entry sorts alphabetically FIRST (aaa- vs zzz-): without a recency tie-break the
  // walk-order tie ranks aaa-older first, so this is a true RED; only recency flips zzz-newer up.
  writeFileSync(join(store, 'aaa-older.md'), fm('older', desc, { importance: 5, created_at: '2025-01-01T00:00:00Z' }))
  writeFileSync(join(store, 'zzz-newer.md'), fm('newer', desc, { importance: 5, created_at: '2026-06-01T00:00:00Z' }))

  const dbPath = freshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  const ids = queryHybrid(db, desc, { scope: 'global', k: 8 }).map(h => h.id)
  assert.ok(ids.includes('zzz-newer') && ids.includes('aaa-older'), 'both tied entries must surface')
  assert.equal(ids[0], 'zzz-newer',
    'with relevance + importance tied, the more-recent entry must rank first (recency breaks the tie)')

  db.close()
  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// DOMINANCE: a clearly-more-relevant entry (strong BM25 + cosine) with LOW importance + OLD
// date still OUTRANKS a barely-relevant entry with MAX importance + NEW date. Relevance wins.
// =========================================================================================
test('DOMINANCE: a clearly-more-relevant low-importance/old entry outranks a barely-relevant high-importance/new one', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memidxrank-store-'))
  const queryText = 'kafka consumer rebalance partition offset commit lag monitoring'

  // relevant: matches the query almost exactly -> top BM25 + top cosine. Stacked AGAINST it:
  // lowest importance, oldest date. If the boost were unbounded, this would lose; it must NOT.
  writeFileSync(join(store, 'relevant.md'),
    fm('relevant', 'kafka consumer rebalance partition offset commit lag monitoring',
      { importance: 1, created_at: '2020-01-01T00:00:00Z' }))
  // barely: shares exactly ONE weak token ("monitoring") and nothing else. Stacked FOR it:
  // max importance, newest date. A bounded boost must not let this overtake the relevant entry.
  writeFileSync(join(store, 'barely.md'),
    fm('barely', 'gardening tomatoes compost watering schedule monitoring',
      { importance: 9, created_at: '2026-06-18T00:00:00Z' }))

  const dbPath = freshDbPath()
  await rebuild({ storePath: store, dbPath, scope: 'global' })
  const db = new DatabaseSync(dbPath)

  const hits = queryHybrid(db, queryText, { scope: 'global', k: 8 })
  const ids = hits.map(h => h.id)
  assert.ok(ids.includes('relevant'), 'the relevant entry must surface')
  assert.equal(ids[0], 'relevant',
    'a clearly-more-relevant (low-importance/old) entry must still outrank a barely-relevant (high-importance/new) one')

  db.close()
  rmSync(store, { recursive: true, force: true })
})
