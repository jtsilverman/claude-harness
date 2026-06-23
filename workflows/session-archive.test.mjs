// session-archive.test.mjs -- RED for Chunk 1: the SessionEnd ARCHIVE hook
// (hooks/session-archive.sh), which replaces the old per-/clear GRADE trigger with
// an ARCHIVE trigger and restores user_corpus_extract corpus capture.
//
// WHAT THIS PINS (the chunk's full acceptance contract -- every criterion has at
// least one assertion that fails if that criterion is unmet):
//   (A) Signal A -- a LOCKED current.md present -> the session is archived under the
//       per-spec store keyed by the `slug:` frontmatter: <cwd>/specs/<slug>/sessions/<id>/.
//   (B) Signal B -- current.md ABSENT but a specs/archive/<slug>-<today>.md was just
//       written (the ship session, which deleted current.md) -> archived keyed to the
//       archive filename stem MINUS the trailing -YYYYMMDD.
//   (C) Signal C -- a NON-locked current.md (pre-lock drafting) -> staged by session-id
//       in the pending bucket <cwd>/specs/_pending-sessions/<id>/ (no slug yet).
//   (None) -- no spec signal -> NO per-spec archive is created, but corpus STILL fires.
//   (Corpus) -- a fresh coo/voice-corpus-raw/<id>.md is written on EVERY qualifying clear
//       (fires even in the None case).
//   (Recursive copy) -- the archive is a RECURSIVE copy of the session DIR, so a nested
//       workflow-subagent transcript at <id>/subagents/<sub>.jsonl lands in the store too.
//   (COPY not reference) -- the store holds an independent COPY: mutating the source
//       transcript AFTER the archive does not change the archived bytes.
//   (Orphan) -- a transcript_path whose sibling session DIR does not exist -> the hook
//       copies the lone .jsonl and DOES NOT crash (exit 0).
//
// LIVE-INTEGRATION (testing-discipline requires it for hook chunks): a real SessionEnd
// firing the registered hook is exercised at chunk 6 (arming) per the spec's test
// strategy, NOT here -- arming settings.json is a separate the operator-gated chunk. This file
// is the unit/behavioral RED; the live fire is documented as belonging to chunk 6.
//
// HERMETIC DESIGN (no worktree pollution). The hook self-locates config_root from
// ${BASH_SOURCE[0]}/.. and runs the corpus extractor relative to it, while spec-detection
// + the per-spec archive run against the payload `cwd`. To keep BOTH possible output
// anchorings (config_root OR cwd) inside an isolated fixture, each test:
//   1. mkdtemps a fixture root,
//   2. copies the REAL scripts/user_corpus_extract.py into <fixture>/scripts/ (reuse the
//      proven extractor, not a re-implementation),
//   3. copies hooks/session-archive.sh into <fixture>/hooks/ and invokes THAT copy, so
//      config_root == <fixture> AND the payload cwd == <fixture>. Nothing escapes the tmp.
// The hook does NOT exist yet, so the copy finds no source and the spawn fails; every
// assertion then checks landed files that do not exist -> a clean per-behavior RED
// (feature missing), never a module-load crash.
//
// ANTI-TAUTOLOGY: every expected path, slug, and corpus location is hand-derived from the
// chunk contract (slug "demo-spec" from a hand-written frontmatter line; archive stem
// "shipped-spec" from a hand-written "shipped-spec-<today>.md"; pending keyed by the
// hand-chosen session-id), never read back from the script. The planted nested-subagent
// bytes and the source-mutation bytes are fixed literals, asserted by content, not by
// any call shape.
//
// Run: node --test workflows/session-archive.test.mjs

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
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKTREE_ROOT = dirname(HERE) // workflows/ -> worktree root
const HOOK_SRC = join(WORKTREE_ROOT, 'hooks', 'session-archive.sh')
const CORPUS_SRC = join(WORKTREE_ROOT, 'scripts', 'user_corpus_extract.py')

// Today's date in the YYYYMMDD form the spec uses for the signal-B archive suffix.
function today() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

// A genuine-the operator prose line (content is a plain string not starting with '<') so the
// reused corpus extractor's filter KEEPS it and writes a corpus file. Hand-written.
const JAKE_LINE = 'archive this session and grade the whole arc at ship'

function jakeTranscript(sessionId) {
  // Minimal but realistic main-transcript JSONL: one assistant turn then one genuine
  // the operator user message. The extractor keeps the the operator line and writes the corpus .md.
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

// Build an isolated fixture: a copy of the hook + corpus extractor under <fixture>, a fake
// <projects> tree holding the session DIR + sibling .jsonl (+ optional nested subagent),
// and the spec files the requested signal needs. Returns the paths the assertions read.
//
// opts:
//   sessionId       the session id (basename of the dir / .jsonl)
//   makeSessionDir  whether to create the sibling session DIR (false => orphan case)
//   nested          whether to plant <dir>/subagents/<sub>.jsonl (recursive-copy probe)
//   spec            'A' (locked current.md) | 'B' (archive file, no current.md) |
//                   'C' (non-locked current.md) | 'none' (no spec signal)
//   slug            the slug to write into current.md frontmatter (signal A)
//   archiveStem     the archive filename stem (signal B) -> file is <stem>-<today>.md
function makeFixture(opts) {
  const {
    sessionId,
    makeSessionDir = true,
    nested = false,
    spec = 'none',
    slug = 'demo-spec',
    archiveStem = 'shipped-spec',
    // (finding 1) write the slug as the REAL BOLD markdown line `**slug:** <x>`
    // (production current.md shape) instead of the bare `slug: <x>` fixture shape.
    boldSlug = false,
    // (finding 2) plant a `<config_root>/plans/<name>` file with a RECENT mtime to
    // simulate a plan that was "just consumed" during the session (Signal C plans arm).
    // { name, mtimeEpochSec } — mtime in seconds since epoch (Date.now()/1000 = now).
    plansFile = null,
    // (finding 3) plant ADDITIONAL same-day archive files besides the keyed one, each
    // with a controlled mtime, to prove the tie-break keys to the most-recent archive.
    // Array of { stem, mtimeEpochSec }. The base archiveStem (spec 'B') is the most-recent.
    extraArchives = [],
    // (fix-loop) stamp the SIMPLE-path (no extraArchives) Signal B keyed archive with a
    // controlled mtime so a test can make the same-day archive STALE relative to a fresh
    // plans file. Only applies when spec === 'B' AND extraArchives is empty. Seconds-epoch.
    archiveMtimeEpochSec = null,
  } = opts

  const root = mkdtempSync(join(tmpdir(), 'session-archive-'))

  // Copy the hook + corpus extractor INTO the fixture so config_root resolves here.
  mkdirSync(join(root, 'hooks'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  if (existsSync(HOOK_SRC)) copyFileSync(HOOK_SRC, join(root, 'hooks', 'session-archive.sh'))
  if (existsSync(CORPUS_SRC)) copyFileSync(CORPUS_SRC, join(root, 'scripts', 'user_corpus_extract.py'))

  // Fake projects tree: the session DIR and its SIBLING .jsonl (the on-disk layout the
  // payload describes). transcript_path = <projects>/<id>.jsonl; dir = ${path%.jsonl}.
  const projects = join(root, 'projects')
  mkdirSync(projects, { recursive: true })
  const transcriptPath = join(projects, `${sessionId}.jsonl`)
  writeFileSync(transcriptPath, jakeTranscript(sessionId))

  if (makeSessionDir) {
    const sessionDir = join(projects, sessionId)
    mkdirSync(sessionDir, { recursive: true })
    // A small file directly in the session dir (so a recursive copy has dir content).
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify({ id: sessionId }))
    if (nested) {
      const subDir = join(sessionDir, 'subagents')
      mkdirSync(subDir, { recursive: true })
      writeFileSync(join(subDir, 'worker-1.jsonl'), 'NESTED_SUBAGENT_TRANSCRIPT_MARKER\n')
    }
  }

  // Spec signal scaffolding under <fixture>/specs (the payload cwd is <fixture>).
  const specsDir = join(root, 'specs')
  mkdirSync(specsDir, { recursive: true })
  if (spec === 'A') {
    // The slug line: BOLD markdown `**slug:** <x>` (the real production shape) when
    // boldSlug, else the bare `slug: <x>` fixture shape. The Status line stays bold
    // either way (matches production). A robust parser must read the slug from BOTH.
    const slugLine = boldSlug ? `**slug:** ${slug}` : `slug: ${slug}`
    writeFileSync(
      join(specsDir, 'current.md'),
      `# Spec\n\n**Status:** Locked ${today()}\n${slugLine}\n`,
    )
  } else if (spec === 'B') {
    const archiveDir = join(specsDir, 'archive')
    mkdirSync(archiveDir, { recursive: true })
    const keyedPath = join(archiveDir, `${archiveStem}-${today()}.md`)
    if (extraArchives.length === 0) {
      // Simple Signal B: the lone just-written archive names the slug.
      writeFileSync(keyedPath, '# Archived spec\n')
      // (fix-loop) optionally stamp the keyed archive's mtime so a test can make it STALE
      // relative to a just-consumed plans file (plans-vs-archive precedence test).
      if (typeof archiveMtimeEpochSec === 'number') {
        utimesSync(keyedPath, archiveMtimeEpochSec, archiveMtimeEpochSec)
      }
    } else {
      // (finding 3) Create the DECOY same-day archives FIRST (directory-insertion order
      // first, so `find ... | head -n1` -- which returns insertion order on this FS --
      // yields a DECOY, exposing the order-dependent bug). Give the decoys OLDER mtimes.
      // Then create the keyed archive LAST and stamp it NEWEST, so a deterministic
      // most-recently-modified tie-break (the fix) selects archiveStem regardless of
      // find/readdir order. This makes the two implementations PROVABLY diverge:
      //   current `find|head -n1` -> a decoy (RED);  fix `ls -t`/mtime -> archiveStem.
      for (const extra of extraArchives) {
        const f = join(archiveDir, `${extra.stem}-${today()}.md`)
        writeFileSync(f, '# Other same-day archive (decoy)\n')
        if (typeof extra.mtimeEpochSec === 'number') {
          utimesSync(f, extra.mtimeEpochSec, extra.mtimeEpochSec)
        }
      }
      writeFileSync(keyedPath, '# Archived spec (the real, most-recent ship)\n')
      const newest = Math.floor(Date.now() / 1000)
      utimesSync(keyedPath, newest, newest)
    }
  } else if (spec === 'C') {
    // A non-locked current.md: pre-lock drafting, no slug yet.
    writeFileSync(join(specsDir, 'current.md'), `# Draft spec\n\n**Status:** Draft\n`)
  }
  // spec === 'none': no current.md, no archive file -> not spec-related.

  // (finding 2) Signal C plans arm: plant a `<config_root>/plans/<name>` file. The hook
  // copy lives at <fixture>/hooks/, so its self-located config_root IS <fixture>; the
  // hermetic plans dir is therefore <fixture>/plans/. A RECENT mtime models "just
  // consumed". (This avoids reading the operator's live ~/.claude/plans on every fire.)
  if (plansFile) {
    const plansDir = join(root, 'plans')
    mkdirSync(plansDir, { recursive: true })
    const pf = join(plansDir, plansFile.name)
    writeFileSync(pf, '# A plan that was just consumed this session\n')
    if (typeof plansFile.mtimeEpochSec === 'number') {
      utimesSync(pf, plansFile.mtimeEpochSec, plansFile.mtimeEpochSec)
    }
  }

  return { root, transcriptPath, sessionId }
}

// Run the hook copy inside the fixture with a SessionEnd payload on stdin. cwd is set to
// the fixture root (the payload also carries cwd=root). Captures status WITHOUT throwing,
// so a missing-hook spawn failure does not abort the test before its behavioral assertion.
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

// Locate the corpus file anywhere under the fixture (it lands relative to cwd OR
// config_root, both == the fixture root in this harness). Returns the path or null.
function corpusPath(root, sessionId) {
  const candidates = [
    join(root, 'coo', 'voice-corpus-raw', `${sessionId}.md`),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// --- (Acceptance + A) signal-A locked spec -> archive under specs/<slug>/sessions/<id>/,
//     the copy is RECURSIVE (nested subagent lands), AND a corpus .md is written. --------
test('signal A: locked current.md -> recursive copy under specs/<slug>/sessions/<id>/ + corpus written', () => {
  const sessionId = 'sess-A-0001'
  const slug = 'demo-spec'
  const { root, transcriptPath } = makeFixture({
    sessionId,
    spec: 'A',
    slug,
    nested: true,
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    const store = join(root, 'specs', slug, 'sessions', sessionId)
    // The sibling .jsonl is copied into the store.
    assert.ok(
      existsSync(join(store, `${sessionId}.jsonl`)),
      `signal A must copy the .jsonl into ${join(store, sessionId + '.jsonl')}`,
    )
    // The recursive copy of the session DIR carries the nested subagent transcript.
    const nestedCopy = join(store, sessionId, 'subagents', 'worker-1.jsonl')
    assert.ok(
      existsSync(nestedCopy),
      `recursive copy must carry the nested subagent transcript to ${nestedCopy}`,
    )
    assert.equal(
      readFileSync(nestedCopy, 'utf8'),
      'NESTED_SUBAGENT_TRANSCRIPT_MARKER\n',
      'nested subagent transcript bytes must survive the recursive copy',
    )
    // Corpus fired: a fresh coo/voice-corpus-raw/<id>.md with the operator's line.
    const corpus = corpusPath(root, sessionId)
    assert.ok(corpus, `corpus must write coo/voice-corpus-raw/${sessionId}.md`)
    assert.match(
      readFileSync(corpus, 'utf8'),
      new RegExp(JAKE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'corpus must contain the genuine the operator message',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- (B) signal-B ship session: current.md ABSENT, archive file present -> key = stem
//     minus -YYYYMMDD. ----------------------------------------------------------------
test('signal B: no current.md but specs/archive/<stem>-<today>.md -> archive under specs/<stem>/sessions/<id>/', () => {
  const sessionId = 'sess-B-0002'
  const archiveStem = 'shipped-spec'
  const { root, transcriptPath } = makeFixture({
    sessionId,
    spec: 'B',
    archiveStem,
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    // Key is the archive stem with the trailing -YYYYMMDD stripped.
    const store = join(root, 'specs', archiveStem, 'sessions', sessionId)
    assert.ok(
      existsSync(join(store, `${sessionId}.jsonl`)),
      `signal B must archive under specs/${archiveStem}/sessions/${sessionId}/ (stem minus -YYYYMMDD)`,
    )
    // It must NOT mis-key under the dated name.
    assert.equal(
      existsSync(join(root, 'specs', `${archiveStem}-${today()}`, 'sessions', sessionId)),
      false,
      'signal B must strip the -YYYYMMDD suffix, not key by the dated archive filename',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- (C) signal-C pre-lock drafting: non-locked current.md -> stage in the pending
//     bucket by session-id (no slug yet). ------------------------------------------
test('signal C: non-locked current.md -> stage in specs/_pending-sessions/<id>/', () => {
  const sessionId = 'sess-C-0003'
  const { root, transcriptPath } = makeFixture({ sessionId, spec: 'C' })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    const pending = join(root, 'specs', '_pending-sessions', sessionId)
    assert.ok(
      existsSync(join(pending, `${sessionId}.jsonl`)),
      `signal C must stage the session in specs/_pending-sessions/${sessionId}/`,
    )
    // A pre-lock session has no slug -> it must NOT land in a slugged sessions/ store.
    assert.equal(
      existsSync(join(root, 'specs', 'demo-spec', 'sessions', sessionId)),
      false,
      'signal C has no slug yet -> must not create a slugged per-spec store',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- (None) no spec signal -> NO per-spec archive, but corpus STILL fires. ----------
test('none: not spec-related -> no per-spec archive, but corpus still fires', () => {
  const sessionId = 'sess-none-0004'
  const { root, transcriptPath } = makeFixture({ sessionId, spec: 'none' })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    // No archive anywhere under specs/ keyed by this session.
    assert.equal(
      existsSync(join(root, 'specs', 'demo-spec', 'sessions', sessionId)),
      false,
      'None case must NOT create a per-spec archive',
    )
    assert.equal(
      existsSync(join(root, 'specs', '_pending-sessions', sessionId)),
      false,
      'None case must NOT stage in the pending bucket either',
    )
    // Corpus fires regardless of spec-relatedness.
    const corpus = corpusPath(root, sessionId)
    assert.ok(
      corpus,
      `corpus must still write coo/voice-corpus-raw/${sessionId}.md even when no spec signal matches`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- (Orphan) transcript_path with no sibling session DIR -> copy the lone .jsonl,
//     do not crash (exit 0). --------------------------------------------------------
test('orphan: transcript_path with no sibling dir -> copy the .jsonl alone, exit 0', () => {
  const sessionId = 'sess-orphan-0005'
  const slug = 'demo-spec'
  const { root, transcriptPath } = makeFixture({
    sessionId,
    makeSessionDir: false, // orphan: only the .jsonl exists, no sibling dir
    spec: 'A',
    slug,
  })
  try {
    const res = runHook(root, payloadFor(root, transcriptPath, sessionId))

    // Must not crash on the missing directory.
    assert.equal(res.status, 0, 'orphan-session hook must exit 0 (fail-open), not crash')
    // The lone .jsonl is still copied into the per-spec store.
    const store = join(root, 'specs', slug, 'sessions', sessionId)
    assert.ok(
      existsSync(join(store, `${sessionId}.jsonl`)),
      'orphan case must still copy the lone .jsonl into the per-spec store',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- (COPY not reference) the store is an independent COPY: mutating the source AFTER
//     the archive does not change the archived bytes. ---------------------------------
test('copy-not-reference: mutating the source transcript after archive does not change the stored copy', () => {
  const sessionId = 'sess-copy-0006'
  const slug = 'demo-spec'
  const { root, transcriptPath } = makeFixture({ sessionId, spec: 'A', slug })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    const stored = join(root, 'specs', slug, 'sessions', sessionId, `${sessionId}.jsonl`)
    assert.ok(existsSync(stored), 'precondition: the .jsonl must have been archived')
    const archivedBytes = readFileSync(stored, 'utf8')

    // Mutate the SOURCE after archiving; a reference would change too.
    writeFileSync(transcriptPath, 'MUTATED_AFTER_ARCHIVE\n')
    assert.equal(
      readFileSync(stored, 'utf8'),
      archivedBytes,
      'the per-spec store must be an independent COPY, unaffected by later source edits',
    )
    assert.notEqual(
      readFileSync(stored, 'utf8'),
      'MUTATED_AFTER_ARCHIVE\n',
      'the stored copy must not reflect a post-archive mutation of the source',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ============================================================================
// FIX-LOOP REDs (chunk-1 fix-loop). The hook is already committed (d03139b);
// these three tests reproduce the Codex/Sonnet live-fire findings before the fix.
// ============================================================================

// --- (FIX 1, P1 LOAD-BEARING) Signal A on the REAL BOLD slug shape -------------------
//     Production current.md carries the slug as a BOLD markdown line `**slug:** <x>`,
//     NOT the bare `slug: <x>` the old fixture used. The hook's `grep '^slug:'` does not
//     match the bold line, so slug resolves EMPTY, the `[ -n "$slug" ]` guard leaves the
//     store dir empty, and Signal A SILENTLY SKIPS the archive. This test uses the real
//     bold shape; it FAILS before the fix (no archive lands) and passes once the slug is
//     parsed robustly. (The slug here is the real production value to mirror the live fire.)
test('FIX1 signal A bold slug: **slug:** frontmatter still archives under specs/<slug>/sessions/<id>/', () => {
  const sessionId = 'sess-A-bold-0007'
  const slug = 'self-running-coo' // the real production slug shape, hand-derived
  const { root, transcriptPath } = makeFixture({
    sessionId,
    spec: 'A',
    slug,
    boldSlug: true, // write `**slug:** self-running-coo`, the production format
    nested: true,
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    // The archive MUST land keyed by the bold-parsed slug. Pre-fix the slug is empty,
    // store_dir is never set, and nothing is copied -> this existsSync is false -> RED.
    const store = join(root, 'specs', slug, 'sessions', sessionId)
    assert.ok(
      existsSync(join(store, `${sessionId}.jsonl`)),
      `signal A must parse the BOLD **slug:** line and copy the .jsonl into ${join(store, sessionId + '.jsonl')} (got nothing -> bold slug parse failed)`,
    )
    // The recursive dir copy (nested subagent) must also land under the bold-keyed store.
    const nestedCopy = join(store, sessionId, 'subagents', 'worker-1.jsonl')
    assert.ok(
      existsSync(nestedCopy),
      `signal A bold-slug recursive copy must carry the nested subagent transcript to ${nestedCopy}`,
    )
    // It must NOT mis-key by leaving the literal bold markers in the slug path (e.g. a
    // half-stripped `**self-running-coo**` directory). Only the clean slug is valid.
    assert.equal(
      existsSync(join(root, 'specs', `**${slug}**`, 'sessions', sessionId)),
      false,
      'signal A must strip the ** bold markers from the slug, not key under a `**slug**` dir',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- (FIX 2, MISSING CONTRACT ARM) Signal C plans-file "just consumed" arm -----------
//     Interfaces line 60 specifies Signal C as an OR: a non-Locked current.md exists,
//     OR a ~/.claude/plans file was just consumed. The hook implements only the
//     non-locked-current.md arm; the plans arm is ENTIRELY ABSENT. With NO current.md
//     present but a recently-modified plans file, the hook today falls through Signal B
//     (no archive file) to None and SKIPS the archive. This test plants a recent
//     <config_root>/plans/*.md (hermetic seam, see makeFixture) and asserts the session
//     stages in the pending bucket. FAILS before the fix; passes once the arm is added.
test('FIX2 signal C plans arm: no current.md but a just-consumed plans file -> stage in specs/_pending-sessions/<id>/', () => {
  const sessionId = 'sess-C-plans-0008'
  const nowSec = Math.floor(Date.now() / 1000)
  const { root, transcriptPath } = makeFixture({
    sessionId,
    spec: 'none', // NO current.md, NO archive file -> only the plans arm can match
    plansFile: { name: 'self-running-coo-plan.md', mtimeEpochSec: nowSec }, // just consumed
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    // Pre-lock session with a freshly-consumed plan -> stage by session-id in the pending
    // bucket (no slug yet). Pre-fix the plans arm is absent -> store_dir empty -> None ->
    // nothing staged -> this existsSync is false -> RED.
    const pending = join(root, 'specs', '_pending-sessions', sessionId)
    assert.ok(
      existsSync(join(pending, `${sessionId}.jsonl`)),
      `signal C plans arm must stage the session in specs/_pending-sessions/${sessionId}/ when a recent plans file was just consumed (got nothing -> plans arm missing)`,
    )
    // No slug exists yet -> it must NOT fabricate a slugged per-spec store.
    assert.equal(
      existsSync(join(root, 'specs', 'self-running-coo', 'sessions', sessionId)),
      false,
      'signal C plans arm has no slug yet -> must stage in the pending bucket, not a slugged store',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- (FIX 2b, negative control for the plans arm) a STALE plans file does NOT trigger --
//     The "just consumed" heuristic is recency-gated: an OLD plans file (modified well
//     outside the session window) must NOT count, or every session in a cwd that has ever
//     held a plan would be mis-archived. With no current.md, no archive file, and only a
//     stale plans file, the result must be None (no archive). This pins the heuristic's
//     recency edge so the FIX2 fix can't degenerate into "any plans file ever -> stage".
test('FIX2b signal C plans arm: a STALE plans file does NOT trigger the archive (None case)', () => {
  const sessionId = 'sess-C-stale-0009'
  const staleSec = Math.floor(Date.now() / 1000) - 24 * 60 * 60 // ~1 day old, clearly stale
  const { root, transcriptPath } = makeFixture({
    sessionId,
    spec: 'none',
    plansFile: { name: 'old-plan.md', mtimeEpochSec: staleSec },
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    // A stale plan is NOT "just consumed" -> no spec signal -> no archive anywhere.
    assert.equal(
      existsSync(join(root, 'specs', '_pending-sessions', sessionId)),
      false,
      'a STALE plans file must NOT stage a pending session (recency gate)',
    )
    // Corpus still fires in the None case (unchanged contract).
    const corpus = corpusPath(root, sessionId)
    assert.ok(
      corpus,
      'corpus must still fire even when the stale plans file does not trigger an archive',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- (FIX 3, P2 HARDENING) Signal B deterministic same-day tie-break -----------------
//     The hook keys Signal B via `find ... -name '*-<today>.md' | head -n1`; with >1
//     same-day archive present, find's directory-traversal order is UNSPECIFIED and
//     head -n1 picks an ARBITRARY file, mis-keying the store. Empirically, on this APFS
//     volume a populated archive dir of ~9 entries makes `find | head -n1` return a STALE
//     decoy (NOT the most-recent file) deterministically, while `ls -t | head -n1` (and
//     any `%T@`-sorted selection -- the fix) returns the just-written newest archive. So:
//       8 decoy archives (OLD mtimes, created FIRST) + 1 keyed archive (NEWEST mtime,
//       created LAST). Current `find|head -n1` -> a stale decoy stem -> archive keyed
//       under the WRONG slug -> the keyed-stem store is absent -> RED. The fix's
//       most-recently-modified tie-break -> the keyed stem -> store present -> GREEN.
//     The decoy stems all share a common prefix DISTINCT from the keyed stem, so the two
//     selections name PROVABLY different slugs (anti-tautology: keyed stem hand-chosen).
test('FIX3 signal B tie-break: multiple same-day archives -> keys to the MOST-RECENT archive stem, not an arbitrary find pick', () => {
  const sessionId = 'sess-B-tiebreak-0010'
  const archiveStem = 'the-real-most-recent-ship' // the keyed (newest) stem, hand-chosen
  const olderSec = Math.floor(Date.now() / 1000) - 2 * 60 * 60 // 2h older than the keyed file
  // 8 stale decoys, distinct from the keyed stem, all older. Enough entries that this
  // volume's `find` traversal order diverges from mtime, so `find|head -n1` lands on one
  // of these stale decoys rather than the newest keyed archive.
  const decoyStems = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((p) => `${p}-stale-draft`)
  const { root, transcriptPath } = makeFixture({
    sessionId,
    spec: 'B',
    archiveStem,
    extraArchives: decoyStems.map((stem) => ({ stem, mtimeEpochSec: olderSec })),
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    // The store MUST key to the MOST-RECENTLY-MODIFIED archive's stem (the keyed one),
    // not to whatever stale decoy `find|head -n1` happened to surface first.
    const store = join(root, 'specs', archiveStem, 'sessions', sessionId)
    assert.ok(
      existsSync(join(store, `${sessionId}.jsonl`)),
      `signal B must tie-break to the MOST-RECENT same-day archive and key under specs/${archiveStem}/sessions/${sessionId}/ (an arbitrary find|head -n1 keyed it elsewhere -> tie-break not deterministic)`,
    )
    // It must NOT mis-key under ANY of the stale decoy stems.
    for (const stem of decoyStems) {
      assert.equal(
        existsSync(join(root, 'specs', stem, 'sessions', sessionId)),
        false,
        `signal B must NOT key to the stale decoy archive '${stem}' (would mean it picked an arbitrary, non-most-recent same-day file)`,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- (FIX 4, P2 PRECEDENCE) recent plans outrank a STALE same-day archive ------------
//     Real workflow: ship spec X today (writes specs/archive/<X>-<today>.md, deletes
//     current.md), then SAME-DAY start a NEW creation session for spec Y before Y's
//     current.md exists (spec-collaboration consumes a fresh ~/.claude/plans/*.md). At
//     that NEW session's teardown, BOTH a same-day archive (X, STALE -- from the earlier
//     ship) AND a freshly-consumed plans file (Y, NEW) are present, with NO current.md.
//     Today Signal B fires first (any same-day archive -> key to it), mis-keying the NEW
//     creation session under the OLD shipped spec X's per-spec store -- corrupting per-spec
//     store integrity. The fix: when BOTH are present, let the RECENT plans file (newer
//     mtime) OUTRANK the STALE archive (older mtime) -> take Signal C (stage in the pending
//     bucket), not Signal B. FAILS before the fix (lands under the stale archive's stem);
//     passes once plans-vs-archive mtime precedence is added.
test('FIX4 plans-vs-archive precedence: a STALE same-day archive + a FRESH plans file -> Signal C wins (stage in pending), not keyed to the stale archive', () => {
  const sessionId = 'sess-precedence-0011'
  const staleArchiveStem = 'old-shipped-spec' // the EARLIER same-day ship, hand-chosen
  const nowSec = Math.floor(Date.now() / 1000)
  const staleArchiveSec = nowSec - 2 * 60 * 60 // the ship archive is 2h old (STALE)
  const { root, transcriptPath } = makeFixture({
    sessionId,
    spec: 'B', // a same-day archive IS present (no current.md), so Signal B would fire today
    archiveStem: staleArchiveStem,
    archiveMtimeEpochSec: staleArchiveSec, // ...but it is STALE
    // ...and a NEW creation session's plan was just consumed THIS session (FRESH, newer).
    plansFile: { name: 'self-running-coo-Y-plan.md', mtimeEpochSec: nowSec },
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    // The NEW creation session must stage in the PENDING bucket (Signal C wins): no slug
    // yet. Pre-fix Signal B fires first and keys to the stale archive -> pending absent -> RED.
    const pending = join(root, 'specs', '_pending-sessions', sessionId)
    assert.ok(
      existsSync(join(pending, `${sessionId}.jsonl`)),
      `a fresh plans file must OUTRANK a stale same-day archive -> stage in specs/_pending-sessions/${sessionId}/ (got nothing -> Signal B still wins over the recent plan)`,
    )
    // It must NOT be mis-keyed under the OLD shipped spec's per-spec store (the corruption
    // the fix prevents): the new creation session does not belong to spec X.
    assert.equal(
      existsSync(join(root, 'specs', staleArchiveStem, 'sessions', sessionId)),
      false,
      `the new creation session must NOT be keyed under the stale shipped spec '${staleArchiveStem}' (that mis-attributes it to the wrong per-spec store)`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- (FIX 4b, negative control) plain Signal B with NO recent plans still keys to the
//     archive. The precedence fix must NOT change the no-plans path: when there is no
//     recent plans file, a same-day archive still wins (Signal B), exactly as today.
test('FIX4b plans-vs-archive precedence: a same-day archive with NO recent plans still keys to the archive (Signal B unchanged)', () => {
  const sessionId = 'sess-precedence-noplans-0012'
  const archiveStem = 'shipped-spec-no-plans' // hand-chosen
  // A same-day archive, no plans file at all. Mtime is irrelevant here (no plans to compare).
  const { root, transcriptPath } = makeFixture({
    sessionId,
    spec: 'B',
    archiveStem,
    // plansFile: null -> no recent plan -> Signal B must still win.
  })
  try {
    runHook(root, payloadFor(root, transcriptPath, sessionId))

    // With no recent plans file, the same-day archive still keys the store (Signal B).
    const store = join(root, 'specs', archiveStem, 'sessions', sessionId)
    assert.ok(
      existsSync(join(store, `${sessionId}.jsonl`)),
      `with NO recent plans file, Signal B must still key under specs/${archiveStem}/sessions/${sessionId}/ (the precedence fix must not break the plain no-plans path)`,
    )
    // It must NOT divert to the pending bucket when there is no plan to outrank the archive.
    assert.equal(
      existsSync(join(root, 'specs', '_pending-sessions', sessionId)),
      false,
      'with no recent plans file, the archive wins -> must NOT stage in the pending bucket',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
