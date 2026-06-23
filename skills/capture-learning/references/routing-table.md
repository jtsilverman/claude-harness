# Routing Table

Full destination map for `capture-learning`. Route by content shape; the question is "what kind of thing is this lesson?"

| Lesson shape | Destination |
|---|---|
| Tactical rule for future Claude (do/don't, mid-chunk) | `memory/patterns/<slug>.md` (tags carry the categorization; no bucket layer) |
| User preference (the operator's working style or Claude-behavior rule) | `memory/preferences/<slug>.md` |
| Failure post-mortem on a 2-strike chunk | `memory/failures/<slug>.md` |
| Plain-English concept the operator should read (generalizable across projects) | `wiki/concepts/<slug>.md` |
| Project-specific note (status shift, decision, architecture insight) | `wiki/projects/<project>/<slug>.md` |
| Tool deep-dive (Obsidian, Claude-Code, etc.) | `wiki/tools/<slug>.md` |
| Person note | `wiki/people/<slug>.md` |
| Framework reference (GSD, Superpowers, Hermes, OpenClaw) | `wiki/frameworks/<slug>.md` |
| Domain knowledge (prediction-markets, btc-15min-trading, etc.) | `wiki/domains/<slug>.md` |
| Entity (company, product, concrete thing) | `wiki/entities/<slug>.md` |
| Daily synthesis | `wiki/daily/YYYY-MM-DD.md` |
| Coding-log: pattern surfaced during a chunk | `wiki/coding-log/patterns/<project>/<slug>.md` |
| Coding-log: failure (per-project record, not the 2-strike memory post-mortem) | `wiki/coding-log/failures/<project>/<slug>.md` |
| Coding-log: win | `wiki/coding-log/wins/<project>/<slug>.md` |
| Coding-log: decision | `wiki/coding-log/decisions/<project>/<slug>.md` |

**Skip-rule:** the only valid skip is "this is tactical-only and the rule is already in memory." Everything else routes somewhere.
