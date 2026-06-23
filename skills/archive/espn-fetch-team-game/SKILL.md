---
name: espn-fetch-team-game
description: Fetch a team's current/latest game from ESPN's unofficial JSON scoreboard API. Args sport (nba|nhl) + team abbr (e.g. MIN). One curl call.
allowed-tools: Bash, Read
runtime: playwright
target_url: https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
last_validated: 2026-05-08
---

# espn-fetch-team-game

One-call fetch of a team's current or most-recent game from ESPN: opponent, score, status (Halftime, Final, In Progress, etc.). Graduated from an autobrowse run that discovered ESPN's unofficial scoreboard JSON endpoint. Adjacent `strategy.md` records the iter-1 (DOM) → iter-2 (API) convergence.

## When to use

- Quick check on a specific team's latest game.
- Recurring data-pull where DOM scraping ESPN's scoreboard page (592KB) is wasted bandwidth and 4+ turns.

## Sport mapping

| Arg `sport` | League | Endpoint segment |
|-------------|--------|------------------|
| nba         | NBA    | `basketball/nba` |
| nhl         | NHL    | `hockey/nhl`     |
| mlb         | MLB    | `baseball/mlb`   |
| nfl         | NFL    | `football/nfl`   |
| wnba        | WNBA   | `basketball/wnba`|

## Workflow

```bash # espn-fetch-team-game-impl
# Args: $1 = sport (nba|nhl|mlb|nfl|wnba), $2 = team abbr (case-insensitive: MIN, NY, NYY, ...)
# Output (stdout): "SHORT | STATUS | TEAM SCORE - TEAM SCORE"  on hit
#                  "(no game today for ABBR)"                   on miss
# Returns 0 on hit-or-miss (both are valid answers); 2 on bad sport arg.
espn_team_game() {
  local sport="$1"
  local team_abbr="$2"
  local seg
  case "$sport" in
    nba)  seg="basketball/nba"  ;;
    wnba) seg="basketball/wnba" ;;
    nhl)  seg="hockey/nhl"      ;;
    mlb)  seg="baseball/mlb"    ;;
    nfl)  seg="football/nfl"    ;;
    *)    echo "ERROR: unknown sport $sport (expected nba|nhl|mlb|nfl|wnba)" >&2; return 2 ;;
  esac
  local url="https://site.api.espn.com/apis/site/v2/sports/${seg}/scoreboard"
  local team_uc
  team_uc=$(echo "$team_abbr" | tr '[:lower:]' '[:upper:]')
  local out
  out=$(curl -s "$url" | jq -r --arg team "$team_uc" '
    .events[]
    | select(any(.competitions[0].competitors[]; .team.abbreviation == $team))
    | "\(.shortName) | \(.status.type.description) | \([.competitions[0].competitors[] | "\(.team.abbreviation) \(.score)"] | join(" - "))"
  ')
  if [ -n "$out" ]; then echo "$out"; else echo "(no game today for $team_uc)"; fi
}
```

## Examples

```bash
# Source the function from this SKILL.md per fenced-bash-block-sigil-for-skill-testability:
source <(awk '/^```bash # espn-fetch-team-game-impl$/,/^```$/' \
   ~/.claude/skills/espn-fetch-team-game/SKILL.md | sed '1d;$d')

espn_team_game nba MIN   # Timberwolves
espn_team_game nhl MIN   # Wild
espn_team_game mlb NYY   # Yankees
```

## Hard rules

- **Unofficial endpoint, no SLA.** ESPN can change or remove this without notice. Re-validate yearly via the autobrowse loop; bump `last_validated:` in this frontmatter on success.
- **One game per call.** Matches by team abbr against today's scoreboard. Multi-game queries (full schedule, standings) need different endpoint paths with different shapes — this skill is intentionally narrow.
- **No team-name fuzzy match.** Pass the exact ESPN team abbreviation (`MIN`, `NY`, `NYY`). Team-name string matches are not handled.
- **Read-only.** No POST, no auth, no captcha. If ESPN ever puts auth or rate-limits in front of this endpoint, the skill is dead and a fresh autobrowse run is required.

## Replay cost

Replay-run cost: 1 turn (one curl + jq parse). The autobrowse run that produced this skill cost 4 turns of DOM exploration in iter 1 + 2 turns of API verification in iter 2. **Replay turns (1) < first-run turns (4)** — every future invocation skips the discovery tax.

## Related

- `~/.claude/skills/autobrowse/SKILL.md` — the iterate→graduate loop that produced this skill.
- `~/Documents/brain/wiki/concepts/fetch-before-browse-discipline.md` — the broader principle.
