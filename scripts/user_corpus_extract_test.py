#!/usr/bin/env python3
"""RED test for the raw all-the operator-message corpus extractor (coo-cockpit-upgrades, chunk MSG-EXTRACT).

Run: python3 scripts/user_corpus_extract_test.py   (exit 0 = all pass, 1 = any fail)

What this pins
--------------
A NEW `scripts/user_corpus_extract.py` is a deterministic CLI that captures ALL
of the operator's (the user's) messages from one session into the RAW tier of the
mock-the operator corpus, so nothing the operator says is ever lost. It is NOT the curated
distillation and does NOT classify/label (that is a separate LLM job).

CLI contract (mirrors scripts/session_digest.py):
    python scripts/user_corpus_extract.py <session-dir>
  - <session-dir> is the session DIR; the main log is the SIBLING
    <parent>/<basename>.jsonl (the exact layout session_digest.py consumes).
  - Output: appends/writes a per-session raw corpus file at
    coo/voice-corpus-raw/<session-id>.md (the script mkdir -p's that dir; it is
    read-only against everything else).
  - No-arg invocation exits 2 with a usage message.
  - Empty / missing / no-user-messages dir exits 0, no crash, no bogus file.

The output file path is repo-relative (coo/voice-corpus-raw/<id>.md), so every
case runs the CLI with cwd set to a throwaway temp repo root (CWD=) and reads
the resulting file from <cwd>/coo/voice-corpus-raw/<session-id>.md. That keeps
the test from writing into the real repo.

Genuine-the operator-message filter (verified against live transcripts in
~/.claude/projects/-Users-admin--claude/*.jsonl):
  user-type events arrive in several content shapes; ONLY one is a real the operator
  message:
    * content is a plain str of human prose  -> KEEP (e.g. "resume",
      "lets keep the context clearing ...").
    * content is a str starting with '<'     -> EXCLUDE (slash-command /
      harness artifacts: <local-command-caveat>, <command-name>,
      <task-notification>, <system-reminder>).
    * content is a list with a tool_result block -> EXCLUDE (tool output
      returned to Claude, arrives as role:user).
    * content is a list of only text blocks   -> EXCLUDE (skill SKILL.md
      bodies / "[Request interrupted by user]" injected by the harness).
  assistant- and system-type events are never the operator messages.

The full acceptance contract (all five criteria) is pinned below, each by an
independent assertion / case, so an implementation that satisfies only the
first criterion cannot pass.

  AC1 -- a transcript with K genuine the operator messages interleaved with assistant
         messages, tool_result-as-user blocks, and a <system-reminder> payload
         yields a corpus file with EXACTLY K entries, the K human messages, in
         CHRONOLOGICAL order, excluding the assistant / tool_result / reminder
         noise.
  AC2 -- each entry carries the FULL untruncated the operator message text + a
         chronological index + the immediately-preceding ASSISTANT message as a
         labeled context preview (or '(none)' for a session-opening message).
  AC3 -- dedup by session id: running twice on the SAME session yields the same
         single file with K entries (not 2K); a DIFFERENT session id writes a
         SEPARATE file.
  AC4 -- robustness: empty / no-user-message dir -> exit 0, no crash, no
         malformed corpus file; no-arg invocation -> exit 2 with usage.
  AC5 -- a live run on an ACTUAL session dir under
         ~/.claude/projects/-Users-admin--claude/ produces a corpus-raw file
         whose entries are recognizably the operator prose, NOT tool noise (no
         <system-reminder> / tool_result block leaks in).

These cases pin the SHIPPED behavior (GREEN): the module exists, the CLI writes
the corpus file, and every assertion below holds. At RED time (before the module
existed) each case failed with a missing-module signal -- the feature absent,
which was the right reason to fail.

The script is driven via subprocess (the exact CLI the acceptance criteria
invoke), so the test asserts externally visible behavior -- the written file
contents and exit code -- not internal function names the implementer is free
to choose.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "user_corpus_extract.py")

CASES = []


def case(name, fn):
    CASES.append((name, fn))


def expect(cond, detail):
    if not cond:
        raise AssertionError(detail)


def run_extract(session_dir, cwd, extra_args=None):
    """Invoke the CLI exactly as the acceptance criteria do.

    cwd is the repo root the corpus file is written relative to
    (coo/voice-corpus-raw/<id>.md is resolved against cwd). Returns
    (returncode, stdout, stderr).
    """
    argv = [sys.executable, SCRIPT]
    if session_dir is not None:
        argv.append(session_dir)
    if extra_args:
        argv.extend(extra_args)
    proc = subprocess.run(argv, capture_output=True, text=True, cwd=cwd)
    return proc.returncode, proc.stdout, proc.stderr


def corpus_path(cwd, session_id):
    return os.path.join(cwd, "coo", "voice-corpus-raw", session_id + ".md")


# --- fixture builders (real production jsonl shapes) ------------------------

def _user_str(text):
    """A genuine the operator message: content is a plain prose string."""
    return {"type": "user", "message": {"role": "user", "content": text}}


def _user_tool_result(tool_id, text):
    """A tool result returned to Claude -- arrives as role:user. EXCLUDE."""
    return {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": tool_id, "content": text}
            ],
        },
    }


def _user_str_tagged(tag_payload):
    """A harness/slash-command artifact: a str starting with '<'. EXCLUDE.

    Covers <system-reminder>, <command-name>, <local-command-caveat>, etc.
    """
    return {"type": "user", "message": {"role": "user", "content": tag_payload}}


def _assistant_text(text):
    """One assistant message event (prose). The CONTEXT source for AC2."""
    return {
        "type": "assistant",
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
    }


def _user_attachment(text):
    """A genuine the operator message that pastes an attachment: a content LIST with an
    image/document block alongside text. KEEP (capture the text)."""
    return {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "data": "x"}},
                {"type": "text", "text": text},
            ],
        },
    }


def _user_text_list(text):
    """A harness injection: a content LIST of ONLY text blocks (a skill body /
    interrupt). EXCLUDE -- the operator's own prose arrives as a string, never a text list."""
    return {
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    }


def _assistant_tool_only():
    """An assistant turn that is ONLY a tool call (no prose). The context scan must
    preserve it (a marker), not render the following the operator message as '(none)'."""
    return {
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "tu_x", "name": "Bash", "input": {}}],
        },
    }


def _write_jsonl(path, events):
    with open(path, "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")


def _make_repo():
    """A throwaway repo root the CLI writes coo/voice-corpus-raw/ into."""
    return tempfile.mkdtemp()


def _make_session(repo, session_id, events):
    """Lay out the session DIR + sibling <id>.jsonl inside `repo` and write events.

    Returns the session DIR path (the CLI argument). Mirrors the
    session_digest.py layout: the main log is a SIBLING of the dir.
    """
    base = os.path.join(repo, "sessions")
    os.makedirs(base, exist_ok=True)
    main_jsonl = os.path.join(base, session_id + ".jsonl")
    session_dir = os.path.join(base, session_id)
    os.makedirs(os.path.join(session_dir, "subagents"), exist_ok=True)
    _write_jsonl(main_jsonl, events)
    return session_dir


# Five genuine the operator messages, interleaved with noise. The exact prose is the
# acceptance contract's "K human messages"; sentinels make order checkable.
JAKE_MSGS = [
    "JAKE_0 lets build the raw corpus extractor",
    "JAKE_1 not quite what i mean, keep all my messages",
    "JAKE_2 sounds good do it in parallel",
    "JAKE_3 wait hold on, finish the spec first",
    "JAKE_4 yes ship it",
]


def _interleaved_events():
    """Main-log events: K the operator messages interleaved with assistant / tool_result
    / <system-reminder> noise, in TRUE chronological line order.

    Line order:
      [0] JAKE_0                  (session-opening the operator message -> context '(none)')
      [1] assistant ASSIST_0
      [2] JAKE_1                  (preceded by assistant ASSIST_0)
      [3] tool_result (noise)
      [4] assistant ASSIST_1
      [5] JAKE_2                  (preceded by assistant ASSIST_1)
      [6] <system-reminder> str  (noise)
      [7] assistant ASSIST_2
      [8] JAKE_3                  (preceded by assistant ASSIST_2)
      [9] list-of-text user       (skill-body injection noise)
      [10] assistant ASSIST_3
      [11] JAKE_4                 (preceded by assistant ASSIST_3)
    """
    return [
        _user_str(JAKE_MSGS[0]),
        _assistant_text("ASSIST_0 here is my plan"),
        _user_str(JAKE_MSGS[1]),
        _user_tool_result("toolu_a", "tool output 12345 not jake prose"),
        _assistant_text("ASSIST_1 understood, doing it"),
        _user_str(JAKE_MSGS[2]),
        _user_str_tagged("<system-reminder>do not surface this as a the operator message</system-reminder>"),
        _assistant_text("ASSIST_2 spec first then ship"),
        _user_str(JAKE_MSGS[3]),
        {"type": "user", "message": {"role": "user", "content": [
            {"type": "text", "text": "Base directory for this skill: /x\n# Skill body injected by harness"}]}},
        _assistant_text("ASSIST_3 shipping now"),
        _user_str(JAKE_MSGS[4]),
    ]


def _entry_count(text):
    """Count corpus entries by how many the operator-message sentinels survived.

    Counts only the JAKE_n sentinels (the genuine messages). Noise sentinels
    (ASSIST_n appears only as CONTEXT previews, tool output, reminders) are
    NOT entry markers, so this counts ENTRIES, not substring hits.
    """
    return sum(1 for m in JAKE_MSGS if m in text)


# --- AC1: K genuine messages, in order, excluding all noise ----------------

def _ac1_k_entries_in_order_excluding_noise():
    repo = _make_repo()
    try:
        sid = "11111111-2222-3333-4444-555555555555"
        session_dir = _make_session(repo, sid, _interleaved_events())
        rc, out, err = run_extract(session_dir, cwd=repo)
        expect(rc == 0, f"exit {rc} on a real session dir; stderr={err!r}")
        path = corpus_path(repo, sid)
        expect(os.path.exists(path),
               f"corpus file not written at coo/voice-corpus-raw/{sid}.md; stdout={out!r} stderr={err!r}")
        text = open(path).read()

        # EXACTLY K entries -- all five the operator messages present.
        present = [m for m in JAKE_MSGS if m in text]
        expect(len(present) == len(JAKE_MSGS),
               f"all {len(JAKE_MSGS)} genuine the operator messages must appear; missing: "
               f"{[m for m in JAKE_MSGS if m not in text]}")

        # CHRONOLOGICAL order: the five the operator sentinels appear in line order.
        positions = [text.find(m) for m in JAKE_MSGS]
        expect(positions == sorted(positions),
               f"the operator messages must be in chronological order; got positions {positions}")

        # EXCLUSIONS: tool_result output, the system-reminder payload, and the
        # skill-body injection must NOT appear as their own entries / content.
        expect("tool output 12345" not in text,
               f"tool_result-as-user content leaked into the corpus: {text!r}")
        expect("do not surface this as a the operator message" not in text,
               f"<system-reminder> payload leaked into the corpus: {text!r}")
        expect("Skill body injected by harness" not in text,
               f"list-of-text harness injection leaked into the corpus: {text!r}")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


case("AC1: K genuine the operator messages, chronological, excluding assistant/tool_result/system-reminder",
     _ac1_k_entries_in_order_excluding_noise)


# --- AC2: full text + chronological index + preceding-assistant context -----

def _ac2_entry_carries_full_text_index_and_context():
    repo = _make_repo()
    try:
        sid = "22222222-3333-4444-5555-666666666666"
        # A long the operator message proves text is FULL (untruncated). Make it well
        # over any plausible preview cap (~500 chars) so a truncate-the-body
        # implementation fails.
        long_tail = "WORD " * 400  # ~2000 chars
        long_msg = "JAKE_LONG opening message " + long_tail + "END_OF_JAKE_LONG"
        events = [
            _user_str(long_msg),                 # session-opening -> context '(none)'
            _assistant_text("ASSIST_CTX this is the assistant turn jake replied to"),
            _user_str("JAKE_REPLY responding to the assistant"),
        ]
        session_dir = _make_session(repo, sid, events)
        rc, out, err = run_extract(session_dir, cwd=repo)
        expect(rc == 0, f"exit {rc}; stderr={err!r}")
        path = corpus_path(repo, sid)
        expect(os.path.exists(path), f"corpus file not written; stdout={out!r} stderr={err!r}")
        text = open(path).read()

        # FULL untruncated text: both the head AND the far tail of the long
        # message must survive (a 500-char-truncated body would drop END_OF_JAKE_LONG).
        expect("JAKE_LONG opening message" in text,
               f"opening of the long the operator message missing: {text[:300]!r}")
        expect("END_OF_JAKE_LONG" in text,
               "the END of the long the operator message is missing -- the entry text was "
               "TRUNCATED; the raw tier must store the FULL untruncated message")

        # CHRONOLOGICAL index: each entry carries an index. Pin that the two
        # entries carry distinct, ordered indices (0/1 or 1/2). We look for the
        # two consecutive integers appearing in the file with the opener's index
        # before the reply's index. Assert by position of the sentinels and that
        # at least two distinct index-looking tokens precede them in order.
        i_open = text.find("JAKE_LONG opening message")
        i_reply = text.find("JAKE_REPLY responding")
        expect(i_open >= 0 and i_reply >= 0, "both entries must be present for the index check")
        expect(i_open < i_reply, "entries must be stored in chronological order (opener before reply)")
        # The reply's index must differ from the opener's: the substring between
        # the two entries must contain a digit (the reply's chronological index/
        # timestamp marker) so the entries are individually addressable.
        between = text[i_open:i_reply]
        expect(any(ch.isdigit() for ch in between),
               f"each entry must carry a chronological index/timestamp; none found "
               f"between the two entries: {between!r}")

        # CONTEXT preview, labeled: the session-OPENING message has no preceding
        # assistant -> its context must be '(none)'.
        expect("(none)" in text,
               "the session-opening the operator message must record its preceding-assistant "
               "context as '(none)' (it opened the session)")
        # The REPLY's context preview must carry the preceding assistant message.
        expect("ASSIST_CTX this is the assistant turn jake replied to" in text,
               "the reply entry must carry its immediately-preceding ASSISTANT message "
               "as the context preview (so a later reader knows what the operator replied to)")
        # And that context must be LABELED (a 'context'/'preceding' marker), not
        # silently dumped -- case-insensitive substring check.
        low = text.lower()
        expect(("context" in low) or ("preceding" in low) or ("replying to" in low),
               "the preceding-assistant context must be LABELED (e.g. 'Context:' / "
               f"'Preceding assistant:'); no label marker found in: {text!r}")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


case("AC2: entry carries FULL untruncated text + chronological index + labeled preceding-assistant context (or (none))",
     _ac2_entry_carries_full_text_index_and_context)


# --- AC3: dedup by session id (rerun idempotent; distinct id -> distinct file) -

def _ac3_dedup_by_session_id():
    repo = _make_repo()
    try:
        sid = "33333333-4444-5555-6666-777777777777"
        session_dir = _make_session(repo, sid, _interleaved_events())

        # First run.
        rc1, out1, err1 = run_extract(session_dir, cwd=repo)
        expect(rc1 == 0, f"first run exit {rc1}; stderr={err1!r}")
        path = corpus_path(repo, sid)
        expect(os.path.exists(path), f"first run did not write the corpus file; stderr={err1!r}")
        first = open(path).read()
        expect(_entry_count(first) == len(JAKE_MSGS),
               f"first run should have {len(JAKE_MSGS)} entries, got {_entry_count(first)}")

        # Second run on the SAME session -> must NOT duplicate (skip-if-exists or
        # idempotent rewrite). Either way the entry count stays K, never 2K.
        rc2, out2, err2 = run_extract(session_dir, cwd=repo)
        expect(rc2 == 0, f"second run exit {rc2}; stderr={err2!r}")
        second = open(path).read()
        expect(_entry_count(second) == len(JAKE_MSGS),
               f"re-running on the same session must NOT duplicate entries: expected "
               f"{len(JAKE_MSGS)}, got {_entry_count(second)} (2x would be "
               f"{2 * len(JAKE_MSGS)})")

        # Exactly one file for this session id (no per-run suffix files).
        produced = glob.glob(os.path.join(repo, "coo", "voice-corpus-raw", "*.md"))
        expect(len(produced) == 1,
               f"dedup-by-session-id should keep ONE file for one session, got {produced!r}")

        # A DIFFERENT session id writes a SEPARATE file (does not overwrite).
        sid2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        session_dir2 = _make_session(repo, sid2, [_user_str("JAKE_OTHER different session msg")])
        rc3, out3, err3 = run_extract(session_dir2, cwd=repo)
        expect(rc3 == 0, f"different-session run exit {rc3}; stderr={err3!r}")
        path2 = corpus_path(repo, sid2)
        expect(os.path.exists(path2),
               "a different session id must write its own SEPARATE corpus file")
        expect(os.path.exists(path),
               "writing a different session's file must not delete the first session's file")
        expect("JAKE_OTHER different session msg" in open(path2).read(),
               "the second session's file must contain the second session's message")
        expect("JAKE_OTHER" not in open(path).read(),
               "the first session's file must NOT contain the second session's message")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


case("AC3: dedup keyed on session id (rerun idempotent; distinct id -> distinct file)",
     _ac3_dedup_by_session_id)


# --- AC4a: empty / no-user-message dir -> exit 0, no crash, no bogus file ----

def _ac4_empty_and_no_user_messages_exit0_no_file():
    repo = _make_repo()
    try:
        # (a) A dir whose sibling jsonl has NO genuine user messages (only an
        # assistant turn + a tool_result) -> exit 0, no crash, no corpus file
        # (or an empty-marker file, which must NOT contain bogus content).
        sid = "00000000-0000-0000-0000-000000000000"
        events = [
            _assistant_text("ASSIST only, no jake here"),
            _user_tool_result("toolu_z", "tool noise only"),
        ]
        session_dir = _make_session(repo, sid, events)
        rc, out, err = run_extract(session_dir, cwd=repo)
        expect(rc == 0, f"no-user-message dir must exit 0, got {rc}; stderr={err!r}")
        path = corpus_path(repo, sid)
        if os.path.exists(path):
            # An empty-marker file is allowed, but it must NOT carry tool noise
            # or assistant prose masquerading as the operator content.
            body = open(path).read()
            expect("tool noise only" not in body and "ASSIST only" not in body,
                   f"no-user-message dir produced a BOGUS corpus file with non-the operator "
                   f"content: {body!r}")

        # (b) A genuinely empty / nonexistent dir -> exit 0, no crash, no file.
        missing = os.path.join(repo, "sessions", "does-not-exist")
        rc2, out2, err2 = run_extract(missing, cwd=repo)
        expect(rc2 == 0, f"missing dir must exit 0, got {rc2}; stderr={err2!r}")
        expect(not os.path.exists(corpus_path(repo, "does-not-exist")),
               "missing dir must not write a bogus corpus file")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


case("AC4a: empty / no-user-message / missing dir -> exit 0, no crash, no bogus file",
     _ac4_empty_and_no_user_messages_exit0_no_file)


# --- AC4b: no-arg invocation -> exit 2 with usage (session_digest contract) --

def _ac4_no_arg_exits_2_with_usage():
    repo = _make_repo()
    try:
        rc, out, err = run_extract(None, cwd=repo)
        expect(rc == 2,
               f"no-arg invocation must exit 2 (mirror session_digest.py), got {rc}; "
               f"stdout={out!r} stderr={err!r}")
        combined = (out + err).lower()
        expect("usage" in combined,
               f"no-arg invocation must print a usage message, got stdout={out!r} stderr={err!r}")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


case("AC4b: no-arg invocation -> exit 2 with a usage message",
     _ac4_no_arg_exits_2_with_usage)


# --- AC5: live run on an ACTUAL session dir -> recognizably-the operator prose --------
# Driven against a copy of a REAL transcript from
# ~/.claude/projects/-Users-admin--claude/ so the filter is proven on
# production data, not just invented fixtures. Skips (does not fail) if no real
# transcript is reachable from this worktree, so the suite stays runnable in
# isolation -- but when a real transcript IS present (the live-verify path), it
# asserts the output is the operator prose and free of tool / system-reminder noise.

def _real_transcript_with_user_strings():
    """Find a real <id>.jsonl whose sibling <id>/ dir exists AND that contains at
    least one genuine the operator-prose user message (content is a str not starting with
    '<'). Returns (session_dir, session_id, [jake_str, ...]) or None."""
    candidates = sorted(
        glob.glob(os.path.expanduser(
            "~/.claude/projects/-Users-admin--claude/*.jsonl")),
        key=os.path.getmtime, reverse=True,
    )
    for jsonl in candidates:
        sid = os.path.basename(jsonl)[:-len(".jsonl")]
        session_dir = jsonl[:-len(".jsonl")]
        if not os.path.isdir(session_dir):
            continue
        jake = []
        try:
            with open(jsonl) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except (ValueError, TypeError):
                        continue
                    if ev.get("type") != "user":
                        continue
                    c = ev.get("message", {}).get("content")
                    if isinstance(c, str) and c.strip() and not c.lstrip().startswith("<"):
                        jake.append(c.strip())
        except OSError:
            continue
        if jake:
            return session_dir, sid, jake
    return None


def _ac5_live_real_session_yields_jake_prose():
    found = _real_transcript_with_user_strings()
    if not found:
        print("    (AC5 skipped: no real transcript with the operator-prose messages reachable)")
        return
    session_dir, sid, jake = found
    repo = _make_repo()
    try:
        rc, out, err = run_extract(session_dir, cwd=repo)
        expect(rc == 0, f"live run on a real session dir must exit 0, got {rc}; stderr={err!r}")
        path = corpus_path(repo, sid)
        expect(os.path.exists(path),
               f"live run must write coo/voice-corpus-raw/{sid}.md; stdout={out!r} stderr={err!r}")
        text = open(path).read()
        # At least one recognizably-the operator message from the real log must appear.
        hit = any((j[:60] in text) for j in jake)
        expect(hit,
               "the live corpus file must contain at least one recognizably-the operator "
               "message from the real transcript; none of the real user-prose "
               "messages were found in the output")
        # Tool / harness noise must NOT leak: no system-reminder payload tags and
        # no tool_result JSON block markers in the corpus body.
        expect("<system-reminder>" not in text,
               "a <system-reminder> payload leaked into the live corpus file (tool/"
               "harness noise must be excluded)")
        expect('"type": "tool_result"' not in text and '"tool_result"' not in text,
               "a tool_result block leaked into the live corpus file (tool output "
               "must be excluded)")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


case("AC5: live run on a real ~/.claude session dir yields the operator prose, not tool noise",
     _ac5_live_real_session_yields_jake_prose)


def _fix_attachment_list_kept_text_list_excluded():
    """FIX (Sonnet P2): a genuine the operator message that arrives as a content list with
    an attachment (image + text) must be KEPT with its text captured; a pure-text
    list (a harness skill-body injection) must still be EXCLUDED."""
    repo = _make_repo()
    try:
        sid = "attach-1111-2222-3333-444444444444"
        events = [
            _assistant_text("here is the plan"),
            _user_attachment("JAKE_ATTACH look at this screenshot"),
            _user_text_list("Base directory for this skill: /x\n# injected skill body"),
        ]
        session_dir = _make_session(repo, sid, events)
        rc, out, err = run_extract(session_dir, cwd=repo)
        expect(rc == 0, f"exit {rc}; stderr={err!r}")
        text = open(corpus_path(repo, sid)).read()
        expect("JAKE_ATTACH look at this screenshot" in text,
               f"a the operator attachment message (list with image + text) must be KEPT; corpus={text!r}")
        expect("injected skill body" not in text,
               f"a pure-text list (harness skill-body injection) must be EXCLUDED; corpus={text!r}")
        expect(text.count("## Entry ") == 1,
               f"exactly 1 genuine the operator message (the attachment) expected; got {text.count('## Entry ')}")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


case("FIX(sonnet-P2): list-with-attachment KEPT (text captured); pure-text list EXCLUDED",
     _fix_attachment_list_kept_text_list_excluded)


def _fix_tool_only_preceding_context_preserved():
    """FIX (Codex P2): when the assistant turn immediately before the operator's message is
    tool-only (no prose), the context must be PRESERVED as a marker, not silently
    rendered '(none)' (which would lose the signal that an assistant turn occurred)."""
    repo = _make_repo()
    try:
        sid = "toolonly-1111-2222-3333-444444444444"
        events = [
            _assistant_tool_only(),
            _user_str("JAKE_AFTER_TOOL responding after a tool call"),
        ]
        session_dir = _make_session(repo, sid, events)
        rc, out, err = run_extract(session_dir, cwd=repo)
        expect(rc == 0, f"exit {rc}; stderr={err!r}")
        text = open(corpus_path(repo, sid)).read()
        expect("JAKE_AFTER_TOOL responding after a tool call" in text,
               f"the the operator message must be captured; corpus={text!r}")
        ctx_line = next((ln for ln in text.splitlines()
                         if ln.startswith("**Preceding assistant context:**")), "")
        expect("(none)" not in ctx_line,
               f"tool-only preceding turn must be preserved, not rendered '(none)'; ctx={ctx_line!r}")
        expect("tool call" in ctx_line.lower(),
               f"the tool-only preceding turn should be marked as a tool call; ctx={ctx_line!r}")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


case("FIX(codex-P2): tool-only preceding assistant turn preserved in context (not '(none)')",
     _fix_tool_only_preceding_context_preserved)


def main():
    failures = 0
    for name, fn in CASES:
        try:
            fn()
            print(f"[PASS] {name}")
        except AssertionError as e:
            print(f"[FAIL] {name}: {e}")
            failures += 1
        except Exception as e:  # a crashing body reports + continues
            print(f"[ERROR] {name}: {type(e).__name__}: {e}")
            failures += 1
    total = len(CASES)
    print(f"\n{total - failures}/{total} passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
