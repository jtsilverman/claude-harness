# Anti-Patterns

Things wiki-ingest must not do.

- Don't write to wiki pages before showing the user the plan (explicit /wiki-ingest path).
- Don't auto-fire on conversational mentions of URLs ("can you look at this?" -- that's a query, not a capture). Source-shaped means the user's framing signals filing, not asking.
- Don't use a regex or token-count gate to decide whether to auto-fire -- qualitative judgment only (see `llm-internal-heuristics-prefer-judgment`).
- Don't ask the user which `source_kind` to use. Infer it, surface the destination, let him override.
- Don't skip Step 3.5 dedupe on auto-fired captures -- the same-URL-pasted-twice case is exactly what dedupe exists for.
- Don't write a source file without the `description:` field -- `wiki-query` won't be able to rank it.
- Don't create duplicates of existing pages -- search index.md first.
- Don't use vague wiki links like `[[the framework]]` -- use specific names.
- Don't auto-resolve contradictions silently -- flag them.
- Don't pad pages with restating what's in other linked pages -- link instead.
- Don't auto-route to `raw-research/` -- that subdir is for batch material the user organizes manually.
- Don't auto-capture throwaway research lookups (library-version checks, navigational searches, dead-end results) -- only file-worthy, reusable sources clear the web-research bar.
- Don't "save the search" -- capture the underlying source (WebFetch the key result and route by kind, or write one clipping for a multi-source synthesis with the URLs listed).
