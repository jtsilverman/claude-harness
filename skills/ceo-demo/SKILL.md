---
name: ceo-demo
description: Use whenever the operator asks for a CEO-level readout at ANY point mid-build — independent of planned milestones. Trigger phrases the COO routes to this skill — "where are we" (status), "show me" / "show me the latest feature" (demonstration), "is this working" (verification), "how does this work and why does it matter" / "how does X work" (explanation). Classifies the ask into one of four shapes (status / demonstration / explanation / verification), assembles a CEO-altitude response from current build state — firing the demo-assembler agent for a demonstration, reading the board/code and narrating directly for the other three — and delivers it TLDR-first with every technical term paired with a plain-English unpack.
---

> **Communication discipline.** Apply `~/.claude/coo/communication-discipline.md` throughout this skill: TLDR on multi-point output, two-line teach format on new concepts, callback over re-derivation when concepts repeat, real vocabulary with plain unpack, conclusion before justification, slow down when complex.

# ceo-demo — on-demand CEO readout (the PULL path)

## Overview

The on-demand half of the demo layer. The **PUSH** path (planned milestone demos, fired by the cockpit when a milestone's trigger chunks merge) is the other half and is not this skill — this is **PULL**: the COO invokes `ceo-demo` whenever the operator asks for a CEO-level readout at **any** point mid-build, independent of the planned milestones. the operator's ask is the trigger; current build state (the board + the as-built code) is the source.

This is **not** a verification gate. The verification net already proved the work works before it merged; a readout is show-and-tell for the operator's comprehension and alignment, never a re-check. Same posture as the push path — it presumes "it works" and shows what/that/how.

## When this fires

The COO routes an ask to this skill when the operator's words match one of the four readout shapes. The harness routes on the frontmatter `description` above — the trigger phrases (`where are we`, `show me`, `is this working`, `how does ... work`) live there verbatim because the description is the only routing surface the 1% rule and the manifest match against. Inside the skill, the COO reads the ask and judges which shape it is.

## Step 1 — Classify the ask (judgment-guided, not a rigid enum)

Read the ask and judge which of the four shapes it is. This is **LLM judgment on the operator's intent**, not a closed switch — the four shapes are an open taxonomy, and a real ask may blend two (then serve the dominant one, or fold a one-line answer to the secondary). Do **not** reduce dispatch to a bare pipe-enum regex (`status|demonstration|explanation|verification`) — classify by reading what the operator actually wants:

- **status** — *progress.* "Where are we." How far along the build is: which chunks have merged, what is in flight, what is next. Answers *how much is done.*
- **demonstration** — *show a feature working.* "Show me" / "show me the latest feature." A narrated walk-through of a feature with evidence (a sim run, a screenshot, a clickable UI handoff, a worked example). Answers *what does it do, shown not asserted.*
- **explanation** — *what a piece does and why it matters.* "How does this script work and why does it matter." The role of a piece of the system and the capability it unlocks. Answers *what is this for.*
- **verification** — *is it working.* "Is this working." The current green/red state from the build's own evidence (the net's results, a fixture run). Answers *can I trust it right now* — reported, not re-gated.

If the ask is ambiguous between shapes, pick the dominant intent and surface that read (Rule 7: state it, proceed, let the operator override).

## Step 2 — Assemble the response (the split dispatch)

The classified shape forks into one of two assembly paths:

- **demonstration → fire the `demo-assembler` agent.** A demonstration needs a narrated story plus captured evidence (sim run / screenshot / clickable UI / worked example) — that is exactly the demo-assembler's job, and the same agent the PUSH path uses. The COO fires it (`subagent_type: demo-assembler`) on the **pull path**, populating `ask` (the question the operator asked) + `scope` (which files / feature / flow to demonstrate, and any depth bound) + the repo-state pointers. The agent drafts the narration + evidence and returns it; **the COO is the sole writer** and applies any persisted output itself.
- **status / explanation / verification → the COO narrates directly.** No demo-assembler. These three are read-and-narrate: the COO **reads the board** (`specs/current.md` — merged chunks, in-flight, next) **and/or the code** (the as-built files for the piece in question, the net's latest evidence) and narrates the answer directly. A direct board/code read is enough; assembling a demo with captured evidence would be over-build for a progress/role/health question.

The fork is the chunk's defining behavior: **demonstration is the only shape that fires the builder; the other three are direct COO board/code narration.**

## Step 3 — Deliver at CEO altitude

Whatever the shape, the readout lands at **CEO altitude** — the communication-discipline immersion bar:

- **TLDR-first.** Lead with the one-or-two-sentence answer; the supporting detail follows for the operator to skim or skip.
- **Real vocabulary, plain unpack.** Every technical term appears paired with a plain-English unpacking the operator would understand — use the real word, then unpack it (Rule 4), never naked jargon and never dumbed-down non-vocabulary.
- **Conclusion before justification.** The answer, then the reasoning.

A substantive readout (one the operator will want to revisit, e.g. a demonstration with captured evidence) may also be filed under `demos/<spec-slug>/`, sole-written by the COO — chat-only is fine for a quick status/verification answer.

## Hard boundary

- **Not a gate.** This skill never re-verifies; it reads already-green state and narrates it. If the net is not green, that is the review gate's job, not this skill's.
- **COO is sole writer.** The demo-assembler drafts and returns; the COO applies any persisted file. Workers never write shared state.
- **Reuse, no new builder.** The demonstration path reuses the existing `demo-assembler` agent; status/explanation/verification reuse the COO's existing board/code reads. This skill adds routing, not a new build engine.

## Return / outcome

A CEO-altitude readout delivered in chat (TLDR-first, jargon paired with plain unpack), assembled by the shape-correct path — demo-assembler for a demonstration, direct COO board/code narration for status / explanation / verification — and optionally filed under `demos/<spec-slug>/` when substantive.
