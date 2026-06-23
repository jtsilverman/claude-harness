# Required Source Frontmatter

Per SCHEMA.md, every source file MUST carry:

```yaml
---
type: source
source_kind: article | paper | clipping | tweet | repo | session | perplexity | inbox
title: <plain title>
description: <one-line hook for recall ranking — what this source IS, in plain terms>
date_added: YYYY-MM-DD
date_published: YYYY-MM-DD       # if known, else omit
url: <original URL if web source>
author: <if known>
status: active
tags: [tag1, tag2]
supersedes: <prior-source-slug> | null    # set by Step 3.5 dedupe on supersede
---
```

## Critical: the `description:` field

`description:` is the recall surface -- recall Pass 2 ranking depends on it. Auto-capture writes MUST include it (don't leave it for the operator to backfill -- the Karpathy article is exactly the kind of source that ended up missing this field per chunk 5's live-finding).

Auto-captured sources (from web research) also get `research-capture` added to `tags:` so autonomously-written sources stay distinguishable from the operator's deliberate pastes.
