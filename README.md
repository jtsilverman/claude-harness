# Rock (claude-harness)

Rock is a lean operating system for [Claude Code](https://claude.com/claude-code): an always-loaded
kernel, a small set of rules, a handful of skills and subagents, and three enforcement hooks
that turn a single Claude Code session into a disciplined, test-first build loop.

It encodes one idea: **you and one session.** You set direction and own the merge gate. The
session does the work, under spec-first discipline, and spawns a subagent only for a specific
bounded job (orientation, a review, a transcript distillation, a live drive-test) that returns
a result. No orchestrator persona, no role tiers, no worker fleet.

This is the harness extracted from a real working `~/.claude`, with personal data removed
(see [What was redacted](#what-was-redacted)). It is meant to be read, forked, and adapted.

## The frame: you + one session

- **You** set the vision and own the merge-to-main gate. Nothing lands on `main` without your go.
- **One session** does the work: orients, writes the spec, builds test-first, reviews, and
  reports. It inherits the kernel and the rules on every turn.
- **Subagents** are spawned only for a bounded job and return a compact result. They never
  coordinate laterally and never own the merge.

Scope is split in two. **Global** (`~/.claude`) is how you work everywhere: this repo. **Per
project** is that repo's own `CLAUDE.md` (lean rules plus its test command), its `specs/`, and
its notes. All skills, agents, and hooks live globally and inherit down.

## Two loops

### Build loop

- **Small or mechanical** (config, doc, rename, one-liner): do it directly on a branch and
  eyeball the diff. No subagent, no ceremony.
- **Non-trivial** (changes behavior, spans files, new files): enter plan mode, then run the
  gates:
  1. **Orient.** An `Explore` subagent digs the relevant code and notes and returns a compact,
     grounded map.
  2. **Spec** (the `spec` skill). One paragraph: intent, acceptance criteria, non-goals,
     orientation findings, and a commit-sized decomposition.
  3. **Creativity beat.** Name one or two alternative approaches plus the 10x-vs-asked version,
     pick one with reasoning, and name the simplest form that works.
  4. **Pressure-test.** `grill-me` walks the design's decision tree; the `reviewer` checks the
     spec for completeness and grounding. You sign off intent, acceptance, and non-goals only.
  5. **Build** (the `build` skill). Orient, then RED (author a failing test, watch it fail,
     commit it), GREEN (the minimum to pass), REFACTOR (delete what you obsolete), a verify
     ladder, a gated live-verify, an anti-slop self-check, and commit.
  6. **Review.** One fresh-context `reviewer` subagent reads the diff, truth-framed ("no issue
     is a valid finding"). You adjudicate each finding by reproducing it.
  7. **You merge.** The spec is the live progress record. One task per branch, `feat/<name>`
     from `main`.

### Learn loop

`/learn` distills a session. A single `learn-evaluator` subagent (fresh context) reads the
transcript plus the current `MEMORY.md` and returns two payloads: a compact state summary
(what happened, where it ended, what is next) and up to five durable lessons, each classified
by scope (global goes to `MEMORY.md`; project goes to that project's `CLAUDE.md`) and type
(a gap in the machine vs a one-off instance). The main session is the single writer: it
merge-prunes each lesson into the target under a hard line cap and shows you the diff. The
evaluator writes nothing itself. `MEMORY.md` is `@`-imported into the kernel, so the lessons
are always in context with no recall step to skip.

The loop also fires from the `SessionStart` hook on the previous session's transcript when that
session did substantial work, which doubles as cross-session continuity.

## The three hooks

All three are `PreToolUse(Bash)` hooks. They fail open: any parse or git error exits 0 with no
output, so a broken hook never blocks you.

| Hook | Fires on | Decision |
|------|----------|----------|
| `destructive-confirm.sh` | a Bash command matching the destructive-ops list (`git reset --hard`, `push --force`, `clean -f`, `branch -D`, `rm -rf`, ...) | **ask** (deliberate confirm, not a hard block) |
| `red-commit-gate.sh` | a `git commit` that stages the deletion or rename-away of a committed test file | **ask** (confirm the test is genuinely obsolete, not silently gutted) |
| `test-pass-gate.sh` | a `git commit` that stages implementation code, when the project `CLAUDE.md` declares `` Test command: `<cmd>` `` | **deny** if that command fails (RED test-only commits are exempt) |

`test-pass-gate` runs the declared command via `eval`, so treat a repo's `CLAUDE.md` as trusted
input: do not commit inside an unvetted clone whose `Test command:` you have not read.

## Repo layout

```
CLAUDE.md              the always-loaded kernel: the frame, hard rules, both loops, pointers
MEMORY.md              durable distilled lessons, @-imported into the kernel
rules/                 auto-loaded rules: communication, simplicity, git-discipline, taste
agents/                bounded-job subagents: reviewer, learn-evaluator
skills/                build, spec, verify, grill-me, learn, diagram-system, systematic-debugging,
                       wiki-*, writing-skills, ...
hooks/                 the three PreToolUse gates (+ tests), session-start, session-archive,
                       caveman-terse
scripts/ statusline/   supporting tooling
settings.example.json  hook + statusline wiring to merge into your settings.json
```

## Install

1. Back up your existing `~/.claude` (at minimum `settings.json`).
2. Copy the directories you want (`rules/`, `skills/`, `agents/`, `hooks/`, `statusline/`,
   and `CLAUDE.md` / `MEMORY.md`) into your `~/.claude`. The kernel and rules auto-load; skills
   and agents are auto-discovered.
3. Merge the `hooks` and `statusLine` blocks from `settings.example.json` into your
   `~/.claude/settings.json`. Do not overwrite your existing permissions, env, or model
   settings. Hook changes take effect at the next session start.
4. To arm `test-pass-gate` in a project, add a line to that project's `CLAUDE.md`:
   `` Test command: `<your test command>` ``.

Read `CLAUDE.md` first. It is short and it is the whole system in one file.

## What was redacted

This is a real working system, not a sanitized demo, so a few things were stripped before
publishing:

- Personal identity and contact details (the operator is referred to generically as "the user").
- `MEMORY.md` keeps the durable lessons (operating discipline plus a general-purpose
  engineering-pattern library: testing, language and runtime gotchas, state and persistence,
  LLM and API patterns) with the operator's identity generified out.
- Work-in-progress specs, session transcripts and reviews, private project grounding docs, the
  local plugins tree, and the live `settings.json` (replaced by `settings.example.json`).

Everything that defines how the system works is here.

## License

MIT. See [LICENSE](LICENSE).
