# Exemplar 03: episodic store (new pure module chunk)

**Shape:** new pure JS module with co-committed tests; no external dependencies, no LLM calls.

## recall

Surfaced: pure read/write module pattern from the session-grader-ledger (appendTrace mirrors
recordDisposition in shape). Also surfaced: outcome vocabulary reuse from chunk-1 ledger enum
(pending|fixed|recurred) -- no need to invent a new enum. Key footgun: `loadTraces` must
return `[]` on missing file, corrupt JSON, or wrong schema shape -- not throw.

## RED (failing test)

Wrote `workflows/episodic-store.test.mjs` pinning:
- `appendTrace` returns a new array (pure, no mutation)
- `saveTraces/loadTraces` round-trip to disk
- `loadTraces` returns `[]` on missing file, corrupt JSON, wrong schema
- `retrieveByTask` keyword match; `retrieveByOutcome` exact match
- outcome normalization (unknown outcome coerced to 'pending')

Ran the suite: all 12 new tests FAILED with "Cannot find module
'./episodic-store.mjs'". RED for the right reason: the module does not exist.

## GREEN (minimal implementation)

Created `workflows/episodic-store.mjs` exporting:
- `appendTrace(traces, entry)` -- pure, returns new array
- `saveTraces(path, traces)` / `loadTraces(path)` -- durable disk I/O
- `retrieveByTask(traces, keyword)` / `retrieveByOutcome(traces, outcome)`
- outcome normalization in `appendTrace`

No LLM or network calls. Ran the suite: 12 tests pass. GREEN.

## REFACTOR

No pre-existing episodic-store module. Scanned for any stale placeholder or duplicate
retrieval logic in other modules -- none found. Suite green after scan. No deletions.

## What made this a clean chunk

- recall surfaced the ledger enum for outcome vocabulary reuse -- prevented reinvention
- RED tested the `[]`-on-corrupt-file edge, not just the happy path
- GREEN was pure module: no side effects, no DI complexity, no abstraction beyond the exports
- REFACTOR found nothing dead -- pure net-new module
- Commit message named the module and the exported interface (appendTrace, save/load, retrieve)
