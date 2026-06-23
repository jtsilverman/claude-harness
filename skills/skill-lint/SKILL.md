---
name: skill-lint
description: Use when the operator invokes /skill-lint or asks for a skill-catalog health check. Scans ~/.claude/skills/ and the telemetry sidecar at ~/.claude/state/skill-usage.json and reports four drift classes (Never invoked, Idle past 30 days, LRU bottom 5, Suspicious). Read-only; reports only, never auto-fixes.
---

> **Communication discipline.** Apply `~/.claude/coo/communication-discipline.md` throughout this skill: TLDR on multi-point output, two-line teach format on new concepts, callback over re-derivation when concepts repeat, real vocabulary with plain unpack, conclusion before justification, slow down when complex.

# Skill Lint

## Overview

Drift reporter for the Claude skill catalog. Scans `~/.claude/skills/` against the telemetry sidecar at `~/.claude/state/skill-usage.json` and surfaces four classes of disuse. **Read-only** — the skill never deletes, moves, or rewrites anything. the operator decides which findings (if any) to act on.

Third sibling of `memory-lint` (memory store) and `wiki-lint` (Obsidian vault). Same posture: report, don't repair.

The telemetry write side is wired separately — every Skill tool call increments per-skill `invoked_count` and refreshes `last_used` (UTC) via the PostToolUse hook at `scripts/track-skill-usage.sh`. This skill only reads.

## When to use

- **Invoked manually via `/skill-lint`** or when the operator asks for a skill-catalog health check.
- **Skip when:** the catalog is empty, telemetry has been wired for less than ~7 days (most skills will look "never invoked"), or a `/skill-lint` ran recently with no churn since.

## Drift classes

Four classes, surfaced in this order in the report.

### 1. Never invoked since telemetry started

Skill directories in `~/.claude/skills/` with no entry in the sidecar. Means: the skill exists on disk but no Skill tool call has fired against it since the hook was wired.

The header reports `Telemetry started N days ago` so this can be read in context — "never invoked since 2 days ago" is mostly noise; "never invoked since 9 months ago" is signal.

### 2. Idle past N days

Skills with a sidecar entry whose `last_used` is older than the threshold (default 30). Configurable via `IDLE_THRESHOLD_DAYS` env var.

### 3. LRU bottom 5 (by last_used)

The 5 invoked skills with the oldest `last_used` timestamps. Always at most 5 entries. Idle skills can also appear here; overlap is intentional — both signals point at the same staleness.

### 4. Suspicious — created but rarely used

Mechanical heuristic: `first_seen` age >= 30 days AND `invoked_count` <= 3. Catches the "added this skill weeks ago and barely touched it" case. Per `llm-internal-heuristics-prefer-judgment`, Claude may re-rank qualitatively after the bash pass — e.g., a quarterly-cadence skill is explainably low-count.

## Workflow

### Step 1: Run the report

```bash
bash ~/.claude/skills/skill-lint/scripts/report.sh
```

Emits the four-section markdown report on stdout. Defaults read the live sidecar and `~/.claude/skills/`. Override `SIDECAR_PATH`, `SKILLS_DIR`, `IDLE_THRESHOLD_DAYS`, `TODAY` for fixture runs (see `tests/report-test.sh`).

### Step 2: Hand the report to the operator

Output inline. Do not edit any skill file. If a section is empty, the script prints `(none)` under the header — that's the report, not a bug.

If the operator wants to act on a finding, he names which and the relevant tool (manual edit, capture-learning, etc.) handles it.

## Hard rules

- **Read-only.** Never delete, move, or rewrite any skill file or the sidecar. Same posture as `memory-lint` and `wiki-lint`.
- **Plugin skills are out of scope.** The hook filters by `:` in the skill name; the report defensively re-filters in case a plugin entry sneaks in.
- **Sidecar is the source of truth for invocation history.** Don't read git log, transcript, or filesystem mtime as a proxy.
- **Don't auto-fix.** Even an unambiguous finding (typo in dir name, never invoked) gets reported and stopped on. the operator decides.
- **Telemetry start date matters.** Recent `telemetry_started` means "Never invoked" is mostly noise; surface the age in interpretation.

## Common mistakes

- **Treating "Never invoked" as evidence to delete.** A 2-day-old telemetry start means most skills look idle; don't recommend pruning until telemetry has accumulated signal (~30+ days).
- **Auto-fixing on the operator's behalf.** No. Report, then stop.
- **Editing `report.sh` without re-running `tests/report-test.sh`.** The acceptance test (20 checks) is the floor; keep it GREEN.
- **Putting the sidecar inside `~/.claude/skills/`.** It lives at `~/.claude/state/skill-usage.json` — the skills tree would confuse the lint walk and other tooling.
- **Padding the report when a section is empty.** The script prints `(none)`; don't elaborate.
