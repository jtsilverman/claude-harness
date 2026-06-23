---
name: wiki-lint
description: Use when the operator invokes /wiki-lint or asks for a vault health check. Reports contradictions, orphan pages, broken links, stale claims, and gaps. Does NOT auto-fix.
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash
---

# Wiki Lint

Health-check the operator's wiki at `~/Documents/brain/`. Read `~/Documents/brain/SCHEMA.md` and `~/Documents/brain/index.md` before running. **Do NOT modify any files** — lint reports, the operator decides (see `CLAUDE.md` § Hard don'ts).

## Checks (run in order)

**1. Broken `[[wiki-links]]`**
- Grep all `wiki/**/*.md` for `[[...]]` patterns; for each, check if the target file exists.
- Report: `[[broken-link]]` referenced in `wiki/X/Y.md` — target not found

False-positive filters (apply before reporting):
- **Skip `![[X]]` embed syntax.** Match `(?<!!)\[\[...\]\]` only.
- **Skip fenced code blocks.** Strip ```` ``` ... ``` ```` before scanning (catches mermaid node-label noise).
- **Skip inline backtick code spans.** Strip `` `...` `` before scanning (catches syntax-example placeholders).
- **Skip skill/memory-pattern namespace.** Wiki-links to skill names (`[[capture-learning]]`, `[[recall]]`, etc.) resolve to `~/.claude/skills/<name>/SKILL.md`; memory-pattern slugs resolve to `~/.claude/projects/.../memory/patterns/<slug>.md`. Report as cross-substrate refs, not broken.
- **Skip rule-file refs.** `[[git-discipline]]`, `[[SOP]]`, etc. resolve to `~/.claude/rules/<name>.md`. Same handling.
- **Skip spec-archive namespace.** Build the spec slug namespace once per scan from (1) `~/.claude/specs/current.md` (slug after `# Spec: `) and (2) `~/.claude/specs/archive/*.md` filenames (strip `-YYYYMMDD.md`). Categorize matches as cross-substrate, not broken. Reference: `scripts/wiki_lint.sh` — source and call `build_spec_slug_namespace`.
- **Folder-target mismatches are real but distinct.** `[[Agnes]]` etc. where the target is a folder, not a file. Report in a separate "folder-target mismatches" subsection — fix via redirect-shim or rewrite to `[[projects/<x>/index|<X>]]`.

**2. Orphan pages (no inbound links)**
- For each wiki page, check if any other wiki page links to it.
- Exclude: `index.md`, `SCHEMA.md`, `log.md`, daily notes, `wiki/coding-log/` entirely (recall-retrieval, not graph-navigation — ~15+ false positives otherwise), `wiki/superseded/` (handled by check 8).
- Report: `wiki/X/Y.md` — no inbound links

**3. Stale frontmatter**
- Pages where `updated:` is older than 30 days AND have new sources added since
- Pages with `status: superseded-by-X` where X doesn't exist
- Pages missing required frontmatter (`type`, `category`, `description`, `created`, `updated`)
- Pages with malformed `updated:` values (inline `# comment` after date breaks YAML parsing)

Carve-outs:
- **Diagram pages** (`level:` in frontmatter): follow `~/Documents/brain/wiki/diagram-conventions.md` spec. Skip standard checks; use `last-verified` for freshness.
- **Convention/utility pages** (`type: convention`): skip standard checks.

**4. Contradictions across pages**
- Sample 5-10 pages or focus on a subset the operator names.
- Report each with both quotes and the conflict; suggest resolution if obvious.

**5. Concepts mentioned without dedicated pages**
- Grep for capitalized multi-word phrases or repeated technical terms; cross-reference against existing wiki pages.
- Suggest: "X mentioned N times across M pages but has no dedicated page."

**6. Index drift**
- Pages in `wiki/` not in `index.md`
- Entries in `index.md` whose target pages don't exist
- Pages whose `index.md` description doesn't match the page's first paragraph

**7. Source-to-wiki coverage gaps**
- Files in `sources/` not referenced by any wiki page. Suggest re-ingest.

**8. Supersede-orphans**
- Files in `wiki/superseded/` should be referenced by `supersedes: <slug>` on a successor page.
- Reference: `scripts/wiki_lint.sh` — source and call `check_supersede_orphans` (emits `ORPHAN: <path> (slug: <slug>)` per orphan). Use `find` not glob; empty `superseded/` is fine.

**9. Empty-bucket signal**
- Hot buckets: `wiki/daily/`, `wiki/domains/`, `wiki/entities/`, `wiki/concepts/`, `sources/inbox/`, `sources/clippings/`, `sources/tweets/`, `sources/repos/`.
- Reference: `scripts/wiki_lint.sh` — source and call `check_empty_buckets` (emits `EMPTY: <bucket-relpath>`). Surface as informational, not error.

**10. Stale projects**
- `wiki/projects/<project>/index.md` pages with mtime > 30 days.
- Reference: `scripts/wiki_lint.sh` — source and call `check_stale_projects`. Cross-reference active-project list in `~/Documents/brain/index.md`; only active projects with stale pages are real findings.

## Output format

```markdown
# Wiki Lint Report — YYYY-MM-DD

## Summary
- Broken links: N  |  Orphans: N  |  Stale frontmatter: N  |  Contradictions: N
- Suggested pages: N  |  Index drift: N  |  Uncited sources: N
- Supersede-orphans: N  |  Empty buckets: N  |  Stale projects: N

## Broken links
## Folder-target mismatches
## Cross-substrate refs (informational)
## Orphans
## Stale frontmatter
## Contradictions
## Suggested new pages
## Index drift
## Uncited sources
## Supersede-orphans
## Empty buckets
## Stale projects
```

### Log the lint
Append to `~/Documents/brain/log.md`:
```
## [YYYY-MM-DD HH:MM] lint | <N total issues>
- Broken links: N | Orphans: N | Contradictions: N | ...
```
Use `date +"%Y-%m-%d %H:%M"`.
