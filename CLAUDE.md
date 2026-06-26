# Kernel

Always-loaded base layer for every session and agent. Carries the operating frame, the hard rules, the build and learn loops, and pointers. Every fact lives in one file; this one links instead of restating. If something seems to belong in two files, flag the conflict, don't silently pick one.

## The frame

You + one session. The user sets direction and owns the merge gate; the session does the work. No orchestrator persona, no tiers, no worker fleet. Subagents are spawned only for a specific bounded job (orientation, a review, a transcript distillation, a live drive-test) and return a result; they never coordinate laterally.

Scope, un-braided: global = `~/.claude` (how I work, everywhere). Per-project (loads in that project only) = the project's `CLAUDE.md` (lean rules + that repo's test command + project-specific lessons), the project's `specs/`, and the project's wiki page. That is the entire per-project surface; all skills/agents/hooks live globally. Both scopes inherit.

## Build loop

- **Small / mechanical** (config, doc, rename, one-liner): do it directly on a branch, eyeball the diff. No subagent, no ceremony.
- **Non-trivial** (changes behavior, spans files, new files): enter plan mode, then:
  1. **Orient** (highest-ROI stage): spawn an `Explore` subagent to dig the wiki index + relevant code + read `MEMORY.md`; it returns a COMPACT grounded map (unfiltered context hurts, compact helps).
  2. **Spec** (the `spec` skill): one paragraph -- intent + acceptance criteria + non-goals + orientation findings + commit-sized decomposition.
  3. **Creativity beat** (bounded, one beat): name 1-2 alternative approaches + the 10x-vs-asked version, pick one with reasoning, name the simplest form that works. Where the user (vision) and the session (implementation) meet.
  4. **Pressure-test**: `grill-me` on the design; the `reviewer` (spec mode) checks completeness/grounding. The user signs off intent + acceptance + non-goals only.
  5. **Build** (the `build` skill): orient -> RED (author failing test, observe it fail, COMMIT it) -> GREEN (minimum to pass) -> REFACTOR (delete-what-you-obsolete, named + reportable) -> verify ladder (pytest always for behavioral code) -> live-verify subagent (gated: runnable surfaces only) -> anti-slop self-check -> commit.
  6. **Review**: one fresh-context `reviewer` subagent on the diff, truth-framed ("no issue is a valid finding"). Adjudicate each finding by REPRODUCING it, never by deference or ego. Optional manual Codex cross-lens for risky/security diffs only.
  7. **the user merges.** Nothing auto-lands on main. Wiki refreshes if the change was structural. Mark the unit done in the spec.
- One task per branch. `feat/<name>` from main. The spec is the live progress record (no separate board).
- **Research open unknowns before deciding** (`rules/communication.md` Perplexity relay): `deep-research-sonnet` for your own research; a the user-run Perplexity prompt for Pro-depth or very-recent forks.

## Learn loop

`/learn` distills a session. The `learn-evaluator` subagent (Sonnet, fresh context) reads the transcript and returns (a) a compact state summary (what happened, where it ended, what's next) and (b) up to 5 durable lessons, each classified by scope (global -> `MEMORY.md`; project -> that project's `CLAUDE.md`) and type (machine-gap vs instance). The main session is the single writer: merge-prune into the target under its hard cap (never blind-append), show the user the diff. A machine-gap may include a draft edit but routes as a build task (spec -> review -> merge); `/learn` never rewrites skills/rules unsupervised. `MEMORY.md` is `@`-imported below so it is always in context: no recall step to skip.

`/learn` fires from the SessionStart hook on the previous (same-workspace) transcript: auto if the session qualified (substantial work), else it asks. This doubles as cross-clear continuity.

@MEMORY.md

## Hard rules (every agent)

- Evidence before claims. Never say works, fixed, or passing without running it and observing the output. Reading the code is not testing. When observation contradicts assumption, flag it; don't silently adjust.
- Don't invent facts. Unsure means look it up. Before asserting how an external tool, API, or plugin behaves, invoke it once and observe the actual output.
- Spec before non-trivial edits. Behavior is defined before generation; never retrofit a spec to existing code.
- One task at a time. Implement only the current intent. No "just one more thing."
- Delete what you obsolete. Code your change makes dead is removed in the same change. No dead code, no defensive theater, no premature abstraction.
- Git: no commits to main, feature branches only; no `--no-verify`, no `--amend` on pushed commits, no force-push to main; stage deliberately (`git add <file>`, never `-A` or `.`). Full protocol: `rules/git-discipline.md`.
- Destructive or hard-to-reverse operations gate on explicit confirmation first.
- Config hygiene: timestamped `.bak-YYYYMMDD-HHMMSS` copy before rewriting `~/.claude/settings*.json`; never claim JSON is valid without parsing it.
- No em dashes in body content or bullets, in anything you write.

## Skill bootstrap

Before any response or action, check whether an available skill matches the task; if one might apply, invoke it via the Skill tool first (the 1% rule: might apply means it applies). An invoked skill's instructions override default behavior while it runs.

## Pointers

- `rules/git-discipline.md`: branch, commit, merge, no-bypass, staging.
- `rules/simplicity.md`: the simplicity definition + generative procedure.
- `rules/communication.md`: how to talk to the user (density, teach, surface-decisions, altitude, Perplexity relay).
- `rules/taste-profile.md`: style preferences.
- `MEMORY.md`: distilled durable lessons (`@`-imported above).
- `specs/<name>.md`: the live spec + progress record for the active task, when present. A live spec carries `status: active` in its frontmatter (the SessionStart hook injects every active spec by name; multiple may be active at once). Archived/shipped specs drop the flag.
