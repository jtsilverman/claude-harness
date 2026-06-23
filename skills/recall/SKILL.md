---
name: recall
description: Use at chunk start (Phase 3 prework, after task statement is locked, before failing test) to surface relevant past patterns, concepts, sources, and reusable code locations from the full knowledge graph (memory + wiki + sources + the project codebase) before implementation begins. Three-pass description-first body-load model. Prevents re-solving solved problems, rediscovering known footguns, and reinventing code that already exists.
---

# Recall

Three passes, all hard-capped at 5 body-loads each. Skip all three only on trivial chunks (single-line typo, mechanical rename). Pass 1 is a hybrid query over the SQLite memory index (`scripts/memory-index.mjs`); Passes 2-3 grep the wiki/sources/codebase via `scripts/recall.sh`.

**Builder context (recall run inside the build-agent's continuous context).** When the build-agent invokes recall as its first step (C4: recall is no longer a separate harness stage -- it runs inside the builder's one continuous context), it runs in DRAFT-AND-RETURN mode: the memory index, wiki, and source sidecars live OUTSIDE the worktree and only the COO writes shared state (sole-writer). Recall does the full three-pass retrieval and records the loaded slugs into the return bundle's `recallEvidence` field, but it does NOT execute the Pass-1 tally `UPDATE` or the Pass-2 `touch`/bumps itself -- the COO applies those sole-writer at merge from the recorded slugs. Outside the pipeline (direct invocation in the COO session) the touch/bumps run inline as written below.

## Pass 1: Memory (patterns + failures) — hybrid index query

Pass 1 is a single ranked query over the **SQLite memory index** (`scripts/memory-index.mjs`, schema B1, populated live by B2), then the existing LLM judge-and-body-load over its short list. The index fuses keyword-match (bm25) and meaning-match (cosine) so one query reaches the whole store — patterns, failures, feedback, preferences, and genuine reference memories alike — with no bucket-pick, no INDEX.md body-load, and no JSON tally sidecar.

### Step 1 — Extract TIGHT topic keywords

Pull 4-8 chunk-specific keywords from `specs/current.md` § Current chunk. Use topic nouns, action verbs, surface words. Skip generic terms ("file", "code", "function", "add", "use"). **Feed the query TIGHT topic keywords, not the whole task sentence** — OR-joining every token of a long sentence makes generic words match structural/decoy rows. A short, high-signal phrase is the input.

### Step 2 — Run the hybrid query (one fused call)

```bash
node scripts/memory-index.mjs query "<tight topic keywords>" --scope <scope> --k 8
```

`--scope` is `global` outside a project workspace, or the workspace scope (e.g. `workspace:<proj>`) inside one; the query then searches that scope **UNION global**. It emits a JSON array of the fused **top ~8** hits, each `{ id, rrf, hasBm25, cosine, path }`, ranked by Reciprocal Rank Fusion (`score = sum of 1/(60+rank)` across the bm25 list and the cosine list — a hit on both axes out-ranks a hit that is #1 on only one). `path` is the **absolute** backing-file path resolved from the index's own store root — use it directly for body-load (see Step 3). Only `status='active'` rows are returned; **structural rows** (the `MEMORY` MOC and per-bucket `*/INDEX` files) are filtered out by slug, while genuine `kind='reference'` memories are kept.

### Step 3 — Judge and body-load the fused short list (hard cap: 5)

Read each fused hit's `id` (and, if helpful, its description via the index) first; body-load only the genuinely relevant entries from the store, **hard cap 5**. The RRF order is the relevance prior; you are the judge over the short list, not over the whole corpus. Cold-start carve-out still applies: when a clearly-relevant hit has never been recalled, prefer including it.

**Body-load via the emitted `path` field (absolute), NOT a path constructed from cwd.** Each hit from `queryHybrid` carries a `path` field: the absolute backing-file path resolved from the index's own store root at rebuild time. Use that path directly (e.g. `Read { file_path: hit.path }`). Do NOT construct the path by joining cwd + id; that breaks inside a build-agent worktree, where `~/.claude/patterns/` is absent. If `hit.path` is missing or `existsSync(hit.path)` is false, the entry is an orphan -- skip body-load and note it in recallEvidence as a description-only hit.

**Tally is now a DB column, not a JSON sidecar.** The per-entry recall tally lives in the index `tally` table and is bumped by a serialized DB `UPDATE`, routed through the sole-writer. In **builder / draft-and-return mode** recall does NOT write the tally itself: it **records the loaded slugs** (into the return bundle's `recallEvidence` field) for the COO/memory-agent to apply sole-writer at merge. Do **not** write `recall-tally.json` for Pass 1; that sidecar is retired for the memory pass. (Direct-invocation tally-write wiring is downstream -- recall here records, it does not write.)

Announce which were loaded and why. Don't ask the operator. Then emit the read-verify lines (next step).

### Step 3.5 — Read-verify each body-loaded entry (REQUIRED field)

Per the annex read-verify contract (Part 4 §C): for **each** entry you body-loaded in Pass 1, return ONE verify line — a required field, a missing one means a malformed return:

```
{ entry_id, verdict: "applies" | "stale" | "contradicted", evidence }
```

- **`applies`** is the expected healthy default — an entry the store is doing its job carries forward unchanged.
- Check the entry's **load-bearing refs the chunk actually touches** with a cheap `ls` / `grep` / `Read` (does the file/symbol/path it asserts still exist and behave as claimed?). Verify against reality where your chunk touches it; do not re-derive the whole entry.
- `stale` (the world moved) or `contradicted` (reality disproves it) carries `evidence` (the command + what it showed) so the COO can route a supersede/delete to the memory-agent. **Never manufacture staleness** — an entry that still holds is `applies`, full stop.

## Pass 2: Wiki + sources

### Step 4 — Grep wiki + sources

```bash
source scripts/recall.sh
grep_wiki_sources "<current-project>" "<kw1>" "<kw2>" "<kw3>"
```

Covers `wiki/concepts`, `wiki/coding-log`, `wiki/projects/<project>`, and all six `sources/` subdirs. Pass empty string for `<current-project>` to skip the project-specific dir.

### Step 5 — Judge and body-load (hard cap: 5 combined across wiki + sources)

Prioritize by: (1) description-field keyword hits, (2) multi-keyword overlap, (3) surface specificity, (4) use-tally rate. Cold-start carve-out applies here too. Anything beyond top-5 stays as a one-liner mention.

After each body Read: `touch` + bump slug in `~/Documents/brain/wiki/recall-tally.json` or `~/Documents/brain/sources/recall-tally.json` as appropriate. Description-only candidates do NOT get touched or bumped.

## Pass 3: Codebase

### Step 5.5 — git grep the project code

```bash
source scripts/recall.sh
grep_codebase "<kw1>" "<kw2>" "<kw3>"
```

Finds the repo root via `git rev-parse --show-toplevel`, runs `git grep -niE` across `scripts/`, `skills/`, `agents/`, `hooks/`, `src/`, `lib/` with `':!*.md'` to exclude markdown. Falls back to `grep -r` outside a git repo. Use `git grep`, not `rg`.

Rank hits: filename match (strongest) > symbol/heading match > body match only.

Surface top `file:line — <matched line>` entries. Body-load only files the chunk would otherwise reimplement, **hard cap: 5**. Most chunks body-load zero or one.

**No `touch`, no tally on Pass 3.** Code is not a freshness-tracked knowledge surface; no codebase sidecar JSON exists. Skip Pass 3 only on trivial chunks or docs-only repos.

## Step 6: Apply and hand back

Apply each loaded item: does the chunk approach respect the recalled pattern? Does Pass 3 show the thing is already built — reuse it instead? If a recalled pattern reveals the approach is wrong, stop and reconsider before writing the failing test.

Note: recall surfaced N memories (Pass 1), M wiki/source items (Pass 2), K code locations (Pass 3). Hand back to Phase 3 → `chunk-kickoff` → failing-test-first.

## Hard rules

- Three passes always run. Skip all three only on trivial chunks; don't skip Pass 2 because Pass 1 had a hit; don't skip Pass 3 because you'll "find the code later."
- 5 body-load cap on every pass. Pass 1's cap covers the pattern/failure/reference entries body-loaded from the fused short list. Anything beyond top-5 stays as one-liner mentions.
- Pass 1 is one fused index query, not a bucket-pick. No MEMORY.md bucket descriptions, no INDEX.md body-load, no `recall-tally.json` sidecar for the memory pass — those are retired. Feed TIGHT topic keywords, never the whole task sentence.
- Read-verify is REQUIRED. Every Pass-1 body-loaded entry returns one `{ entry_id, verdict, evidence }` line; a missing one is a malformed return. `applies` is the healthy default; never manufacture staleness.
- Description-first, body-on-demand. Read the fused hit's id/description before body-loading (Pass 1) and before body-loading wiki/sources (Pass 2). For Pass 3, read the `file:line` match line first; body-load only when reuse is in play.
- Pass-1 tally is a DB column bumped by the sole-writer. In pipeline mode recall RECORDS loaded slugs for the COO/memory-agent to apply; recall never writes the tally itself. Pass-2 `touch` + bump on body Read only (wiki/sources sidecar JSONs); files that ranked but weren't body-loaded do NOT get touched or bumped.
- RRF order is the relevance prior for Pass 1; you judge over the short list. Cold-start carve-out: prefer including a clearly-relevant never-recalled hit.
- mtime is freshness, not relevance. Don't rank by mtime; `wiki-lint` consumes it to surface stale files.
- No touch, no tally on Pass 3. No codebase sidecar JSON.
- Claude decides which to load. Don't ask the operator.
- Don't query/grep on trivial chunks. Don't fabricate matches — if the query/grep returns nothing, say so and move on.
