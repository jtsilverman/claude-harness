# Chunk Decomposition: Rationale and Budget Notes

## Why the 5-line cap exists

Measured: 10 lines/chunk × 10 chunks = ~2.5k tokens of decomposition. 30 lines/chunk × 10 chunks = ~7.5k. The spec gets re-read every chunk; cost multiplies. Anything above 5 lines per chunk either belongs upstream (plan / constraints / test strategy) or is sub-decomposition that should split.

## What does NOT go in the chunk row

- Design rationale, alternatives considered, why X over Y → plan file (Phase 1) or commit message at Phase 6.
- Constraints repeated across multiple chunks → write once in `## Constraints`, reference by name in chunk rows.
- Sub-decomposition / "and also touches X" → `chunk-pivot` smell. Carve it as its own chunk.
- Test-strategy details → `## Test strategy` section, not per-chunk.

## Spec total guideline (soft)

Specs over 15k tokens (~400 lines) are a smell. Audit before lock if the spec exceeds that — usually rationale leaking into chunk rows or chunks that should pivot into separate specs.
