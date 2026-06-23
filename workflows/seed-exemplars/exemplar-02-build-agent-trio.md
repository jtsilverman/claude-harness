# Exemplar 02: build-agent trio (new-files chunk)

**Shape:** new doc-only files (no runtime code); three lockstep files sharing a byte-identical body.

## recall

Surfaced: byte-identical body pattern for multi-variant agent files (frontmatter differs,
body must be lockstep). The key footgun: editing one file and forgetting the others.
Also surfaced: autoload cost compounds -- keep the body lean; each rule pointer should
reference the canonical file, not restate the rule inline.

## RED (failing test)

Wrote `specs/scripts/three-loop-rebuild-c4-acceptance.sh` pinning:
- all three files exist (build-agent.md / build-agent-light.md / build-agent-heavy.md)
- bodies are byte-identical after stripping frontmatter (sha-256 check)
- body contains each required section (recall / RED / GREEN / capture-DRAFT-ONLY)
- frontmatter differs (model/effort per tier)

Ran the script: EXIT=1, all 5 structural checks FAILED. RED for the right reason:
the files do not exist yet.

## GREEN (minimal implementation)

Created all three files. Body written once; pasted byte-identically into all three.
Frontmatter set per tier: base (opus/xhigh), light (sonnet/high), heavy (opus/xhigh).
Ran the acceptance script: all checks PASS. GREEN.

## REFACTOR

No pre-existing build-agent files existed. Scanned for any stale stub or placeholder
in agents/ that the new files superseded -- found none. Suite green, no deletions.

## What made this a clean chunk

- recall caught the lockstep footgun before writing a single line
- RED script tested structural shape, not just file existence (sha-256 body-parity check)
- GREEN was write-once-paste-three: no drift between the three bodies
- REFACTOR found nothing dead -- net-new files, no obsoleted code
- Commit message named "agents/build-agent{,-light,-heavy}.md" and the behavior shift
