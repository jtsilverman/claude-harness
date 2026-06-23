---
name: backfill-decisions
description: Use when the COO needs to classify a decision as backfillable vs blocking, log it to the inline queue, or drain the queue at exhaustion or the operator's return. Invoked mid-execution when a decision arises that might block progress, and at session wrap-up or the operator's return to resolve the accumulated queue.
---

# backfill-decisions -- classify, log, drain

## Overview

This skill mechanizes the defer-and-backfill COO default: **classify** each decision that arises mid-execution, **log** backfillable ones to the inline queue, and **drain** the queue at exhaustion or the operator's return. Full policy lives in `coo/coo-sop.md` § Defer and backfill reversible decisions.

## Step 1: Classify the decision

Ask: is this decision reversible, non-destructive, and non-scope-changing?

- **Yes to all three** --> backfillable. Proceed to Step 2 (log + continue).
- **No to any one** (destructive, irreversible, scope-invalidating, or no autonomous path) --> blocking. Proceed to Step 3 (halt only this branch).

The classifier reuses CLAUDE.md Rule 8's existing test verbatim: "Ask only when the wrong pick is destructive, irreversible, scope-changing, or a genuine preference call." The flip is the backfillable side.

## Codex Pre-filter (mandatory, before surfacing any decision to the operator)

Before the COO surfaces ANY decision to the operator -- whether as a backfill entry or a blocking escalation -- it MUST first run the decision past Codex. **Every backfill decision is run past Codex before it reaches the operator. This is a mandatory pre-filter, not optional.**

The COO invokes Codex on demand via the local binary (`codex exec ... < /dev/null`) or the `/codex:adversarial-review` plugin command, passing the decision statement, the options, and the context as text -- manual, on-demand, no auto-gate. Always pass `< /dev/null` when invoking `codex exec` directly: it reads stdin even with a prompt arg and blocks forever on an open pipe in non-interactive contexts.

**Resolve branch:** If Codex resolves the decision (the COO is now confident AND the decision is backfillable), the COO proceeds without escalating. Log it as a CLOSED record (tagged `[resolved-via-Codex]`) -- for the audit trail and `/clear`-durability, not as a pending ask. It does not await the operator; the drain step skips resolved entries, the same way the queue already carries closed `BD-N ✓` items:

```
**BD-N -- <question headline>** [resolved-via-Codex]
Q: <one-sentence statement>
Options: <A> | <B>
Rec: <option chosen> -- resolved via Codex consultation; Codex's rationale: <summary>.
```

**Escalate branch:** If the COO is still confused or genuinely stuck after Codex, or if the decision genuinely needs CEO judgment (vision, scope, irreversible), escalate to the operator as a backfill entry WITH Codex's perspective attached:

```
**BD-N -- <question headline>** [needs the operator; Codex consulted]
Q: <one-sentence statement>
Options: <A> | <B>
Codex: <summary of what Codex said>
Rec: <the COO's recommendation given Codex's input>
```

This composes with the existing backfillable-vs-blocking classifier: the classifier (Step 1) runs first to decide whether the decision is backfillable or blocking; then the Codex pre-filter runs before the surface-to-the operator step on ALL decisions that would otherwise reach the operator. Codex does not change the blocking classification -- it resolves the decision content so the operator (if he still needs to see it) gets a richer entry with a different-model perspective already attached.

## Step 2: Log (backfillable decisions)

Append an entry to the backfill queue, which lives in the active spec's `## Backfill decisions` section (a file on disk, e.g. `specs/current.md`) so it survives a `/clear`. Format:

```
**BD-N -- <question headline>**
Q: <one-sentence statement of the decision>
Options: <option A> | <option B> [| ...]
Rec: <the choice the COO would take if forced, with one-line rationale>
```

After logging, **continue building**. Do not halt for a backfillable decision.

## Step 3: Halt (blocking decisions)

A blocking decision halts only its own branch. Route around it: continue all independent branches. Do not stop the entire execution. Only halt everything when all remaining work is gated on unresolved blocking decisions -- nothing left can proceed.

Log the blocker inline (same BD-N format, but mark it `STATUS: BLOCKING -- awaiting the operator`) so it surfaces at the operator's return.

## Step 4: Drain the queue

Drain in two situations:

1. **At exhaustion**: when all independent branches are complete and only gated work remains, present the full queue to the operator before declaring blocked.
2. **On the operator's return**: include the queue in the chunk-end CEO relay (the COO go/no-go). the operator ratifies or overrides each recommendation in one pass.

For each entry:
- If the operator ratifies or it is an obviously-safe autonomous call: apply the recommended option and mark resolved.
- If it carries vision/scope/direction weight: escalate to the operator, do not self-resolve.

After drain, the queue is empty. Resume any work that was gated on the now-resolved decisions.

## Anti-patterns

- Halting all work because one branch hit a blocking decision (halt only its branch).
- Treating a reversible decision as blocking to avoid the log step.
- Leaving the queue unreviewed when the session reaches exhaustion.
- Logging without a recommendation (the `Rec:` field is required; "I'm not sure" is a reason to pick and flag, not to omit).
