# Step 3.5 Dedupe Protocol

Full detail for the mandatory dedupe check before writing any new source file.

## Detection

- List existing files in the target subdir: `ls ~/Documents/brain/sources/<kind>/` (or `find` per `lint-scan-bash-hygiene` if the subdir might be empty under zsh).
- For each existing file, read the `description:` and `url:` frontmatter fields.
- Judge overlap: same URL? Same author + same topic? Excerpt of the same underlying piece?

Qualitative judgment, not a token-count or filename diff -- same rule as the auto-trigger detection.

## On overlap detected

Prompt the operator with one of three actions:

> I see overlap with [existing-file] (description: \<one-line\>, url: \<url\>).
> [One-sentence judgment of overlap shape — what's the same, what's different.]
> Recommend [supersede | merge | parallel].
> Confirm or override? [Y / M / P / n]

- **supersede (Y):** new source replaces old. The old gets `status: superseded-by-[[new-slug]]` set in its frontmatter (sources are immutable per SCHEMA -- no archive move; just status flip). New source written normally with a `supersedes:` field pointing to the old slug.
- **merge (M):** rare for sources (usually they're discrete artifacts). When it does apply (two excerpts of the same article), Claude drafts a single combined source file and applies the supersede to the older one.
- **parallel (P) or skip (n):** write new source normally; both coexist, no link.

## On no overlap

Proceed silently to Step 4. Don't surface "no overlap found" -- only surface when there's a decision to make.

## Gate purpose

This is a mandatory inline pause; it's the only judgment call between propose and write for source captures. (Wiki-page edits in Step 3 already had the operator's approval; this gate exists specifically for the new auto-capture source-write path.)
