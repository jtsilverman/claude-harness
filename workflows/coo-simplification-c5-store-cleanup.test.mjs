// coo-simplification-c5-store-cleanup.test.mjs -- RED test for chunk 5
//
// CONTRACT under test (specs/current.md chunk 5 acceptance criteria):
//   AC1: session-start.sh has no FIRED-trigger owed-items injection branch
//   AC2: applyLedgerLines in grader-workflow-lib.mjs has no JSON.stringify(object) branch;
//        ledgers/slow-loop-ledger.md has no raw-JSON object lines
//   AC3: session-grader.mjs, session-grader-lib.mjs, agents/session-judge.md,
//        session-grader.test.mjs, coo/five-step-loop.md ABSENT; full suite green
//        with no dangling read/import refs (verified separately)
//   AC4: ship-spec archive step deletes specs/.cockpit-sidecar.json;
//        sweep allow-pattern matches current.md.bak-YYYYMMDD-HHMMSS
//   AC5: rules/taste-profile.md still present

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')

function readFile(rel) {
  return readFileSync(resolve(root, rel), 'utf8')
}

describe('chunk-5 store cleanup', () => {
  // -----------------------------------------------------------------------
  // AC1: session-start.sh -- no FIRED-trigger owed-items injection
  // -----------------------------------------------------------------------
  it('AC1: session-start.sh has no FIRED-trigger owed-items injection branch', () => {
    const src = readFile('hooks/session-start.sh')
    // The injection block introduces `fired_entries` and `owed_blob` variables
    // to parse the owed-items register for FIRED-marked entries.
    // After removal these identifiers must not appear.
    assert.ok(
      !src.includes('fired_entries'),
      'session-start.sh still contains fired_entries variable (FIRED injection not removed)',
    )
    assert.ok(
      !src.includes('owed_blob'),
      'session-start.sh still contains owed_blob variable (FIRED injection not removed)',
    )
    // The banner comment that introduces the section should also be gone
    assert.ok(
      !src.includes('owed-items re-surface'),
      'session-start.sh still contains owed-items re-surface comment block',
    )
  })

  // -----------------------------------------------------------------------
  // AC2a: applyLedgerLines -- no JSON.stringify(object) branch
  // -----------------------------------------------------------------------
  it('AC2a: applyLedgerLines has no JSON.stringify(object) branch', () => {
    const src = readFile('workflows/grader-workflow-lib.mjs')
    // The old branch: .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
    // After fix: only strings are accepted; no object serialization.
    // Check the applyLedgerLines function body only (not the unrelated JSON.stringify
    // for string-length counting elsewhere in the file).
    const fnStart = src.indexOf('export function applyLedgerLines(')
    assert.ok(fnStart !== -1, 'applyLedgerLines function not found')
    // Grab from function start to the closing brace (find next export after it)
    const fnEnd = src.indexOf('\nexport ', fnStart + 1)
    const fnBody = fnEnd === -1 ? src.slice(fnStart) : src.slice(fnStart, fnEnd)
    assert.ok(
      !fnBody.includes('JSON.stringify'),
      'applyLedgerLines still contains JSON.stringify (object branch not removed)',
    )
  })

  // -----------------------------------------------------------------------
  // AC2b: ledgers/slow-loop-ledger.md -- no raw-JSON object lines
  // -----------------------------------------------------------------------
  it('AC2b: ledgers/slow-loop-ledger.md has no raw-JSON object lines', () => {
    const content = readFile('ledgers/slow-loop-ledger.md')
    const lines = content.split('\n')
    const jsonLines = lines.filter((l) => {
      const trimmed = l.trim()
      // A raw JSON object line starts with { and ends with } (trimmed)
      return trimmed.startsWith('{') && trimmed.endsWith('}')
    })
    assert.equal(
      jsonLines.length,
      0,
      `ledgers/slow-loop-ledger.md contains ${jsonLines.length} raw-JSON object line(s):\n${jsonLines.join('\n')}`,
    )
  })

  // -----------------------------------------------------------------------
  // AC3: retired grader family files must not exist
  // -----------------------------------------------------------------------
  it('AC3: retired grader family files are absent', () => {
    const absent = [
      'workflows/session-grader.mjs',
      'workflows/session-grader-lib.mjs',
      'agents/session-judge.md',
      'workflows/session-grader.test.mjs',
      'coo/five-step-loop.md',
    ]
    for (const rel of absent) {
      assert.ok(
        !existsSync(resolve(root, rel)),
        `Expected ${rel} to be absent but it exists`,
      )
    }
  })

  // -----------------------------------------------------------------------
  // AC4a: scripts/ship_spec.sh sweep allow-pattern matches *.bak-* files
  // -----------------------------------------------------------------------
  it('AC4a: ship_spec.sh sweep list_bucket_b matches *.bak-YYYYMMDD-HHMMSS files', () => {
    const src = readFile('scripts/ship_spec.sh')
    // The updated allow-pattern should have -name '*.bak-*' (not just '*.bak')
    // so timestamped backups like current.md.bak-20260621-143000 are swept.
    assert.ok(
      src.includes("'*.bak-*'"),
      "ship_spec.sh list_bucket_b does not include '*.bak-*' pattern (timestamped baks not swept)",
    )
  })

  // -----------------------------------------------------------------------
  // AC4b: scripts/ship_spec.sh (or ship-spec SKILL.md) includes sidecar delete
  // -----------------------------------------------------------------------
  it('AC4b: ship_spec.sh deletes specs/.cockpit-sidecar.json at archive/ship time', () => {
    const src = readFile('scripts/ship_spec.sh')
    // The sidecar path constant is SIDECAR_NAME = ".cockpit-sidecar.json" in cockpit_sidecar.py
    // ship_spec.sh's apply_all_ship_mutations (or a new helper) must delete it.
    assert.ok(
      src.includes('.cockpit-sidecar.json') || src.includes('cockpit-sidecar'),
      'ship_spec.sh does not reference .cockpit-sidecar.json (sidecar delete not added)',
    )
  })

  it('FIXER-F2/F3/F4: ship_spec.sh sidecar path uses $project_root not dirname($archive)', () => {
    const src = readFile('scripts/ship_spec.sh')
    // The sidecar lives at specs/.cockpit-sidecar.json (sibling of current.md).
    // apply_all_ship_mutations receives archive=specs/archive/<slug>-YYYYMMDD.md, so
    // dirname("$archive") resolves to specs/archive/, NOT specs/. The sidecar delete
    // must be anchored to $project_root (first arg of apply_all_ship_mutations).
    // Fail if the bad dirname-archive form is present in the sidecar assignment.
    const badPattern = /sidecar=["']?\$\(dirname "\$archive"\)/
    assert.ok(
      !badPattern.test(src),
      'ship_spec.sh sidecar path still uses $(dirname "$archive") which resolves to specs/archive/ -- ' +
      'fix: sidecar="$project_root/specs/.cockpit-sidecar.json"',
    )
    // Also assert the correct form is present: $project_root/specs/.cockpit-sidecar.json
    assert.ok(
      src.includes('project_root') && src.includes('specs/.cockpit-sidecar.json'),
      'ship_spec.sh sidecar path must use $project_root/specs/.cockpit-sidecar.json',
    )
  })

  // -----------------------------------------------------------------------
  // AC5: rules/taste-profile.md still present
  // -----------------------------------------------------------------------
  it('AC5: rules/taste-profile.md is still present', () => {
    assert.ok(
      existsSync(resolve(root, 'rules/taste-profile.md')),
      'rules/taste-profile.md is missing (should have been kept)',
    )
  })
})
