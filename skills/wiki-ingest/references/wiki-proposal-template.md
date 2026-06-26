# Wiki Proposal Template (Step 3)

## rg-cite-before-CREATE rule

Before proposing any NEW wiki page, run:

```
rg -li "<topic keywords>" ~/Documents/brain/wiki/ -t md
```

If matches exist, prefer UPDATE over CREATE. Surface any matches in the proposal so the user sees what you found. This is mandatory -- `rg` cite before CREATE.

## Proposal format

Show the user this structured plan BEFORE writing anything:

```
Wiki updates proposal:

Pages to UPDATE (existing):
- [[page-name]] — what's changing and why

Pages to CREATE (new):
- [[new-page-name]] (category: X) — one-line summary of what it'll contain

Pages to ARCHIVE/SUPERSEDE (rare):
- [[old-page]] — being superseded because...

Cross-references to add:
- [[page-A]] ↔ [[page-B]] — because both discuss X

Index updates:
- Add [[new-page]] under <category>
- Update [[updated-page]] description
```

Wait for the user's OK or revisions before proceeding to Step 3.5.
