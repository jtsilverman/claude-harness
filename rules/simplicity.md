# Simplicity

The standing principle: the machine and the artifacts agents produce stay un-braided. Auto-inherited by every producing agent type via `rules/`; enforced on output by the review-contract SLOP lens. One definition, one procedure, no per-prompt copying.

## What simple means (the validated definition)

- **One role per part, one fact per place, one reason to change.** A thing does one job; a fact is stated in exactly one file; a part changes for exactly one reason.
- **Un-braided, not small.** Simple means disentangled (Hickey): independent concerns pulled apart. It is **not small** and not minimal. A long un-braided thing beats a short tangled one.
- **Interface smaller than its implementation.** Deep modules (Ousterhout): a narrow interface hiding real work, never a wide interface over a thin shim.
- **Essential, not accidental.** Carry the complexity the problem demands (Brooks); shed the complexity the design added.
- **Everything traces to a named failure mode.** Each non-obvious element earns its place by pointing at a concrete failure it prevents. No element that traces to nothing.

## The generative procedure (run it before you build)

1. **Question the requirement.** Try to delete it first; the best part is no part. Only the requirement that survives deletion gets built.
2. **State the part in one sentence with no "and".** If the sentence needs an "and", it is two parts; split them.
3. **Count concepts, not lines.** Complexity is the number of moving concepts a reader must hold, not the line count. Fewer concepts wins even at more lines.
4. **Map the dependencies and the obscurity.** Name what depends on what, and what is non-obvious to a fresh reader. Those two are where braiding hides.
5. **Trace each non-obvious element to a failure mode.** If an element points at no concrete failure, cut it; it is defensive theater or premature abstraction.
6. **Check the seams.** A seam between parts should carry one clear contract; a leaky or chatty seam means the parts are still braided.
7. **Grow from the last working version.** Extend the simplest thing that ran, one change at a time, instead of building the whole structure ahead of a confirmed need.
