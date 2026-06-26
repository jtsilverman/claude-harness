# Lessons

Distilled durable lessons. `@`-imported into `CLAUDE.md`, always in context. Appended by `/learn` (one evaluator, <=5 lessons/run). Hard cap ~100 lines; over cap merge related lines and prune lowest-value, never blind-append. One line per lesson, greppable, plain English. A lesson earns its place by pointing at a concrete failure it prevents. Front-loaded: oldest/lowest-value sinks to the bottom (middle entries get ignored).

## Working with the user

- Don't ask what you can answer: name the pick you'd make, take it, surface inline as a decision. Ask only when wrong is destructive/irreversible/scope-changing or a genuine preference call.
- When you do ask, give context: what you were doing + what you hit + options + your recommendation. Bare "X or Y?" fails.
- Clear bug with an obvious fix: just fix it (RED->GREEN), don't raise it as a decision. If your rec is "fix it" with no real alternative, it's autofix.
- Thoroughness over time: default to the most thorough option; time is not a cost to weigh. Token cost / irreversibility / blast-radius still apply.
- Trust execution calls: don't elevate operational/mechanical decisions to the user. Escalate only vision / scope / taste / a real tradeoff.
- Surface spec-documented deferrals as decisions before starting the deferred work, not as an aside.
- Before a 4+-workstream spec: name each workstream + end state, say how they relate (sequential vs parallel), get a read, THEN write.

## Discipline

- Verify external-tool invocation before asserting: confirm the call ran (trivial run / --help) before claiming a CLI worked or diagnosing a failure; never pass an unconfirmed flag.
- Calibrate verification prompts for truth: adversarial "find what's wrong" framing makes reviewer models hallucinate. Frame for truth ("no issues" is valid), require evidence per flag, adjudicate against ground truth.
- Prefer skills/prompts/human-gate over machine enforcement for quality/shape. Code only for irreversible/race-prone ops (merge engines, file-overlap, atomic writes).
- Evidence before claims, always: run it, observe output. Reading code is not testing.
- Hook-script deletion order: commit the settings.json de-registration, restart the session, THEN delete the script file. Deleting a loaded PreToolUse script in the same session triggers the missing-script deadlock (blocks ALL Bash/Write/Edit) with no in-session escape.

## Preferences

- Naming/vocabulary test: uniform (one shape) + understandable (no code knowledge needed) + convenient (greppable, short). A mixed-style proposal fails uniform.
- Don't surface LLM invocation costs unprompted (no per-call/per-sweep $ in chat or docs). Wall-clock and run-counts are fine.

## Coding patterns

Seeded 2026-06-26 from the retired 1229-file pattern store (highest-value globally-reusable lessons only). Grow via /learn; prune lowest-value when the file nears cap.

**Testing / TDD**
- Prove a new test on already-green code is non-tautological: temporarily break the targeted impl path, confirm RED for the right reason, then restore.
- A test using the implementation's own parse/regex/helper as its expected-value oracle is tautological; check against an independent hand-written literal or simpler recomputation.
- RED on a not-yet-built module: the stub's descriptive error can tautologically satisfy a substring assertion; assert the real guard's marker AND that the stub phrase ("not implemented") is absent.
- Tests against state-mutating systems (dedup windows, counters, idempotency keys) pass once then fail on rerun; clear state in setup, randomize input, or assert a range.
- pytest + pandas: `series == pytest.approx(x)` always returns False; use float equality on exact literals or `np.testing.assert_allclose` for tolerance on a Series.
- Node asserts: `assert.notMatch` does not exist and throws TypeError (crashes the suite); the negative-regex assertion is `assert.doesNotMatch`.
- MagicMock `__getattr__` never raises, so `getattr(mock,"x",None)` returns an auto-child not None and masks wrong SDK paths; isinstance-gate the leaf or set the attr to None.
- JWT/RS256 tests: build real tokens in-process with a test RSA keypair and monkeypatch only the JWKS resolver; don't mock the verifier itself.
- ESM mocking: `globalThis.fetch` is swappable per-test, but `spawnSync` and other named import bindings are read-only and need DI, not reassignment.
- Python test files: `from module import ...` does not expose that module's stdlib imports; import `json`/`os`/`re` explicitly in every test file that uses them.

**Language / runtime**
- Python: `bool` is an `int` subclass and passes `math.isfinite`/`isinstance(x,(int,float))`; reject with `isinstance(x,bool)` first, on scalars and unpacked struct fields alike.
- Python `(negative_real) ** (fractional)` returns `complex`, not a real or error; guard or use `abs`/`math.copysign` before fractional-power math on possibly-negative bases.
- macOS system Python is 3.9: `X | Y` union annotations (`float | None`) throw TypeError at runtime; use `Optional[X]` for code that may run under the system interpreter.
- `json.dumps(obj, default=str)` as a catch-all silently stringifies unexpected types and hides type errors; serialize known types explicitly, let the rest raise.
- Python subprocess killed by a signal has a negative returncode (`-signo`), not POSIX `128+signo`; convert `if rc<0: code=128+(-rc)` (SIGKILL -> 137) before reporting.
- Before making a sync function async, grep every call site: a caller reading a property off the bare return without `await` gets `undefined` and its success-gate fails open silently.
- A function with both input validation and an early-return fast-path must validate FIRST; a guard after the short-circuit is bypassed by degenerate inputs.
- Writer and reader must sanitize keys identically; if writer uses the raw key and reader applies `basename`/normalization they resolve different paths with no error, just invisible misses. Audit both sides together.
- Two parallel impls of one computation (live vs offline, train vs serve) diverge silently: a fix on one never reaches the other; grep for the mirror path before closing a fix. A model is COUPLED to the sampling cadence its features were trained on -- changing collector/sampling rate silently breaks any cadence-dependent feature (rolling-window row caps, per-step vol annualization assuming fixed dt) with no error.
- Awaiting slow upstream I/O (HTTP refresh, cache update) on a hot write/tick path is a staleness source; decouple via `asyncio.create_task` (one in flight, consume the prior task's exception before relaunch) and warm the cache once at startup.

**Claude Code harness**
- Skill routing: trigger phrases must appear verbatim in SKILL.md frontmatter `description:`; that field is the ONLY surface the harness injects for dispatch, body prose is invisible to routing.
- Config hot-reload is asymmetric: new `skills/<X>/SKILL.md` entries live-update mid-session; `settings.json` hook DE-REGISTRATION/changes only take effect at next session start (already-loaded hooks stay in memory); MCPs and agent definitions always need a fresh harness.
- `skillListingBudgetFraction = 0.01`: past ~15-25 skills the harness silently drops skill descriptions from dispatch context, making those skills invisible to routing; cap the global skill inventory under 20 with tight descriptions.
- `rules/*.md` autoloads its full body every session via whole-dir sweep and reaches subagents; it's always-in-context, so anything you don't want everywhere stays out of `rules/`.
- Edit/Write file-state cache only updates from Read/Edit/Write calls: after any Bash write (`>file`, `sed -i`, heredoc) re-Read before editing or Edit fails "File has not been read yet."
- Subagents autoload full CLAUDE.md + all `rules/` + MEMORY.md, but from the PARENT session's start-time snapshot; live edits to those docs are invisible to them until a fresh session.
- Skill testability: embed step logic in a sigil-tagged ```bash``` block and have tests awk-extract + source it from the on-disk SKILL.md (not the Skill-tool render, which corrupts `local var="$N"`).
- Hook contract: exit 2 + stderr = blocking gate; exit 0 + `hookSpecificOutput` JSON on stdout = inject/decide; a PreToolUse hook whose script is missing exits non-zero and blocks ALL Bash/Edit/Write.
- Workflow agent() needs `schema:` to travel with the call; without it the agent returns raw TEXT and every structured result key silently reads `undefined`.

**Bash / shell (macOS)**
- `rg` is often not on PATH in a non-interactive subshell -- use `grep -rl`; never `2>/dev/null` a missing-tool error or absence becomes a silent false PASS.
- `mapfile`/`readarray` is bash 4+; macOS ships bash 3.2 -- use a `while IFS= read -r` loop to fill arrays in portable hook/test scripts.
- `find ... | xargs cmd` splits on whitespace so a filename with a space is dropped; use `find -print0 | xargs -0` or `find -exec cmd {} \;`.
- `python3 - <<HEREDOC` makes the heredoc the script's stdin, so `sys.stdin.read()` is empty; pass data via env var, argv, or tempfile.
- macOS BSD sed: `|`-delimited `sed -i` throws "bad flag in substitute command"; use Python `str.replace`/awk for portable in-place edits.
- Under `set -uo pipefail`, `printf "%s" "$VAR" | grep -Fq` can false-fail exit 141 (SIGPIPE) past ~64KB; use a here-string `grep -Fq "anchor" <<<"$VAR"`.
- `$(cmd 2>&1 >/dev/null)` captures nothing: `2>&1` binds stderr to current stdout first, then `>/dev/null` discards both; capture stderr via a separate file.

**State / persistence**
- SQLite multi-write atomicity: wrap the write unit in `with conn:` so any exception rolls back all of it; validate-before-write is not atomic and helpers must be commit-free.
- `sqlite3.connect(path)` silently creates an empty DB for a missing file, so try/except around connect catches nothing; guard the FIRST query for `OperationalError: no such table`.
- SQL on ISO-timestamp TEXT compares lex order, not chrono: same-second cutoffs must match the stored offset byte-for-byte (`Z` vs `+00:00`); SQLite `datetime('now','-Ns')` is space-separated while stored ts use a `T` separator, so `WHERE ts > datetime('now',...)` lex-matches ALL rows -- use row-id/LIMIT windows for recent-row queries; bare-date is lex-safe only for half-open `[since, until)`.
- Merged to main != deployed: verify deploy state by grepping the LIVE process's source for the chunk's signature symbol + checking process start time / actual write cadence, never trust the board's "merged"; deploy COUPLED changes whole (shipping half -- e.g. cadence without its feature-window fix -- silently skews downstream).
- "Latest row per key" JOIN must repeat the date/scope filter in BOTH the inner `MAX(ts)` subquery AND the outer WHERE; omitting either lets stale rows bleed through.
- Reporting reads against a possibly-old deployed DB must degrade not crash: guard each table via `sqlite_master` and each column via `PRAGMA table_info`; tests seeded from current schema never catch drift.
- Adding a field to a durable row must default on READ (`row.field || 'default'`), not just on write; rows written by a prior version have no value and a write-only default breaks in-flight state across a deploy.

**LLM / external APIs**
- External API integration: make the first live call a multi-hypothesis `curl` probe of the actual shape, not code-on-mocks; OSS reference clients can be stale even when 3 agree.
- Verify a provider access token (Privy/OIDC/JWT) via JWKS, not an SDK: `pyjwt[crypto]` against the app's `jwks.json`, pin `algorithms` + issuer + audience.
- API 403 debug: decode the token's `roles`/`scopes` claim before trusting the error hint; validation order is near-universally auth -> scope -> schema.
- Anthropic `/v1/messages` for structured JSON: static rubric in a `cache_control:ephemeral` system array (dynamic text in `messages`), tolerant fence-stripping parse, enum validation, deterministic fallback.
- Anthropic caching/cost: the Console "not using prompt caching" nudge only checks for `cache_control` blocks, not hits; check `cache_read_input_tokens`, and the cost driver is usually request VOLUME (fanout/retries).

**Frontend**
- Vite in Docker: `import.meta.env.VITE_*` is baked into the client bundle at build time; pass values as build ARG (or write `.env`) before `npm run build`, runtime container ENV does nothing.
- Next.js `next/font/google`: the literal family name is never registered, only a hashed name; reference `var(--font-inter)` in CSS/Tailwind, not the string, or the font silently won't apply.
- vitest+jsdom on Next App Router: `usePathname()` returns null (not throws) without a provider, so branches go untested while tests pass; `vi.mock('next/navigation')` with `usePathname: vi.fn(() => '/')`.

**Mermaid**
- Mermaid label syntax: `1.`/`1)` prefixes trip the list parser (use `(N)`); `"` in `[label]` chokes v10+ parsers (quote as `["label"]`); subroutine `[[ ]]` multi-line labels go INSIDE the brackets; render to verify, grep is not parse.
- Swim-lanes: any cross-lane edge incident on a `direction LR` subgraph flips it to TB; a lane needing both cross-edges and LR must escape to another tool.
