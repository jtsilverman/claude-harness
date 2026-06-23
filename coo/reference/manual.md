# COO Reference Manual (coo/reference/manual.md)

The COO playbook's reference half: the eight pure-reference sections moved out of `coo/coo-sop.md` so the always-injected operating core stays lean. This file lives in `coo/reference/` ON PURPOSE: the session-start hook injects `coo/*.md` with a NON-RECURSIVE glob, so a file one directory down is NOT auto-loaded every session. The COO reads it on demand (when a pointer in `coo-sop.md` sends it here), not as standing context.

Section numbers are preserved from `coo-sop.md` so existing pointers (`see manual.md § 16.1`) resolve. Operating-core sections (§1, §3, §4, §5, §6, §7, §8, §9, §10, §15, §19, §20) stay in `coo-sop.md`; this file holds the reference sections (§2, §11, §12, §13, §14, §16, §17, §18) plus the §5a merge-sequence slip histories (field detail behind the § 5 procedure).

---

> Moved from coo-sop.md (chunk 2, coo-doc-leanness).

## 2. How docs reach agents (the COO's loading duties)

The kernel states the model; these are the consequences the COO acts on.

- **Inheritance is agent-type-dependent, not worktree-gated.** Most agent types (worktree builders, general-purpose and default workflow agents, and the reviewer) inherit the full bodies of `CLAUDE.md` + every `rules/*.md` file at spawn. Lean types (`Explore`) get a stripped context with neither. So `git-discipline` reaches reviewers too; do not re-add it to their payloads.
- **`coo/*.md` reaches the COO only** (session-start hook; does not fire on subagent spawns). Workers stay blind to orchestration by construction.
- **`disciplines/*.md` is injected, not inherited.** `rules/` reach is indiscriminate (a doc there reaches builder AND reviewer AND fixer), so targeting one agent type requires dispatch injection: the worker-pipeline injects `worker-discipline.md` into builder + fixer and `review-contract.md` into reviewer + Codex. One file each -> no drift; dispatch-injection -> no skip; outside `rules/` -> no leak.
- **Placement decides reach:** every agent needs it -> kernel or `rules/`; some agents need it -> one shared file the workflow injects to just those agents (never copied into multiple agent.mds; that is the drift); one agent needs it -> inline in that agent.md.
- **Snapshot caveat (load-bearing for scheduling).** Subagents inherit the parent session's START-TIME snapshot of these docs. A doc rewritten mid-session is invisible to workers spawned later in the SAME session. When a chunk rewrites a doc that a dependent chunk's worker must obey, the COO threads the rewritten content into that dependent payload explicitly; never rely on inheritance to deliver a mid-session rewrite.
- **Static vs dynamic orientation.** Static = the agent.md (identity + loop) plus the inherited/injected docs. Dynamic, rebuilt per dispatch = the task payload + recall findings + chunk-shape-matched exemplars (§ 13).
- **READ is enforced by placement/injection; LISTEN cannot be forced.** Two backstops: the review net catches a violation per chunk (immediate); the grader catches recurring non-compliance and the redesigner sharpens the prompt (systemic).

---

> Moved from coo-sop.md (chunk 1, coo-simplification).

## 5a. Merge-sequence slip histories (why the procedure is structural)

The § 5 merge sequence is enforced by a tested primitive rather than prose because the same failures recurred under prose escalation. The procedure itself is authoritative in `coo-sop.md § 5`; this is the field history behind it, kept out of the operating core.

- **The fold-it-all-in slip.** "Don't fold the prune into the merge" slipped 6x in one session and was flagged in the backtest-robustness grade. The earlier shape was "fold it all into one four-step Bash command," which let the worktree prune ride along unconfirmed AND let `git branch -d` run after a red suite. The three-invocation primitive-based shape removes both folding sites by construction: a `merge_chunk_branch` call physically cannot contain a `git worktree remove` line or a `git branch -d`, so the prune (step 1) and the gated branch delete (step 3) cannot collapse into the merge.
- **The file-bring slip (a subtler relapse).** A `git checkout <chunk-branch> -- <files>` file-bring (bringing only the in-scope files across, then a hand-rolled `git commit`) is NOT a contamination-immune alternative merge -- it is the same hand-rolled-git-dance slip wearing a different keystroke. It slipped across an entire spec's merges after one contaminated chunk branch seeded it and then GENERALIZED into the default path, used even on chunks with NO contamination. `merge_engine.py` exposes no file-scoped or board-skip path: `merge_chunk_branch` rebases the WHOLE branch, so there is nothing to reach for in place of it. The contaminated-branch recovery (strip the board commit via a fixer, then run the primitive) is in `coo-sop.md § 5` step 2; the file-bring is never the recovery.

---

> Moved from coo-sop.md (chunk 2, coo-doc-leanness).

## 11. Chunk vs spec: the contract-fit test

One test decides whether mid-flight work is a chunk or a new spec: **does it change what was signed at spec-lock?**

- **No** (fits the locked Context / Requirements / theme, or is a sub-goal of one) -> a **chunk**. If large, decompose into more chunks; size is never a spec signal.
- **Yes** (opens a goal the locked narrative doesn't cover, violates a non-goal, changes the contract) -> a **new spec**. Same condition § 10 calls scope-invalidating (blocking).

**Default: lean chunks.** A wrong chunk-call is silent scope creep on a locked contract, invisible until the ship review no longer maps to a coherent narrative; a wrong spec-call is cheap visible ceremony. So bias to chunks, but every added chunk must name which Requirement it serves; if it cannot, it is drift. **Grouping items into one spec:** group what you would REVIEW and SHIP together (shared theme + ship boundary + shared risk); split items with independent verdicts or ship timing. Board thrash and resume friction are the signals one theme too many got grouped.

---

> Moved from coo-sop.md (chunk 2, coo-doc-leanness).

## 12. Agentic primitives (the decomposition rubric)

When packaging a capability, there are exactly three primitives; pick before building. Wrong pick = overhead with no benefit, or lost capability.

- **TOOL: a deterministic capability the model calls** (run code, read a file, search, call an API; same call, same result). Lean on human-like primitives first (code execution, filesystem, web search); add custom tools only when a primitive doesn't exist. MCP only when multiple agents need the SAME standardized, governed access (a governance layer, not a convenience alias). Anti-pattern: wrapping a one-liner shell command as a custom tool.
- **SKILL: a packaged step-by-step procedure the model follows inline.** For procedural, judgment-heavy capabilities with reuse pressure, small enough to pull on demand. The key property is progressive disclosure: a skill stays on disk until called, keeping the always-on context lean. Anti-pattern: inlining an occasionally-needed procedure in an always-loaded prompt.
- **SUBAGENT: a separately-context-windowed worker for isolatable work.** Two valid reasons only: **parallelism** (fan a task out) or **context isolation / a fresh mind** (a reviewer must not carry the writer's context; inherited framing distorts judgment). The work needs its own contract and completion criteria; output returns to the orchestrator, which synthesizes. Anti-pattern: exposing a subagent as a tool (schema-wrapping degrades instruction fidelity both ways).

**Checklist:** deterministic and discrete -> TOOL. Procedural + reused across contexts -> SKILL. Needs parallelism or a fresh mind -> SUBAGENT. Judgment-heavy but invoked from exactly one place (reuse=0) -> **keep inline; do not promote.** When in doubt, inline first; extract when the pressure actually arrives. (Worked example: grill-me was correctly kept inline at reuse=0; it was promoted to a standalone skill only when it became a default step of every spec-collaboration run, i.e. when the reuse pressure arrived. The rubric's verdict changed because the facts did.)

**The "prompt outgrew itself" signal.** A sprawling system prompt or skill eventually regresses: a capability that was clean now needs self-corrections, two sections contradict and the model oscillates, new function works but old function regresses, or the right answer arrives via a winding path. **Eval regression is the signal; line count alone is only the smell.** On regression + sprawl: stop adding; extract the overloaded portion into a skill (progressive disclosure) or split into a subagent (isolation). Qualitative judgment, not a token-count gate.

---

> Moved from coo-sop.md (chunk 2, coo-doc-leanness).

## 13. Cold start + authoring long-lived surfaces

- **Seed exemplars (dispatch-side grounding).** `workflows/seed-exemplars/` holds compact distillations of known-good build cycles (the recall -> RED -> GREEN -> REFACTOR shape, not transcripts). They are the cold-start fallback until the memory store warms: when recall has little to surface for a chunk's shape, include 1-2 shape-matched exemplars in the dispatch payload (unit-test chunk / new-files chunk / new pure module). Exemplars are grounding, not a script: they calibrate what "RED for the right reason," "minimal GREEN," and "REFACTOR found nothing vs deleted X" look like as reported results. What a good chunk looks like is the worker's doc (`disciplines/worker-discipline.md`); the COO's job is only to supply the grounding.
- **Lockstep variants.** The build-agent effort variants share one body; an edit to the body applies byte-identically to every variant file, then diff to verify parity before committing. Editing one and forgetting the siblings is the drift.
- **Long-lived docs are self-contained.** Docs loaded every run (this playbook, the kernel, the disciplines, agent.mds) must strip spec-relative shorthand: no numbered requirements, no chunk IDs, no section refs that only resolve inside a spec archive. A future reader has the doc, not the spec that built it.

---

> Moved from coo-sop.md (chunk 2, coo-doc-leanness).

## 14. The five-step loop (Dalio, compressed)

Goals -> Problems -> Diagnosis -> Design -> Do, at three cadences: per bug (`systematic-debugging`), per chunk (kickoff/review net), per spec (grader + ship funnel). The one load-bearing rule: **never let a Problem jump straight to a Design; run Diagnosis first.** Symptom-patching without a root cause is the failure mode `systematic-debugging`, `reset-or-decompose` ("the fix is upstream"), and the grader judge's fault split all exist to block. The mapping in this system: Goals = the locked spec + chunk contracts + the board; Problems = review-net findings, Stage-1 failures, grader flags; Diagnosis = systematic-debugging, the judge's memory-vs-doc root-cause, reset-or-decompose; Design = chunk-pivot, spec-collaboration for scope changes, the judge's routed findings; Do = the builder/fixer, the redesigner's applied rewrite.

---

## Decision principles (Dalio-translated COO doctrine)

Three judgment rules, not mechanisms to build:

1. **Believability is a LENS.** Weight input by domain track record -- the operator on vision/product, COO on systems/operations. Apply this manually; no scoring cards are built yet.
2. **Diagnose before design.** A Problem must pass through Diagnosis before a Design is proposed. No Problem jumps straight to a solution; name the root cause first.
3. **Decision-rights by class.** Vision and direction go to the CEO. Execution and operational calls go to the COO. Disagreements escalate by class, not by urgency.

---

## 16. Perplexity surfaces (the operator-run)

Perplexity (Deep Research + Comet) is a the operator-run research and review surface. The COO hands the operator a copy-paste prompt at defined moments; the output is advisory input, never a blocking gate. Surface 1 is mandatory per spec; surfaces 2-3 are optional. Calibrate every prompt for truth: "no issues" is a valid output; require evidence per flag. Prompts live here only; skills reference this section.

**16.1 Perplexity spec pass (MANDATORY, every spec; § 4 step 5).** During spec-collaboration, after decomposition is drafted and before lock. Fire-and-tell: the operator runs it asynchronously; lock does not wait.

**Mode selection (COO picks by complexity):** trivial or narrow spec (single factual unknown) -> quick query; complex, high-unknown, or multi-axis spec -> full Deep Research. "Skip it" is never a valid mode.

*Quick-query template (trivial/single-unknown specs):*

```
Perplexity quick query: spec-draft gate
Spec: <spec-name>
Question: <one specific factual question>
Context: <one sentence on why this matters for the spec>
```

*Deep Research template (complex/multi-axis specs):*

```
Deep Research prompt: spec-draft gate
Spec: <spec-name>
Design question: <one-sentence statement of the open design question>

Research axes:
1. <axis 1, e.g. "existing implementations of X in production systems">
2. <axis 2, e.g. "known failure modes of approach Y">
3. <axis 3, e.g. "industry consensus on Z vs W tradeoff">

Evidence standards: prefer primary sources (docs, papers, post-mortems) over blog
summaries. Cite sources with dates. Ranges over midpoints where data is noisy.

Required output shape: end your synthesis with a short decision table:
| Option | Evidence summary | Key risk | Recommendation |
```

**16.2 Comet high-stakes chunk review (`heavy` chunks only; optional, never a gate).** At the review stage of a `heavy` chunk where an extra independent lens beyond Codex + Sonnet is warranted, offer the prompt alongside the standard results; the operator decides on perceived residual risk. The chunk proceeds on Codex + Sonnet alone. Template:

```
Comet review prompt: heavy chunk
Chunk: <chunk title>
File(s) touched: <list>
Behavior shift: <before -> after>

Diff summary:
<paste the git diff or a summary of key changes>

Review focus:
1. Correctness: does the implementation match the stated behavior shift?
2. Edge cases: what inputs or states could produce wrong behavior?
3. Irreversibility: if this is a high-blast-radius heavy chunk, what would make a mistake unrecoverable?
4. Blast radius: what downstream systems or behaviors could be affected?

Calibration: "no issues" is a valid and correct response for a sound change.
Require concrete evidence per flag (quote the code, name the specific input that
breaks, cite the rule violated). Do not surface uncertain findings.
```

**16.3 Comet final system review (at ship; optional).** At ship, a full-system coherence lens when the accumulated changes are larger than any single review captured; ship proceeds regardless. Template:

```
Comet final system review prompt
Spec: <spec-name> (shipping)
Phase: <phase name / number if applicable>

Summary of changes shipped in this spec:
<paste the completed chunks list with one-line summaries>

Review focus:
1. Coherence: do the shipped chunks form a consistent, non-contradictory system?
2. Coverage: are there obvious gaps in the acceptance criteria that were never tested?
3. Emergent risks: what interactions between chunks could produce unexpected behavior?
4. Residual open questions: which open questions in the spec were never resolved and
   could bite downstream?

Calibration: "no issues" is a valid and correct response for a clean ship.
Require concrete evidence per flag. Do not surface speculative concerns.
```

**Rules:** the operator-run only, no automated invocation. Routine `default` chunks never get a Comet offer. These surfaces supplement the standard net (Codex + Sonnet); they replace nothing, and the verdict is always the operator's at the named gates. Separately: when the COO hits an empirical unknown it cannot settle and that gates a decision, hand the operator a tight copy-paste Perplexity prompt inline as an option (memory `feedback_route-open-questions-to-perplexity`).

---

> Moved from coo-sop.md (chunk 2, coo-doc-leanness).

## 17. Research, wiki, visualization (routing)

**Research posture.** Shallow + current -> WebSearch / WebFetch. Deep synthesis on a hard topic -> a § 16 Perplexity hand-off. Multi-source fact-check on contested claims -> `workflows/deep-research-sonnet.js` (sonnet-pinned; § 1.1). Codebase-specific -> Grep/Glob/Explore. Training data stale? Prefer live sources.

**Wiki routing** (the wiki system is unchanged; wiki is not memory):

- "Here's a new source, add it" -> `/wiki-ingest <path>`.
- **Chat-paste auto-trigger.** Source-shaped content pasted (URL with extract, multi-paragraph quote, tweet, Perplexity output, GitHub URL, article excerpt) auto-fires `wiki-ingest`. Detection is qualitative, no token-count gate. Surface destination inline (`Filing this to sources/<kind>/<date>-<slug>.md, flag if not.`), then write; the Rule 7 surface IS the audit, no Y/N gate. A paste bundled with a question still fires: answer AND capture in the same turn.
- **Web-research auto-trigger.** The COO's own WebSearch/WebFetch surfacing a substantive, reusable source auto-fires the same way, tagged `research-capture`; noise guard is source-shaped-and-citable vs a version/navigational lookup.
- "What do we know about X?" -> `/wiki-query`. "Is the vault healthy?" -> `/wiki-lint` (weekly cron carries the structural sweep; it is not a ship step).
- Session-derived lessons are NOT ingest: tactical -> memory-agent (§ 8.1); concept -> wiki via the capture flow's `wiki-ingest` seam. One surface per lesson; never the same lesson in two voices.

**Visualization.** "Draw X" / "ERD" / "swim lane" / "I want a visual" -> `diagram-system`. "I'm lost in this system" -> check `wiki/projects/<project>/index.md` first; stale or missing -> `diagram-system`. Upkeep is automated at ship (§ 7 diagram step), not lock-gated at chunk time. Conventions, frontmatter, layer rules: `~/Documents/brain/wiki/diagram-conventions.md`. Anti-patterns: ASCII art called a diagram; drawing before the textual summary; cramming small diagrams inside boxes (use the `expands` hierarchy).

---

> Moved from coo-sop.md (chunk 2, coo-doc-leanness).

## 18. Infrastructure

Personal infrastructure has been redacted for the public release of this harness.
Define your own host aliases in `~/.ssh/config` and reference them here if your
COO session orchestrates work across multiple machines. The harness itself does
not require any particular host topology; everything runs against the local
`~/.claude/` working directory by default.
