# Claude Harness

A personal operating system for [Claude Code](https://claude.com/claude-code): a set of
always-loaded rules, role-scoped playbooks, skills, subagents, and multi-agent workflows
that turn a single Claude Code session into a disciplined build org. It encodes one idea:
a long-running orchestrator that never writes code, cheap workers that each build one
chunk under test-first discipline, and a slow self-improvement loop that makes the system
leaner every time it ships.

This is the harness extracted from my own `~/.claude`, with personal data removed (see
[What was redacted](#what-was-redacted)). It runs out of the box and is meant to be read,
forked, and adapted.

## The frame: four roles, three loops

**Four roles.**

- **CEO** (you): vision in, verdict out. Owns the spec and the merge-to-main gate. Stays
  out of operations.
- **COO** (the long-running Opus session): orchestrates all operations and is the sole
  writer of shared state (the board, memory, the wiki). Never builds.
- **Workers** (tier-dialed subagents): build one chunk each, in their own git worktree.
  Model and reasoning effort are set by the chunk's risk tier.
- **Fable** (the sharpener): the strongest model, used sparingly to rewrite docs, prompts,
  and skills.

**Three loops.**

- **Build loop** (per chunk): recall -> kickoff -> RED -> GREEN -> REFACTOR -> review ->
  commit. A worker runs it; a fresh-context verification net judges the result; the COO
  gates the merge.
- **Sharpen loop**: capture -> memory -> recall during a build, plus grader -> redesigner
  at ship. Each run makes the system leaner, not bigger.
- **Meta loop**: Fable over COO sessions. The self-improvement layer.

## How it fits together

The base layer (`CLAUDE.md` plus `rules/`) is auto-loaded into every session and every
subagent. Role-specific playbooks (`coo/`, `disciplines/`) are injected only into the
agent type that needs them, so a worker never pays for the COO's playbook and vice versa.
Skills are invoked on demand. The per-chunk verification net (reviewer + an independent
judge + a fixer) runs each chunk's diff through adversarial review before the COO will
merge it.

## Layout

| Path | What it holds |
| --- | --- |
| `CLAUDE.md` | The always-loaded kernel: the frame, the universal hard rules, the scope model. |
| `rules/` | Auto-inherited rules (git discipline, the simplicity definition, taste). |
| `disciplines/` | Role kernels injected at dispatch (worker discipline, the review contract). |
| `coo/` | The COO-only playbooks (the SOP, communication discipline, the reference manual). |
| `skills/` | 23 invocable skills (spec collaboration, TDD red/green, recall, ship, grader, and more). |
| `agents/` | 15 subagent definitions (build workers, reviewers, the meritocracy judge, grader stages). |
| `workflows/` | Deterministic multi-agent orchestration scripts plus their test suites. |
| `scripts/` | Supporting tooling (memory indexing, session archiving, corpus extraction, tests). |
| `hooks/` | Session-start injection, the COO lane guard, session archiving, terse-mode. |
| `docs/` | Reference material and templates. |

## Using it

1. Read `CLAUDE.md` first. It is the entry point and points at everything else.
2. Copy the pieces you want into your own `~/.claude/` (global) or a project's
   `.claude/` (workspace). Scope is a parameter, not a second copy of the machinery.
3. Wire the hooks in `hooks/` through your `settings.json` (the `SessionStart` hook
   injects the COO playbooks; the lane guard enforces the orchestrate-don't-build rule).
   A `settings.json` is intentionally not shipped, since it carries machine-specific
   paths; wire the hooks to your own.

The runtime state the harness expects (the board, the memory store, the voice corpus,
the reader model) ships empty. It accretes from your own sessions as you use it.

## What was redacted

This is a real working system, not a sanitized demo, so a few things were stripped before
publishing:

- Personal identity, contact details, and the operator's voice corpus and reader model
  (shipped as empty templates).
- Private infrastructure (host aliases, IPs, machine topology).
- Session transcripts, work-in-progress specs, and the populated memory store.

Everything that defines how the system *works* is here and unmodified.

## License

MIT.
