# Body and Frontmatter Templates

Templates for the draft step (SKILL.md Step 3): body first, then frontmatter. Copy the relevant block and fill in.

---

## Body templates

### Memory pattern body

```
<one-sentence rule>

**Why:** <mechanism, the underlying reason this is true>

**How to apply:** <when this kicks in / what to do / what to avoid>
```

### Memory failure body

```
<one-sentence what-went-wrong>

**Cause:** <root cause, not symptom>

**Attempts:** <branch names or attempt numbers>

**Resolution:** <option chosen: shrink | decompose | reset | abandon>; <rationale>

**Lesson:** <the rule that survives this failure>
```

Memory word budget: 100-200 words.

### Wiki concept body

```
## How this works in plain English

<2-4 sentences for a reader who knows software but not this specific system. Additive to sections below; required on every new wiki page per diagram-conventions.md. Project notes and coding-log entries use the same opening section.>

## What this is

<one-paragraph framing>

## Why it matters

<mechanism / underlying truth>

## How it shows up

<concrete examples, [[wiki-links]] to related concepts>

## Related

<bullet list of [[wiki-links]]>
```

Wiki word budget: 200-500 words.

---

## Frontmatter templates

### Memory frontmatter

```yaml
---
name: <human-readable title>
description: <one-line hook; the primary rank surface in the hybrid memory index. Specific enough that the trigger condition is recognizable from the description alone.>
type: feedback
kind: pattern | preference | failure
status: active
superseded_by: null
tags: [<3-6 kebab-case tags>]
importance: <1-10>
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
---
```

`type: feedback` for all three kinds (closest fit in the auto-memory enum, owned by the harness; do not repurpose). The kind-of-memory distinction lives in the subfolder and the `kind:` field, which matches the subfolder name (`patterns/` maps to `kind: pattern`, etc.). Tags replace buckets: 3-6 kebab tags, no `bucket:` field. `status` and `superseded_by` belong to the reconcile EXECUTE step (`agents/memory-agent.md`): a new entry is born `active` with `superseded_by: null`; a superseded entry gets its `status` flipped and `superseded_by` set in place, with no directory move. Use `date +%Y-%m-%d` for `created_at`/`updated_at` (don't guess); EXTEND and MERGE_INTO bump `updated_at` on the target.

For failures, also include in frontmatter:
```yaml
project: <project-slug>
chunk: <chunk-name>
attempts: [<branch-1>, <branch-2>]
```

### Wiki frontmatter

```yaml
---
type: wiki
category: concept | project | tool | person | framework | domain | entity | daily | pattern | failure | win | decision
description: <one-line hook for the recall surface>
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: []
related:
  - "[[other-page]]"
supersedes: <prior-page-slug> | null
status: active
tags: [tag1, tag2]
---
```

Use `date +%Y-%m-%d` for the date (don't guess). The `description:` field is required; it is the recall ranking surface.
