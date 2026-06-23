---
name: wiki-ingest
description: Use when the operator asks to ingest a source into his Obsidian vault at ~/Documents/brain/, invokes /wiki-ingest, pastes source-shaped content into chat (a URL with extract, a multi-paragraph quote, a tweet body, a Perplexity output, a GitHub repo URL, an article excerpt), OR when Claude's own web research (WebSearch/WebFetch) surfaces a substantive, reusable source worth keeping.
disable-model-invocation: false
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch
---

# Wiki Ingest

Process a new source into the operator's wiki at `~/Documents/brain/`. Implements the ingest workflow defined in `~/Documents/brain/SCHEMA.md`. Three entry points: explicit (`/wiki-ingest <path>` or "ingest this"), **auto-trigger on chat-paste** (the operator pastes source-shaped content), and **auto-trigger on web research** (Claude's own WebSearch/WebFetch surfaces a file-worthy source).

## Auto-trigger on chat-paste

Fires when the operator pastes source-shaped content into chat without explicit invocation. **Detection is qualitative -- no token-count gate, no regex.** Claude judges whether the pasted content looks like a source (see `llm-internal-heuristics-prefer-judgment` memory pattern).

**Source-shaped (judge yes):** standalone URL where the operator's framing signals filing not querying; multi-paragraph quote or extract; Perplexity Pro output; AI session handoff to save.

**Not source-shaped (judge no):** short question or task statement; code snippet to review; path to a file in his working tree; conversational framing ("can you look at this URL?") signaling query not capture.

**A question *about* pasted source content does NOT reclassify it as non-source.** If the operator pastes a substantive, reusable source and also asks something about it ("here's an article, is this worth adopting?"), it is still a capture: answer the question AND ingest the source in the same turn. The "query not capture" exclusion is for a bare pointer with no filing value, not for a real source that happens to arrive with a question.

**On detection, surface the destination inline (Rule 7):**

> `Filing this to sources/<kind>/<YYYY-MM-DD>-<slug>.md — flag if not.`

Then proceed to the workflow below. Wait for "flag" override; otherwise proceed without explicit confirmation.

## Auto-trigger on web research (Claude's own searches)

Fires when **Claude's own** WebSearch / WebFetch during a task surfaces a substantive, reusable source worth keeping. Bar: "would future-Claude or the operator want this source again?" not "did a fetch succeed?"

**Clears the bar (capture):** substantive article / doc / paper / repo README that informed the work; a non-obvious technique or key fact future-Claude should not re-derive.

**Does NOT clear the bar (skip):** throwaway lookup used once (current library version, navigational search); dead-end results; pages read only to finish the immediate task; anything already captured (Step 3.5 dedupe catches re-fetches).

**Routing:** capture the underlying source, not "the search." A WebFetch maps to its URL's kind. Multi-source synthesis with no single URL goes to `clipping` (or `inbox` if kind is ambiguous). Add `research-capture` to `tags:` on autonomously-written sources.

Surface inline (Rule 7) identical to chat-paste, then run the workflow (Step 3.5 dedupe before write).

## Source destinations

Full routing table: `references/source-routing-table.md`.

Quick summary: tweet / article / clipping / repo / perplexity / paper / session / inbox -- each maps to `sources/<kind>/<YYYY-MM-DD>-<slug>.md`. `raw-research/` is reserved for batch material the operator pre-organizes; never auto-route there. When `source_kind` is ambiguous, pick the closer fit and surface the decision (Rule 7).

## Required reading before acting

Before any write (auto-trigger or explicit), read:
1. `~/Documents/brain/SCHEMA.md` -- vault conventions, hard rules, frontmatter formats
2. `~/Documents/brain/index.md` -- what wiki pages already exist

If the source argument was a path, read the source. If it was a URL, fetch it (use WebFetch) and propose where to save it under `~/Documents/brain/sources/` first.

## Workflow

### Step 1: Read and understand
- Read the source completely.
- Identify: what is this about? genre? what's new?

### Step 2: Discuss key takeaways with the operator
- 1-3 bullet points: the most important things you learned.
- One sentence: how this relates to existing wiki content (or "this is a new topic area").
- Wait for the operator's reaction before proceeding.

### Step 3: Propose wiki updates

**Mandatory rg-cite-before-CREATE:** before proposing any NEW page, run `rg -li "<topic keywords>" ~/Documents/brain/wiki/ -t md`. If matches exist, prefer UPDATE over CREATE. Surface matches in the proposal.

Show the operator a structured plan BEFORE writing anything. Full proposal template: `references/wiki-proposal-template.md`. Wait for the operator's OK or revisions before proceeding.

### Step 3.5: Dedupe before write

Before writing any new source file, check for overlap with existing files in the same `sources/<kind>/` subdir. List existing files, read their `description:` and `url:` frontmatter, judge overlap qualitatively (same URL? same author + topic? excerpt of same piece?).

On overlap: prompt the operator to supersede (Y), merge (M), write in parallel (P), or skip (n). On no overlap: proceed silently to Step 4. Full protocol detail: `references/dedupe-protocol.md`.

This is a mandatory inline pause -- the only judgment call between propose and write for source captures.

### Step 4: Execute
- Updates: Read first, then Edit. Update the `updated:` frontmatter date. Append to `sources:` list.
- New pages: Write with full frontmatter per SCHEMA.md and `references/source-frontmatter.md`. Include a `## How this works in plain English` section near the top (2-4 sentences). Use `[[wiki-links]]` for cross-references.
- Cite the source: `According to [[source-slug]], ...`
- Use `date +%Y-%m-%d` for the current date in frontmatter (don't guess).

### Step 5: Update index.md and log.md
- `index.md`: add new pages under their category, update existing entries' summaries if changed.
- `log.md`: append `## [YYYY-MM-DD HH:MM] ingest | <source title> | <pages touched>` using `date +"%Y-%m-%d %H:%M"`.

### Step 6: Confirm
- List what was done.
- Note any contradictions surfaced.
- Suggest next actions (related sources to find, lint to run, follow-up questions).

## Hard rules (from SCHEMA.md)

1. **Never modify files in `sources/`.** Read-only.
2. **Never silently delete wiki pages.** Mark `status: superseded-by-[[X]]` instead.
3. **Always update `index.md` and `log.md`.**
4. **Use `[[wiki-links]]` for any cross-reference.**
5. **Cite sources in wiki pages.** Don't make claims without backing.
6. **Don't re-derive what exists.** Update existing pages.
7. **Surface contradictions explicitly.** Don't paper over them.
8. **Stay terse.** One screen of useful content > five screens of padding.
9. **rg-cite before CREATE.** Run `rg` to check for existing pages before proposing any new one (Step 3).
10. **Step 3.5 dedupe is not optional.** Always run on auto-fired captures; the same-URL-pasted-twice case is exactly what it exists for.
11. **`description:` field is required.** Every source file must have it; recall Pass 2 ranking depends on it.

## Anti-patterns

Full list: `references/anti-patterns.md`. Key violations: writing wiki pages before showing the operator the plan; skipping Step 3.5 dedupe; asking the operator which `source_kind` to use (infer and surface instead); writing a source without `description:`; auto-routing to `raw-research/`; capturing throwaway lookups.

## References

- `references/source-routing-table.md` -- full kind-to-destination mapping table
- `references/wiki-proposal-template.md` -- rg-cite rule + proposal block format
- `references/dedupe-protocol.md` -- Step 3.5 supersede / merge / parallel protocol
- `references/source-frontmatter.md` -- required YAML frontmatter fields + notes
- `references/anti-patterns.md` -- complete anti-patterns list
- `~/Documents/brain/SCHEMA.md` -- vault conventions (read before every write)
- `~/.claude/coo/communication-discipline.md` § Rule 7 -- surface-and-proceed format
