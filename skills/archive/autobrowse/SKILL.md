---
name: autobrowse
description: Use when a browser-agent task on a real site needs convergent iteration and graduation into a durable, replayable SKILL.md.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, mcp__playwright__*, mcp__browserbase__*
---

# Autobrowse

> **Communication discipline.** Apply `~/.claude/rules/communication-discipline.md` throughout: TLDR-first on multi-point output, two-line teach on new concepts, conclusion before justification.

## Overview

Iterate a browser task to convergence on a real site, then graduate the winning approach into a durable, human-readable `SKILL.md` plus the deterministic glue (selectors, helper scripts, fetch calls) needed to repeat it. The artifact is the point — a future agent or human can load the graduated skill and run the workflow without re-discovering the site from scratch.

The Browserbase article (2026-05-08) frames this as the cure for browser-agent amnesia: every run today re-pays the discovery tax forever; autobrowse pays it once and writes the answer down.

## When to use

- **Hidden / undocumented JSON APIs** that show in network traffic but not on the rendered page.
- **Heavy client-side rendering** where content only appears after a sequence of interactions.
- **Multi-step login or wizard flows** where the right path isn't obvious from the first screen.
- **Any UI where the shortest reliable path is non-trivial enough that a human reverse-engineering it would take a couple of hours.**
- **Captcha / anti-bot-gated pages** that local Playwright fails on (use Browserbase here).

## When NOT to use (anti-patterns / hard rules)

These are non-negotiable. Surfaced as Red flags below.

1. **Deterministic parsing.** The article's $24 lesson: 167-row static HTML state catalog, no JS / no auth / no anti-bot. Four autobrowse iterations later, the loop still hadn't returned all 167 rows in one output (per-turn output cap kept truncating reasoning). ~200 lines of `fetch + BeautifulSoup` did it in sub-second runtime, zero inference cost. Reach for autobrowse only after the cheaper deterministic options have given up.
2. **Real-account live iteration.** Don't iterate 5x against a real-account / real-charges / single-session context (e.g., a logged-in Resy on someone's actual machine). Iterate against a throwaway Browserbase session or a test account; replay the converged skill against the real account once.
3. **Graduating on iteration 1.** One success ≠ converged. Graduation requires ≥2 iterations with `strategy.md` evidence that the second beat the first (or held flat at lower cost).
4. **Commits without `chunk-checkpoint`.** A graduated skill is a chunk boundary. Run `chunk-checkpoint` before any commit lands in git.

## Workflow

### Step 1: Lock objective

Hand the agent one task on one site, in one sentence. Concrete enough that "did it work" is unambiguous. Examples: "book a 7pm dinner reservation at this restaurant on OpenTable," "return all listings on the Craigslist apartments page in city X matching query Y."

If the task can't be stated in one sentence with an unambiguous "did it work" check, decompose first. Vague objectives compound across iterations and never converge.

### Step 2: Cost gate

Before any browser session fires, decide whether the runtime cost is bounded enough to iterate. The gate has two inputs: runtime (`playwright` = local, free per session; `browserbase` = cloud, paid past free tier) and an estimated per-run inference cost (Claude tokens × $/token).

The hard threshold is `$0.50/run` on Browserbase. Above that, the iter-cap drops from 5 to 2 (hard). Playwright runs skip the gate (no session cost; only inference cost matters, and the iter-cap of 5 still applies).

```bash # autobrowse-step-2-cost-gate-impl
# Side-effect-free cost-gate primitive. Returns PASS or BLOCK on stdout, exit 0 or 1.
# Args: $1 = runtime ("playwright" or "browserbase"), $2 = estimated_cost_usd (e.g. "0.45")
autobrowse_cost_gate() {
    local runtime="$1"
    local cost="$2"
    local threshold="0.50"

    if [ "$runtime" = "playwright" ]; then
        echo "PASS:playwright-no-session-cost"
        return 0
    fi

    local exceeds
    exceeds=$(awk -v c="$cost" -v t="$threshold" 'BEGIN{print (c+0 > t+0) ? "1" : "0"}')
    if [ "$exceeds" = "1" ]; then
        echo "BLOCK:browserbase-cost-${cost}-exceeds-${threshold}"
        return 1
    fi
    echo "PASS:browserbase-cost-${cost}-under-${threshold}"
    return 0
}
```

When the gate returns `BLOCK`, surface the threshold to the operator inline (`Cost gate fired at $X — drop iter-cap to 2 or stop entirely?`) and wait. Don't override silently.

### Step 3: Fetch-before-browse probe

Before spawning a browser, check whether the site has a usable JSON API the frontend itself calls. Most modern web apps are thin clients over a backend HTTP API; if you can replicate what the JS does (auth headers, endpoint paths), you skip the browser entirely. Concrete benchmark from the Craigslist case study: $0.22/run + 71s (browser path) → $0.12/run + 27s (API path).

Three discovery moves, in order:

1. **WebSearch `<site> unofficial API`** — popular sites have GitHub clients. Recency of last release tells you if the API is stable.
2. **Network tab** — open the site, log in, click around. Filter requests by the site's API subdomain. Copy one auth header. Replay with curl.
3. **Frontend bundle** — search the JS for `api_key`, `authorization`, fetch URLs. Static credentials get embedded; per-user tokens come from login flows.

If any move yields a usable endpoint, write a deterministic fetch path and graduate that as the SKILL.md `recommended_method: api`. Fall back to the browser path only if all three probes fail.

### Step 4: Iterate ≤5 with strategy.md

Run the task end-to-end. After each iteration, append observations to `strategy.md` in the working directory: what worked, what broke, what to try next, what to stop doing. On the next iteration, **read `strategy.md` first** as context — improvements compound instead of resetting.

Hard cap: 5 iterations on Playwright runs, 2 iterations on Browserbase runs that tripped the cost gate. The cap exists because, per the article, the goal is reliable + cheap, not theoretically optimal.

Each iteration records one line in `strategy.md`:

```
iter-N | cost=$X.XX | turns=N | outcome=success|partial|fail | notes=...
```

### Step 5: Convergence check

After each iteration past the first, run the convergence helper. It returns `CONVERGED` when consecutive iterations stop yielding meaningful improvement (<10% delta on both cost and turn count); `DIVERGED` when cost is climbing (>10% worse than the prior iteration) — that's a stop-and-reconsider signal, not a continue signal; `CONTINUE` otherwise.

```bash # autobrowse-step-5-convergence-impl
# Side-effect-free convergence-detection primitive.
# Args: cost,turns pairs in iteration order, e.g. "0.22,71" "0.18,55" "0.12,27"
autobrowse_convergence_check() {
    if [ "$#" -lt 2 ]; then
        echo "CONTINUE:need-at-least-2-iterations"
        return 0
    fi
    local last="${@: -1}"
    local prev="${@: -2:1}"
    local last_cost prev_cost last_turns prev_turns
    last_cost=$(echo "$last" | cut -d',' -f1)
    last_turns=$(echo "$last" | cut -d',' -f2)
    prev_cost=$(echo "$prev" | cut -d',' -f1)
    prev_turns=$(echo "$prev" | cut -d',' -f2)

    local diverging
    diverging=$(awk -v l="$last_cost" -v p="$prev_cost" 'BEGIN{print (l+0 > p*1.10) ? "1" : "0"}')
    if [ "$diverging" = "1" ]; then
        echo "DIVERGED:cost-${prev_cost}-to-${last_cost}"
        return 1
    fi

    local cost_delta turns_delta converged
    cost_delta=$(awk -v l="$last_cost" -v p="$prev_cost" 'BEGIN{p=p+0; if (p==0) print 1; else print (p-l)/p}')
    turns_delta=$(awk -v l="$last_turns" -v p="$prev_turns" 'BEGIN{p=p+0; if (p==0) print 1; else print (p-l)/p}')
    converged=$(awk -v c="$cost_delta" -v t="$turns_delta" 'BEGIN{print (c+0 < 0.10 && t+0 < 0.10) ? "1" : "0"}')
    if [ "$converged" = "1" ]; then
        echo "CONVERGED:cost-delta-${cost_delta}-turns-delta-${turns_delta}"
        return 0
    fi
    echo "CONTINUE:still-improving"
    return 0
}
```

`CONVERGED` short-circuits the loop. `DIVERGED` is a discipline trigger: stop and ask whether the strategy needs a different approach, not another iteration on the same one.

### Step 6: Graduate SKILL.md

Write a new skill at `~/.claude/skills/<site>-<verb>-<object>/SKILL.md`. Naming: kebab-case, names the site + the action, e.g., `craigslist-search-listings`, `opentable-book-reservation`. Required frontmatter:

```yaml
---
name: <site>-<verb>-<object>
description: Use when ... (≤150 chars, third-person, triggering conditions only)
runtime: playwright | browserbase
target_url: https://<site>/...
last_validated: YYYY-MM-DD
---
```

Body: the converged workflow as numbered steps, the deterministic glue (selectors, helper scripts, fetch URLs, auth header shapes), and a `## Replay` section showing the cost + turn count of the converged run. **Hard rule: do not graduate after iteration 1.** The 7-step workflow exists to verify the path is reliable; one success isn't reliability evidence.

### Step 7: Handoff

Run the graduated skill in a fresh Claude Code session against the same target. Compare cost + turn count against the first-run baseline; the replay must beat it (`replay_cost < first_run_cost`) or the skill is not actually converged.

Then invoke `chunk-checkpoint` to verify the chunk and draft the commit. **Hard rule: no commits without chunk-checkpoint.** The graduated skill is a substrate that downstream agents will execute; it earns the same verification gate as any other code change.

After `chunk-checkpoint` completes, route the graduation into the wiki. Source the `# autobrowse-step-7-payload-impl` block below from disk (per memory pattern `source-sigil-from-disk-not-skill-render`), then call:

```
autobrowse_format_capture_payload "$GRADUATED_SKILL_MD" "$STRATEGY_MD" "$PROJECT_SLUG"
```

`$GRADUATED_SKILL_MD` is the just-graduated `~/.claude/skills/<slug>/SKILL.md`; `$STRATEGY_MD` is the working-dir `strategy.md` from the iterate-to-converge run; `$PROJECT_SLUG` is the active project (e.g. `claude-code-setup`). The orchestrator emits a labeled-payload string with 9 fields — `skill_name`, `graduated_path`, `runtime`, `target_url`, `iteration_count`, `first_run_cost`, `first_run_turns`, `replay_run_cost`, `replay_run_turns` — plus a `project:` tag.

Pass that payload to the `capture-learning` skill (Skill tool, args = the orchestrator's stdout). capture-learning routes the win to `~/Documents/brain/wiki/coding-log/wins/<project>/<skill-name>-graduation.md` via `category: win` in the wiki frontmatter — no new enum value, no schema change. The drafter renders the labeled fields into the standard wiki-win body (What graduated / Iteration evidence / Replay-run cost delta / Related). **Hard rule: no graduation without capture-learning.** A graduated skill that doesn't file a wins entry is invisible to future runs and to skill-lint.

```bash # autobrowse-step-7-payload-impl
# Side-effect-free graduation-payload formatter. Emits a labeled key/value
# payload that capture-learning's drafter expands into a wiki-win body.
# Args:
#   $1 = path to graduated SKILL.md (~/.claude/skills/<slug>/SKILL.md)
#   $2 = path to working-dir strategy.md
#   $3 = project slug (e.g. "claude-code-setup")

# Extract one frontmatter field value from a SKILL.md. Reads only the first
# frontmatter block (between the first two `---` lines).
autobrowse_skill_field() {
    local skill_md="${1:-}"
    local field="${2:-}"
    if [ -z "$skill_md" ] || [ -z "$field" ]; then return 1; fi
    awk -v f="$field" '
        /^---$/ { in_fm++; if (in_fm == 2) exit; next }
        in_fm == 1 && match($0, "^"f"[[:space:]]*:[[:space:]]*") {
            val = substr($0, RLENGTH + 1)
            sub(/[[:space:]]+$/, "", val)
            print val
            exit
        }
    ' "$skill_md"
}

# Parse iter-N lines from strategy.md and emit 5 labeled fields:
#   iteration_count, first_run_cost, first_run_turns, replay_run_cost, replay_run_turns.
# Line shape: 'iter-N | cost=$X.XX | turns=M | outcome=... | notes=...'
# first_run_* = iter-1 line; replay_run_* = the last iter-N line in the file.
autobrowse_strategy_parse() {
    local strategy_md="${1:-}"
    if [ -z "$strategy_md" ] || [ ! -f "$strategy_md" ]; then return 1; fi
    local iter_lines count first last
    iter_lines=$(grep -E '^iter-[0-9]+[[:space:]]*\|' "$strategy_md" 2>/dev/null || true)
    if [ -z "$iter_lines" ]; then
        echo "iteration_count: 0"
        echo "first_run_cost:"
        echo "first_run_turns:"
        echo "replay_run_cost:"
        echo "replay_run_turns:"
        return 0
    fi
    count=$(printf '%s\n' "$iter_lines" | wc -l | tr -d ' ')
    first=$(printf '%s\n' "$iter_lines" | head -n 1)
    last=$(printf '%s\n' "$iter_lines" | tail -n 1)
    local first_cost first_turns last_cost last_turns
    first_cost=$(printf '%s' "$first" | grep -oE 'cost=\$[0-9.]+' | sed 's/^cost=//' | head -n 1)
    first_turns=$(printf '%s' "$first" | grep -oE 'turns=[0-9]+' | sed 's/^turns=//' | head -n 1)
    last_cost=$(printf '%s' "$last" | grep -oE 'cost=\$[0-9.]+' | sed 's/^cost=//' | head -n 1)
    last_turns=$(printf '%s' "$last" | grep -oE 'turns=[0-9]+' | sed 's/^turns=//' | head -n 1)
    echo "iteration_count: $count"
    echo "first_run_cost: $first_cost"
    echo "first_run_turns: $first_turns"
    echo "replay_run_cost: $last_cost"
    echo "replay_run_turns: $last_turns"
}

# Orchestrator: produce the labeled 9-field capture-learning payload.
autobrowse_format_capture_payload() {
    local skill_md="${1:-}"
    local strategy_md="${2:-}"
    local project="${3:-}"
    local skill_name runtime target_url
    skill_name=$(basename "$(dirname "$skill_md")")
    runtime=$(autobrowse_skill_field "$skill_md" "runtime")
    target_url=$(autobrowse_skill_field "$skill_md" "target_url")
    cat <<PAYLOAD
project: $project
skill_name: $skill_name
graduated_path: $skill_md
runtime: $runtime
target_url: $target_url
PAYLOAD
    autobrowse_strategy_parse "$strategy_md"
}
```

## Hard rules

- **Don't autobrowse on deterministic-parsing tasks.** The article's $24 lesson — pivot to fetch + BeautifulSoup.
- **Don't iterate against a real-account / single-session real-charges context.** Throwaway Browserbase or test account only.
- **Don't graduate on iteration 1.** Minimum 2 iterations with strategy.md evidence.
- **Don't commit without chunk-checkpoint.** Graduated skills are substrate; they earn the gate.
- **Don't override the cost gate silently.** Surface the threshold trip to the operator; wait for the call.

## Common mistakes

- **Skipping Step 3 (fetch-before-browse).** Selection bias straight to browser. Most modern sites have a thin-client + JSON API shape; a 30-min spike against `api.<site>.com` can replace weeks of selector cascade.
- **Letting `strategy.md` drift.** If iter N+1 doesn't read iter N's notes first, improvements don't compound and the loop is just N independent runs that never converge.
- **Confusing `DIVERGED` with `CONTINUE`.** Cost climbing across iterations means the strategy is wrong, not that one more iter will fix it. Stop and reconsider.
- **Graduating on the happy path only.** A skill that works on the easy case but breaks on a real edge case isn't graduated — it's a draft. Add an edge-case check before writing `last_validated:`.
- **Burying the cost gate trip.** A silent override of the $0.50 threshold means the cap was never the cap.

## Red flags

- "Just one more iteration."
- "It worked once, ship it."
- "I'll skip the API probe; the page rendered fine in the snapshot."
- "The cost is climbing but I think iter 5 will get there."
- "I'll commit before chunk-checkpoint, it's just a skill file."

**All of these mean: stop, re-read this skill, decide whether to reset the loop or graduate as-is.**

## Sister patterns

- `wiki/concepts/fetch-before-browse-discipline.md` — Step 3's full taxonomy.
- `wiki/concepts/real-browser-driver-defeats-commercial-anti-bot.md` — when fetch-before-browse fails and you need a real browser, why headless Chromium loses to real Safari / Browserbase Stagehand.
- `memory/patterns/fenced-bash-block-sigil-for-skill-testability.md` — the sigil pattern this skill uses; tests can `awk`-extract the two `# autobrowse-step-N-impl` blocks and `eval` them.
