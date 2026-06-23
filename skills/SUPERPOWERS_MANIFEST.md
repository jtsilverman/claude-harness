# Superpowers Skills — Cherry-Pick Manifest

Tracks which Superpowers skills are installed and at what version.

## Source

- Repository: https://github.com/obra/superpowers
- Local clone: `~/Documents/references/superpowers/`
- Pinned commit: `b557648` (2026-04-16)
- Strategy: cherry-pick only (8 of 14 skills)

## Installed skills

| Skill | Purpose | Why we picked it |
|-------|---------|-------------------|
| `systematic-debugging/` | 4-phase root cause discipline | Fires on any bug — better than ad-hoc debugging |
| `receiving-code-review/` | No performative agreement on review feedback | Encodes anti-validation-seeking as procedure |
| `using-git-worktrees/` | Auto-detects setup, verifies gitignore before creating worktree | Worktrees are useful and we don't have GSD's worktree harness outside execute-phase |
| `finishing-a-development-branch/` | Clean 4-option workflow (merge/PR/keep/discard) | Replaces ad-hoc branch cleanup decisions |
| `writing-skills/` | TDD-for-skills methodology + Anthropic best practices reference | Reference when creating new skills (e.g., save-session, project-specific patterns). Anthropic best-practices docs bundled inline. |
| `using-superpowers/` | Activation discipline for the other Superpowers skills | Without this, behavioral skills (debugging, verification) get rationalized away. This makes them actually fire. |

## Skipped skills (and why)

These conflict with GSD or aren't the right fit:

- `brainstorming` — GSD's `/gsd-discuss-phase` covers this
- `writing-plans` — GSD's `/gsd-plan-phase` covers this
- `executing-plans` — GSD's `/gsd-execute-phase` covers this
- `subagent-driven-development` — GSD orchestrates subagents already
- `dispatching-parallel-agents` — GSD's wave-based parallelization covers this
- `requesting-code-review` — GSD's `/gsd-code-review` is more thorough

## Update strategy

Skills are pinned to commit `b557648`. To update:

1. `cd ~/Documents/references/superpowers && git pull`
2. Review changes with `git log b557648..HEAD --stat -- skills/`
3. If updating, copy fresh + update this manifest's pinned commit
4. Test in a real session before relying on changes

Do NOT auto-sync. Each update should be a deliberate decision.
