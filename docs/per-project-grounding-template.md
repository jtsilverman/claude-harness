# Per-project grounding template

A reusable recipe for grounding a project session in that project's own decisions, rules, conventions, wiki, and skills -- so opening the project auto-loads its durable context instead of running on the global `~/.claude` kernel alone. Built and verified end-to-end on Agnes (the worked example throughout); this template batches it across the other projects (Phase 2).

Apply it once per target project. Not every section fits every project -- see "Per-project variation" before you start.

## What you are producing (the three layers)

### Layer 1 -- Workspace docs (the project repo)

Three pieces in the project repo:

1. **A cleaned `CLAUDE.md`** -- durable content ONLY. Strip ephemeral status (active-spec banners, workplans, dead changelogs) that belongs in the spec board or the wiki. Keep the durable design mental-model and system map that no rule captures. Agnes went from a 132-line mixed doc to ~70 durable lines. The cleaned file ends with a **global-OS reference block**: a short map (not a duplicate) of the inherited `~/.claude` hard rules / roles / git protocol, pointing at the global files by path. See `~/Documents/projects/Agnes/CLAUDE.md` lines 54-71 for the exact block to copy.

2. **An `@`-imported workspace rules doc** at `.claude/rules/<project>.md`, pulled in by a literal line `@.claude/rules/<project>.md` near the top of `CLAUDE.md`. Two sections:
   - **Rules** -- durable, project-specific rules only (topology, who-it-serves, git naming, deploy/schema invariants, safety invariants, cost discipline). Do NOT repeat the global kernel; reference it. See `~/Documents/projects/Agnes/.claude/rules/agnes.md` lines 5-35.
   - **References** -- point, do not copy: the wiki decisions registry, the cluster MOCs, the wiki index, and the project-scoped global-memory entries (by path). See the same file lines 37-51.

3. **A project skills/agents pointer** in `CLAUDE.md`: one short line telling the agent to look in `.claude/skills/` and `.claude/agents/` (auto-discovered) before reaching for a global skill. See `~/Documents/projects/Agnes/CLAUDE.md` line 7.

### Layer 2 -- Wiki coherent-context layer (the brain vault)

Under `~/Documents/brain/wiki/projects/<project>/`:

1. **A decisions-registry MOC** at `decisions.md` -- one entry per major locked decision, grouped by theme, each with: title, `[[link]]` to its source page, lock date, and a one-line rationale + impact. It is a coherent recall block, not a bare index. Superseded decisions stay listed and marked, not dropped, so the trail of how the design moved stays legible. A decision recorded only inside a status/changelog page still gets an entry. Worked example: `~/Documents/brain/wiki/projects/agnes/decisions.md` (groups: Posture and safety / Substrate and cost / Topology and operations / Testing and release).

2. **Cross-cutting cluster MOCs** under `clusters/<cluster>.md` -- each gathers the scattered L3/L4 + prose pages for one cross-cutting concern into one block recall can load whole. Each cluster MOC **opens with a synthesis paragraph** (what this concern IS and what is load-bearing within it), then a "Constituent pages" list where each link carries a one-line note on what that page contributes. A page that belongs to two clusters is linked from both; proposed/parked pages are labeled as such. Agnes used three clusters: safety, runtime, cost (`~/Documents/brain/wiki/projects/agnes/clusters/{safety,runtime,cost}.md`). The cluster SET is per-project judgment -- see "Per-project variation."

### Layer 3 -- Skills and agents (the project repo)

1. **One exemplar project skill** under `.claude/skills/<project>-<role>/SKILL.md`, **project-prefixed in its `name:` frontmatter** (Agnes used `agnes-ops`). It routes asks to the project's existing scripts / wiki runbook and names the safety order each demands; it does NOT reimplement scripts. Worked example: `~/Documents/projects/Agnes/.claude/skills/agnes-ops/SKILL.md` (a dispatch map for deploy / deploy-skill / pull-state / audit / recovery, with a per-script safety order and a "When to use which" table).

2. **A backlog** file (e.g. `backlog.md` in the skill dir) listing the other project skills/agents this project should eventually have. You ship one exemplar, not the full suite.

## Verified mechanics (carry these forward -- they bit us)

- **`@`-import loads the file at FULL token cost.** A separate rules doc buys organization, not token savings -- the imported body autoloads exactly as if inlined. So the real context lever is the `CLAUDE.md` CLEANUP, not the split. Do not justify the rules doc as a cost saving; justify it as durable-vs-referenced separation. (Imports are relative / absolute / `~/` path forms, recursive to 4 hops.)
- **Project skill names MUST be project-prefixed.** A user-level `~/.claude/skills/<name>` skill OVERRIDES a same-named project `.claude/skills/<name>` skill. Prefix with the project (`agnes-ops`, not `ops`) so a global skill cannot shadow it. Note this reservation in the skill's own description so the reason survives.
- **If the project gitignores `.claude/*`, un-ignore the rules dir.** Add exceptions `!.claude/rules/` and `!.claude/rules/**` so the rules doc is version-controlled. The `@`-import works even when the file is ignored, but you want it tracked. Scope the exception narrowly -- it must NOT un-ignore other `.claude/*` paths. (Agnes: `.gitignore` had `.claude/*` with only `.claude/skills/` excepted; chunk 3 added the rules exception.)
- **The brain vault is NOT git.** Wiki MOCs are additive new files, direct-edit-with-review; deletion is the undo (there is no revert). Treat each wiki write as land-and-review, not commit-and-rollback.
- **Reference project-scoped global-memory entries by path; do NOT migrate them.** Agnes has ~9 project-scoped entries living in the global memory store. The rules doc references them by their `~/.claude/projects/.../memory/...` path so a project session can find them; nothing gets moved into the workspace. (Migrating them out was explicitly dropped.)
- **Execution model is direct-edit-with-review, not the worktree build-loop.** This is doc/skill curation across three trees (project repo, `~/.claude`, the non-git brain vault) with no natural TDD RED. Per chunk: draft against the entry, a fresh-context reviewer checks it against the recipe, then apply + commit. The project repo and `~/.claude` commit on a `feat/<...>` branch; the vault edits are direct.

## Per-project checklist

Run start to finish for each target project:

1. **Recon the decision history.** Sweep `wiki/projects/<project>/` (and any status/changelog pages) for locked decisions. Count them -- this sets your decisions-MOC link target (N).
2. **Write the decisions-registry MOC** (`wiki/projects/<project>/decisions.md`): grouped entries, each with link + lock date + rationale/impact. Mark superseded, do not drop.
3. **Pick the cluster set** by judgment (see variation note) and **write each cluster MOC** under `clusters/`: synthesis paragraph first, then annotated constituent links.
4. **Un-ignore the rules dir** if `.claude/*` is gitignored (`!.claude/rules/` + `!.claude/rules/**`); confirm `git check-ignore .claude/rules/<project>.md` returns nothing.
5. **Write the workspace rules doc** (`.claude/rules/<project>.md`): Rules section (durable, project-specific, no global-kernel repeats) + References section (decisions MOC, all cluster MOCs, >= 3 project-scoped global-memory paths, wiki index).
6. **Clean `CLAUDE.md`**: remove ephemeral status/workplan/dead-changelog; keep durable model + system map; add the `@.claude/rules/<project>.md` import line, the project skills/agents pointer, and the global-OS reference block. Do not duplicate content the rules doc now owns.
7. **Author the exemplar project skill** (`.claude/skills/<project>-<role>/SKILL.md`, project-prefixed `name:`) plus a backlog file (>= 3 candidate future skills/agents).
8. **Live-verify in a project-cwd session** (see acceptance).
9. **Commit** the project-repo and `~/.claude` changes on the feature branch; the vault edits are already landed (direct-edit).

## Acceptance list

- `CLAUDE.md` contains the literal `@.claude/rules/<project>.md` import line and a project skills/agents pointer; the ephemeral status/workplan sections are gone.
- The rules doc is tracked (`git check-ignore` returns nothing) and has both a Rules section and a References section.
- The decisions MOC links >= N decisions (N from recon; Agnes's bar was >= 8), each with a one-line rationale.
- Each cluster MOC exists and opens with a synthesis paragraph (not just a link list), and links its constituent pages.
- The exemplar skill is discoverable as `/<project>-<role>` in a project session, with a project-prefixed `name:`.
- **Live load check:** open a project-cwd session and confirm the `@`-imported rules doc loads into context, the project skill is discoverable, and `recall` surfaces a cluster MOC as one coherent block. If a live check fails, record the gotcha in this section for the next project rather than hiding it. (Agnes verify, 2026-06-18: a `claude --print` from the Agnes cwd confirmed agnes-ops discoverable, the imported mailbox rule loaded, and a cluster link resolved.)

## Per-project variation

The three layers are the spine; their richness scales to the project.

- **Cluster set is per-project judgment.** Agnes used safety / runtime / cost because those were its load-bearing cross-cutting concerns. Another project's clusters might be data-model / API / deploy, or it might have only one. Pick clusters around the concerns where recall currently pulls fragments; do not force three.
- **Not every project has a Mac-Studio-style ops surface.** Agnes's `agnes-ops` skill exists because Agnes has real production scripts (deploy / pull-state / recovery) worth a dispatch map. A project with no such surface gets a different exemplar skill (or, for a thin project, may skip the skill layer and just record the backlog).
- **Not every project has a rich decision history.** A thin project may need only a decisions MOC + a rules doc + the cleaned `CLAUDE.md` -- no clusters, no exemplar skill. Do not manufacture decisions or clusters to hit a count; the bar is "everything load-bearing is grounded," not "all three layers maxed out."
- **Global-memory references scale to what exists.** A project with no project-scoped global-memory entries simply omits that References sub-list; do not invent paths.
