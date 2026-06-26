---
name: learn
description: Use when the user invokes /learn (or asks to distill what a session taught), and fired automatically by the SessionStart hook on the previous session's transcript when that session qualified. Dispatches the single learn-evaluator agent to extract a compact state summary plus up to 5 durable lessons (each classified by scope and type), applies the merge-prune to MEMORY.md or the project CLAUDE.md under the hard cap, queues any machine-gap as a build task, and shows the user the diff. The whole self-improvement loop, one agent, single writer.
---

# Learn

The lean self-improvement loop, end to end. Triggers: The user runs `/learn`, OR the SessionStart hook fires it on the previous (same-workspace) transcript when that session qualified (substantial work). One evaluator, one flat always-loaded file, no grader pipeline, no memory store, no recall step.

## Steps

1. **Gather the transcript.** Identify the transcript to distill: the SessionStart hook passes the previous session's archived transcript; a manual `/learn` uses the current session (a path to the archive if available, else summarize the arc yourself).

2. **Dispatch the evaluator.** Spawn one `learn-evaluator` subagent (Sonnet) with the transcript and the path to `~/.claude/MEMORY.md`. It returns two payloads as data and writes nothing:
   - **`stateSummary`**: what the session did, where it ended, what is next (the cross-clear continuity readout). Read it to orient.
   - **`lessons`**: up to 5 durable lessons, each tagged `scope` (global | project) and `type` (machine-gap | instance), plus any `merges`/`prunes`. Zero lessons is a normal result.

3. **Apply under the cap (single writer = you).** Apply `merges`/`prunes` first, then write each lesson to its scope target: `scope: global` -> `~/.claude/MEMORY.md`; `scope: project` -> that project's `CLAUDE.md`. Confirm the target stays under its ~100-line cap; if still over, prune the lowest-value lines yourself. Never blind-append over the cap.

4. **Queue machine-gaps, don't apply them.** A lesson tagged `type: machine-gap` means "a rule/skill/CLAUDE change would make this mistake structurally impossible." It may carry a draft edit. Do NOT auto-apply it. Surface it as a queued build task (spec -> change -> review -> the user merges). Only `instance` lessons get written as notes here.

5. **Show the user the diff.** Surface what changed in the target file (added lines, merges, prunes) plus any queued machine-gap, so he can veto. One line per lesson, plain English.

## What this is not

Not a multi-agent grader. Not a tagged store with an index. Not autonomous skill/rule rewriting (machine-gaps route through the build gate). If you find yourself wanting recall, embeddings, or a second agent here, stop: the read path is the `@MEMORY.md` import in `CLAUDE.md`, already always in context. There is no seam to reconnect.
