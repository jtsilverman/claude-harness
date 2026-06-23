---
name: spec-collaboration
description: Use when presented with a coding task that will change behavior, span multiple files, create new files, or exceed a few lines of change, before any implementation code is written. Consumes a recent plan file from ~/.claude/plans/ when present.
---

# Spec Collaboration

## The flow (idea to locked)

Eight steps, in order. The design rationale lives in `specs/lean-system-design.md` §2; this skill is the executable surface.

1. the operator says "I want to do X."
2. A couple of quick questions get the general shape.
3. Context two ways: (a) fan out Explore agents (Sonnet, read-only, parallel) to map the relevant code; (b) run `recall` inline so past patterns and failures ground the questions. Both feed the grill.
4. Grill, default-on: invoke the `grill-me` skill (§ Interrogation workflow).
5. Perplexity pass, mandatory every spec (§ Perplexity pass (mandatory, every spec)).
6. Chunk decomposition (§ Chunk decomposition format), tier set per chunk (§ Tier), demo plan drafted (§ The CEO demo plan table). For a heavy spec, Fable co-authors the decomposition (§ Pre-lock spec review).
7. Pre-lock review, tiered by stakes (§ Pre-lock spec review).
8. Read-back and lock (§ Pre-lock teaching synopsis, § Locking the spec).

## Step 0: Detect a plan file

Before starting interrogation, check `~/.claude/plans/` for files modified recently.

Decision tree:

- One file, <5 min old → auto-use as input. Announce: "Using recent plan file `<name>` as input."
- One file, 5-60 min old → prompt: "Use plan file `<name>` (modified <relative time>) as input?" Default yes.
- Multiple files in last hour → list with timestamps, ask the operator to pick or skip.
- Zero recent files → start fresh interrogation.
- `~/.claude/plans/` doesn't exist → start fresh; create the directory if Step N needs it.

When a plan file is consumed, treat it as filling Requirements + parts of Constraints; interrogation focuses on the rest (chunks, acceptance criteria, non-goals, test strategy). Don't manufacture questions when the plan's recommendation is sound and there's no real tradeoff.

## Interrogation workflow (grill by default)

The interrogation defaults to grilling: invoke the `grill-me` skill at the start of interrogation, without waiting for the operator to ask for it. Grilling means:

- **One decision at a time.** Walk down each branch of the design tree, resolving dependencies between decisions one by one. No five-question batches, and no section skipped because it "looks mostly OK."
- **Every question carries a recommended answer.** Format: "Question: [the open issue]. My read: [proposed answer]. Confirm, or tell me what I'm missing." the operator confirms or overrides; he never has to think from scratch.
- **Self-answer from the codebase first.** Any question answerable by exploring the codebase (existing code, naming conventions, prior patterns) gets explored and answered rather than asked; surface the read for override ("I read `src/auth/` and it looks like X; confirm or override").
- **Drive every open question to a decision.** A vague or deferred answer triggers an immediate follow-up, not a next-round note. Along the way, suggest related additions worth folding into the spec, and close with a clear statement of the end goal.

**Scale-down for trivial specs.** A trivial spec (a single-file mechanical change, a config tweak, no real design choices) gets a proportionally lighter grill: fewer questions, never zero. Requirements, acceptance criteria, and blast radius are always confirmed. Scaling down shortens the grill; it never skips it.

Cover the sections in order; the grill walks them as its spine:

| Section | First question |
|---|---|
| **Requirements** | What must be true after this ships that isn't true now? |
| **Constraints** | What can't change? What's the blast radius if this goes wrong? |
| **Non-goals** | What are you explicitly NOT asking for, even though a naive read might include it? |
| **Interfaces / data model** | What touches this code? What flows in and out? |
| **Acceptance criteria** | How will we know this is done? Can we write a test that would fail today and pass after? |
| **Test strategy** | What's the first failing test? |
| **Execution boundaries** | Which files are in scope? What branch? Am I allowed to run commands? |
| **Chunk decomposition** | What's the smallest first chunk that produces observable value? |
| **Testing chunks** | What scenarios does this spec owe? Walk each chunk in `## Chunk decomposition` and name the scenario(s) that verify it. Reference the project-local test-design rubric if one exists (e.g. Agnes's `cert/SKILL.md` § Test-design rubric). May resolve to "None -- <reason>" only if the spec genuinely needs no testing. |
| **Pre-mortem** (product specs only) | Assume this ships exactly as specced -- what is the most likely way the result still disappoints? (advisory, never gates lock; skip for pure config / process / self-improvement specs) |

Do not draft the spec in one pass; co-write it turn by turn as decisions land.

## Push-back patterns

Vague answers get specific push-back:

- "Make it fast" → "How fast? What's the current baseline, what's the target, what breaks if we miss?"
- "Clean it up" → "What specifically bothers you right now? Give me one concrete example."
- "Trust your judgment" → "Judgment is fine for implementation details. Not for scope or interfaces. Tell me the scope."
- "Just do what's standard" → "Standard where? Which team, stack, or codebase are we matching?"
- "We'll figure it out as we go" → "Name the first chunk. Then we figure out the rest."

If the operator gives a non-answer twice on the same section, stop drafting and name the gap out loud.

## Perplexity pass (mandatory, every spec)

Every spec gets a Perplexity pass. Never skipped: every spec asks "what am I assuming that I should check?" The COO picks mode by spec complexity:

- **Trivial or narrow spec (single factual unknown):** one quick query. Default-on; "skip it" is never a valid mode.
- **Complex, high-unknown, or multi-axis spec:** full Deep Research pass.

Both template shapes are in `coo/reference/manual.md § 16.1`.

**Mechanics:** after the grill and before decomposition, draft the prompt (quick query or Deep Research, per complexity) and hand it to the operator. the operator runs it in Perplexity and pastes the result back; fold the findings into the spec. Fire-and-tell: lock does not wait on the result. This surface is the operator-run; the COO does not invoke Perplexity programmatically. It is distinct from the COO's own `deep-research` workflow (which the COO runs itself for contested claims).

## Refuse-to-code criteria

Do not start writing implementation code until all of the following are resolved:

- Requirements (one or more concrete outcome statements).
- Constraints (at least the blast-radius and non-change list).
- Acceptance criteria (at least one testable condition).
- Execution boundaries (files in scope, branch, command permissions).
- Current chunk (the first one, with objective completion criterion).
- Testing chunks (the `## Testing chunks` section must be present in the spec -- populated with scenario rows, or an explicit "None -- <reason>" line if the spec genuinely needs no testing).

Interfaces, non-goals, test strategy, and full chunk decomposition can be partial at lock time. The others cannot.

## Spec structure (post-lock)

Required sections, in order: Context, Requirements, Constraints, Non-goals, Interfaces / data model, Acceptance criteria, Test strategy, Execution boundaries, Chunk decomposition, CEO demo plan, Testing chunks, Execution state (default for multi-chunk specs) OR Current chunk (fallback for a genuine strict-dependency / single-threaded chain only), Completed chunks, Backfill decisions (seeded empty; drained at ship), Open questions, Follow-up (post-ship, separate spec).

Full annotated template with section notes → `references/spec-template.md`.

## Chunk decomposition format (the chunk entry IS the dispatch payload)

Break the work into chunks, each ultra-specific. Every chunk in `## Chunk decomposition` is written as ONE schema entry in the wire shape below. The chunk-spec shape IS the payload shape (one schema, not two): at dispatch the cockpit extracts the entry verbatim and attaches only runtime fields; the COO never authors a payload on the fly. What you write at decomposition time is exactly what the builder receives.

**Per-chunk entry schema** (source: `specs/lean-system-design-fable-review.md` Part 4 §D-(i)):

```
{ chunkId, specSlug, tier: "default"|"heavy",
  currentState, requirements, endState,
  acceptanceCriteria: [...], edgeCases: [...], touches: [...], dependsOn: [...], nonGoals: [...] }
```

Field by field:

- **chunkId**: the bare chunk number N (§ The id contract).
- **specSlug**: the spec's canonical slug, the same string the `current.md` frontmatter carries.
- **tier**: `default | heavy`, set here per § Tier, with the dual-axis trigger as a comment on the line. The builder never reclassifies.
- **currentState**: one line, what is true now.
- **requirements**: the behavior shift, ultra-specific, naming the file or interface and the change.
- **endState**: one line, what is true after the chunk ships.
- **acceptanceCriteria**: observable checks (input X produces output Y, never "no errors thrown"); a code-fence bash check where the check is mechanical.
- **edgeCases**: the boundary/error/invariant/integration cases this chunk must also pin (distinct from happy-path acceptanceCriteria). Required, may be `[]` when the chunk genuinely has none.
- **touches**: the files this chunk edits or creates (§ The touches contract). Together with dependsOn, this forms the dependency graph that lets file-disjoint chunks build in parallel.
- **dependsOn**: the chunkIds that must merge before this one launches; empty if none.
- **nonGoals**: what this chunk is explicitly NOT doing; kills chunk-level scope creep.

**Runtime fields are never authored.** `worktree`, `branch`, and `injectedDocs` are attached by the cockpit at dispatch; they do not appear in the spec.

**Write-time budget:** one line per scalar field, tight lists for the array fields. Design rationale, repeated constraints, sub-decomposition, and test-strategy details do NOT go in chunk entries (see `references/chunk-decomposition-rationale.md`).

**Standalone acceptance scripts are deliverables.** When a chunk's acceptance hook is a standalone script rather than an inline or in-suite test, that script is a deliverable of the chunk: name it in `requirements` AND include its `specs/scripts/<slug>-c<N>-acceptance.{sh,py}` path in `touches` (a NEW file the chunk creates is a valid `touches` entry). A chunk that references an acceptance script only in prose ships without it: the worker contract never asks for it and every mechanical check still passes.

**Completeness and agent contracts at decomposition.** As each chunk is written, apply two checks at decomposition time so the loose payload is caught before lock: the contract-completeness check (no loose pass-through; a stated fail-loud condition for the empty/null/missing/zero-row case) and the agent-contract step (any chunk that creates or modifies an agent ships that agent's literal prompt walk + RECEIVES + EMITS, not a prose role). Both run again at lock; the verbatim walks live in § Pre-lock self-check (checks 4 and 5) and are not re-inlined here.

## Tier (set at decomposition, binary heavy-trigger walk)

Tier is set per chunk HERE, at spec decomposition, by the spec author. It rides the chunk entry into dispatch and sets the worker model/effort dial and the review depth (the dial itself lives in `specs/lean-system-design.md` §3 and `workflows/tier-dispatch.mjs`; do not restate it). Kickoff confirms the two trigger answers; the builder never reclassifies the tier.

**Run the heavy-trigger walk per chunk.** It is binary (heavy or default), set by two explicit yes/no answers, never a vibe. Write both answers as the comment on the entry's `tier` line:

```
tier: "heavy",  // blast-radius: yes (corrupts shared state, no clean rollback); complexity: no
```

A tier with no trigger answers is unassigned; the pre-lock self-check rejects it.

The trigger walk (install VERBATIM, run per chunk at decomposition):

```
A chunk is HEAVY iff EITHER answer is yes (write both answers on the tier line):
  - Blast-radius: does a failure corrupt state with no clean rollback, or touch
    irreversible / external / shared state?
  - Complexity: does it introduce a new concurrency seam, a new architecture / abstraction,
    or genuinely novel logic a senior would have to think hard about?
If NEITHER is yes -> DEFAULT. The two answers, not a vibe, set the tier.
```

Default is the bias: a chunk answering yes to NEITHER axis is DEFAULT (not a third option). The over-classification guard is the walk itself, both answers no means default. Old specs may still carry S/A/B/C letters; the dispatch dial folds them (A/S -> heavy, B/C -> default) so legacy reads resolve, but new decompositions answer the two-axis walk and write `default` / `heavy`.

The trigger only SETS the tier here. Two downstream halves of the same walk live at their own loci: the TIER-FIT CHECK confirms the declared tier against the chunk's touches before lock (§ Pre-lock self-check, check 3), and the OUTCOME ESCALATION corrects a mis-tiered default by outcome (`skills/reset-or-decompose/SKILL.md`). Kickoff confirms the two answers (`skills/chunk-kickoff/SKILL.md`).

## The id contract (board id = entry title = chunkId = dependsOn, all bare N)

**Pin ONE id form for every chunk and use it identically at every id site.** The canonical form is the bare chunk number N (just `1`, `2`, `7`, with no `C`, `chunk`, or any prefix). The sites that MUST string-match:

- the **board id** in `## Execution state` (the line `- N: <status>`),
- the **entry title** (`**Chunk N**`) and the **`chunkId`** field in the chunk entry,
- every **`dependsOn`** entry that references the chunk,
- every **trigger chunks** id in the `## CEO demo plan` table.

Why bare N, and why it string-matches: the scheduling join (`scripts/runnable_set.py`) matches the board id to dependency references by literal string equality, so if the board says `- C5:` but a dependency says `5`, the join silently misses and the chunk never becomes runnable (failure F9, hit 3 times in one run). The board codec `scripts/exec_state.py` is a passthrough (it parses everything up to the first colon and writes it back verbatim), so feeding it bare ids makes the board emit bare N. No code change is needed; the fix is writing bare N at every site.

## The touches contract

Every `touches:` entry must be a **repo-relative, non-gitignored path**. This does NOT mean "already git-tracked": a not-yet-tracked **NEW file the chunk creates** (a new module, a new test) is perfectly valid as a `touches:` entry, as long as it sits inside the repo root and is not gitignored. The two things the cockpit's isolation guard actually rejects are exactly: a path that is **gitignored** (`git check-ignore`, e.g. a path under a `memory/` tree the repo ignores) or one that **resolves outside the repo root**. Either escapes worktree isolation: the worker would write live shared state directly instead of into its isolated worktree, bypassing the review gate. The cockpit's launch guard **loud-rejects** any such chunk at launch, so an invalid `touches:` blocks the chunk rather than corrupting state -- fix the path, don't work around the rejection.

## The CEO demo plan table (required; drafted after the chunk decomposition)

Every multi-chunk spec carries a `## CEO demo plan` section holding a markdown TABLE. The table is the cockpit's detection surface: the cockpit parses it and fires the demo-assembler when a row's trigger chunks complete. Without the table, "meaningful milestone" is vibes and demos under-fire. The section and its table are required, not optional.

A **demo** is a milestone moment where the COO pauses to show the operator the partially-built system at a point worth seeing: either a *show-and-tell* (here is the thing working, confirming we are on track) or a *direction-fork* (here are two ways this could go, your call decides which).

To draft it:

1. **Scan the chunk decomposition plus the product surface for natural reveal points**: the chunks where a coherent, showable capability first exists, or where a genuine product-direction choice opens up. Not every chunk is a demo; pick the moments that earn a CEO look.
2. **Draft 2-4 rows** with the fixed column set `trigger chunks | what + how | what it shows | fork?`:
   - **trigger chunks**: the bare chunk ids whose completion fires the demo (must string-match the board ids, § The id contract).
   - **what + how**: free-form, what gets shown and how it's shown (a CLI run, a rendered page, a before/after, a diff), whatever fits this milestone.
   - **what it shows**: the capability or decision the demo surfaces.
   - **fork?**: show-and-tell or direction-fork, a per-milestone judgment.
3. **Co-select with the operator.** Surface the proposed rows, let the operator add, cut, or reshape, and record the agreed set in `## CEO demo plan` before lock.

The COLUMN SET is fixed (the cockpit parses it); the CONTENT stays per-milestone judgment, never a closed enum. The right demo for a backend-glue milestone (a CLI transcript) differs from a UI milestone (a rendered screen), and whether a milestone is a fork depends on whether a real direction choice actually opens there.

## Pre-lock spec review, tiered by stakes

Before lock, the drafted spec gets an independent review, tiered by stakes. The reviewer redlines the draft; the operator does not line-edit. Truth-calibrated, flag-and-fix only: "no issues" is the expected default for a sound spec, and every flag needs concrete evidence (quote the text, name the two different builds two readers would produce, or cite the exact rule violated).

**The stakes ladder.** Stakes are read with the same dual-axis vocabulary at spec scale; the default read is the spec's highest chunk tier.

- **High-stakes (heavy: the spec's highest chunk tier is heavy -- big blast radius, irreversible, core architecture)**: **Fable** reviews the spec.
- **Low-stakes (default)**: **Codex** reviews (the cheap cross-model lens).

**Fable co-authors heavy decompositions.** For a heavy spec (a spec whose highest chunk tier is heavy -- extreme complexity or catastrophic blast radius), Fable does not just review at step 7: it CO-AUTHORS the chunk decomposition at step 6. A bad decomposition is the most expensive and least-catchable error a spec can carry, so the strong model shapes the chunk cut itself, not only its redline. The step-7 Fable review is then its second pass over that cut.

**Fable-unavailable fallback (heavy specs).** When Fable is suspended or unavailable, substitute an **Opus/high** reviewer as primary, with the **Codex cross-lens** as a secondary pass (same Codex mechanics as the low-stakes path, run after the Opus review). Opus is primary; Codex adds the cheap cross-model diversity. This fallback applies to both the step-7 review and the heavy co-authoring pass -- for co-authoring, the COO runs Opus/high inline.

**What the reviewer looks for:**

- Underspecification: acceptance criteria that don't pin observable behavior (input X produces output Y).
- Wrong data source: a chunk that reads from or writes to the wrong file, table, or system given the stated goal.
- Internal contradictions: requirements or constraints that logically cannot both be satisfied.
- Ambiguous scope: a `requirements` field loose enough that two implementers would build different things.
- Schema completeness: every chunk entry carries all eleven schema fields (including edgeCases), and the demo-plan table is present (mirrors the pre-lock self-check).
- Decomposition cut (the seam BETWEEN chunks, not just each chunk internally): flag **VACUOUS-UNTIL-LATER** (a chunk whose acceptance hook cannot pass until a later chunk lands), **HIDDEN COUPLING** (two "file-disjoint" chunks sharing an implicit contract -- a schema, format, or constant -- so they cannot truly build independently), **WRONG DEP EDGE** (a `dependsOn` missing a real ordering need, or spurious and serializing parallelizable work), and **OVER-CUT** (N chunks where fewer cohere; a chunk that does not stand alone as a shippable unit). Mirrors the pre-lock self-check's DECOMPOSITION-CUT CHECK.

**Codex mechanics** (low-stakes path): invoke via the local binary, always with `< /dev/null` (`codex exec` reads stdin even with a prompt argument and blocks forever on an open pipe in non-interactive contexts). Frame the prompt for truth: make "no issues" the explicitly valid answer; adversarial "find what's wrong" framing produces false positives.

**After the review:** revise the spec to address findings before locking; if the reviewer finds nothing material, lock as planned. Document any significant revision as a Rule 7 inline surface so the operator sees what changed. Review at authoring time is cheap and reversible; there is no mid-pipeline contract review. A chunk contract enters a worker already reviewed.

## Pre-lock self-check (run before flipping Status to Locked)

Before you ask the operator to lock, run this self-check over the drafted `## Chunk decomposition`, `## CEO demo plan`, and `## Execution state`. All eleven must hold:

1. **Schema-presence**: every chunk entry carries all eleven schema fields (chunkId, specSlug, tier, currentState, requirements, endState, acceptanceCriteria, edgeCases, touches, dependsOn, nonGoals). A missing field means the cockpit dispatches an incomplete payload. In particular, confirm `edgeCases` is present on a sample entry (it is the field most easily dropped, being the newest; required, may be `[]` but never absent).
2. **Tier-trigger presence**: every entry's `tier` line carries its two heavy-trigger answers (a blast-radius yes/no + a complexity yes/no, per § Tier). A tier line with no answers is unassigned and fails the check.
3. **Tier-fit check** (P7, install VERBATIM):

```
TIER-FIT CHECK (pre-lock): an independent read confirms each chunk's declared tier matches its
touches + requirements. A DEFAULT chunk whose touches include an irreversible-state file, or whose
requirements describe a new concurrency seam, is flagged UNDER-TIERED -- re-tier before lock.
```

The fit-check only SURFACES a flag for a human/author call; it never silently re-tiers. A flagged chunk is re-tiered by decision before lock, not by the check.
4. **Contract-completeness check** (P8, install VERBATIM):

```
For each chunk, the requirements must pin EXACT completeness, not a loose pass-through. Flag before lock:
  - any "pass through / handle / the cols / the data" with no exact set or "FULL/ALL" qualifier;
  - any transform with no stated FAIL-LOUD condition for the empty / null / missing / zero-row case.
A loose completeness contract is the expensive-rework trigger (a dropped feed makes a downstream chunk
vacuous). Tighten to "full <X> passthrough; fail loud if any required <Y> is 100% null" before lock.
```

5. **Agent-contract check** (P10, install VERBATIM):

```
For any chunk that CREATES or MODIFIES an agent, the chunk must specify that agent's LITERAL contract
before lock, not a prose role:
  - the exact prompt walk it runs (a step list, like P2/P4 here -- not "it adjudicates findings");
  - exactly what it RECEIVES (every input field by name);
  - exactly what it EMITS (the output shape by field).
A chunk that adds or changes an agent with only a prose description is flagged INCOMPLETE -- write the
contract. (Chunk contracts are already schema-tight; agent contracts must be too, or the agent is set up
loose and the bad output is downstream.)
```

6. **Id-consistency**: for every chunk, the board id, the entry title, the `chunkId` field, every `dependsOn` reference, and every demo-plan trigger id string-match in bare N (per § The id contract). Grep each id across all sites and reconcile any divergence before lock.
7. **Touches-validity**: every `touches` entry is a valid repo-relative, non-gitignored path (per § The touches contract); none is gitignored or resolves outside the repo root (a not-yet-tracked NEW file the chunk creates is fine).
8. **Acceptance-script-as-deliverable**: for every chunk whose acceptance hook is a standalone script, that `specs/scripts/<slug>-c<N>-acceptance.{sh,py}` path is named in `requirements` AND present in `touches` (per § Chunk decomposition format). A referenced-but-unlisted acceptance script is the DOC-FAULT that lets a whole wave ship without theirs.
9. **Demo-plan table present**: `## CEO demo plan` exists and holds a parseable table with at least one row. A genuinely single-chunk trivial spec may record "None: <reason>" instead, and must say so explicitly; a silent absence fails the check.
10. **EndState-coverage check** (install VERBATIM):

```
ENDSTATE-COVERAGE CHECK: the chunk's acceptanceCriteria must COLLECTIVELY cover every
behavioral clause of its endState. Walk the endState clause by clause; for each, name the
acceptanceCriterion that would FAIL if that clause were left unimplemented. A clause with no
such criterion is an UNCOVERED endState -- a half-landed chunk would pass its own gate. Add a
criterion (or cut the clause) before lock.
```

An endState clause genuinely covered by an existing criterion is not flagged; only an uncovered clause is. Run per chunk over the drafted decomposition.
11. **Decomposition-cut check** (install VERBATIM):

```
DECOMPOSITION-CUT CHECK (pre-lock): review the cut BETWEEN chunks, not just each chunk. Flag:
  - VACUOUS-UNTIL-LATER: a chunk whose acceptance hook cannot pass until a later chunk lands.
  - HIDDEN COUPLING: two "file-disjoint" chunks sharing an implicit contract (a schema, a
    format, a constant) so they cannot truly build independently.
  - WRONG DEP EDGE: a dependsOn missing (a real ordering need unstated) or spurious (a stated
    edge with no real dependency, serializing parallelizable work).
  - OVER-CUT: N chunks where fewer cohere; a chunk that does not stand alone as a shippable unit.
```

This reviews the seam between chunks; the independent reviewer's redline carries the same four flags (§ Pre-lock spec review). A single-chunk spec resolves it trivially (no between-chunk cut) and must not false-flag.

If any check fails, fix the spec and re-run the self-check; do not lock a spec that fails it.

## Pre-lock teaching synopsis

Before asking the operator to lock, read the spec back to him in plain English -- the last cheap moment to catch misalignment.

Three sections: (1) **Current state** in prose. (2) **Changes to be made** -- one bullet per chunk with file/interface touched, behavior shift, and why this chunk in the causal chain. (3) **End state** in prose -- what the system looks like after the last chunk ships.

End with: "Does this match what you expected to be implementing? If yes, say lock. If anything reads wrong, tell me which section needs another pass."

Full format with per-chunk sub-bullet structure → `references/pre-lock-synopsis-format.md`.

## Pre-lock diagram gate (demoted)

Before accepting "lock," check whether the work crosses or creates a system boundary. The check fires when any of:

- The work introduces a new system (no existing L1 diagram for it).
- The work modifies system boundaries (new external edge, new/removed container, changed data store).
- The work touches a project that already has L1/L2 diagrams in `~/Documents/brain/wiki/projects/<project>/`.

If any apply, produce a **textual structural summary** of the boundary change as part of the pre-lock synopsis -- words, not a drawn diagram. **Do NOT block spec lock on a diagram lock.** Full diagrams come from the chunk-end diagram auto-refresh.

**One exception -- greenfield new systems.** Invoke `diagram-system` for a rough L1 + L2 at spec time. Lock is never blocked, even here.

Skip entirely for self-contained changes that cross no boundary.

## Locking the spec

The spec locks only when the operator says "lock" in response to the synopsis. Do not infer lock from "looks good" or silence. SOP Phase 2.

## Lock-time project sync

After the operator says "lock," persist the canonical slug to `current.md` frontmatter: ensure a `**slug:** <spec-slug>` line is present in `current.md` so the session-archive hook and ship-time grader read the identical string (no title-vs-archive-filename mismatch). Write/ensure the line before any other lock-time steps.

Then auto-write the spec's existence to `~/Documents/brain/wiki/projects/<project>/index.md` (Rule 10 posture -- no Y/N gate).

Map the spec to a project:
- Spec edits files under `~/.claude/` → project = `claude-code-setup`.
- Spec edits files under `~/<project-slug>/` → project = leaf dir name.
- Spec names a project in its title or context → use that.
- Ambiguous → surface inline per Rule 7 and proceed.

Surface inline: `Updating wiki/projects/<project>/index.md with new spec -- flag if not.`

Write to the page's `## Specs` section: one line of the form `- [[<spec-slug>]] -- Locked YYYY-MM-DD. <one-line summary>.` Create the project page if it doesn't exist.

## Step N: Archive consumed plan file

On lock, if a plan file was consumed in Step 0, archive it:

- Move `~/.claude/plans/<consumed-plan>` to `<project>/specs/plan-archive.md`.
- If `<project>/specs/plan-archive.md` already exists, append with a `---\n## Archived YYYY-MM-DD HH:MM\n` divider.

## References

- `~/.claude/skills/grill-me/SKILL.md`: the default-on interrogation skill (vendored local copy).
- `references/spec-template.md`: full annotated spec skeleton.
- `references/chunk-decomposition-rationale.md`: why chunk entries stay tight, what does not belong in them.
- `references/pre-lock-synopsis-format.md`: detailed 3-section synopsis format.
- `specs/lean-system-design.md` §2: the idea-to-locked flow this skill executes; §3: the tier dial the chunk tier feeds.
- `specs/lean-system-design-fable-review.md` Part 4 §D-(i): the chunk-entry wire schema; Part 5 #5: why the demo-plan table is the detection surface.
- `~/.claude/coo/coo-sop.md` § Phase 2: spec lock policy and Phase 2.5 branch setup.
- `~/.claude/skills/chunk-kickoff/SKILL.md`: per-chunk self-orientation that runs after lock.
