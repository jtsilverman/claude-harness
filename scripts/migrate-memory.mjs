// migrate-memory.mjs -- the idempotent frontmatter-migration for the memory store (chunk B2).
//
// MERGES status/tags/importance/created_at INTO each ENTRY file's EXISTING YAML frontmatter
// block. Entry files already carry name/description (+ metadata.type as the kind); the new
// keys are appended to the ONE existing block -- never a second `---` block. The markdown body
// after the closing `---` stays byte-identical (only the frontmatter block is rewritten).
//
// ENTRY-VS-STRUCTURAL: only files whose top-level frontmatter carries BOTH `name:` and
// `description:` are entries. Structural files (bucket INDEX.md, MEMORY.md) carry no such
// frontmatter and are SKIPPED -- this is the predicate the B1 index agrees on (an entry is a
// file with real entry frontmatter; the index's permissive walker indexes everything, but the
// migration's entry SET is the name+description predicate, the universal marker across the
// store's flat and nested frontmatter shapes).
//
// FIELD SOURCES:
//   - status:      defaults to 'active'.
//   - tags (3-6):  from the injected tagger (canned in tests; batches ~30 files/call to
//                  `claude -p --model sonnet` in production -- see defaultTagger).
//   - importance:  from the injected tagger (1-10).
//   - created_at:  the file mtime via fs.stat, captured BEFORE the migration's own write
//                  resets it, serialized ISO-8601. (mtime is the best universally-available
//                  signal; git first-commit date was NOT used -- the store is gitignored /
//                  Syncthing-synced, so most files are untracked and a git lookup would be a
//                  per-file spawn for a value mtime already supplies.)
//
// IDEMPOTENT + SUBSET-RERUNNABLE: a file already carrying all four keys is skipped (no diff);
// accepts a subset (a file list or a dir) so a delta sweep re-runs over only new files.
//
// After injection, triggers an index build (reuses memory-index.mjs's rebuild) so the migrated
// entries are queryable.
//
// CLI:  node scripts/migrate-memory.mjs [--store PATH] [--db PATH] [file-or-dir ...]
//
// FIREWALL: parameterizable on the store path so it builds/tests against a fixture store and
// never touches the live ~/.claude memory store unless explicitly pointed at it.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { rebuild } from './memory-index.mjs'

const DEFAULT_STORE = join(homedir(), '.claude', 'projects', '-Users-admin--claude', 'memory')
const DEFAULT_DB = join(homedir(), '.claude', 'memory-index.db')

// the keys this migration injects (top-level, where the B1 index reads them).
const INJECTED_KEYS = ['status', 'tags', 'importance', 'created_at']

// Sanitise an importance value from a tagger: must be an integer in [1, 10].
// Out-of-range values are clamped; non-finite values default to 5.
function sanitiseImportance(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 5
  return Math.max(1, Math.min(10, Math.round(n)))
}

// Sanitise a tags array from a tagger: keep only string items, cap at 6.
function sanitiseTags(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter((t) => typeof t === 'string').slice(0, 6)
}

// ---- frontmatter split + top-level key detection ----------------------------------------
// Returns { fmText, body, raw } where fmText is the inner YAML (between the fences) and body
// is everything after the closing `---\n`. Returns null when there is no frontmatter block.
function splitFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return null
  return { fmText: m[1], body: m[2], raw }
}

// Top-level keys are lines matching `key:` at column 0 (indented lines belong to a nested
// block like `metadata:` and are NOT top-level). Returns a Set of the top-level key names.
function topLevelKeys(fmText) {
  const keys = new Set()
  for (const line of fmText.split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):/)
    if (kv) keys.add(kv[1])
  }
  return keys
}

// An entry file carries BOTH `name:` and `description:` at the top level of its frontmatter.
// Structural files (INDEX.md, MEMORY.md) carry neither -> not entries.
function isEntry(raw) {
  const fm = splitFrontmatter(raw)
  if (!fm) return false
  const keys = topLevelKeys(fm.fmText)
  return keys.has('name') && keys.has('description')
}

// Already-migrated == all four injected keys already present at the top level.
function alreadyMigrated(fmText) {
  const keys = topLevelKeys(fmText)
  return INJECTED_KEYS.every((k) => keys.has(k))
}

// Read the `kind` for an entry from the frontmatter, handling both flat and nested shapes:
//   - flat: a top-level `kind:` or `type:` key.
//   - nested: a `metadata:` block containing `kind:` or `type:` on an indented line.
// Returns the kind string (e.g. 'pattern', 'feedback') or null when absent.
// Used by the migration to promote the kind to a top-level key so the B1 index can read it
// (parseFrontmatter in memory-index.mjs only scans top-level lines).
function readKind(fmText) {
  const topKind = fmText.match(/^kind:\s*(\S.*)$/m)
  if (topKind) return topKind[1].trim()
  const topType = fmText.match(/^type:\s*(\S.*)$/m)
  if (topType) return topType[1].trim()
  // nested: look inside the `metadata:` block for an indented `kind:` or `type:` line.
  const nestedKind = fmText.match(/^metadata:[\s\S]*?^\s+kind:\s*(\S.*)$/m)
  if (nestedKind) return nestedKind[1].trim()
  const nestedType = fmText.match(/^metadata:[\s\S]*?^\s+type:\s*(\S.*)$/m)
  if (nestedType) return nestedType[1].trim()
  return null
}

// ---- the YAML serialization for the injected keys ---------------------------------------
// Minimal, deterministic emit for the scalar/list shapes the schema needs. tags -> a JSON-
// style inline array (the same shape the B1 parser reads); status/importance/created_at ->
// plain scalars. Only keys NOT already present at the top level are emitted, so a partially-
// migrated entry (e.g. an interrupted earlier run left status+tags) gains only its missing
// keys -- never a duplicate `status:`/`tags:` line. Nested structure (the `metadata:` block)
// is untouched.
// kind: promoted to top-level when the entry carries it only in a nested metadata block --
// the B1 index's parseFrontmatter only reads top-level lines, so a nested metadata.kind would
// otherwise be invisible (falling back to 'reference'). Injected only when absent at top-level.
function emitInjectedKeys({ status, tags, importance, created_at, kind }, present) {
  const lines = []
  if (!present.has('status')) lines.push(`status: ${status}`)
  if (!present.has('tags')) lines.push(`tags: ${JSON.stringify(tags)}`) // ["a","b","c"]
  if (!present.has('importance')) lines.push(`importance: ${importance}`)
  if (!present.has('created_at')) lines.push(`created_at: ${created_at}`)
  // Promote kind to top-level only when no top-level kind/type exists AND the entry has one.
  if (kind && !present.has('kind') && !present.has('type')) lines.push(`kind: ${kind}`)
  return lines.join('\n')
}

// Rewrite ONLY the frontmatter block: keep the existing inner YAML verbatim, append the
// MISSING injected key lines, re-fence, then re-attach the byte-identical body. Trailing
// whitespace on the existing block is trimmed at the join so we don't emit a blank line before
// the new keys.
function mergeFrontmatter(raw, injected) {
  const fm = splitFrontmatter(raw)
  const existing = fm.fmText.replace(/\s+$/, '') // drop trailing blank lines inside the block
  const newKeys = emitInjectedKeys(injected, topLevelKeys(fm.fmText))
  const newFm = newKeys ? `${existing}\n${newKeys}` : existing
  return `---\n${newFm}\n---\n${fm.body}`
}

// ---- file collection (subset or whole store) --------------------------------------------
function walkMd(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkMd(p))
    else if (ent.isFile() && ent.name.endsWith('.md')) out.push(p)
  }
  return out
}

// Resolve the working file list: an explicit `files` list (each may be a file or a dir) takes
// precedence; otherwise the whole store is walked.
function resolveFiles(storePath, files) {
  if (!files || files.length === 0) return walkMd(storePath)
  const out = []
  for (const f of files) {
    const st = statSync(f)
    if (st.isDirectory()) out.push(...walkMd(f))
    else if (f.endsWith('.md')) out.push(f)
  }
  return out
}

// ---- the production tagger (mockable seam) ----------------------------------------------
// Batches ~30 files/call to `claude -p --model sonnet`, asking for 3-6 tags + a 1-10
// importance per entry. Tests inject a canned tagger instead; this default is the production
// path and is never exercised in the fixture suite (no live claude -p in tests).
const TAGGER_BATCH = 30

async function defaultTagger(entries) {
  const out = []
  for (let i = 0; i < entries.length; i += TAGGER_BATCH) {
    const batch = entries.slice(i, i + TAGGER_BATCH)
    const prompt = buildTaggerPrompt(batch)
    const res = spawnSync('claude', ['-p', '--model', 'sonnet'], { input: prompt, encoding: 'utf8' })
    if (res.status !== 0) {
      throw new Error(`tagger: claude -p failed (status ${res.status}): ${res.stderr || ''}`)
    }
    const parsed = JSON.parse(extractJson(res.stdout))
    for (const e of batch) {
      const got = parsed[e.id] || {}
      out.push({
        id: e.id,
        tags: sanitiseTags(got.tags),
        importance: sanitiseImportance(got.importance),
      })
    }
  }
  return out
}

function buildTaggerPrompt(batch) {
  const items = batch.map((e) => `## ${e.id}\nname: ${e.name}\ndescription: ${e.description}`).join('\n\n')
  return [
    'For each entry below, return 3-6 short topical tags and an importance score from 1 (trivia)',
    'to 10 (load-bearing). Respond with ONLY a JSON object keyed by the entry id, each value',
    '{ "tags": [...], "importance": N }. No prose.',
    '',
    items,
  ].join('\n')
}

// pull the first {...} JSON object out of an LLM response that may wrap it in prose/fences.
function extractJson(s) {
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) throw new Error('tagger: no JSON object in response')
  return s.slice(start, end + 1)
}

// ---- migrate ----------------------------------------------------------------------------
// Merge the four lifecycle/ranking keys into every entry file in scope, skipping structural
// files and already-migrated files, leaving the body byte-identical, then rebuild the index.
//
// Options:
//   storePath   the store root (default: the live store; tests pass a fixture dir).
//   files       optional subset (a list of files and/or dirs) to migrate instead of the store.
//   dbPath      the index db path (default: the live db; tests pass a fixture db).
//   tagger      the injectable tagging seam (default: defaultTagger -> claude -p).
//   buildIndex  whether to rebuild the index after injection (default true).
//
// Returns a summary { migrated: [...ids], skipped: [...{id,reason}], indexed: bool }.
export async function migrate({
  storePath = DEFAULT_STORE,
  files,
  dbPath = DEFAULT_DB,
  tagger = defaultTagger,
  buildIndex = true,
} = {}) {
  const candidates = resolveFiles(storePath, files)

  // Phase 1: select entry files that still need migration; capture each one's pre-write mtime.
  const pending = []
  const skipped = []
  for (const file of candidates) {
    const raw = readFileSync(file, 'utf8')
    if (!isEntry(raw)) { skipped.push({ id: file, reason: 'structural' }); continue }
    const fm = splitFrontmatter(raw)
    if (alreadyMigrated(fm.fmText)) { skipped.push({ id: file, reason: 'already-migrated' }); continue }
    // created_at from the file mtime captured BEFORE this migration's own write resets it.
    const created_at = statSync(file).mtime.toISOString()
    pending.push({
      file,
      raw,
      id: fileId(storePath, file),
      name: scalar(fm.fmText, 'name'),
      description: scalar(fm.fmText, 'description'),
      created_at,
      // kind: read from top-level kind/type OR promoted from metadata.kind/metadata.type.
      // Passed to mergeFrontmatter so a nested-only kind is promoted to the top-level YAML
      // key that parseFrontmatter in memory-index.mjs can read (it only scans top-level lines).
      kind: readKind(fm.fmText),
    })
  }

  // Phase 2: one tagger pass over all pending entries (the seam batches internally).
  const tagInfo = pending.length ? await tagger(pending.map((p) => ({
    id: p.id, name: p.name, description: p.description,
  }))) : []
  const byId = new Map(tagInfo.map((t) => [t.id, t]))

  // Phase 3: rewrite each pending file's frontmatter block (body byte-identical).
  // Sanitise tagger output here (the canonical consumption point) so any injected tagger --
  // canned, production, or test -- goes through the same guards before writing to disk.
  const migrated = []
  for (const p of pending) {
    const t = byId.get(p.id) || { tags: [], importance: 5 }
    const merged = mergeFrontmatter(p.raw, {
      status: 'active',
      tags: sanitiseTags(t.tags),
      importance: sanitiseImportance(t.importance),
      created_at: p.created_at,
      kind: p.kind,
    })
    writeFileSync(p.file, merged)
    migrated.push(p.id)
  }

  // Phase 4: rebuild the index so the migrated entries are queryable.
  let indexed = false
  if (buildIndex) {
    await rebuild({ storePath, dbPath, scope: 'global' })
    indexed = true
  }

  return { migrated, skipped, indexed }
}

// the id passed to the tagger / used as the index slug: store-relative path sans .md.
function fileId(storePath, file) {
  const rel = file.startsWith(storePath) ? file.slice(storePath.length).replace(/^[/\\]/, '') : file
  return rel.replace(/\.md$/, '').split(/[/\\]/).join('/')
}

// read a single top-level scalar key from the inner YAML (for name/description handed to the
// tagger). Strips surrounding quotes; returns '' when absent.
function scalar(fmText, key) {
  const m = fmText.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
  if (!m) return ''
  let v = m[1].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  return v
}

// ---- CLI --------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--store') args.store = argv[++i]
    else if (a === '--db') args.db = argv[++i]
    else args._.push(a)
  }
  return args
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2))
  const storePath = args.store || DEFAULT_STORE
  if (!existsSync(storePath)) {
    console.error(`migrate-memory: store path does not exist: ${storePath}`)
    process.exit(2)
  }
  const t0 = Date.now()
  const summary = await migrate({
    storePath,
    files: args._.length ? args._ : undefined,
    dbPath: args.db || DEFAULT_DB,
  })
  console.log(
    `migrate-memory: ${summary.migrated.length} migrated, ${summary.skipped.length} skipped, ` +
    `index ${summary.indexed ? 'rebuilt' : 'untouched'} in ${Date.now() - t0}ms`
  )
}
