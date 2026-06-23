---
name: ship-spec
description: Use when a project's spec is complete or being abandoned, to ship it COO-style as a SEQUENTIAL funnel -- a re-runnable GATE phase (Stage-1 live-run, Stage-2 full-spec code review + Codex), then once the gates come back clean a run-once ARTIFACT phase (the one self-sufficient diagram refresh + Stage-3 demo), then the CEO go/no-go. On GO it merges the feature branch to main (rebase + --ff-only), triggers the grader workflow over the spec's session archive, and runs the Fable redesign step (visible commits, diffs in the ship report, no metric gate). Invoked at last-chunk completion or manually when a spec ends early.
---

# Ship Spec (thin orchestrator)

The COO ships the spec by firing separate pieces in sequence, never by doing the work inline: the `ship-review-workflow` funnel (GATE phase: Stage-1 + Stage-2 review + Codex), then once gates are clean the ARTIFACT phase (the one self-sufficient diagram refresh + Stage-3 demo + CEO GO), the merge, the grader trigger, and the redesign step. Each piece returns data; the COO is the sole writer that applies it. Policy (status enum, archival path, rollback) lives in `coo/coo-sop.md` 7.3 (spec lifecycle); communication rules in `coo/communication-discipline.md`.

**The funnel is SEQUENTIAL.** Stage-1 (does it run) gates Stage-2 (is the code right) gates Stage-3 (does the operator approve). A failing Stage-1 stops the funnel: no deep review, no demo, no merge. Do not spend the deep review on something that does not run. Route the failure back to the fix-loop, re-open the implicated chunk(s), and re-run the funnel from Stage-1 once fixed.

## When it fires

- Auto: the cockpit detects every chunk in `## Chunk decomposition` is `merged` or `deferred` and routes here.
- Manual: the operator invokes directly for specs that end early, pivot abandonment, or any off-path ship moment.

A skip of any step below is never silent: surface `Skipped <step> because <reason>.` at the Stage-3 gate.

## Step 0: Setup

1. **Board complete?** Read `specs/current.md` (stop if absent). Every chunk `merged` or `deferred` (`python3 scripts/exec_state.py parse < specs/current.md`); surface and stop on any `building` / `awaiting-review` / `failed`.
2. **Status + slug + dates.** Confirm `Shipped` or `Abandoned` with the operator if not supplied. Slug from the `# Spec:` heading (lowercase, hyphenated); never fabricate one, ask if the heading is missing. Dates: `date +%Y-%m-%d` (Status line), `date +%Y%m%d` (archive filename).
3. **Assemble the funnel args:** spec trio (current-state, changes, end-state), feature branch + base ref, the spec's top tier, a one-paragraph what-shipped summary, and the diagram conventions reference.

An Abandoned spec skips the funnel (nothing ships): go straight to Step 3's archive + Status flip, then stop. Say so.

## Step 1: The ship-review funnel (Stage-1, then Stage-2)

Invoke `workflows/ship-review-workflow.js` via the Workflow tool with the Step 0 args. It runs the sequential funnel and returns pure data:

- **Stage-1 live-run** (opus): drives the built system end-to-end on real input. Empirical gate. On `verdict: fail` the workflow returns immediately with `stopped: 'stage1-failed'` and Stage-2 never spawns.
- **Stage-2 full-spec code review**, only on a Stage-1 pass: one opus reviewer over the aggregate feat-vs-main diff against the spec's goal + non-goals, alongside the Codex cross-model lens (`scripts/codex-review.sh`, tier-scaled). Catches what per-chunk reviewers could not see: integration, coherence, mirror-surface drift.
**The funnel is split into a re-runnable GATE phase and a run-once ARTIFACT phase (coo-simplification C3).** The GATE phase is just Stage-1 + Stage-2 (review + Codex); call it with `gatesOnly: true`. The diagram refresh and the demo are NO LONGER in the gate barrier -- they are the artifact phase, fired ONCE on green (below). This is the whole point of the split: a fix re-runs only the cheap gates, never the two expensive artifact producers it did not invalidate.

- **The artifact phase is run-once-on-green:** the COO fires `ship-review-workflow.js` a second time with `artifactsOnly: true`, threading in the final clean gate's `stage1Evidence` + `stage2Verdict`. It dispatches the ONE self-sufficient `diagram-refresher` (which lists the project's diagrams itself, judges stale-or-current against the AS-BUILT final system, refreshes the stale set, returns drafts -- contract: `agents/diagram-refresher.md`) and the `demo-assembler` (the Stage-3 narration drafted from the threaded-in final evidence + verdict), and returns `{ diagrams, demo }`. No per-diagram detection or dispatch COO-side. Judging the diagrams against the as-built system run-once-at-end is MORE correct than mid-gate-loop.

Gate-phase return shape: `{ stage1, stage2: { review, codex }, diagrams: null, demo: null, stopped, phase: 'gates' }`. Artifact-phase return shape: `{ diagrams, demo, phase: 'artifacts' }`. (With neither flag the workflow runs gates then artifacts in one linear pass, `phase: 'full'` -- the back-compat single-shot path.)

The funnel is sequential (Stage-1 gates Stage-2), the diagram refresh is one self-sufficient dispatch, and there is no separate capture arm: ship-time capture flows through the grader in Step 5 plus the Step 5.5 owed-backlog drain (per-chunk lessons are drafted by the builders during the build and drained to the memory-agent at Step 5.5 if not already event-routed at merge).

**Outcome routing.**
- `stopped: 'stage1-failed'`: fix-loop at worker level (re-open chunks, fix, re-verify), then **re-run the GATE phase** (`gatesOnly: true`) from Stage-1. No merge until clean. Does not rise to the operator.
- Stage-2 findings: adjudicate each against ground truth (truth-calibration; never performatively agree). Real technical findings -- INCLUDING trivial / logic-free ones (an unused dep, a docstring count, a test marker, a function rename): route through the fix-loop AT WORKER LEVEL (dispatch a worker fixer; re-open the implicated chunk if needed), then **re-run the GATE phase** (`gatesOnly: true`) -- NOT the artifact phase. A fix re-runs only the gates; the diagram refresh + demo are run-once-on-green and a fix did not invalidate them. The re-run of the GATE phase after ANY real Stage-2 fix is MANDATORY, with NO exemption: not "cosmetic," not "zero logic risk," not "suite green." A green acceptance suite from the worker fixer does NOT substitute for the gate re-run -- the suite ran on the worker's worktree, the gate must re-run on the fixed feature-branch HEAD. There is NO COO-hand-edit fast path for "small" or "just bookkeeping" findings -- the COO never hand-applies a code or test fix on the feature branch; trivial does not exempt it from the worker lane. The same non-exemption binds the gate re-run: a worker-fixed cosmetic change whose suite is green is still un-gated until `gatesOnly: true` re-runs clean on the post-fix HEAD. False positives: record the rejection rationale and proceed.
- Clean gate pass of the FINAL post-fix HEAD: fire the artifact phase (`artifactsOnly: true`, run-once-on-green) to produce the diagram drafts + demo, then proceed to Stage-3. The artifact phase (and the merge that follows it) fires ONLY on a clean gate pass of the HEAD it ships, never on a prior gate result plus a substituted suite re-confirm: if any Stage-2 fix landed after the last clean gate, that gate is stale and the artifact phase threads stale evidence -- re-run `gatesOnly: true` first.

## Step 2: Stage-3, demo + the one CEO go/no-go

Present the drafted demo (narration + evidence) plus the ship report skeleton (Step 7 fields gathered so far), CEO-email format, every technical term paired with a plain unpack. Ask the one go/no-go: merge to main, or hold?

- **Works but the operator wants a change:** never retrofit the spec to built code. Small and within intent: a follow-up chunk on the same branch before merge. Real redirection: seeds a new spec.
- **On hold:** the feature branch stays unmerged; nothing has touched main. Surface what is already applied vs reversible.

## Step 2.5: Owed-items register audit (forced verdict before merge)

Before any merge bookkeeping, open `specs/owed-items.md` and surface every OPEN entry to the COO/CEO for a forced per-item verdict. The audit is exhaustive: every open item is presented regardless of its `re-surface-trigger` value (owed-items surfaces exhaustively here at ship Step 2.5 only; there is no session-start injection of owed-items). The COO presents each item and records one verdict:

- **fix**: route for immediate resolution -- dispatch a worker or open a follow-up chunk before this spec merges.
- **formally-accept**: the item is acknowledged and closed; record the rationale inline in owed-items.md and update the item's `re-surface-trigger` field to `FORMALLY-ACCEPTED`. A `FORMALLY-ACCEPTED` marker causes the entry to remain in the register as a historical record; it will not surface at future ship audits.
- **kill**: delete the entry outright -- it is no longer relevant.

If the register is empty, this step is a no-op. A verdict is required on every open item before proceeding; no item may remain unresolved at merge.

## Step 3: On GO, bookkeeping before the merge (COO sole-writer)

Apply in this order, so a crash mid-apply never strands a half-shipped board:

1. **Apply the diagram drafts** to the vault (`~/Documents/brain/wiki/projects/<project>/`), one write per returned draft; surface each path per Rule 7.
2. **Flip the Status line** in `specs/current.md` to `Shipped - YYYY-MM-DD` (or `Abandoned - ...`, the `coo-sop` 7.3 format); change no other line.
3. **Archive:** `mv specs/current.md specs/archive/<slug>-YYYYMMDD.md` (never overwrite a collision; offer `-2` or abort). Clear `## Execution state` in the archived file (`scripts/ship_spec.sh` primitive: `clear_execution_state`).
4. **Scaffolding sweep:** delete the spec's acceptance scaffolding from `specs/` (`scripts/ship_spec.sh sweep_scaffolding`); protect-list (`current.md`, `owed-items.md`) and non-slug orphan scripts survive.
5. **Project-page sync:** flip the spec's line in `wiki/projects/<project>/index.md` to the terminal status.
6. **Commit the ship mutations** on the feature branch, staged deliberately (`git add <file>`, never `-A`): the archive rename, sweep deletions (tracked only), any pair-row. One commit; no bypass, no co-author footer.

## Step 4: Merge to main

Per `rules/git-discipline.md` Merge-back: rebase the feature branch onto latest main (never rebase main), then `git checkout main && git merge --ff-only <feature-branch>`, then push. No squash, no `--force`, no `--no-verify`. Surface the new main sha + per-chunk commit count. A diverged branch or PR-vs-direct decision is the COO's call at this gate (`coo/coo-sop.md § 7`).

## Step 5: Trigger the grader

The slow loop fires once per ship, over everything the spec's sessions produced. **The grader is mandatory at ship.** There is exactly one non-run path (a runtime error, below); archive size and token cost are never grounds to skip it.

1. **Stage the live transcript** by running `scripts/stage_session_transcript.sh <slug>` before grading. This self-resolves the newest-mtime `.jsonl` in `~/.claude/projects/<cwd-slug>/`, copies it and its sibling `<session_id>/` dir (subagent transcripts) into `specs/<slug>/sessions/<session_id>/`, and is idempotent (safe to re-run). Copy logic mirrors `hooks/session-archive.sh` (the SessionEnd-hook path for prior sessions). Without this step a same-session ship has nothing to grade.
2. **Build the segment manifest COO-side via Bash, then invoke the workflow with it.** Run the pure helper over the archive: `node --input-type=module -e 'import { buildSegmentManifest } from "./workflows/grader-workflow-lib.mjs"; process.stdout.write(JSON.stringify(buildSegmentManifest("specs/<slug>/sessions")))'`, capture the JSON array, and pass it as `args.manifest`. Then invoke `workflows/grader-workflow.js` via the Workflow tool: `{ manifest: <the array>, specSlug }`. The manifest is always built COO-side this way (no in-workflow segmentation step): the COO has Bash + node, so it builds the manifest directly, because routing a multi-KB array through an agent return was a truncation hazard. The workflow pre-bundles the in-scope segments and fans out one HAIKU summarizer per segment-bundle, then bundles the summaries and fans out one SONNET flagger per pre-bundled summary-bundle (not one per segment; the bundling caps the fan-out and its token cost), funnels every flag to the one opus judge, and returns routed findings as pure data: `{ memoryCandidates, docFaults, readerModelUpdates, corpusAppend, ledgerLines }`.
3. Apply the three **auto-apply side effects** mechanically via `workflows/apply-grade-side-effects.mjs` (no gate, no adjudication needed): `corpusAppend` -> `coo/voice-corpus.md`; `readerModelUpdates` -> `coo/reader-model.md`; `ledgerLines` -> the slow-loop ledger. Run: `node workflows/apply-grade-side-effects.mjs --grade <grade-result.json> --corpus coo/voice-corpus.md --reader-model coo/reader-model.md --ledger <ledger-path> --verbose`. The script is idempotent -- a re-run against the same grade JSON is a no-op. The two **adjudicated paths** remain manual: route `memoryCandidates` to the memory-agent batch (Step 5.5); hand `docFaults` to Step 6 (the redesign step). **Regrade note:** a manual re-grade rebuilds the manifest the same way -- run `buildSegmentManifest` via Bash and pass `args.manifest` -- never a hand-rolled loader agent (loader-agent StructuredOutput round-trips truncate large manifests; the COO-side Bash build avoids it).

**Large archive (scope, never skip).** A large manifest is not a reason to skip the grade or defer the whole thing. The workflow already pre-bundles to cap fan-out cost; when the archive is large, the scoping happens inside `buildSegmentManifest` (it drops out-of-scope and grader-self segments as the COO builds the manifest via Bash), and the workflow runs with the capped result. Never silent-skip on size, never defer the entire grade to "later."

**Fail-open is ERRORS ONLY.** The only non-run is the grader workflow throwing a runtime error: surface the error, skip Step 6, and finish the ship; a broken grade never blocks a shipped spec. This clause is not a general escape hatch. It is not discretion to skip on archive size, token cost, or convenience. Absent a runtime error, the grader runs every ship.

## Step 5.5: Drain the capture queue (memory-agent batch) -- runs in parallel with Step 6

The guaranteed capture drain. Capture is event-driven (`coo-sop.md` § Capture: "fires anytime, by whoever notices"), but event-driven firing has no enforced flush, so builder RAW candidates accumulate as an owed backlog across the build. This step is the backstop that drains it every ship, so nothing rots unrouted.

One memory-agent batch carries **both** sources (the memory-agent is the serialized sole writer -- one exclusive-flock batch, never two concurrent):
- The grader's `memoryCandidates` from Step 5.
- The **owed builder backlog**: every RAW `lessonCandidate` + `recallVerify` a builder bundle returned during the build that was not already event-routed to the memory-agent at its merge. (Track the owed set as it accrues -- board "Captures owed" notes / per-merge -- and drain whatever remains here.)

Dispatch ONE memory-agent with the merged batch; it dedups/reconciles across both (NEW/MERGE_INTO/SUPERSEDE/EXTEND/DROP_DUP) and returns per-candidate dispositions for the Step 7 report.

**This batch and the Step 6 redesigner run in parallel** -- disjoint surfaces (memory store at the absolute path vs policy docs `coo/*.md`/`agents/*.md`/`skills/`), no contention. Fire both, await both before Step 7.

## Step 6: The redesign step (Opus/max primary; no metric gate) -- runs in parallel with the Step 5.5 capture drain

For each `docFaults` group (the judge groups findings by target file, one rewrite per file, so same-file races cannot happen):

1. **Assemble the judge-to-redesigner report** in the annex shape (`specs/lean-system-design-fable-review.md` Part 4 D-(iii), the authoritative schema): `target`, `scope`, `findings` (each `what_happened`, `evidence`, `why_doc_fault` quoted from the target, `desired_behavior`), `constraints` ("sharpen don't expand. Preserve unimplicated sections. One fact one place."), `siblings`, `output_contract` (exact-match edits `{finding_id, exact_old_text, new_text}[]` applied by the COO via the Edit tool; a non-matching exact_old_text fails loud).
2. **Dispatch the redesigner:** `agentType: redesigner-max` (Opus/max). If Fable returns, override inline with `model: 'fable'` on the same agent call -- effort stays `max` from the agent file (no inline effort option; see coo-sop §6 mechanic). It returns a list of exact-match edits (one per finding, or `no_change`).
3. **Auto-apply each edit via the Edit tool as a VISIBLE git commit:** for each edit, replace `exact_old_text` with `new_text` in the target file; a non-matching `exact_old_text` fails loud and ABORTS the commit (the over-reach guard -- the redesigner cannot touch a span it did not quote). Commit the applied edits for one target alone (one commit per target file, message naming the finding ids), and carry the diff into the Step 7 ship report. **No metric gate** (the operator ruling 5): no held-out metric, no commit-if-better harness; the high-reasoning judge decided warrant, the redesigner's quality plus the next grader cycle is the backstop. A bad rewrite gets flagged next cycle and rewritten again.

## Step 7: The ship report

One CEO-email report closing the ship, carrying:

- Status + archive path; new main sha + commit count.
- Funnel verdicts: Stage-1 evidence headline, Stage-2 review + Codex results (with any adjudicated false positives), demo delivered.
- Diagrams: listed / judged-stale / refreshed counts and the applied vault paths.
- Grader headline: counts per routed key. Memory-agent batch disposition (Step 5.5), split by source: grader candidates vs drained builder backlog.
- **Each redesign commit with its visible diff** (sha + target file + finding ids).
- **Rewritten COO-loaded docs, named explicitly for re-read.** A Fable rewrite of a COO-loaded doc (CLAUDE.md, `rules/*.md`, hook-injected `coo/*.md`) lands at ship, but the running COO loaded the OLD text at session-start. List every such rewritten doc under a "Re-read before next spec" heading; the COO re-reads them before opening the next spec. Non-COO-loaded targets (skills, agent prompts) need no re-read; they load fresh per use.

## One-off step for THIS rebuild (documented, not executed here)

At the ship of the `lean-system-rebuild` spec itself, the one-off Fable final-review pass runs (Fable-leverage #2): Fable takes the Stage-2 reviewer seat for that one ship, reviewing the whole rebuild (the thing every future spec runs on) before the E2 switchover merge. This is a standing note for that single ship, not a recurring funnel stage.

## Hard rules

- The funnel order is fixed: a failing Stage-1 stops everything; Stage-2 never runs on a build that does not run; the merge never runs without the Stage-3 GO.
- The COO is the sole writer of every side effect: vault writes, archive move, Status flip, project-page sync, merge, grader side effects, redesign commits. Every workflow agent drafts or reports only.
- Redesign rewrites are auto-applied but never invisible: one commit per target file, full diff in the ship report, no metric gate.
- Never overwrite an existing archive file; never fabricate a slug; never silently rewrite non-Status lines in `current.md`.
- Never `--force` to main; never squash-merge; rebase only the feature branch.
- No em dashes in anything written at ship.

## References

- `workflows/ship-review-workflow.js`: the sequential funnel (Stage-1 gate, Stage-2 barrier, demo draft).
- `workflows/grader-workflow.js` + `workflows/grader-workflow-lib.mjs`: the grader contract + `buildSegmentManifest`.
- `specs/lean-system-design-fable-review.md` Part 4 D-(iii): the judge-to-redesigner report schema.
- `agents/diagram-refresher.md`, `agents/demo-assembler.md`: the self-sufficient refresh + demo contracts.
- `rules/git-discipline.md` Merge-back + No-bypass: the rebase + `--ff-only` protocol.
- `coo/coo-sop.md` 7.3: spec lifecycle policy (status enum, archival, rollback).
- `scripts/ship_spec.sh`: reference implementation for sweep / drain / clear primitives.
- `hooks/session-archive.sh`: populates `specs/<slug>/sessions/` (the grader's input) all along.
