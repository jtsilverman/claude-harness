# Git Discipline

The git rules every role follows: branches, commits, merge-back, no-bypass, destructive operations. No enforcement hook backstops these; Claude follows them as discipline.

## Branch protocol

- **Feature branch: `feat/<spec-name>`.** Created from main at spec lock. One per spec; all chunk work lands here.
- **Attempt branch: `attempt/<chunk-name>-N`** for high-risk chunks or retries. `N` starts at 1 and increments per retry. Branches off the feature branch, not main.
- **Worktree for isolated work:** experiments that might be abandoned, or context switches that would pollute the working tree. Create it under `.worktrees/` after confirming a clean state.
- **Redesigner auto-commit (named automated exception):** the ship-time redesigner (Opus/max primary; Fable if it returns -- see `coo/coo-sop.md § 8.2`) auto-applies an adopted doc/prompt rewrite as a visible git commit named in the ship report, on a non-main branch, no metric gate; merge-gated by human review of the visible diff in the ship report, not a per-commit go/no-go.
- **Never commit to main or master.** Feature branch first, always.
- **Per-project override** only if the repo has a documented convention (e.g. `feature/` prefix); default applies otherwise.

## Commit discipline

- **One commit per chunk on the feature branch.** Chunk boundaries map to commit boundaries; preserves the per-chunk narrative.
- **Claude drafts the message; the single chunk-end go/no-go authorizes it.** Drafted at chunk-end (`disciplines/worker-discipline.md`): one imperative subject line + one or two body sentences naming the file or interface and the behavior shift. The one verdict authorizes both the spec update and the commit (no separate commit-message gate); `git commit` does not run until it lands. This governs chunk commits; the redesigner auto-commit (above) is the one automated exception, gated at merge instead.
- **Frequent small commits** inside a feature branch are fine and encouraged. Never batch multiple chunks into one commit; splitting an oversized chunk across commits is fine.
- **No co-author footers unless the operator asks.** No `Co-Authored-By: Claude`, no "Generated with" tag.
- **Stage deliberately.** `git add <file>`, never `git add -A` / `git add .`. A directory-level add (`git add specs/`) still sweeps everything under that path — use it only after `git status` confirms every changed file there is in scope for this commit.

## No-bypass rules

- **No `--no-verify` on commit or push.** Ever. If a repo's pre-commit / pre-push hook fires, fix the underlying issue.
- **No `--amend` on pushed commits.** Local-only amend before push is fine.
- **No force-push to main or master.** Ever.
- **Force-push to a feature branch** only during a deliberate rebase or explicit rework, only after confirming no collaborator has pulled it, and only via `git push --force-with-lease` (fails instead of silently overwriting if someone pushed in the meantime).
- **No `git reset --hard`** on branches with uncommitted work you haven't reviewed. Stash or commit first.
- **No `git branch -D`** on unmerged branches without explicit confirmation; `-d` (refuses unmerged) is the safe default.
- **No skipping pre-commit / pre-push hooks** via environment variables, aliases, or config tricks.

## Merge-back

- **Default: rebase-and-merge.** Rebase the feature branch onto main; chunk commits land on main individually, in order. Linear history, per-chunk narrative preserved.
- **No squash-merge** (collapses chunks, destroys the per-chunk story). **Merge commit (`--no-ff`) is not the default** (graph complexity with team-only value). **Per-project override** when the repo mandates a strategy.
- **Rebase only the feature branch.** Never rebase main. Never rebase a branch someone else has pulled without explicit coordination.
- **Merges targeting main are gated.** The COO's ship merge gate (`coo/coo-sop.md § 7`) gates a main-bound merge that needs option presentation (PR vs. direct) or whose branch has diverged. At spec ship, `ship-spec` Step 8's CEO go/no-go IS the authoritative merge gate and authorizes the direct rebase-and-fast-forward without re-invoking the gate. Routine per-chunk branch-into-feature merges need neither. The slip this rule prevents: a silent merge to main with no gate at all.

## Destructive operations

Explicit confirmation before any of these: explain what will be lost, confirm the target, then execute. Never batch destructive operations.

- `git reset --hard <ref>`
- `git branch -D <branch>`
- `git clean -f` / `git clean -fd`
- `git worktree remove --force <path>` — discards uncommitted work in that worktree; gates on confirmation even after self-diagnosis confirms the committed work is clean on the branch. **Named automated exception (cockpit merge-sequence prune):** when the worktree's ONLY uncommitted content is the regenerable judge audit sidecar `.issue-log-<id>.json` (deliverables committed and durable on the chunk branch), this force-remove is NOT confirmation-gated and MAY be batched across the file-disjoint runnable set — it is governed by `coo/coo-sop.md` § 8 step 1, which holds the authoritative mechanics (the porcelain precondition). Every other `git worktree remove --force` (uncommitted DELIVERABLE work at risk) keeps the confirmation gate and the never-batched rule.
- `git push --force` / `git push --force-with-lease`
- `git rebase -i` on pushed branches
- `git filter-branch` / `git filter-repo`
- `git checkout -- .` / `git restore .` (discards all unstaged changes)
- anything that rewrites history past the most recent commit

## External code review

- Reviewing an external PR or receiving review: verify each suggestion technically before implementing, no performative agreement.
- See `disciplines/review-contract.md` §1 (Calibration) for the adjudication and untrusted-input rules for reviewer comments.
