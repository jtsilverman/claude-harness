# Strategy log: espn-fetch-team-game

Autobrowse run on 2026-05-08 against ESPN scoreboard pages. Target task: given a sport (`nba` | `nhl`) and a team abbreviation, return the team's current or latest game (opponent, score, status). Iteration cap = 5; converged at iter 2.

## Iteration 1

- timestamp: 2026-05-08T20:01Z
- runtime: playwright
- approach: rendered-DOM extraction
- target: https://www.espn.com/nba/scoreboard
- turns: 4 (navigate + snapshot + 2 evaluates)
- result: SUCCESS — extracted Timberwolves vs Spurs (MIN 51, SA 51, Halftime) and Knicks vs 76ers (NY 108, PHI 94, Final)
- friction noted:
  - selector experimentation: `.Scoreboard` returned 9 weak hits with no useful text; pivoted to `li[class*="ScoreCell"]` for 8 useful hits
  - mixed class-name hierarchy: header strip uses `ScoreCell__Item`, main board uses `ScoreboardScoreCell__Item` — same data, two selector trees
  - scores are JS-injected post-render; arbitrary waits would have been brittle
  - quarter scores are positional ("23 28 51"), no labels — caller must know schema
  - body size 592KB; snapshot output was ~250 lines, mostly page chrome
  - NBA-specific: extending to NHL would require re-discovering Wild-vs-opponent selectors
- cost-shape: O(N_pages × selector-rewrites-per-sport)

## Iteration 2

- timestamp: 2026-05-08T20:03Z
- runtime: playwright (discovery) + bash/curl (converged path)
- approach: network-tab inspection + canonical-API discovery
- target: https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
- turns: 2 to verify (one curl per league)
- result: SUCCESS — both NBA and NHL endpoints return structured JSON with same shape; one curl per call, no selector parsing
  - NBA: HTTP 200, 39.6KB, 189ms, MIN 51 / SA 51 Halftime confirmed
  - NHL: HTTP 200, 47.4KB, 97ms — Wild not playing today; pattern verified via VGK @ ANA In Progress and MTL @ BUF Final
- discovery insight: ESPN's frontend uses `site.web.api.espn.com/apis/personalized/...` for streams metadata + fastcast websocket for live ticks, but the canonical scoreboard JSON lives at `site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard` (well-known unofficial endpoint). The frontend never hits that endpoint directly during page render; only third-party clients use it. Discovering it required pivoting from "what does the page call?" to "what's the documented unofficial API?"
- cost-shape: O(1) — one URL pattern works for any league ESPN covers (basketball/nba, hockey/nhl, baseball/mlb, football/nfl, basketball/wnba)
- convergence: API path is structurally cheaper AND generalizes across sports

## Convergence verdict

Graduated to API-first fetch skill at `~/.claude/skills/espn-fetch-team-game/SKILL.md`. Iter 2 is the chosen path; iter 1 (DOM) is preserved here as the alternative. Iteration cap (5) honored — converged at iter 2.

Replay-run cost: 1 turn (one curl + jq parse). First-run cost: 4 turns (iter 1 DOM probe). **replay turns (1) < first-run turns (4)** — graduating the skill saves the discovery tax on every future invocation.

## Lesson embedded

Same as `wiki/concepts/fetch-before-browse-discipline.md`: the right answer for ESPN scoreboard data is curl + the unofficial JSON endpoint, not selector cascade against the rendered DOM. The autobrowse loop's value was *discovering* the API path through honest iter-1 friction; the graduated skill encodes the discovery so future runs skip it entirely.
