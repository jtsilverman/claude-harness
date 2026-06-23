---
name: capture-learning
description: The routing and drafting playbook for session-derived lessons, run by the memory-agent (the single actor that executes this skill) on each RAW lesson candidate the COO routes to it. Routes by content shape (tactical rule into the memory store; concept into a drafted wiki page the COO writes inline), drafts in destination voice, then lands the memory path through the memory-agent reconcile playbook. Builders, fixers, and the grader-judge do not run this skill; they emit RAW candidates ({raw_lesson, kind_hint, provenance}) into their return bundles.
---

# Capture Learning

Route by content shape; default = capture into the surface that fits. The only valid skip is "tactical-only and already in memory." Full destination table: `references/routing-table.md`.

## Who does what (the capture pipeline)

Three actors, one direction of flow. Lessons travel RAW until they reach the one reconciling writer; no upstream actor pre-drafts finished captures, and no write waits on a merge-time apply step.

- **Emitters** (the builder, the fixer, the grader-judge, anyone who notices a lesson): emit a RAW candidate `{ raw_lesson, kind_hint, provenance }` into their return bundle. They do not run this skill, do not draft finished captures, and never write memory or the vault. What counts as capturable and when to emit: `disciplines/worker-discipline.md` (Lessons out).
- **The COO**: routes candidates to the memory-agent, one batch at a time per scope. It does not run this skill and does not write the memory store. Its one write in this flow: session-derived wiki pages, written inline from the memory-agent's returned drafts (see the wiki seam below).
- **The memory-agent**: the single actor that runs this skill. Per candidate: capture-or-skip, route by content shape, draft in destination voice, then land it (reconcile + write for memory; returned draft for wiki). The reconcile decision and the write/index mechanics live in `agents/memory-agent.md`; this skill is the routing and drafting half of that playbook and does not restate the reconcile.

## Invocation sources

1. **Chunk merge**: the builder's RAW candidates, collected from its return bundle.
2. **Ship**: the grader-judge's MEMORY-FAULT findings, routed as candidates.
3. **Recall read-verify**: a builder's `recallVerify` supersede/delete action against a stale entry (`agents/memory-agent.md`, Read-verify actions).
4. **Event-driven / manual**: anyone (the operator included) notices a lesson; the COO routes it as a candidate.

## Workflow (per candidate, inside the memory-agent)

### Step 1: Capture or skip

Skip if no real lesson surfaced. Real lesson signals: friction that surprised you, a technique that generalizes, a failure revealing a wrong assumption, a bigger-picture system realization. A skipped candidate is still acked with a one-line why; a silent skip is indistinguishable from a lost candidate.

### Step 2: Route by content shape

`kind_hint` is the emitter's guess; content shape decides. Use `references/routing-table.md`.

1. Tactical rule future Claude should follow at chunk-execution time? Memory.
2. Content the operator should read (concept, project note, tool/person/framework/domain/entity, daily, coding-log)? Wiki.
3. Both can apply when the content is genuinely distinct for each audience; if you cannot articulate non-overlapping content, pick one (tactical wins the tie-break).
4. Scope (memory only): general "how I work" lesson routes to the global store; project-specific routes to the workspace store (`agents/memory-agent.md`, Scope handling).

### Step 3: Draft in destination voice

Templates: `references/templates.md`.

- **Memory**: title, description (the index's primary rank surface; make the trigger condition recognizable from it alone), tags (3-6, kebab), importance (1-10), body 100-200 words. Voice = instructional, audience = future Claude. Kinds: `pattern` (reusable technique/gotcha/rule), `preference` (the operator-stated rule about working style or Claude behavior), `failure` (post-mortem on a 2-strike chunk). Tags replace buckets; there is no bucket pick.
- **Wiki**: `## How this works in plain English` as the first body section (required vault-wide), then What / Why / How / Related. 200-500 words. Voice = explanatory, audience = the operator. Category matches the destination subdir (12 categories; default `concept` for cross-project insight, `project` for codebase-specific).

### Step 4: Land it

- **Memory path**: hand the draft to the reconcile playbook in `agents/memory-agent.md` (search top-5 similar, threshold pre-filter, one structured reconcile call, the five dispositions, status-flip supersession, write + index). Not restated here; that file is the single home of the reconcile decision.
- **Wiki path**: return the drafted page in the disposition ack. The COO writes it inline and updates `index.md` + `log.md` in the same pass (SCHEMA Hard Rule #3).

## The wiki seam (session-derived vs external)

Two skills share the vault as a destination; the boundary is the content's origin, and it is sharp:

- **`wiki-ingest` owns EXTERNAL sources**: pasted URLs, tweets, articles, Perplexity outputs, GitHub repos. Its contract does not change. Never route a session-derived lesson through `wiki-ingest`, and never write `~/Documents/brain/sources/` from this skill.
- **`capture-learning` owns SESSION-DERIVED content**, concepts included. The concept path: the memory-agent drafts the page (Step 3, wiki voice), and **the COO writes session-derived concept pages inline to the vault**. The COO is the vault's sole writer; the memory-agent never writes it; there is no `wiki-ingest` hop anywhere in this path.

## Channel details

**Memory store:** `~/.claude/projects/-Users-admin--claude/memory/` (global scope); each workspace has its own store and index under `<project>/.claude/` (scope is a parameter, never second machinery).

- Layout by kind: `patterns/`, `preferences/`, `failures/`. New entries land flat in their kind's subdir; the legacy `patterns/<bucket>/` subdirs stay where they are and stay readable through the index. Tags carry the categorization buckets used to.
- Retrieval index: the flat hybrid SQLite index (FTS5 BM25 + embeddings), derived from the files and rebuildable (`scripts/memory-index.mjs`). The memory-agent's write+index step keeps it current; capture touches no MEMORY.md entry list and no bucket `INDEX.md`.
- Supersession: `status: superseded` + `superseded_by` in frontmatter, set by the reconcile EXECUTE step. No `superseded/` directory move for memory entries.

**Wiki store:** `~/Documents/brain/wiki/<category>/<slug>.md`

- Index: `~/Documents/brain/index.md`. Log: `~/Documents/brain/log.md`. Schema: `~/Documents/brain/SCHEMA.md`.
- Supersede archive: `~/Documents/brain/wiki/superseded/<slug>-YYYYMMDD.md` (the wiki keeps its dated-archive convention; the status-flip model above is memory-only).
- Cross-linking: `[[wiki-links]]`. Categories (12): concept | project | tool | person | framework | domain | entity | daily | pattern | failure | win | decision.
- Every wiki write updates `index.md` and `log.md` in the same pass; project-page captures also link the new sibling page from the project's `index.md`.

## Hard rules

- Route by content shape. No high-bar / low-bar. Every real lesson routes somewhere; skip only "tactical-only and already in memory," and ack the skip.
- RAW in, finished out: emitters emit raw candidates; only the memory-agent drafts and reconciles. No agent drafts finished captures in its own bundle.
- One writer per store: the memory-agent writes the memory store; the COO writes the vault. Nobody writes both, and no worker writes either.
- The reconcile decision lives in `agents/memory-agent.md` only. This skill routes and drafts; it never restates or overrides the disposition logic.
- Don't duplicate across channels. Two captures = two distinct artifacts, different audiences, different content.
- `description:` required on all memory and wiki frontmatter (it is the rank surface recall queries).
- Memory `type:` stays in the harness-owned enum (`feedback` for all three kinds); `kind:` matches the subdir. Tags 3-6; importance 1-10; no `bucket:` field.
- Overlap and collisions resolve through the reconcile (merge / extend / supersede / drop), never through a silent overwrite.
- Wiki has 12 categories; don't fold everything into `concepts/`. Project notes go to `wiki/projects/<project>/<slug>.md`.
- Sources go to `wiki-ingest`. This skill handles session-derived content only.

Common mistakes and red flags: `references/pitfalls.md`.

## References

- `agents/memory-agent.md` (the reconcile playbook: search, threshold, dispositions, execution, serialization, scope handling).
- `references/routing-table.md` (full destination table by lesson shape).
- `references/templates.md` (body + frontmatter templates for the draft step).
- `references/pitfalls.md` (common mistakes and red flags).
- `disciplines/worker-discipline.md` (Lessons out: what emitters emit, and when).
