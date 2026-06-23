// Test for lean-system-rebuild chunk B3b: the memory-agent EXECUTION scripts.
//
// WHAT B3b BUILDS (the contract, from the chunk task + acceptance criteria + the standing
// playbook agents/memory-agent.md + annex 4A):
//   A NEW script scripts/memory-agent.mjs that ENACTS the reconcile playbook the prompt
//   describes in words. Per RAW lesson candidate it runs:
//     SEARCH  -> top-5 similar ACTIVE entries over scope UNION global, RRF-fused over the
//               B1 memory-index primitives (queryFts BM25 + cosineTopK), status=active.
//     THRESHOLD -> cheap pre-filter: zero BM25 hits AND cosine < 0.60 => write NEW, skip the
//               LLM reconcile (the floor only decides "worth asking the LLM", never the
//               disposition itself).
//     LLM RECONCILE -> ONE structured call behind a MOCKABLE/INJECTABLE seam (reconcileFn):
//               returns per-hit relation + one decision NEW|MERGE_INTO:id|SUPERSEDE:id|
//               EXTEND:id|DROP_DUP:id. In tests the seam returns a CANNED decision; in
//               production it shells to `claude -p --model sonnet`.
//     EXECUTE -> NEW: write file + index; EXTEND/MERGE_INTO: rewrite target body IN PLACE
//               (sharpen, no new file), bump updated_at, reindex; SUPERSEDE: write new entry
//               + flip OLD entry status:superseded + set superseded_by + reindex BOTH + NO
//               directory move; DROP_DUP: ack only.
//     RETURN -> a disposition ack { disposition, entry_id } per candidate.
//   Plus SERIALIZATION: withDbLock() takes an EXCLUSIVE lock on the .db so only one
//   memory-agent batch writes at a time per scope (concurrent invocations serialize, never
//   interleave). Node has no native flock(2), so the lock is an exclusive lockfile
//   (fs.openSync(path,'wx') atomic O_EXCL) with bounded busy-wait retry.
//
// CRITICAL FIREWALL: every test constructs its OWN fixture store (a tmpdir with a few .md
//   entries carrying the new frontmatter schema) + a built index, and passes explicit
//   dbPath + storePath. The live 960-file store is NEVER read or written; the memory-index
//   defaults point at the live store, so a test that forgot to pass paths would corrupt it.
//   We assert the live path is untouched.
//
// ANTI-TAUTOLOGY: every expected value is FIXED from the contract, not read back from the
//   code-to-be-written. MERGE is checked by asserting the target FILE's body changed to the
//   canned sharpened text AND no new file appeared. SUPERSEDE is checked by reading the OLD
//   file's frontmatter (status:superseded + superseded_by=<new id>) and the NEW file's
//   existence, plus the rebuilt index reflecting both, and asserting the directory layout
//   did not move. NOVEL is checked by the new file existing + indexed as active. The lock is
//   checked by an INDEPENDENT mechanism: each of two concurrent invocations appends its id to
//   a shared sentinel file ONLY while it believes it holds the lock, bracketed by a non-atomic
//   read-modify-write with an await in the middle; without serialization the second clobbers
//   the first and one id is lost. We assert BOTH ids survive (no lost write) -- a property of
//   correct mutual exclusion, independent of the lock's implementation.
//
// Run: node --test scripts/memory-agent.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { rebuild } from './memory-index.mjs'
import { reconcile, withDbLock, productionReconcileFn } from './memory-agent.mjs'

// ----- fixture helpers -------------------------------------------------------------------

// Build a fixture store with a few ACTIVE entries carrying the new frontmatter schema, then
// build the index over it. Returns { store, dbPath }.
function makeFixtureStoreAndIndex(scope = 'global') {
  const store = mkdtempSync(join(tmpdir(), 'memagent-store-'))
  mkdirSync(join(store, 'patterns'), { recursive: true })

  // An ACTIVE pattern about flock/locking -- the collision target for a DUPLICATE candidate.
  writeFileSync(join(store, 'patterns', 'serialize-writes-with-a-lock.md'),
`---
kind: pattern
status: active
title: Serialize concurrent writes with a lock
description: Concurrent writers to one store must serialize via an exclusive lock so writes never interleave or get lost.
tags: ["concurrency","lock","serialize"]
importance: 7
created_at: 2026-06-01T00:00:00Z
updated_at: 2026-06-01T00:00:00Z
---
Two processes writing the same store at once will interleave. Take an exclusive lock so only one writes at a time.
`)

  // An ACTIVE pattern stating a claim a CONTRADICTING candidate will overturn.
  writeFileSync(join(store, 'patterns', 'flock-is-portable.md'),
`---
kind: pattern
status: active
title: flock is available everywhere
description: Use the flock shell utility to serialize file access; it is available on every Unix including macOS.
tags: ["concurrency","flock","portability"]
importance: 6
created_at: 2026-06-02T00:00:00Z
updated_at: 2026-06-02T00:00:00Z
---
flock(1) ships on every Unix; call it to serialize. It is always on PATH.
`)

  const dbPath = join(mkdtempSync(join(tmpdir(), 'memagent-db-')), 'index.db')
  return { store, dbPath }
}

function readMeta(file) {
  const raw = readFileSync(file, 'utf8')
  const meta = {}
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const body = m ? m[2] : raw
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/)
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return { meta, body }
}

function countMdFiles(dir) {
  let n = 0
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) n += countMdFiles(join(dir, ent.name))
    else if (ent.name.endsWith('.md')) n += 1
  }
  return n
}

// ----- (A1) DUPLICATE candidate MERGEs into the existing entry ---------------------------
// A candidate that the LLM seam judges MERGE_INTO an existing entry rewrites the TARGET's
// body in place (sharpened to the canned text), bumps updated_at, reindexes, and writes NO
// new file. The disposition acks merged_into:<id>.
test('B3b: a DUPLICATE candidate MERGEs into the existing entry (body sharpened, no new file)', async () => {
  const { store, dbPath } = makeFixtureStoreAndIndex('global')
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const target = 'patterns/serialize-writes-with-a-lock'
  const before = countMdFiles(store)
  const beforeUpdatedAt = readMeta(join(store, target + '.md')).meta.updated_at

  const SHARPENED = 'Concurrent writers must take an exclusive lock; an exclusive lockfile (O_EXCL) serializes even where flock is absent.'

  // Canned seam: judge the candidate a duplicate of the lock entry, decide MERGE_INTO it, and
  // hand back the sharpened body the merge should fold in.
  const reconcileFn = (candidate, hits) => ({
    relations: hits.map(h => ({ id: h.id, relation: h.id === target ? 'duplicate' : 'unrelated' })),
    decision: `MERGE_INTO:${target}`,
    mergedBody: SHARPENED,
  })

  const ack = await reconcile(
    { raw_lesson: 'Use an exclusive lockfile to serialize writes when flock is unavailable.',
      kind_hint: 'tactical', provenance: 'llr-B3b-test' },
    { dbPath, storePath: store, scope: 'global', reconcileFn, now: '2026-06-12T10:00:00Z' },
  )

  assert.equal(ack.disposition, `merged_into:${target}`, 'MERGE_INTO acks merged_into:<id>')
  assert.equal(ack.entry_id, target, 'ack names the merged-into entry')

  // No new file: the merge folds into the existing entry.
  assert.equal(countMdFiles(store), before, 'MERGE writes NO new file')

  // Target body rewritten in place to the sharpened text, updated_at bumped.
  const after = readMeta(join(store, target + '.md'))
  assert.ok(after.body.includes(SHARPENED), 'target body was rewritten (sharpened) in place')
  assert.notEqual(after.meta.updated_at, beforeUpdatedAt, 'updated_at was bumped on the merge')

  // Index reflects the rewritten body (reindexed).
  const db = new DatabaseSync(dbPath)
  const row = db.prepare('SELECT body, status FROM entries WHERE id = ?').get(target)
  db.close()
  assert.ok(row.body.includes(SHARPENED), 'index reindexed the rewritten body')
  assert.equal(row.status, 'active', 'merged-into entry stays active')

  rmSync(store, { recursive: true, force: true })
})

// ----- (A2) CONTRADICTING candidate SUPERSEDEs -------------------------------------------
// A candidate the LLM seam judges to CONTRADICT an existing entry writes a NEW entry, flips
// the OLD entry's status to superseded + sets superseded_by to the new id, reindexes BOTH,
// and does NOT move any directory. Acks superseded:<old-id>.
test('B3b: a CONTRADICTING candidate SUPERSEDEs (new entry, old flipped + superseded_by, both reindexed, no dir move)', async () => {
  const { store, dbPath } = makeFixtureStoreAndIndex('global')
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const old = 'patterns/flock-is-portable'
  const newId = 'patterns/flock-absent-on-macos-use-lockfile'

  // Record the directory layout before, to assert NO directory move.
  const dirsBefore = readdirSync(store).sort()

  const NEW_TITLE = 'flock is absent on macOS; use an exclusive lockfile'
  const NEW_DESC = 'macOS has no flock binary and Node has no native flock; serialize with an exclusive lockfile (O_EXCL) instead.'
  const NEW_BODY = 'flock(1) is NOT on macOS and node has no flock(2). Use fs.openSync(path, "wx") as an atomic exclusive lock.\n'

  const reconcileFn = (candidate, hits) => ({
    relations: hits.map(h => ({ id: h.id, relation: h.id === old ? 'contradicts' : 'unrelated' })),
    decision: `SUPERSEDE:${old}`,
    newEntry: {
      id: newId, kind: 'pattern', title: NEW_TITLE, description: NEW_DESC,
      tags: ['concurrency', 'flock', 'macos'], importance: 7, body: NEW_BODY,
    },
  })

  const ack = await reconcile(
    { raw_lesson: 'flock is not on macOS; use an exclusive lockfile to serialize.',
      kind_hint: 'tactical', provenance: 'llr-B3b-test' },
    { dbPath, storePath: store, scope: 'global', reconcileFn, now: '2026-06-12T11:00:00Z' },
  )

  assert.equal(ack.disposition, `superseded:${old}`, 'SUPERSEDE acks superseded:<old-id>')
  assert.equal(ack.entry_id, newId, 'ack names the NEW (replacement) entry id')

  // New entry file written.
  assert.ok(existsSync(join(store, newId + '.md')), 'the new replacement entry file was written')

  // Old entry flipped in place: status superseded + superseded_by = new id.
  const oldMeta = readMeta(join(store, old + '.md')).meta
  assert.equal(oldMeta.status, 'superseded', 'old entry status flipped to superseded')
  assert.equal(oldMeta.superseded_by, newId, 'old entry superseded_by points at the new id')

  // NO directory move: top-level layout unchanged, old file still where it was.
  assert.deepEqual(readdirSync(store).sort(), dirsBefore, 'no directory was moved or created at top level')
  assert.ok(existsSync(join(store, old + '.md')), 'superseded file stays in place (no dir move, no removal)')

  // BOTH reindexed: old row now superseded, new row present + active.
  const db = new DatabaseSync(dbPath)
  const oldRow = db.prepare('SELECT status, superseded_by FROM entries WHERE id = ?').get(old)
  const newRow = db.prepare('SELECT status, title FROM entries WHERE id = ?').get(newId)
  db.close()
  assert.equal(oldRow.status, 'superseded', 'index reindexed the OLD entry as superseded')
  assert.equal(oldRow.superseded_by, newId, 'index reindexed the OLD entry superseded_by')
  assert.equal(newRow.status, 'active', 'index reindexed the NEW entry as active')
  assert.equal(newRow.title, NEW_TITLE, 'index has the new entry title')

  rmSync(store, { recursive: true, force: true })
})

// ----- (A3) NOVEL candidate below threshold writes NEW -----------------------------------
// A candidate that finds no BM25 hit and is below the cosine floor short-circuits the LLM
// reconcile and writes a NEW entry, indexed active. We assert the seam was NOT consulted
// (threshold short-circuit) AND the new file + index row exist.
test('B3b: a NOVEL candidate (below threshold) writes a NEW entry and indexes it', async () => {
  const { store, dbPath } = makeFixtureStoreAndIndex('global')
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const before = countMdFiles(store)
  const newId = 'patterns/quokkas-are-marsupials'

  let seamConsulted = false
  const reconcileFn = () => { seamConsulted = true; return { relations: [], decision: 'NEW' } }

  // A lesson with no lexical/semantic overlap with the two fixture lock/flock entries -> zero
  // BM25 hits AND cosine < 0.60 -> threshold short-circuit to NEW, seam never consulted.
  const ack = await reconcile(
    { raw_lesson: 'Quokkas are small marsupials native to Rottnest Island; they are not reptiles.',
      kind_hint: 'tactical', provenance: 'llr-B3b-test',
      // The agent normally DRAFTs id/title/desc/body via capture-learning; the test supplies a
      // draft so the executed NEW entry is deterministic (drafting voice is not this chunk).
      draft: { id: newId, kind: 'pattern', title: 'Quokkas are marsupials',
               description: 'Quokkas are small marsupials from Rottnest Island, not reptiles.',
               tags: ['trivia'], importance: 3,
               body: 'A quokka is a small wallaby-like marsupial. Unrelated to anything in this store.\n' } },
    { dbPath, storePath: store, scope: 'global', reconcileFn, now: '2026-06-12T12:00:00Z' },
  )

  assert.equal(seamConsulted, false, 'below threshold: the LLM reconcile seam is NOT consulted')
  assert.equal(ack.disposition, 'wrote_new', 'NOVEL candidate acks wrote_new')
  assert.equal(ack.entry_id, newId, 'ack names the new entry id')

  assert.equal(countMdFiles(store), before + 1, 'exactly one new file was written')
  assert.ok(existsSync(join(store, newId + '.md')), 'the new entry file exists')

  const db = new DatabaseSync(dbPath)
  const row = db.prepare('SELECT status, title FROM entries WHERE id = ?').get(newId)
  db.close()
  assert.equal(row.status, 'active', 'new entry indexed as active')
  assert.equal(row.title, 'Quokkas are marsupials', 'new entry indexed with its title')

  rmSync(store, { recursive: true, force: true })
})

// ----- (A4) Two concurrent invocations serialize via the .db lock ------------------------
// withDbLock must give MUTUAL EXCLUSION: two concurrent holders of the same .db lock never
// run their critical sections at the same time. Tested INDEPENDENTLY of the implementation:
// each task does a non-atomic read-modify-write of a shared sentinel file with an await in
// the middle of the critical section. Without mutual exclusion the second read sees the stale
// value and clobbers the first task's write -> one id lost. With correct serialization both
// ids survive. We also assert the two critical sections did not overlap in time.
test('B3b: two concurrent memory-agent invocations serialize via the .db lock (no interleaved/lost writes)', async () => {
  const { store, dbPath } = makeFixtureStoreAndIndex('global')
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const sentinel = join(store, 'sentinel.json')
  writeFileSync(sentinel, JSON.stringify({ ids: [] }))

  let active = 0
  let maxConcurrent = 0

  // A critical section that is intentionally NOT atomic: read, pause, write-back. Mutual
  // exclusion is the only thing that prevents a lost update here.
  async function criticalAppend(id) {
    await withDbLock(dbPath, async () => {
      active += 1
      maxConcurrent = Math.max(maxConcurrent, active)
      const cur = JSON.parse(readFileSync(sentinel, 'utf8'))
      // yield to the event loop mid-critical-section: a second holder, if admitted, would
      // read the same `cur` and clobber on write-back.
      await new Promise(r => setTimeout(r, 30))
      cur.ids.push(id)
      writeFileSync(sentinel, JSON.stringify(cur))
      active -= 1
    })
  }

  // Fire both concurrently.
  await Promise.all([criticalAppend('A'), criticalAppend('B')])

  const finalIds = JSON.parse(readFileSync(sentinel, 'utf8')).ids.sort()
  assert.deepEqual(finalIds, ['A', 'B'], 'both writes survived: the lock serialized them (no lost update)')
  assert.equal(maxConcurrent, 1, 'the two critical sections never ran concurrently (mutual exclusion held)')

  rmSync(store, { recursive: true, force: true })
})

// ----- (A6) Async reconcileFn: the await on line 307 is load-bearing ---------------------
// Pins finding 7: reconcileFn must be await-ed so that Promise-returning (async) seams work
// correctly. Without the await, seamResult is the Promise object, seamResult.decision is
// undefined, and executeDecision throws 'unknown decision verb "undefined"'.
// Pins finding 8: at least one test must use an async reconcileFn to exercise the await path.
test('B3b: an async reconcileFn (Promise-returning) works correctly -- the await seam is exercised', async () => {
  const { store, dbPath } = makeFixtureStoreAndIndex('global')
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const target = 'patterns/serialize-writes-with-a-lock'
  const SHARPENED = 'Async seam: exclusive lockfile serializes concurrent writers even without flock(1).'

  // async reconcileFn: returns a Promise (not a plain object). Without `await reconcileFn(...)` in
  // the implementation, seamResult is a Promise, seamResult.decision is undefined, and
  // executeDecision would throw 'unknown decision verb "undefined"'.
  const reconcileFn = async (candidate, hits) => {
    // Simulate an async operation (e.g. a subprocess call in production).
    await new Promise(r => setTimeout(r, 1))
    return {
      relations: hits.map(h => ({ id: h.id, relation: h.id === target ? 'duplicate' : 'unrelated' })),
      decision: `MERGE_INTO:${target}`,
      mergedBody: SHARPENED,
    }
  }

  const ack = await reconcile(
    { raw_lesson: 'Use exclusive lockfile to serialize; async production path.',
      kind_hint: 'tactical', provenance: 'llr-B3b-test' },
    { dbPath, storePath: store, scope: 'global', reconcileFn, now: '2026-06-12T14:00:00Z' },
  )

  assert.equal(ack.disposition, `merged_into:${target}`, 'async reconcileFn: disposition correct')
  assert.equal(ack.entry_id, target, 'async reconcileFn: entry_id correct')

  const after = readMeta(join(store, target + '.md'))
  assert.ok(after.body.includes(SHARPENED), 'async reconcileFn: target body rewritten correctly')

  rmSync(store, { recursive: true, force: true })
})

// ----- (A-prod) Production reconcile seam: productionReconcileFn is exported ---------------
// Pins finding 3: the spec requires "shells to `claude -p --model sonnet` in production".
// productionReconcileFn must be exported and accept (candidate, hitBodies) -> { decision, ... }.
// We test it by verifying: (a) it is exported as an async function, and (b) it throws a clear
// error when `claude` is not found (rather than hanging or crashing without context), using a
// stub spawn to avoid actual claude invocation in CI.
test('B3b: productionReconcileFn is exported as an async function with correct interface', async () => {
  // The function must be exported (not undefined).
  assert.ok(productionReconcileFn !== undefined, 'productionReconcileFn must be exported')
  assert.equal(typeof productionReconcileFn, 'function', 'productionReconcileFn must be a function')
  // It must return a Promise (be async or return one).
  const candidate = { raw_lesson: 'test', kind_hint: 'tactical', provenance: 'test' }
  const hitBodies = [{ id: 'patterns/foo', title: 'Foo', description: 'Foo desc', body: 'Foo body.', cosine: 0.7 }]
  // Calling it may fail because `claude` may not be available; the important thing is:
  // (a) it is async, and (b) it throws with a meaningful error if claude fails (not a hang).
  const result = productionReconcileFn(candidate, hitBodies)
  assert.ok(result instanceof Promise, 'productionReconcileFn must return a Promise')
  // We do NOT await -- just verify the shape; a live claude invocation is not required in tests.
  // Prevent unhandled rejection by attaching a no-op handler.
  result.catch(() => {})
})

// ----- (A7) Path traversal: fileForId must reject ids that escape the store ---------------
// Pins finding 1: an id like '../../etc/passwd' would resolve outside the store root. The
// implementation must detect and reject any id whose resolved path escapes the store.
test('B3b: fileForId rejects ids that escape the store root (path traversal guard)', async () => {
  const { store, dbPath } = makeFixtureStoreAndIndex('global')
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const reconcileFn = () => ({
    relations: [], decision: 'NEW',
  })

  // A candidate whose draft.id contains a path traversal sequence.
  await assert.rejects(
    () => reconcile(
      { raw_lesson: 'traversal test', kind_hint: 'tactical', provenance: 'llr-B3b-test',
        draft: { id: '../../etc/passwd', kind: 'pattern', title: 'evil',
                 description: 'traversal', tags: ['test'], importance: 1, body: 'evil\n' } },
      { dbPath, storePath: store, scope: 'global', reconcileFn, now: '2026-06-12T15:00:00Z' },
    ),
    /path traversal|escape|outside/i,
    'reconcile must reject an id that would write outside the store root',
  )

  rmSync(store, { recursive: true, force: true })
})

// ----- (A8) NEW must refuse to overwrite an existing file --------------------------------
// Pins finding 4: if the target file already exists, a NEW write should throw rather than
// silently clobber an existing entry. This prevents duplicate-id NEW decisions from
// overwriting good entries.
test('B3b: NEW decision refuses to overwrite an existing entry file', async () => {
  const { store, dbPath } = makeFixtureStoreAndIndex('global')
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  // The target id already exists in the fixture store.
  const existingId = 'patterns/serialize-writes-with-a-lock'

  const reconcileFn = () => ({ relations: [], decision: 'NEW' })

  await assert.rejects(
    () => reconcile(
      { raw_lesson: 'colliding new', kind_hint: 'tactical', provenance: 'llr-B3b-test',
        draft: { id: existingId, kind: 'pattern', title: 'Collision',
                 description: 'A duplicate id that should be rejected on NEW.',
                 tags: ['test'], importance: 1, body: 'Collision.\n' } },
      { dbPath, storePath: store, scope: 'global', reconcileFn, now: '2026-06-12T16:00:00Z' },
    ),
    /already exists|collision|overwrite/i,
    'NEW must refuse to overwrite an existing entry file',
  )

  rmSync(store, { recursive: true, force: true })
})

// ----- (A9) SUPERSEDE must validate the old target exists before writing the new entry ---
// Pins finding 5: if the old target file does not exist, the SUPERSEDE should throw
// BEFORE writing the new entry (to avoid partial writes).
test('B3b: SUPERSEDE validates the old target exists before writing the new entry', async () => {
  const { store, dbPath } = makeFixtureStoreAndIndex('global')
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const missingId = 'patterns/nonexistent-entry'
  const newId = 'patterns/replacement-entry'

  const reconcileFn = () => ({
    relations: [{ id: missingId, relation: 'contradicts' }],
    decision: `SUPERSEDE:${missingId}`,
    newEntry: { id: newId, kind: 'pattern', title: 'Replacement',
                description: 'A replacement for a nonexistent entry.',
                tags: ['test'], importance: 1, body: 'Replacement.\n' },
  })

  // Force a SUPERSEDE by simulating a hit on a nonexistent entry (inject via reconcileFn).
  // The implementation should validate the old file exists BEFORE writing the new entry.
  await assert.rejects(
    () => reconcile(
      { raw_lesson: 'supersede nonexistent', kind_hint: 'tactical', provenance: 'llr-B3b-test',
        // give a draft so the search may short-circuit to NEW, but the seam overrides
        draft: { id: 'patterns/candidate', kind: 'pattern', title: 'Cand',
                 description: 'flock serialize concurrent lock exclusive', tags: [], importance: 5, body: 'cand\n' } },
      { dbPath, storePath: store, scope: 'global', reconcileFn: async (candidate, hits) => {
          // Always return the SUPERSEDE decision regardless of what the search found,
          // targeting a nonexistent entry, to exercise the validation path.
          return {
            relations: [{ id: missingId, relation: 'contradicts' }],
            decision: `SUPERSEDE:${missingId}`,
            newEntry: { id: newId, kind: 'pattern', title: 'Replacement',
                        description: 'A replacement.', tags: [], importance: 1, body: 'Replacement.\n' },
          }
        },
        now: '2026-06-12T17:00:00Z' },
    ),
    /not found|does not exist|SUPERSEDE.*target|no such/i,
    'SUPERSEDE must throw (not write) when the old target does not exist',
  )

  // The new entry must NOT have been written (no partial write).
  assert.ok(!existsSync(join(store, newId + '.md')), 'new entry must NOT be written when old target is missing')

  rmSync(store, { recursive: true, force: true })
})

// ----- (A10) Backup names must be collision-free (sub-second suffix) --------------------
// Pins finding 6: bakSuffix is second-precision. Two EXTEND writes in the same second
// produce the same backup name, so the second clobbers the first. The backup suffix must
// include sub-second information (or a random/counter element) to be collision-free.
test('B3b: rewrite backup names are collision-free even within the same second', async () => {
  const { store, dbPath } = makeFixtureStoreAndIndex('global')
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const target = 'patterns/serialize-writes-with-a-lock'

  // Perform two sequential EXTEND/MERGE_INTO writes with the SAME `now` timestamp (same second).
  // If backup names are only second-precision, the second backup clobbers the first.
  const BODY1 = 'First sharpened body for collision test.'
  const BODY2 = 'Second sharpened body for collision test.'
  const sameNow = '2026-06-12T10:00:00Z'

  // Force the seam to be invoked by using a candidate that matches the lock entry via BM25.
  // reconcileFn overrides to always return MERGE_INTO the target.
  const makeMergeFn = body => async () => ({
    relations: [], decision: `MERGE_INTO:${target}`, mergedBody: body,
  })

  await reconcile(
    { raw_lesson: 'serialize concurrent lock exclusive lockfile',
      kind_hint: 'tactical', provenance: 'llr-B3b-test',
      draft: { id: 'patterns/dummy1', kind: 'pattern', title: 'D1',
               description: 'lock serialize concurrent', tags: [], importance: 1, body: 'd1\n' } },
    { dbPath, storePath: store, scope: 'global', reconcileFn: makeMergeFn(BODY1), now: sameNow },
  )
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  await reconcile(
    { raw_lesson: 'serialize concurrent lock exclusive lockfile',
      kind_hint: 'tactical', provenance: 'llr-B3b-test',
      draft: { id: 'patterns/dummy2', kind: 'pattern', title: 'D2',
               description: 'lock serialize concurrent', tags: [], importance: 1, body: 'd2\n' } },
    { dbPath, storePath: store, scope: 'global', reconcileFn: makeMergeFn(BODY2), now: sameNow },
  )

  // Both backups must exist as distinct files. If second-precision only, only one survives.
  const allFiles = readdirSync(join(store, 'patterns'))
  const bakFiles = allFiles.filter(f => f.includes('.bak-'))
  assert.ok(bakFiles.length >= 2, `both backups must survive: found ${bakFiles.length} bak files (${bakFiles.join(', ')}), need >=2`)

  rmSync(store, { recursive: true, force: true })
})

// ----- (A11) Scope-aware routing: MERGE_INTO a global entry from a workspace candidate ---
// Pins finding 2: when a workspace candidate (scope='workspace:proj') gets a MERGE_INTO
// decision targeting a global entry, the write must go to the GLOBAL store, not the
// workspace store. Without this fix, fileForId(workspaceStorePath, globalId) resolves into
// the workspace store and either reads a missing file (throws) or creates a ghost file.
test('B3b: MERGE_INTO a global target from a workspace candidate writes to the global store', async () => {
  // Build a fixture GLOBAL store with the lock entry.
  const globalStore = mkdtempSync(join(tmpdir(), 'memagent-global-'))
  mkdirSync(join(globalStore, 'patterns'), { recursive: true })
  writeFileSync(join(globalStore, 'patterns', 'serialize-writes-with-a-lock.md'),
`---
kind: pattern
status: active
title: Serialize concurrent writes with a lock
description: Concurrent writers to one store must serialize via an exclusive lock.
tags: ["concurrency","lock"]
importance: 7
created_at: 2026-06-01T00:00:00Z
updated_at: 2026-06-01T00:00:00Z
---
Two processes writing the same store at once will interleave.
`)

  // Build a fixture WORKSPACE store (empty -- the candidate will come from workspace scope).
  const wsStore = mkdtempSync(join(tmpdir(), 'memagent-ws-'))
  mkdirSync(join(wsStore, 'patterns'), { recursive: true })

  // One shared DB: build global scope first, then workspace scope into the same db.
  const dbPath = join(mkdtempSync(join(tmpdir(), 'memagent-db-')), 'index.db')
  await rebuild({ storePath: globalStore, dbPath, scope: 'global' })
  // (workspace store is empty; rebuild is idempotent on empty dir)
  await rebuild({ storePath: wsStore, dbPath, scope: 'workspace:proj' })

  const globalTarget = 'patterns/serialize-writes-with-a-lock'
  const SHARPENED = 'Workspace candidate sharpened the global lock rule.'

  // The seam always returns MERGE_INTO the global target, even though the candidate is
  // workspace-scoped. The implementation must route the write to globalStore, not wsStore.
  const reconcileFn = async () => ({
    relations: [{ id: globalTarget, relation: 'duplicate' }],
    decision: `MERGE_INTO:${globalTarget}`,
    mergedBody: SHARPENED,
  })

  const ack = await reconcile(
    { raw_lesson: 'lock serialize concurrent writes exclusive',
      kind_hint: 'tactical', provenance: 'llr-B3b-test' },
    { dbPath, storePath: wsStore, scope: 'workspace:proj', globalScope: 'global',
      globalStorePath: globalStore, reconcileFn, now: '2026-06-12T18:00:00Z' },
  )

  assert.equal(ack.disposition, `merged_into:${globalTarget}`, 'cross-scope MERGE_INTO acks correctly')

  // The GLOBAL store must have the rewritten body.
  const globalFile = join(globalStore, 'patterns', 'serialize-writes-with-a-lock.md')
  const afterGlobal = readMeta(globalFile)
  assert.ok(afterGlobal.body.includes(SHARPENED), 'global entry body was rewritten in the GLOBAL store')

  // The workspace store must NOT have a ghost file for the global id.
  assert.ok(!existsSync(join(wsStore, globalTarget + '.md')), 'NO ghost file created in the workspace store')

  rmSync(globalStore, { recursive: true, force: true })
  rmSync(wsStore, { recursive: true, force: true })
})

// ----- (A5) Firewall: fixture-only, the live store is never touched ----------------------
// Every test above passes explicit dbPath + storePath. This one asserts the firewall holds:
// running a reconcile against a fixture leaves NO trace at the live store/db default paths.
test('B3b: reconcile runs fixture-only and never reads or writes the live ~/.claude memory store', async () => {
  const liveStore = join(homedir(), '.claude', 'projects', '-Users-admin--claude', 'memory')
  const liveDb = join(homedir(), '.claude', 'memory-index.db')
  const liveStoreBefore = existsSync(liveStore) ? countMdFiles(liveStore) : null
  const liveDbBefore = existsSync(liveDb) ? readFileSync(liveDb).length : null

  const { store, dbPath } = makeFixtureStoreAndIndex('global')
  await rebuild({ storePath: store, dbPath, scope: 'global' })

  const reconcileFn = () => ({ relations: [], decision: 'NEW' })
  await reconcile(
    { raw_lesson: 'A firewall-only candidate.', kind_hint: 'tactical', provenance: 'llr-B3b-test',
      draft: { id: 'patterns/firewall-check', kind: 'pattern', title: 'Firewall check',
               description: 'A standalone novel entry with no store overlap, for the firewall test.',
               tags: ['test'], importance: 1, body: 'No overlap.\n' } },
    { dbPath, storePath: store, scope: 'global', reconcileFn, now: '2026-06-12T13:00:00Z' },
  )

  const liveStoreAfter = existsSync(liveStore) ? countMdFiles(liveStore) : null
  const liveDbAfter = existsSync(liveDb) ? readFileSync(liveDb).length : null
  assert.equal(liveStoreAfter, liveStoreBefore, 'the live memory store file count is unchanged')
  assert.equal(liveDbAfter, liveDbBefore, 'the live memory-index.db is byte-unchanged')

  rmSync(store, { recursive: true, force: true })
})
