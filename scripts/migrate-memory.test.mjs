// Test for lean-system-rebuild chunk B2: scripts/migrate-memory.mjs -- the idempotent
// frontmatter-migration for the memory store.
//
// WHAT B2 BUILDS (the contract, from the chunk task + acceptance criteria):
//   A NEW script scripts/migrate-memory.mjs that:
//     - MERGES status/tags/importance/created_at INTO each ENTRY file's EXISTING YAML
//       frontmatter block (entry files already carry name/description/metadata.type as the
//       kind). NO second `---` block: the new keys merge into the one existing block.
//     - status defaults to 'active'; tags (3-6) and importance (1-10) come from a MOCKABLE/
//       INJECTABLE tagger seam (canned in tests; batches to `claude -p --model sonnet` in
//       production); created_at from the file mtime (fs.stat) -- the best available signal
//       captured BEFORE the migration's own write resets mtime.
//     - ENTRY-VS-STRUCTURAL: migrates ONLY entry files (those carrying name/description
//       frontmatter). SKIPS structural files (bucket INDEX.md, MEMORY.md) which carry NO
//       entry frontmatter -- they are navigation/index, not entries.
//     - BODY BYTES UNCHANGED: only the frontmatter block is rewritten; the markdown body
//       after the closing `---` stays byte-identical (asserted via sha256 compare).
//     - IDEMPOTENT + SUBSET-RERUNNABLE: a rerun over an already-migrated file is a NO-OP
//       (keys present + body unchanged -> skip); accepts a subset (a file list or a dir).
//     - After injection, triggers an index build (reuse memory-index.mjs's rebuild) so the
//       migrated entries are queryable; MEMORY.md is left unchanged.
//
// CRITICAL FIREWALL: the build + tests run ENTIRELY against a FIXTURE store (a tmpdir of a
//   few .md entry files + an INDEX.md to prove it is skipped). NEVER read or write the live
//   ~/.claude memory store. The live 960-file run is a separate COO step, not this chunk.
//
// ANTI-TAUTOLOGY: every expected value is FIXED from the chunk task + acceptance criteria,
//   never read back from the code-to-be-written:
//     - body-bytes-unchanged is checked by sha256-ing the body (everything after the closing
//       `---`) BEFORE migration via an INDEPENDENT split of the original file, and asserting
//       it EQUALS the body sha256 AFTER migration (a separate crypto call, not the script's);
//     - the merge-into-one-block assertion counts the literal `---` fences and requires
//       EXACTLY two (one open, one close) -- a prepended second block would yield four;
//     - structural-skip is checked by asserting INDEX.md / MEMORY.md are byte-identical
//       (whole-file sha256) after a run that migrated their sibling entry files;
//     - idempotency is checked by capturing each file's whole-file sha256 after the first
//       migration and asserting a SECOND migration leaves every byte identical;
//     - queryability is checked by rebuilding the index over the migrated store and asserting
//       the migrated entry is returned by an FTS query (proving the merged keys parse).
//
// Run: node --test scripts/migrate-memory.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from './migrate-memory.mjs'
import { rebuild, queryFts } from './memory-index.mjs'

// --- the canned/injected tagger seam (no live claude -p) ----------------------------------
// Returns deterministic tags + importance per slug so the test asserts fixed values.
function cannedTagger() {
  return async (entries) =>
    entries.map((e) => ({
      id: e.id,
      tags: ['alpha', 'beta', 'gamma'],
      importance: 7,
    }))
}

// Split a raw file into [frontmatterBlockIncludingFences, bodyAfterClosingFence].
// INDEPENDENT of the script's own parser -- a primitive split on the first two `---` lines.
function splitBody(raw) {
  const m = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)
  return m ? m[1] : null
}

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function countFences(raw) {
  return (raw.match(/^---$/gm) || []).length
}

// --- fixture: entry files (name/description/metadata.type) + structural files -------------
// Mirrors the REAL store's TWO frontmatter shapes (nested metadata: block, and flat) plus
// the structural INDEX.md / MEMORY.md which carry NO entry frontmatter.
function makeFixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'migmem-store-'))
  const bucket = join(dir, 'patterns', 'testing-and-tdd')
  mkdtempDirs(bucket)

  // NESTED entry (newer shape): name/description + metadata block with metadata.type.
  writeFileSync(join(bucket, 'nested-entry.md'),
`---
name: nested-entry-example
description: An entry whose frontmatter carries a nested metadata block with metadata.type as the kind.
metadata:
  node_type: memory
  type: feedback
  kind: pattern
  bucket: testing-and-tdd
---
Body of the nested entry. This markdown must stay byte-identical after migration.
The closing fence above is the only boundary the migration may touch.
`)

  // FLAT entry (older shape): top-level name/description/type/kind, no metadata block.
  writeFileSync(join(bucket, 'flat-entry.md'),
`---
name: Flat entry example
description: An entry whose frontmatter is flat top-level name/description/type/kind.
type: feedback
kind: pattern
bucket: testing-and-tdd
---
Body of the flat entry. Also byte-stable across migration.
`)

  // STRUCTURAL: a bucket INDEX.md -- heading + prose, NO entry frontmatter. Must be SKIPPED.
  writeFileSync(join(bucket, 'INDEX.md'),
`# testing-and-tdd

TDD discipline, failing-test-first, mocks vs real, fixtures.

Entries: 2.

- [nested-entry-example](nested-entry.md) -- a nested-shape entry.
- [Flat entry example](flat-entry.md) -- a flat-shape entry.
`)

  // STRUCTURAL: MEMORY.md at the store root -- the index MOC, NO entry frontmatter. SKIPPED.
  writeFileSync(join(dir, 'MEMORY.md'),
`# Memory index

Sectioned MOC. Each entry is one line.

## Coding patterns
### testing-and-tdd
TDD discipline. (2 entries -- [INDEX](patterns/testing-and-tdd/INDEX.md))
`)

  return dir
}

// mkdir -p helper (avoids importing mkdirSync at top just for this)
import { mkdirSync } from 'node:fs'
function mkdtempDirs(p) { mkdirSync(p, { recursive: true }) }

const ENTRY_REL = ['patterns', 'testing-and-tdd', 'nested-entry.md']
const FLAT_REL = ['patterns', 'testing-and-tdd', 'flat-entry.md']
const INDEX_REL = ['patterns', 'testing-and-tdd', 'INDEX.md']
const MEMORY_REL = ['MEMORY.md']

function freshDbPath() {
  const d = mkdtempSync(join(tmpdir(), 'migmem-db-'))
  return join(d, 'memory-index.db')
}

// =========================================================================================
// AC1: merges the four keys into the SAME YAML block (no second block); body byte-identical.
test('B2: merges status/tags/importance/created_at into the one existing block, body byte-identical', async () => {
  const store = makeFixtureStore()
  const entryPath = join(store, ...ENTRY_REL)

  const before = readFileSync(entryPath, 'utf8')
  const bodyBefore = splitBody(before)
  assert.ok(bodyBefore !== null, 'precondition: fixture entry has a parseable frontmatter block')
  const bodyHashBefore = sha256(bodyBefore)

  await migrate({ storePath: store, tagger: cannedTagger(), buildIndex: false })

  const after = readFileSync(entryPath, 'utf8')

  // No second block: exactly two `---` fences (one open, one close), not four.
  assert.equal(countFences(after), 2,
    'migration must merge into the ONE existing block, never prepend a second `---` block')

  // The four new keys are present in the (single) frontmatter block.
  const fm = after.match(/^---\n([\s\S]*?)\n---\n?/)[1]
  assert.match(fm, /^status:\s*active\s*$/m, 'status defaults to active in the merged block')
  assert.match(fm, /^importance:\s*7\s*$/m, 'importance from the tagger is merged in')
  assert.match(fm, /^tags:/m, 'tags from the tagger are merged in')
  assert.match(fm, /^created_at:\s*\S+/m, 'created_at (from file mtime) is merged in')
  // The pre-existing keys survive the merge.
  assert.match(fm, /^name:\s*nested-entry-example\s*$/m, 'existing name key survives the merge')
  assert.match(fm, /^description:/m, 'existing description key survives the merge')

  // BODY BYTES UNCHANGED: sha256 of the body after the closing fence is identical.
  const bodyAfter = splitBody(after)
  assert.equal(sha256(bodyAfter), bodyHashBefore,
    'the markdown body after the closing --- must be byte-identical (sha256 compare)')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// AC2: an INDEX.md / MEMORY.md (no entry frontmatter) is SKIPPED, not migrated.
test('B2: structural files (INDEX.md, MEMORY.md) are skipped, left byte-identical', async () => {
  const store = makeFixtureStore()
  const indexPath = join(store, ...INDEX_REL)
  const memoryPath = join(store, ...MEMORY_REL)

  const indexHashBefore = sha256(readFileSync(indexPath, 'utf8'))
  const memoryHashBefore = sha256(readFileSync(memoryPath, 'utf8'))

  await migrate({ storePath: store, tagger: cannedTagger(), buildIndex: false })

  assert.equal(sha256(readFileSync(indexPath, 'utf8')), indexHashBefore,
    'a bucket INDEX.md (no entry frontmatter) must be skipped, not migrated')
  assert.equal(sha256(readFileSync(memoryPath, 'utf8')), memoryHashBefore,
    'MEMORY.md (no entry frontmatter) must be left unchanged')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// AC3: a rerun over an already-migrated fixture is a no-op (no diff).
test('B2: a rerun over an already-migrated store is a no-op (every byte identical)', async () => {
  const store = makeFixtureStore()
  const entryPath = join(store, ...ENTRY_REL)
  const flatPath = join(store, ...FLAT_REL)

  await migrate({ storePath: store, tagger: cannedTagger(), buildIndex: false })

  const entryAfterFirst = sha256(readFileSync(entryPath, 'utf8'))
  const flatAfterFirst = sha256(readFileSync(flatPath, 'utf8'))

  // A second migration with a tagger that would return DIFFERENT tags must NOT re-tag or
  // re-write an already-migrated file: keys-present + body-unchanged -> skip.
  const differentTagger = async (entries) =>
    entries.map((e) => ({ id: e.id, tags: ['zzz', 'yyy', 'xxx'], importance: 1 }))
  await migrate({ storePath: store, tagger: differentTagger, buildIndex: false })

  assert.equal(sha256(readFileSync(entryPath, 'utf8')), entryAfterFirst,
    'a rerun over an already-migrated entry must be a no-op (no byte change)')
  assert.equal(sha256(readFileSync(flatPath, 'utf8')), flatAfterFirst,
    'a rerun over an already-migrated flat entry must be a no-op too')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// IDEMPOTENCY ROBUSTNESS: a PARTIALLY-migrated entry (already carries some injected keys, e.g.
// status+tags from an earlier interrupted run) must gain ONLY the missing keys -- never a
// duplicate `status:`/`tags:` line in the same block. Duplicate YAML keys are silent
// corruption on a no-rollback store. The merge injects only keys NOT already present.
test('B2: a partially-migrated entry gains only the missing keys (no duplicate frontmatter keys)', async () => {
  const store = mkdtempSync(join(tmpdir(), 'migmem-partial-'))
  mkdtempDirs(join(store, 'p'))
  const file = join(store, 'p', 'partial.md')
  writeFileSync(file,
`---
name: partial
description: Already carries status+tags from an earlier run, but not importance+created_at.
status: active
tags: ["x","y"]
---
Partial body stays byte-identical.
`)
  const bodyHashBefore = sha256(splitBody(readFileSync(file, 'utf8')))

  await migrate({ storePath: store, tagger: cannedTagger(), buildIndex: false })

  const fm = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n?/)[1]
  // No duplicate top-level keys: each injected key appears EXACTLY once in the block.
  for (const key of ['status', 'tags', 'importance', 'created_at']) {
    const occurrences = (fm.match(new RegExp(`^${key}:`, 'gm')) || []).length
    assert.equal(occurrences, 1, `key '${key}' must appear exactly once (no duplicate after merge)`)
  }
  // The pre-existing tags value is preserved, not overwritten by the tagger.
  assert.match(fm, /^tags:\s*\["x","y"\]\s*$/m, 'an already-present tags value is preserved, not re-tagged')
  // The missing keys were added.
  assert.match(fm, /^importance:\s*7\s*$/m, 'the missing importance key is added')
  assert.match(fm, /^created_at:\s*\S+/m, 'the missing created_at key is added')
  // Body untouched.
  assert.equal(sha256(splitBody(readFileSync(file, 'utf8'))), bodyHashBefore, 'body byte-identical')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// AC4 (dir variant): accepts a subset as a DIRECTORY and migrates only the files under it.
// The criterion says 'file list or dir'; the dir path in resolveFiles (statSync + isDirectory
// + walkMd) must be directly exercised, not just inferred from the full-store walk.
test('B2: accepts a subset (directory) and migrates only the files under that dir', async () => {
  // Two-bucket store: bucket-a and bucket-b. Pass bucket-a as the dir subset; verify only
  // bucket-a entries are migrated and bucket-b entries are left byte-identical.
  const store = mkdtempSync(join(tmpdir(), 'migmem-dirsubset-'))
  const bucketA = join(store, 'patterns', 'bucket-a')
  const bucketB = join(store, 'patterns', 'bucket-b')
  mkdirSync(bucketA, { recursive: true })
  mkdirSync(bucketB, { recursive: true })

  writeFileSync(join(bucketA, 'entry-a.md'),
`---
name: entry-a
description: Entry in bucket-a, should be migrated when bucket-a is the dir subset.
metadata:
  type: pattern
---
Body of entry-a.
`)

  writeFileSync(join(bucketB, 'entry-b.md'),
`---
name: entry-b
description: Entry in bucket-b, must NOT be migrated when bucket-a is the dir subset.
metadata:
  type: pattern
---
Body of entry-b.
`)

  const entryBPath = join(bucketB, 'entry-b.md')
  const entryBHashBefore = sha256(readFileSync(entryBPath, 'utf8'))

  // Pass bucket-a as a DIRECTORY subset.
  await migrate({ storePath: store, files: [bucketA], tagger: cannedTagger(), buildIndex: false })

  // bucket-a entry is migrated.
  assert.match(readFileSync(join(bucketA, 'entry-a.md'), 'utf8'), /^status:\s*active\s*$/m,
    'the entry under the dir subset must be migrated')
  // bucket-b entry is untouched.
  assert.equal(sha256(readFileSync(entryBPath, 'utf8')), entryBHashBefore,
    'entries NOT under the dir subset must be left byte-identical')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// AC4: the script accepts a subset (a file list or a dir) and migrates only those.
test('B2: accepts a subset (file list) and migrates only the named files', async () => {
  const store = makeFixtureStore()
  const entryPath = join(store, ...ENTRY_REL)
  const flatPath = join(store, ...FLAT_REL)

  const flatHashBefore = sha256(readFileSync(flatPath, 'utf8'))

  // Migrate ONLY the nested entry by passing a one-element file list.
  await migrate({ storePath: store, files: [entryPath], tagger: cannedTagger(), buildIndex: false })

  // The named file was migrated...
  assert.match(readFileSync(entryPath, 'utf8'), /^status:\s*active\s*$/m,
    'the file named in the subset must be migrated')
  // ...and the un-named sibling was left untouched.
  assert.equal(sha256(readFileSync(flatPath, 'utf8')), flatHashBefore,
    'a file NOT in the subset must be left untouched')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// AC5: the LLM tagger is behind a mockable seam (the test injects a canned tagger; the tags
// it returned land in the file). Asserting the injected tags appear proves the seam is live.
test('B2: the tagger is an injectable seam -- canned tags land in the migrated frontmatter', async () => {
  const store = makeFixtureStore()
  const entryPath = join(store, ...ENTRY_REL)

  const taggerWithMarkerTags = async (entries) =>
    entries.map((e) => ({ id: e.id, tags: ['canary-tag-one', 'canary-tag-two', 'canary-tag-three'], importance: 9 }))

  await migrate({ storePath: store, tagger: taggerWithMarkerTags, buildIndex: false })

  const after = readFileSync(entryPath, 'utf8')
  assert.match(after, /canary-tag-one/, 'the injected tagger\'s tags must appear in the migrated frontmatter')
  assert.match(after, /^importance:\s*9\s*$/m, 'the injected tagger\'s importance must be used')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// AC6: after injection the index build runs (reuse memory-index.mjs) and the migrated entries
// are queryable; MEMORY.md is left unchanged.
test('B2: after migration the rebuilt index makes migrated entries queryable; MEMORY.md unchanged', async () => {
  const store = makeFixtureStore()
  const dbPath = freshDbPath()
  const memoryPath = join(store, ...MEMORY_REL)
  const memoryHashBefore = sha256(readFileSync(memoryPath, 'utf8'))

  // Run the migration WITH the index build (the default) -- prove the reuse seam fires.
  await migrate({ storePath: store, dbPath, tagger: cannedTagger() })

  // The migrated entry must be queryable via the rebuilt index. Query a description term.
  const db = new DatabaseSync(dbPath)
  const results = queryFts(db, 'nested', { scope: 'global' })
  const ids = results.map((r) => r.id)
  assert.ok(ids.includes('patterns/testing-and-tdd/nested-entry'),
    'after migration + index build the migrated entry must be queryable by FTS')

  // The migrated entry's importance/tags actually reached the index (proves the merge parsed).
  const row = db.prepare('SELECT importance, tags, status FROM entries WHERE id = ?')
    .get('patterns/testing-and-tdd/nested-entry')
  assert.equal(row.importance, 7, 'the merged importance reaches the index')
  assert.equal(row.status, 'active', 'the merged status reaches the index')
  assert.notEqual(row.tags, '[]', 'the merged tags reach the index')

  // Structural files were NOT indexed as entries via migration changes; MEMORY.md untouched.
  assert.equal(sha256(readFileSync(memoryPath, 'utf8')), memoryHashBefore,
    'MEMORY.md must be left unchanged by the migration')

  db.close()
  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// created_at sourcing: comes from the file mtime captured BEFORE the migration's own write.
test('B2: created_at is sourced from the file mtime (a valid ISO timestamp)', async () => {
  const store = makeFixtureStore()
  const entryPath = join(store, ...ENTRY_REL)
  const mtimeBefore = statSync(entryPath).mtime

  await migrate({ storePath: store, tagger: cannedTagger(), buildIndex: false })

  const fm = readFileSync(entryPath, 'utf8').match(/^---\n([\s\S]*?)\n---\n?/)[1]
  const m = fm.match(/^created_at:\s*(\S+)\s*$/m)
  assert.ok(m, 'created_at present in the merged frontmatter')
  const parsed = new Date(m[1])
  assert.ok(!Number.isNaN(parsed.getTime()), 'created_at parses as a valid date')
  // It reflects the ORIGINAL mtime (captured before the write), within a generous window.
  assert.ok(Math.abs(parsed.getTime() - mtimeBefore.getTime()) < 5000,
    'created_at reflects the file mtime captured before the migration write')

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// P1: malformed tagger rows (non-string tag items, out-of-range/non-integer importance)
// must be sanitised to safe defaults before writing, never written as-is.
test('B2: malformed tagger rows are sanitised -- non-string tags dropped, importance clamped to integer 1-10', async () => {
  const store = makeFixtureStore()
  const entryPath = join(store, ...ENTRY_REL)

  // A tagger that returns malformed data: tags contains nulls, an object, and a number;
  // importance is a float outside [1,10].
  const malformedTagger = async (entries) =>
    entries.map((e) => ({
      id: e.id,
      tags: ['valid-tag', null, { nested: true }, 42],
      importance: 11.7,
    }))

  await migrate({ storePath: store, tagger: malformedTagger, buildIndex: false })

  const fm = readFileSync(entryPath, 'utf8').match(/^---\n([\s\S]*?)\n---\n?/)[1]

  // tags line must contain only string items -- null, object, number must be dropped.
  const tagsLine = fm.match(/^tags:\s*(.+)$/m)
  assert.ok(tagsLine, 'tags line must be present in the migrated frontmatter')
  const tagsValue = JSON.parse(tagsLine[1])
  assert.ok(Array.isArray(tagsValue), 'tags must be a JSON array')
  for (const item of tagsValue) {
    assert.equal(typeof item, 'string',
      `every tag item must be a string; got ${JSON.stringify(item)}`)
  }
  assert.ok(tagsValue.includes('valid-tag'), 'valid string tag survives the sanitisation')

  // importance must be an integer in [1, 10]; 11.7 is out of range and must be clamped.
  const impLine = fm.match(/^importance:\s*(\S+)\s*$/m)
  assert.ok(impLine, 'importance line must be present')
  const impVal = Number(impLine[1])
  assert.ok(Number.isInteger(impVal), `importance must be an integer; got ${impLine[1]}`)
  assert.ok(impVal >= 1 && impVal <= 10, `importance must be in [1,10]; got ${impVal}`)

  rmSync(store, { recursive: true, force: true })
})

// =========================================================================================
// P2: after migration the rebuilt index must correctly reflect the entry's kind (pattern),
// not fall back to 'reference'. The nested-entry fixture has metadata.kind = 'pattern'
// and metadata.type = 'feedback'; neither is a top-level key, so the index would read
// 'reference'. The migration must promote kind to top-level so the index reads it.
test('B2: migration promotes nested metadata.kind to top-level so the rebuilt index preserves it', async () => {
  const store = makeFixtureStore()
  const dbPath = freshDbPath()

  await migrate({ storePath: store, dbPath, tagger: cannedTagger() })

  // After migration the nested-entry has metadata.kind = 'pattern' (from metadata block).
  // The rebuilt index must store kind='pattern', not the 'reference' fallback.
  const db = new DatabaseSync(dbPath)
  const row = db.prepare('SELECT kind FROM entries WHERE id = ?')
    .get('patterns/testing-and-tdd/nested-entry')
  assert.ok(row, 'the nested-entry must be indexed after migration')
  assert.equal(row.kind, 'pattern',
    'nested metadata.kind must be promoted to top-level and reach the rebuilt index as kind=pattern')
  db.close()

  rmSync(store, { recursive: true, force: true })
})
