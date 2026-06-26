---
name: diagram-system
description: Use when the user asks for a diagram, ERD, swim lane, system view, flowchart, sequence, or state machine — for either a new system from scratch or to update an existing one. Produces hierarchical, sign-off-gated Mermaid diagrams that fit into each other. Polished Claude Design renders are on-demand only, when external sharing is needed.
---

# Diagram System

Diagrams are clarity tools, readable in ~30 seconds. Layer hierarchy: L1 Context → L2 Containers → L3 Internal (L4 only for gnarly internals). Each level is its own complete diagram; the boundary of an L(N) diagram is the box it expands from in L(N-1). Full frontmatter spec, naming conventions, notation rules, and layer rules: `~/Documents/brain/wiki/diagram-conventions.md`. Per-type Mermaid recipes and viability boundaries: `~/Documents/brain/wiki/diagram-recipes.md`. Diagrams live at `~/Documents/brain/wiki/projects/<project>/L<N>-<topic>.md`.

## When it fires

- The user says "draw X", "diagram Y", "ERD for Z", "swim lane for W", "show me how V works", "I want a visual."
- Phase 2 (Specify): greenfield new system triggers L1 + L2 at spec time. Non-greenfield: textual structural summary only; full diagrams come from the chunk-end diagram auto-refresh.
- Chunk-checkpoint: chunk changes a diagrammed flow → **auto-refresh path** (see § Auto-refresh).
- Manual reorientation: any time the user feels lost.

## Step 1: Determine intent and starting state

Ask the user:

1. **Which system?**
2. **New from scratch, or modify an existing diagram?** Check `~/Documents/brain/wiki/projects/<project>/` first; surface anything that exists before assuming greenfield.
3. **What level?** L1 if no diagram yet; L2 to drill into an L1 box; L3 into an L2 box. If unclear, ask which parent box is being expanded.
4. **What aspect?** (L3/L4 only) Structural, decision logic, time-ordered, data, state, or cross-actor? This drives diagram type.

Do not start drawing until all four are answered. Vague answers get specific push-back ("which box from L2 are we expanding?").

## Step 2: Pick the diagram type

- **L1 → C4 Context.** Always.
- **L2 → C4 Container/Component.** Always.
- **L3/L4 → mixed by aspect:**
  - **Flowchart** — decision-heavy logic, dispatch, rule enforcement.
  - **Sequence diagram** — time-ordered API calls, multi-actor request/response.
  - **State machine** — entities with discrete states and transitions.
  - **ER diagram** — data shape, tables, relationships, cardinality.
  - **Swim lane** — cross-actor workflow where "who does what when" matters.

**Orthogonal types** (project lifecycle, fault tree, threat model): linked from related containers but stand alone, not children in the zoom chain.

Once type is locked, see `~/Documents/brain/wiki/diagram-recipes.md` § <Type> for the minimal-viable Mermaid template, node-count target, edge-density target, and Claude Design escape boundary.

## Step 3: Textual structural summary first

Before any Mermaid, produce a bullet list:

- **Boxes/nodes** at this level (one-sentence description each).
- **Relationships/flows** (verb-phrase labels: "sends email to", "reads from", "writes to").
- **Boundary** (for L2/L3: which parent box is being expanded; what crosses that boundary).
- **Test surface** (which behaviors are guarded by which test IDs; populate from existing tests).

Show to the user. He confirms or corrects. **Do not draw yet.** Catching wrong assumptions in text is faster. Iterate on the summary to confirmation.

## Step 4: Generate the diagram

Start from the per-type recipe in `~/Documents/brain/wiki/diagram-recipes.md` § <Type>. **Default to Mermaid** — the block lives inside the wiki page within a fenced code block. Conform to notation rules in `diagram-conventions.md` § Notation rules: shape vocabulary, color conventions, arrow conventions, arrow numbering are non-negotiable. Follow the recipe's escape rule if content exceeds the per-type viability boundary.

**"How this works in plain English" section (required).** Every new diagram page carries a `## How this works in plain English` section: two-to-four sentences for a reader who knows software but not this system. Sits alongside the Mermaid, does not replace it.

## Step 5: Bidirectional review

Show the user the diagram. He gives **anchored feedback** pointing at specific elements ("the edge from A to B should not exist", "split this box into two"). Generic feedback ("this is wrong") gets push-back: ask for an anchored point.

Iterate until the user is ready to lock. Before lock, run the **challenge prompt**:

> Name three ways this diagram could be wrong, incomplete, or misleading.

Address each item or accept the risk explicitly.

## Step 6: Sign-off

Lock signal must be explicit: The user says "lock." Do not infer from "looks good" or silence.

On lock:
- Set frontmatter `status: as-built` (existing system) or `status: proposed` (greenfield ahead of implementation).
- Set `last-verified` to today's date (and commit hash if applicable).
- Set `expands` field if L2/L3/L4.
- Set `related-tests` if a test surface was identified in Step 3.

## Step 7: Persist and update navigation

Write the file to `~/Documents/brain/wiki/projects/<project>/L<N>-<topic>.md` with frontmatter per `diagram-conventions.md`.

Update the project's `index.md` to link the new diagram (parent → child). Update `~/Documents/brain/wiki/projects/index.md` if a new project was added.

## Step 8: Boundary check

When adding a diagram at level N, verify boundary consistency against the parent at N-1:

- The outer boundary corresponds to a labeled box in the parent.
- Arrows entering/leaving that boundary in the parent appear in the new diagram with the same semantics.
- If the new diagram requires an external edge the parent doesn't show, **update the parent first.** Do not let inconsistency ship.

When modifying an existing diagram, check both directions (parent and children). Flag mismatches; do not silently propagate.

## Step 9: Hand-off

**From the `spec` skill:** return the diagram path so the spec can reference it.

**From the milestone/ship wiki-refresh path:** return the refreshed diagram path for the review set. If boundaries changed, refresh parent diagrams too and return all touched paths.

## Auto-refresh (chunk-end upkeep path)

When the chunk-end auto-refresh invokes this skill to refresh an existing `as-built` diagram, run the abbreviated path — no lock ceremony (Req 9):

1. **Re-derive structure from current code** (Steps 3-4 equivalent): read the changed skill/code, redraw affected nodes/edges/prose so the diagram matches what shipped. Reuse the existing diagram's shape vocabulary and `classDef` verbatim.
2. **Update the page's plain-English prose** — the `## How this works in plain English` section and any other prose describing the changed flow. A refresh that redraws boxes but leaves prose describing the old flow ships a contradiction. Genuinely out-of-scope prose debt: disclose in frontmatter, not silently left wrong.
3. **Re-verify frontmatter:** set `last-verified` and `last-updated` to today; keep `status: as-built`; refresh the `represents:` summary if step count or shape changed.
4. **Write the file** and surface inline per Rule 7 (`Auto-refreshed <path> — flag if not.`). The refreshed diagram is the chunk's Step 9 review artifact.

**Steps 5-6 are skipped on auto-refresh** — no anchored-feedback round, no challenge prompt, no "lock" wait. Upkeep of an already-locked `as-built` diagram is auto-write, same posture as the chunk-end project-page write. Still run **Step 8** — a refresh that reveals a parent-boundary mismatch auto-refreshes the parent too.

## Hard rules

- Readable in 30 seconds. Three-to-five shape types max. Verb-phrase arrow labels. Plain-English subtitle.
- Follow `diagram-conventions.md` § Notation rules. Never invent shapes or colors.
- Never produce ASCII art. Mermaid or Claude Design only.
- Always pick a level (L1/L2/L3/L4) and type explicitly before drawing.
- Always produce the textual structural summary before drawing.
- Lock ceremony (Steps 5-6) is **draw flow only** — greenfield, manual "draw X", spec-time new diagram. Auto-refresh path skips it.
- Source from real code/spec for `as-built` diagrams; imagined ones get `status: proposed`.
- Never silently modify a diagram. Draw flow: show proposed diff, get anchored feedback before re-lock. Auto-refresh path: surface the write inline per Rule 7.

## References

- `~/Documents/brain/wiki/diagram-conventions.md` — frontmatter spec, naming rules, layer rules, legibility rules, notation rules. The contract this skill targets.
- `~/Documents/brain/wiki/diagram-recipes.md` — per-type Mermaid templates, node/edge targets, Claude Design viability boundaries.
- C4 model: https://c4model.com — hierarchy reference.
