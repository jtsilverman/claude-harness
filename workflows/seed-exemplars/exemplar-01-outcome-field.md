# Exemplar 01: outcome field + recordOutcome (unit-test chunk)

**Shape:** new behavior on an existing module, pinned by unit tests.

## recall

Surfaced: ledger round-trip patterns (loadLedger normalizes unknowns), `recordDisposition`
as the pure-writer mirror. No prior outcome-field work -- clean slate.
No known footguns beyond the normalize-on-load pattern for schema evolution.

## RED (failing test)

Wrote `workflows/session-grader-ledger.test.mjs` cases pinning:
- `newEntry()` stamps `outcome:'pending'`
- `recordOutcome(ledger, fp, 'fixed')` mutates correctly
- `loadLedger` normalizes missing/unknown outcome to `'pending'`
- `recordFindings` auto-stamps `'recurred'` on a second match

Ran the suite -- all 5 new tests FAILED with "outcome is not a property" and
"recordOutcome is not a function". RED for the right reason: the feature is absent.

## GREEN (minimal implementation)

Added to `workflows/session-grader-ledger.mjs`:
- `outcome` field in `newEntry()` (defaulting to `'pending'`)
- `recordOutcome(ledger, fingerprint, value)` pure writer
- normalize branch in `loadLedger` for missing/unknown outcome values
- `'recurred'` stamp in `recordFindings` on second match

No new abstractions. Ran the suite: 43 tests pass (38 pre-existing + 5 new). GREEN.

## REFACTOR

Scanned for dead code: the old `recordDisposition` wasn't touched; no dead paths
introduced. Suite still green after the scan. No deletions needed.

## What made this a clean chunk

- recall surfaced `recordDisposition` as the shape template early, preventing reinvention
- RED confirmed failure for the right reason before any implementation line
- GREEN was minimal: 4 targeted additions, no speculative abstraction
- REFACTOR found nothing dead -- new feature, no obsoleted code
- Commit message named the file + the behavior shift (outcome field + auto-transitions)
