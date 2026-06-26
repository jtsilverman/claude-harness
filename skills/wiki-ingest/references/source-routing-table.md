# Source Routing Table

Full kind-to-destination mapping for the auto-trigger and explicit ingest flows.

## Routing table

| Source shape | Destination | source_kind |
|---|---|---|
| Tweet (X.com / Twitter URL or pasted tweet body) | `sources/tweets/<YYYY-MM-DD>-<slug>.md` | `tweet` |
| Article (Substack, blog, news, any URL with prose extract) | `sources/articles/<YYYY-MM-DD>-<slug>.md` | `article` |
| Website clipping (snippet from a non-article URL) | `sources/clippings/<YYYY-MM-DD>-<slug>.md` | `clipping` |
| GitHub / GitLab / repo URL | `sources/repos/<YYYY-MM-DD>-<slug>.md` | `repo` |
| Perplexity Pro output | `sources/perplexity/<YYYY-MM-DD>-<slug>.md` | `perplexity` |
| Academic paper (arxiv URL or PDF reference) | `sources/papers/<YYYY-MM-DD>-<slug>.md` | `paper` |
| Claude / AI session handoff | `sources/sessions/<YYYY-MM-DD>-<slug>.md` | `session` |
| Uncategorized paste (you can't judge the kind) | `sources/inbox/<YYYY-MM-DD>-<slug>.md` | `inbox` |

`raw-research/` is reserved for batch material the user pre-organizes; do not auto-route there.

## Ambiguity rule

When inferring `source_kind` is genuinely ambiguous (e.g., a long Reddit comment — clipping or article?), pick the closer fit and surface that decision: `Reading this as a clipping, not an article — flag if you'd rather route to articles/.` Don't ask the user to pick from the menu; pick and surface.
