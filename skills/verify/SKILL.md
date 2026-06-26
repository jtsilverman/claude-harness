---
name: verify
description: Use to live-verify a change by driving the REAL system and observing actual behavior, not just running pytest. Invoked by the build loop's live-verify gate for runnable surfaces (endpoint, UI, CLI, hook, external system), or on demand to confirm a fix works end-to-end. Drives the real thing like a user would, observes the actual side effect, reports observed-vs-expected. The false-success guard with teeth: verify state change, not the agent's self-report.
---

# Verify

Live end-to-end verification. Mechanical tests on crafted payloads are not sufficient for code that touches a real surface -- two shipped hook bugs passed 40+ mechanical tests and surfaced only live. Drive the real system; observe the real side effect.

## When it fires

Gated by change shape. Runnable surface -- an endpoint, a UI, a CLI, a hook, an external integration -- gets live verification. Pure logic with no runnable surface gets pytest only and skips this.

## Steps

1. **Identify the real invocation.** What does a user actually do to trigger this? The real command, the real endpoint call, the real UI action, the real hook event. Not a crafted stub.
2. **Drive it for real.** Start the app / hit the endpoint / run the command / fire the hook event against a safe-but-real target. Use an isolated throwaway config for hook-registration spikes -- never the live `~/.claude/settings.json`.
3. **Observe the actual side effect.** Did the file change, the row write, the email send, the branch block, the endpoint respond with the real shape? Look at the real output/state, not a log line claiming success.
4. **Report observed-vs-expected.** State what you drove, what you observed, and whether it matches the spec's acceptance criteria. A mismatch is a finding. If live testing is genuinely impractical, say so explicitly and name where it gets exercised instead; never a bare "exercised downstream."

## The discipline

Verify state change, not self-report. "It should work" and "the test passed" are not live evidence. Crafted-payload green does not imply live green. The whole point is to catch the gap between what the unit test asserts and what the real environment does.
