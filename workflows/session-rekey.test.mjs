// session-rekey.test.mjs -- RED for Chunk 2: per-spec accumulator + canonical slug.
//
// Chunk 2 has TWO parts and this file pins BOTH:
//
//   PART 1 (skills/spec-collaboration/SKILL.md) -- at spec LOCK, a step persists the
//   canonical slug as a `slug:` frontmatter line in current.md, so the build-time
//   archive hook and the ship-time grade read the IDENTICAL string (no title-vs-
//   archive-filename mismatch). SKILL.md is an instruction doc, not executable code,
//   so the testable artifact is that the doc DOCUMENTS a lock-time slug-persist step
//   writing `slug:` to current.md frontmatter (criterion a). The production frontmatter
//   style is the BOLD markdown form `**slug:** <x>` (see specs/current.md), so the
//   persisted line must match that style.
//
//   PART 2 (hooks/session-archive.sh) -- the pending->slug RE-KEY step. When a spec
//   LOCKS (Signal A: a locked current.md with a slug fires), any pre-lock sessions
//   previously staged in specs/_pending-sessions/<id>/ are RE-KEYED (MOVED) into
//   specs/<slug>/sessions/<id>/ under the now-known slug. The store ACCUMULATES:
//   appending session dirs, NEVER overwriting an existing one (criteria b + c).
//
// WHAT THIS PINS (every acceptance criterion has at least one assertion that fails if
// that criterion is unmet):
//   (a) locking a draft writes the slug to current.md frontmatter
//       -> SKILL.md documents a lock-time step persisting `slug:` to current.md.
//   (b) a staged pending session re-keys (MOVES) into specs/<slug>/sessions/<id>/ at lock
//       -> a planted specs/_pending-sessions/<id>/ lands at specs/<slug>/sessions/<id>/
//          and the pending source is GONE (moved, not copied).
//   (c) a SECOND session of the same slug APPENDS without clobbering the first
//       -> with a pre-existing session ALREADY in the slug store, re-keying a pending
//          session leaves BOTH session dirs present (append, never overwrite); and two
//          distinct pending sessions both re-key in, both surviving.
//
// HERMETIC DESIGN (mirrors the chunk-1 harness, no worktree pollution): each test
// mkdtemps a fixture root, copies the REAL hook into <fixture>/hooks/ and the REAL
// corpus extractor into <fixture>/scripts/, and invokes THAT copy so config_root ==
// payload cwd == <fixture>. Nothing escapes the tmp dir.
//
// ANTI-TAUTOLOGY: every expected path/slug/marker is hand-derived from the chunk
// contract (slug "rekey-spec" from a hand-written frontmatter line; the pending
// session-ids are hand-chosen; the planted marker bytes are fixed literals asserted by
// content). Nothing is read back from the script. The re-key destination is recomputed
// independently (join(specs, slug, 'sessions', id)), not lifted from the hook's output.
//
// The re-key code does NOT exist yet in the committed hook, so PART 2 assertions check
// for a moved dir that never appears -> a clean per-behavior RED (feature missing). The
// SKILL.md slug-persist step does NOT exist yet -> PART 1 assertion fails on a doc that
// has no such step.
//
// Run: node --test workflows/session-rekey.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKTREE_ROOT = dirname(HERE) // workflows/ -> worktree root
const HOOK_SRC = join(WORKTREE_ROOT, 'hooks', 'session-archive.sh')
const CORPUS_SRC = join(WORKTREE_ROOT, 'scripts', 'user_corpus_extract.py')
const SKILL_SRC = join(WORKTREE_ROOT, 'skills', 'spec-collaboration', 'SKILL.md')

function today() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

const JAKE_LINE = 'lock the spec and re-key the staged sessions under the slug'

function jakeTranscript() {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: JAKE_LINE },
    }),
  ]
  return lines.join('\n') + '\n'
}

// Build an isolated fixture for the re-key path. A LOCKED current.md carrying `slug`
// (Signal A) is always written, since the re-key fires at lock. Caller controls which
// pending sessions are pre-staged and which sessions already exist in the slug store.
//
// opts:
//   sessionId             the firing session's id (the SessionEnd payload's session).
//   slug                  the slug written into the locked current.md frontmatter.
//   pendingSessions       array of ids -- each pre-planted at specs/_pending-sessions/<id>/
//                         with a marker file, to be re-keyed at lock.
//   preExistingSessions   array of ids -- each pre-planted ALREADY at
//                         specs/<slug>/sessions/<id>/ with a DISTINCT marker, to prove
//                         the re-key APPENDS and does not clobber an existing store.
function makeFixture(opts) {
  const {
    sessionId,
    slug = 'rekey-spec',
    pendingSessions = [],
    preExistingSessions = [],
  } = opts

  const root = mkdtempSync(join(tmpdir(), 'session-rekey-'))

  mkdirSync(join(root, 'hooks'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  if (existsSync(HOOK_SRC)) copyFileSync(HOOK_SRC, join(root, 'hooks', 'session-archive.sh'))
  if (existsSync(CORPUS_SRC)) copyFileSync(CORPUS_SRC, join(root, 'scripts', 'user_corpus_extract.py'))

  // Fake projects tree: the firing session's DIR + sibling .jsonl.
  const projects = join(root, 'projects')
  mkdirSync(projects, { recursive: true })
  const transcriptPath = join(projects, `${sessionId}.jsonl`)
  writeFileSync(transcriptPath, jakeTranscript())
  const sessionDir = join(projects, sessionId)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify({ id: sessionId }))

  // Signal A: a LOCKED current.md carrying the BOLD slug line (production shape).
  const specsDir = join(root, 'specs')
  mkdirSync(specsDir, { recursive: true })
  writeFileSync(
    join(specsDir, 'current.md'),
    `# Spec\n\n**Status:** Locked ${today()}\n**slug:** ${slug}\n`,
  )

  // Pre-stage pending sessions (from earlier pre-lock drafting clears). Each gets a
  // UNIQUE marker file so the re-key can be verified to MOVE that exact content.
  for (const pid of pendingSessions) {
    const pdir = join(specsDir, '_pending-sessions', pid)
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, `${pid}.jsonl`), `PENDING_MARKER_${pid}\n`)
    writeFileSync(join(pdir, 'meta.json'), JSON.stringify({ id: pid, staged: 'pre-lock' }))
  }

  // Pre-plant sessions that ALREADY live in the slug store (e.g. an earlier locked-spec
  // build session). The re-key must APPEND alongside these, never wipe them.
  for (const eid of preExistingSessions) {
    const edir = join(specsDir, slug, 'sessions', eid)
    mkdirSync(edir, { recursive: true })
    writeFileSync(join(edir, `${eid}.jsonl`), `PREEXISTING_MARKER_${eid}\n`)
  }

  return { root, transcriptPath, sessionId, slug }
}

function runHook(root, payload) {
  const hookCopy = join(root, 'hooks', 'session-archive.sh')
  try {
    const stdout = execFileSync('bash', [hookCopy], {
      input: JSON.stringify(payload),
      cwd: root,
      encoding: 'utf8',
    })
    return { ok: true, status: 0, stdout }
  } catch (err) {
    return { ok: false, status: typeof err.status === 'number' ? err.status : null, err }
  }
}

function payloadFor(root, transcriptPath, sessionId) {
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: root,
    hook_event_name: 'SessionEnd',
    reason: 'clear',
  }
}

// ============================================================================
// PART 1 (criterion a): spec-collaboration documents a lock-time slug-persist step.
// ============================================================================
//
// SKILL.md is an instruction document, not executable code, so the testable artifact is
// the DOC: at lock, spec-collaboration must run a step that persists the canonical slug
// to current.md frontmatter (as a `slug:` line) so the archive hook + ship-time grade
// read one identical string. The chunk's own justification ("avoiding a title-vs-archive-
// filename mismatch") is the WHY; the assertion pins the WHAT: a lock-time step that
// writes/ensures the `slug:` frontmatter line. Hand-derived from the task statement; not
// fitted to any existing doc text (the step does not exist in the doc yet -> RED).
test('part1 (a): spec-collaboration SKILL.md documents a lock-time step persisting slug: to current.md frontmatter', () => {
  assert.ok(existsSync(SKILL_SRC), `precondition: ${SKILL_SRC} must exist`)
  const doc = readFileSync(SKILL_SRC, 'utf8')

  // Isolate the lock-time region of the doc: the slug-persist step belongs at/after the
  // "Lock-time project sync" section (the lock-time block), not buried in unrelated prose.
  const lockIdx = doc.indexOf('## Lock-time project sync')
  assert.ok(
    lockIdx !== -1,
    'precondition: SKILL.md must have a "## Lock-time project sync" section anchoring the lock-time steps',
  )
  const lockRegion = doc.slice(lockIdx)

  // The lock-time region must mention persisting the slug to current.md frontmatter.
  // Require BOTH the frontmatter key (`slug:`) and a reference to current.md in the same
  // lock-time region, so a generic mention of "slug" elsewhere cannot satisfy this.
  assert.match(
    lockRegion,
    /slug:/,
    'the lock-time region of spec-collaboration SKILL.md must document persisting a `slug:` frontmatter line (criterion a)',
  )
  assert.match(
    lockRegion,
    /current\.md/,
    'the lock-time slug-persist step must target current.md (where the archive hook + ship-time grade read the slug)',
  )
  // The step must be explicitly LOCK-triggered and PERSIST/WRITE the slug -- not merely
  // mention the word slug. Pin the action verb so a passing impl actually documents a
  // write step, not an incidental reference.
  assert.match(
    lockRegion,
    /persist|write|ensure|record/i,
    'the lock-time step must PERSIST/WRITE/ENSURE the slug into current.md frontmatter, not merely mention it',
  )
})

// ============================================================================
// PART 2 (criterion b): a staged pending session RE-KEYS (moves) into the slug store.
// ============================================================================
test('part2 (b): a staged pending session re-keys (MOVES) into specs/<slug>/sessions/<id>/ at lock', () => {
  const sessionId = 'sess-lock-2001'
  const pendingId = 'sess-pending-2001'
  const slug = 'rekey-spec'
  const { root, transcriptPath } = makeFixture({
    sessionId,
    slug,
    pendingSessions: [pendingId],
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    // The pending session must now live under the slug store, with its marker intact.
    const moved = join(root, 'specs', slug, 'sessions', pendingId, `${pendingId}.jsonl`)
    assert.ok(
      existsSync(moved),
      `the pending session must re-key into ${moved} at lock (got nothing -> re-key step missing)`,
    )
    assert.equal(
      readFileSync(moved, 'utf8'),
      `PENDING_MARKER_${pendingId}\n`,
      'the re-keyed session must carry its original pending bytes (a true move of the staged content)',
    )

    // RE-KEY means MOVE, not copy: the source in _pending-sessions/ must be GONE.
    const sourceStill = join(root, 'specs', '_pending-sessions', pendingId)
    assert.equal(
      existsSync(sourceStill),
      false,
      `re-key must MOVE (not copy): specs/_pending-sessions/${pendingId}/ must no longer exist after lock`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ============================================================================
// PART 2 (criterion c): a SECOND session of the same slug APPENDS without clobbering.
// ============================================================================

// (c-i) A pre-existing session already in the slug store must SURVIVE a re-key. This is
// the direct anti-clobber pin: re-keying a new pending session must not wipe a store that
// already holds an earlier session of the same slug.
test('part2 (c-i): re-keying a pending session APPENDS -- a pre-existing session in the slug store is NOT clobbered', () => {
  const sessionId = 'sess-lock-2002'
  const pendingId = 'sess-pending-2002'
  const existingId = 'sess-existing-2002'
  const slug = 'rekey-spec'
  const { root, transcriptPath } = makeFixture({
    sessionId,
    slug,
    pendingSessions: [pendingId],
    preExistingSessions: [existingId],
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    // The pre-existing session must still be present and unmodified (not overwritten).
    const existing = join(root, 'specs', slug, 'sessions', existingId, `${existingId}.jsonl`)
    assert.ok(
      existsSync(existing),
      `the pre-existing session ${existingId} must SURVIVE the re-key (store accumulates, never overwrites)`,
    )
    assert.equal(
      readFileSync(existing, 'utf8'),
      `PREEXISTING_MARKER_${existingId}\n`,
      'the pre-existing session bytes must be untouched by the re-key (append, not clobber)',
    )

    // ...AND the newly re-keyed session is also present: BOTH dirs coexist.
    const moved = join(root, 'specs', slug, 'sessions', pendingId, `${pendingId}.jsonl`)
    assert.ok(
      existsSync(moved),
      `the re-keyed pending session ${pendingId} must ALSO be present -> both session dirs coexist`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// (c-ii) TWO distinct pending sessions of the same slug both re-key in, both surviving.
// The accumulation guarantee across multiple stagings: a scan-and-move of ALL pending
// dirs lands every one in its own <id>/ subdir, none clobbering another.
test('part2 (c-ii): two distinct pending sessions both re-key under the same slug -- both dirs present (no clobber)', () => {
  const sessionId = 'sess-lock-2003'
  const pendingA = 'sess-pending-A-2003'
  const pendingB = 'sess-pending-B-2003'
  const slug = 'rekey-spec'
  const { root, transcriptPath } = makeFixture({
    sessionId,
    slug,
    pendingSessions: [pendingA, pendingB],
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    const movedA = join(root, 'specs', slug, 'sessions', pendingA, `${pendingA}.jsonl`)
    const movedB = join(root, 'specs', slug, 'sessions', pendingB, `${pendingB}.jsonl`)
    assert.ok(
      existsSync(movedA),
      `pending session ${pendingA} must re-key into the slug store (got nothing -> not all pending dirs scanned/moved)`,
    )
    assert.ok(
      existsSync(movedB),
      `pending session ${pendingB} must ALSO re-key into the slug store -> both accumulate, neither clobbered`,
    )
    // Each kept its own bytes (the moves did not collide / overwrite one another).
    assert.equal(readFileSync(movedA, 'utf8'), `PENDING_MARKER_${pendingA}\n`)
    assert.equal(readFileSync(movedB, 'utf8'), `PENDING_MARKER_${pendingB}\n`)

    // Both pending sources are gone (true moves).
    assert.equal(
      existsSync(join(root, 'specs', '_pending-sessions', pendingA)),
      false,
      `specs/_pending-sessions/${pendingA}/ must be gone after re-key (moved, not copied)`,
    )
    assert.equal(
      existsSync(join(root, 'specs', '_pending-sessions', pendingB)),
      false,
      `specs/_pending-sessions/${pendingB}/ must be gone after re-key (moved, not copied)`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
