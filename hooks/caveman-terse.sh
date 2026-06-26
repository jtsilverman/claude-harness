#!/usr/bin/env bash
# Caveman terse-mode enforcement (UserPromptSubmit hook).
#
# Re-injects comms-discipline Rule 0 (Density) into context on EVERY user turn so
# the terse posture cannot decay over a long session -- the enforcement a passive
# autoloaded doc lacks (read once at session start, then buried by context rot).
# Modeled on the UserPromptSubmit reinforcement hook in JuliusBrussee/caveman.
#
# Output contract: a UserPromptSubmit hook injects context via
# hookSpecificOutput.additionalContext (stdout JSON, exit 0). suppressOutput keeps
# the raw JSON out of the transcript.
cat <<'JSON'
{"suppressOutput":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"CAVEMAN MODE (comms-discipline Rule 0, re-injected every turn -- obey it now): terse, high-density. Default a few lines. A status / answer / confirmation = 1-3 lines, no TLDR, no recap. Run a PRE-SEND DELETE PASS: cut every sentence that is not the answer, a decision, or evidence -- kill self-justification ('why it is better', 'cleaner'), plan/process narration ('I will hold here', 'next I will'), meta-hedges ('flagging so you can veto', 'one boundary I drew'), reasoning recaps, and restating what you just did. Fragments over sentences. Code, paths, commands, identifiers stay EXACT. Expand ONLY for a genuine tradeoff / subtle bug, or when the user asks ('explain', 'walk me through'). Brain big, mouth small."}}
JSON
