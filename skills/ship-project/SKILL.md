---
name: ship-project
description: Use when a project is complete, parked, or being sunset, and the operator wants to mark its terminal status on the project page. Manual-trigger only; the operator invokes. Does not auto-detect "project complete," does not chain from the chunk-end self-check, and is independent of ship-spec (the two act on different surfaces and have separate triggers).
---

# Ship Project

## Step 1: Confirm inputs

Locate the project page at `~/Documents/brain/wiki/projects/<project>/index.md`. If the operator supplied a project slug, use it; otherwise ask:

- Which project? (slug = leaf directory name under `wiki/projects/`)
- What terminal status? Options: `Shipped` (done and live), `Parked` (paused indefinitely), `Sunset` (retired).

If no project page exists at the slug, stop: "No project page at `wiki/projects/<slug>/index.md`. Create the page first or correct the slug."

Surface inline:

> `Reading the project as <slug> — flag if not.`

## Step 2: Get today's ISO date

```bash
date +%Y-%m-%d
```

## Step 3: Verify preconditions

Surface each of these advisory checks (do not block on any; the operator decides whether to proceed):

- **Open spec:** If `specs/current.md` exists at the project root (or `~/.claude/specs/current.md` for `claude-code-setup`), surface: `Open spec at <path>, Status: <line>. Run ship-spec on it first if it should be terminal before the project ships. Flag if not, otherwise continuing.` Do not invoke `ship-spec` from here.
- **Recent activity:** If no edits in the last 30 days, surface: `Project's source tree last touched <date>. Flag if shipping is premature.`

## Step 4: Update project-page status

Find the `## Status` block on the project page. Replace its content with:

- `Shipped — YYYY-MM-DD. <one-line ship summary>` for complete-and-live.
- `Parked — YYYY-MM-DD. <one-line parking reason>` for indefinite pause.
- `Sunset — YYYY-MM-DD. <one-line sunset reason>` for retirement.

If the page has no `## Status` heading, insert one immediately after the `# Project: ...` heading, then write the status line. Surface and apply:

> `Updating wiki/projects/<slug>/index.md § Status — flag if not.`

## Step 5: Sweep adjacent project-page sections

Read these sections if present and surface any stale entries. Do not silently rewrite; surface findings and let the operator redirect:

- `## Specs`: confirm each listed spec's status is `Shipped — YYYY-MM-DD`, `Abandoned — YYYY-MM-DD`, or (for still-open specs) `Locked — YYYY-MM-DD`. Flag any line that says "in progress" or similar.
- `## Open questions`: flag entries now stale (resolved by the project shipping or no longer relevant); suggest moving them to `## Resolved` or striking them through.
- `## Recent decisions`: flag any "next milestone" or "next step" entries implying the project is still mid-flight; prompt the operator for a resolution sentence.

## Step 6: Hand off to Claude Design collage

The L0 collage is the project's single-page executive view: a seed `.md` plus canonical Claude Design HTML (with a PNG sibling for Obsidian preview).

### 6a. Author the L0 seed

Read `~/Documents/brain/wiki/projects/<slug>/L0-collage.md` if the operator authored one. Otherwise draft it. Frontmatter:

```yaml
---
type: diagram
level: 0
parent: null
expands: null
diagram-type: collage
status: in-progress
created: <ISO date>
updated: <ISO date>
project: <slug>
design-source: null
---
```

Body sections per `~/Documents/brain/wiki/claude-design-prompt.md` § Collage variant:

- **Three required synthesis-primary tiles:** Workflow-at-a-glance (one paragraph plus 3-5 inline boxes), Skills inventory (one line per added/changed skill), Project state (substrate, ship date, follow-ups, spec-archive link).
- **Curated polished flow list:** 3 entries max. Name the L1/L2/L3 source `.html` files the operator hand-picks; each goes in a fenced list block with a one-phrase rationale.

Claude drafts the synthesis-primary tile copy from `wiki/projects/<slug>/index.md` plus `specs/archive/`; the operator supplies the curated polished flow picks. Surface inline:

> `Drafting L0 seed at wiki/projects/<slug>/L0-collage.md — flag if not.`

### 6b. Assemble the collage prompt and hand off to the operator

Template the per-project prompt from `~/Documents/brain/wiki/claude-design-prompt.md` § Collage variant `### Prompt template`. Substitute the seed path and curated polished flow filenames. The only mandatory drag-ins for the Claude Design session are the seed `.md` itself plus the named polished flow `.html` files.

Hand the operator the rendered prompt as a single fenced markdown block. the operator pastes into `claude.ai/design`, watches the render, and returns the **implement URL** (the `claude.ai/design/<id>` path, which serves a gzipped tarball when fetched).

If the operator declines to run Claude Design at this time:

> `the operator skipped the collage round-trip; project-page status flip stands; collage left for a later session — flag if not.`

Then exit Step 6 without running 6c.

### 6c. Round-trip primitives

Once the operator hands back the implement URL, source `~/.claude/scripts/ship_project.sh` from disk and call `collage_round_trip <implement-url> <slug>`.

The script: fetches the gzipped tarball, extracts it (handles both wrapper-dir and root formats), copies the canonical `.html` to `wiki/projects/<slug>/L0-collage.html`, runs `~/.claude/scripts/render-design-png.sh` to produce `L0-collage.png` (HTML stays canonical; PNG is the Obsidian-preview sibling, re-exported on every HTML edit). On collision (a prior collage already at `L0-collage.html`), it refuses to overwrite — the operator removes or renames the prior collage before re-running. Tmp paths are derived from the target so concurrent runs do not collide.

### 6d. Persist frontmatter and embed on project page

After the script returns, write the L0 seed's `design-source: <implement URL>` and `updated: <ISO date>` frontmatter fields. Flip `status: in-progress` to `status: as-built`.

Embed the PNG on `wiki/projects/<slug>/index.md` in a new `## Collage` section: `![[L0-collage.png|800]]` plus a one-line caption naming the implement URL. The `|800` width specifier is required — Claude Design renders at 2x retina (~3616×2360) which overflows Obsidian's note pane without an explicit width. Surface inline:

> `Updating wiki/projects/<slug>/index.md § Collage — flag if not.`

## Step 7: Confirm to the operator

Report:

- Project page status line updated (which line, what it now reads).
- Adjacent-section sweep results (what was edited, what was surfaced for the operator's redirect).
- Collage outcome: HTML + PNG paths if Step 6c ran, "deferred (the operator skipped Claude Design)" if 6b exited early, "collage already present, no round-trip" if 6c hit the collision guard.
- Rollback command: if the collage round-trip ran, `rm wiki/projects/<slug>/L0-collage.{html,png}` plus revert the `## Collage` section; if only the status flip ran, revert `## Status`. 

## Edge cases

- No `## Status` section: Step 4 inserts one. Mention: `Created ## Status section on wiki/projects/<slug>/index.md (first ship).`
- Ambiguous slug (multiple `wiki/projects/<x>/` dirs match a partial): surface the candidates and ask the operator to pick. Never guess between near-matches.
- Status already terminal (e.g., `Shipped — 2026-04-15`): surface the existing status and ask whether to re-ship with today's date or abort.
- `claude-code-setup` (no per-project repo): open-spec check in Step 3 reads `~/.claude/specs/current.md`; everything else is unchanged.

## Hard rules

- Never auto-trigger. Manual invocation only. Do not chain from the chunk-end self-check, `ship-spec`, or any other skill.
- Never invoke `ship-spec` from this skill. If a spec needs to ship first, surface that to the operator.
- Never ship a project whose page does not exist.
- Never silently rewrite multiple lines in Step 4. Only the Status block changes silently; everything else is surfaced and confirmed.
- Never overwrite a previously-produced L0 collage HTML or PNG. The Step 6c script enforces this via its collision guard.

## References

- `~/.claude/coo/coo-sop.md` § Phase 8: spec-ship vs project-ship distinction.
- `~/Documents/brain/wiki/diagram-conventions.md` § L0 collage: frontmatter spec, tile composition rule.
- `~/Documents/brain/wiki/claude-design-prompt.md` § Collage variant: pasteable prompt template Step 6b uses.
- `~/.claude/scripts/render-design-png.sh`: HTML-to-PNG rasterizer Step 6c invokes.
- `~/.claude/scripts/ship_project.sh`: the `collage_round_trip` orchestrator Step 6c sources.
