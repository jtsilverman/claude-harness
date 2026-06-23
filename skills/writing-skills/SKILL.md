---
name: writing-skills
description: Use when creating new skills, editing existing skills, or verifying skills work before deployment
---

# Writing Skills

Writing skills is TDD applied to process documentation. Skills live in `~/.claude/skills/`. Full TDD rationale: `disciplines/worker-discipline.md` (RED -> GREEN -> REFACTOR).

**Iron Law: NO SKILL WITHOUT A FAILING TEST FIRST.** This applies to new skills AND edits. Write skill before testing? Delete it and start over. No exceptions.

## What is a Skill?

A **skill** is a reusable reference guide for proven techniques, patterns, or tools. NOT a narrative of how you solved a problem once.

**Create when:** technique wasn't obvious, applies broadly across projects, others benefit.
**Don't create for:** one-offs, standard practices documented elsewhere, project-specific conventions (put those in CLAUDE.md), mechanical constraints (if regex/validation can enforce it, automate -- save skills for judgment calls).

**Self-carry convention (worker agents):** a worker agent (`agents/*.md`) that produces CEO-facing output must self-carry its comm/altitude guidance inline in its own prompt, because `communication-discipline` is off the worker autoload path -- do not rely on it autoloading.

## Skill Types

- **Technique:** concrete method with steps (condition-based-waiting)
- **Pattern:** mental model (flatten-with-flags)
- **Reference:** API docs, syntax guides

## Directory Structure

```
skills/
  skill-name/
    SKILL.md              # required
    supporting-file.*     # only if needed (heavy reference 100+ lines, or reusable tool)
```

Keep inline: principles, code patterns under 50 lines, everything else.

## SKILL.md Structure

**Frontmatter (YAML):**
- `name`: letters, numbers, hyphens only -- no special chars; max 1024 chars total
- `description`: third-person, starts with "Use when...", triggering conditions ONLY -- never summarize the skill's workflow (if you summarize the process, Claude follows the description instead of reading the body)

```markdown
---
name: skill-name
description: Use when [specific triggering conditions]
---

# Skill Name

## Overview
Core principle in 1-2 sentences.

## When to Use
Bullet list of symptoms/conditions. When NOT to use.

## Core Pattern
Before/after comparison (for techniques/patterns).

## Quick Reference
Table or bullets for scanning.

## Implementation
Inline code or link to separate file.

## Common Mistakes
What goes wrong + fixes.
```

## Claude Search Optimization (CSO)

**Description field -- triggering conditions only, no workflow:**

```yaml
# BAD: summarizes workflow -- Claude follows this instead of reading the body
description: Use when executing plans - dispatches subagent per task with code review between tasks

# GOOD: conditions only
description: Use when executing implementation plans with independent tasks in the current session
```

**Keyword coverage:** use words Claude would search for -- error messages, symptoms, tool names, synonyms.

**Naming:** verb-first, active voice. `condition-based-waiting` not `async-test-helpers`. Gerunds work: `creating-skills`, `debugging-with-logs`.

**Token efficiency:** getting-started workflows target <150 words; frequently-loaded skills <200 words; others <500.
- Reference `--help` instead of listing all flags inline.
- Use cross-refs instead of repeating workflow details.
- One excellent example beats many mediocre ones.

**Cross-referencing other skills:**
```markdown
# GOOD: explicit requirement
**REQUIRED:** Use `tdd-red` then `tdd-green`

# BAD: force-load syntax burns context before you need it
@skills/test-driven-development/SKILL.md
```

## Flowchart Usage

Use Mermaid flowcharts ONLY for non-obvious decision points or process loops where you might stop too early. Never for reference material (use tables), code examples (use code blocks), or linear instructions (use numbered lists).

## RED-GREEN-REFACTOR for Skills

- **RED:** Run pressure scenario WITHOUT the skill. Document exact rationalizations verbatim.
- **GREEN:** Write minimal skill addressing those specific rationalizations. Run same scenario WITH skill -- verify compliance.
- **REFACTOR:** Find new rationalizations → add explicit counters → re-test until bulletproof.

Full testing methodology: `testing-skills-with-subagents.md`.

## Testing by Skill Type

**Discipline-enforcing** (TDD, verification): pressure scenarios with combined stressors (time + sunk cost); identify rationalizations and add explicit counters.

**Technique** (how-to guides): application scenarios, variation/edge cases, gap-finding.

**Pattern** (mental models): recognition scenarios, counter-examples, when-NOT-to-apply.

**Reference** (docs/APIs): retrieval scenarios, application scenarios, common-use-case coverage.

For discipline skills: explicitly forbid loopholes. List workarounds agents will attempt and preemptively ban each. Build a rationalization table from baseline testing. Create a Red Flags list.

## Skill Creation Checklist

**RED Phase:**
- [ ] Create pressure scenarios (3+ combined pressures for discipline skills)
- [ ] Run WITHOUT skill -- document baseline behavior verbatim
- [ ] Identify patterns in rationalizations/failures

**GREEN Phase:**
- [ ] Frontmatter: valid `name` (letters/numbers/hyphens) and `description` (starts "Use when...", third-person, no workflow summary)
- [ ] Description has concrete triggers/symptoms and keywords
- [ ] Addresses specific baseline failures from RED
- [ ] One excellent code example (not multi-language)
- [ ] Run WITH skill -- verify compliance

**REFACTOR Phase:**
- [ ] Identify new rationalizations
- [ ] Add explicit counters (discipline skills)
- [ ] Re-test until bulletproof

**Quality checks:**
- [ ] Flowchart only if decision non-obvious
- [ ] Quick reference table
- [ ] Common mistakes section
- [ ] No narrative storytelling
- [ ] Supporting files only for tools or heavy reference (100+ lines)

**Stop after each skill: do NOT batch-create multiple skills without testing each one.**
