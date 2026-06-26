---
name: wiki-query
description: Use when the user asks a question that should be answered against his Obsidian wiki at ~/Documents/brain/, or invokes /wiki-query. Searches the wiki first, falls back to sources only if needed.
disable-model-invocation: false
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Wiki Query

Answer the user's question against his wiki at `~/Documents/brain/`. Implements the query workflow defined in `~/Documents/brain/SCHEMA.md`.

## Required reading before answering

You MUST read `~/Documents/brain/index.md` first. That's the catalog. It tells you what wiki pages exist and what they cover.

## Workflow

### Step 1: Identify candidate pages
- Read `index.md`
- Before relying on index.md alone, run `rg -li "<key terms from question>" ~/Documents/brain/wiki/ -t md` to find pages that mention the topic but may not be catalogued yet. Index.md can lag behind actual page content.
- Identify which wiki pages are likely relevant to the user's question
- If nothing in the wiki obviously relates, say so explicitly: "No wiki pages on this topic yet."

### Step 2: Read the wiki, not the sources
- Read the candidate wiki pages
- The wiki is the synthesis. Don't re-derive from sources unless the wiki is incomplete.
- Use Glob/Grep to find related pages by `[[wiki-link]]` references if needed.

### Step 3: Answer with citations
- Synthesize the answer from the wiki pages
- Cite explicitly: "Per [[page-name]]: claim X" or "From [[source-slug]] (via [[page-name]]): claim Y"
- If multiple wiki pages contradict each other, surface that — don't paper over it
- If the wiki is incomplete on this topic, say so and offer to fall back to sources

### Step 4: Compound the answer back into the wiki (when valuable)
After answering, ask: **"This answer revealed X. Should I file it back into the wiki?"**

Examples of answers worth filing back:
- A comparison you generated (could become a new page or section)
- A connection you noticed across pages (could become an entity or concept page)
- A gap you identified (could become a stub page with `status: needs-research`)
- An updated understanding that supersedes existing wiki content

If the user says yes, follow `/wiki-ingest` workflow steps 3-6 to write the update.

### Step 5: Log the query
Append to `~/Documents/brain/log.md`:
```
## [YYYY-MM-DD HH:MM] query | <one-line question summary> | <pages consulted>
- Answer summary: <1-2 sentences>
- Filed back: yes/no — <if yes, which page>
```

Use `date +"%Y-%m-%d %H:%M"` for the timestamp.

## When the wiki is incomplete

If the wiki has nothing relevant:
1. Say so explicitly. Don't fabricate from training data.
2. Offer two options: "(a) I can search the sources/ directory directly, (b) I can web-search and propose this becomes a new ingest."
3. Wait for the user's choice.

## Anti-patterns

- Don't answer without reading index.md first
- Don't cite the wiki without naming the specific page
- Don't fall back to sources/ silently — say when you do and why
- Don't use training-data knowledge to fill gaps without flagging it
- Don't skip the "file back?" prompt — that's how the wiki compounds
- Don't forget to log the query
