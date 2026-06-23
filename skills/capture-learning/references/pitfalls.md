# Common Mistakes and Red Flags

Reference for `capture-learning`. Use when something feels off; these are the known failure modes.

---

## Common mistakes

- **Asking the operator what to capture, or showing a draft for approval.** The memory-agent decides from the candidate and the store, acks one line per disposition, and writes. the operator overrides after the fact.
- **Drafting finished captures in an emitter context.** A builder, fixer, or judge that "helpfully" drafts a routed, voiced capture is doing the memory-agent's job without its reconcile. Emit the RAW candidate (`{raw_lesson, kind_hint, provenance}`) and stop.
- **Defaulting to skip on wiki because the lesson "doesn't feel big enough."** That's the old "high bar wiki" framing. New rule: route by content shape; skip only if tactical-only and already in memory.
- **Folding everything into `wiki/concepts/`.** Use the destination that fits the content shape: project notes go to `wiki/projects/<project>/`, tool deep-dives to `wiki/tools/`, daily synthesis to `wiki/daily/`, etc.
- **Routing a tactical rule to wiki because it sounds bigger-picture.** If future Claude needs to follow it, it goes to memory. Wiki is for things the operator reads and recall's wiki pass surfaces as background, not mid-chunk rules.
- **Writing both surfaces with the same content in different voices.** That's redundancy. Two captures = non-overlapping content with different audiences.
- **Long memory entries.** 100-200 words. If longer, the rule is probably also a concept: split into a memory pattern (terse) AND a wiki concept (explanatory).
- **Trying to capture a pasted source.** Source URLs / quotes / articles → wiki-ingest, not capture-learning. capture-learning is for session-derived insight only.
- **Skipping `description:` field.** Required on wiki and memory. It's the primary rank surface in the hybrid index; without it, recall can't surface the file by relevance.
- **Making up a memory `type:` value.** Stay in the enum. The harness reads it.
- **Skipping `index.md` / `log.md` updates on wiki writes.** SCHEMA Hard Rule #3. Wiki writes are atomic with their index entries.
- **Editing MEMORY.md or any `INDEX.md` on capture.** The hybrid SQLite index is the retrieval surface; the memory-agent's write+index step keeps it current. Capture appends to no markdown index file.
- **Picking a bucket.** Buckets are retired; tags (3-6, kebab) carry the categorization and the index retrieves flat. New entries land directly in their kind's subdir (`patterns/`, `preferences/`, `failures/`); legacy bucket subdirs stay readable through the index but never receive new files.
- **Moving a superseded memory entry to `superseded/`.** Memory supersession is a frontmatter status flip (`status: superseded` + `superseded_by`), executed by the reconcile, with no directory move. The dated-archive move convention is wiki-only.

---

## Red flags

- "I'll write to memory and also write the same lesson to wiki for the operator to read" → Route, don't duplicate. If you can't articulate non-overlapping content for each, pick one.
- "This is project-specific so I'll skip it" → Project-specific is `wiki/projects/<project>/`'s job. Skip-rule is only "tactical-only and already in memory," not "doesn't fit `wiki/concepts/`."
- "This is a big realization, I'll write 800 words to wiki" → Stay terse. SCHEMA Hard Rule #8. If 800 words is genuinely needed, split into two pages.
- "An entry already covers something similar, I'll just overwrite it" → Never overwrite. The reconcile decides: extend, merge into, supersede (status flip), or drop the duplicate. `agents/memory-agent.md` owns that decision.
- "The hit titles look unrelated, I'll skip the reconcile call" → The threshold pre-filter (zero BM25 hits and cosine < 0.60) is the only sanctioned skip, and it never decides the disposition. With hits present, the reconcile call runs against each hit's full body.
- "This batch surfaced some messy neighbors, I'll clean them up while I'm here" → One batch only. Entries your candidates did not touch stay byte-unchanged; store-wide cleanup is not a capture-time job.
