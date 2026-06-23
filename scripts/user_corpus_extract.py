#!/usr/bin/env python3
"""user_corpus_extract.py -- capture ALL of the operator's messages from one session
into the RAW tier of the mock-the operator corpus.

CLI: python scripts/user_corpus_extract.py <session-dir>

  <session-dir>  The session DIR; the main log is the SIBLING
                 <parent>/<basename>.jsonl (same layout as session_digest.py).

Output: writes coo/voice-corpus-raw/<session-id>.md relative to the current
working directory.  mkdir -p is applied; the script is read-only against
everything else.

Genuine-the operator-message filter (verified against live transcripts):
  - content is a plain str of human prose AND does not start with '<'  -> KEEP
  - content is a str starting with '<'                                 -> EXCLUDE
  - content is a list with any tool_result block                       -> EXCLUDE
  - content is a list of ONLY text blocks (harness injections)         -> EXCLUDE
  - content is a list with an attachment block (the operator paste + text)     -> KEEP
  - assistant- and system-type events                                  -> never the operator

Dedup by session id: if coo/voice-corpus-raw/<id>.md already exists, skip.

Empty / missing / no-user-messages dir -> exit 0, no crash, no bogus file.
No-arg invocation -> exit 2 with usage (mirrors session_digest.py).
"""
import json
import os
import sys

CONTEXT_PREVIEW_CHARS = 500


def _message_text(event):
    """Return an event's prose text whether content is a plain string or a list of
    blocks (text blocks concatenated; non-text blocks ignored). Used both to test
    the operator messages and to render the message body + the preceding-assistant context."""
    content = event.get("message", {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _is_genuine_jake_message(event):
    """Return True iff the event is a real the operator prose message.

    the operator's plain prose arrives as a content STRING. A content LIST is genuine the operator
    ONLY when it carries an attachment (a pasted image/file): a non-text,
    non-tool_result block alongside the text. A list of ONLY text blocks is a
    harness injection (a skill body, an interrupt notice), never the operator; a list with
    a tool_result block is a tool's output handed back to Claude.
    """
    if event.get("type") != "user":
        return False
    content = event.get("message", {}).get("content")
    if isinstance(content, str):
        stripped = content.lstrip()
        # Exclude harness/slash-command artifacts that start with '<'
        return bool(stripped) and not stripped.startswith("<")
    if isinstance(content, list):
        # A tool's output handed back to Claude (tagged user) -> never the operator
        if any(
            isinstance(b, dict) and b.get("type") == "tool_result"
            for b in content
        ):
            return False
        # Keep ONLY when an attachment block is present (genuine the operator + a paste);
        # a pure-text list is a harness injection, never the operator prose.
        return any(
            isinstance(b, dict) and b.get("type") not in ("text", "tool_result")
            for b in content
        )
    return False


def _preceding_assistant_text(events, jake_idx):
    """Return context describing what the operator was responding to.

    Returns the most recent assistant TEXT before events[jake_idx], scanning back
    PAST tool-only assistant turns (a tool call carries no prose) to find it. If
    assistant turns preceded this message but none carried text, returns a marker
    so the tool-only turn is preserved, not silently rendered as "(none)". Returns
    None only when no assistant event precedes this the operator message at all.
    """
    saw_assistant = False
    for i in range(jake_idx - 1, -1, -1):
        ev = events[i]
        if ev.get("type") == "assistant":
            saw_assistant = True
            text = _message_text(ev)
            if text.strip():
                return text
        # else: skip user / tool_result noise, keep scanning back
    if saw_assistant:
        return "[preceding assistant turn(s): tool call(s), no text]"
    return None


def _parse_jsonl(path):
    """Return all user/assistant events from the JSONL file in file order."""
    events = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if event.get("type") in ("user", "assistant"):
                    events.append(event)
    except OSError:
        pass
    return events


def extract(session_dir, output_root):
    """Extract the operator's messages from session_dir, writing to output_root.

    Returns 0 on success (or graceful no-op), 2 on usage error.
    Never raises on an absent/empty/no-user-messages session.
    """
    session_dir = os.path.abspath(session_dir)
    parent = os.path.dirname(session_dir)
    session_id = os.path.basename(session_dir)
    main_jsonl = os.path.join(parent, session_id + ".jsonl")

    # Dedup by session id: skip if already extracted
    out_dir = os.path.join(output_root, "coo", "voice-corpus-raw")
    out_path = os.path.join(out_dir, session_id + ".md")
    if os.path.exists(out_path):
        return 0

    # If the sibling JSONL doesn't exist, the dir is missing/empty -> exit 0
    if not os.path.exists(main_jsonl):
        return 0

    events = _parse_jsonl(main_jsonl)

    # Collect the operator messages in chronological order with context
    entries = []
    for idx, ev in enumerate(events):
        if not _is_genuine_jake_message(ev):
            continue
        message_text = _message_text(ev)
        if not message_text.strip():
            message_text = "[attachment with no text]"
        preceding = _preceding_assistant_text(events, idx)
        entries.append((len(entries), message_text, preceding))

    # No genuine the operator messages -> exit 0, no file written
    if not entries:
        return 0

    # Build the markdown output
    os.makedirs(out_dir, exist_ok=True)
    lines = [
        f"# the operator Corpus RAW — session {session_id}\n",
        "\n",
    ]
    for entry_idx, message_text, preceding_text in entries:
        lines.append(f"## Entry {entry_idx}\n")
        lines.append("\n")
        if preceding_text is not None:
            preview = preceding_text[:CONTEXT_PREVIEW_CHARS]
            if len(preceding_text) > CONTEXT_PREVIEW_CHARS:
                preview += "..."
            lines.append(f"**Preceding assistant context:** {preview}\n")
        else:
            lines.append("**Preceding assistant context:** (none)\n")
        lines.append("\n")
        lines.append(f"{message_text}\n")
        lines.append("\n---\n\n")

    with open(out_path, "w") as f:
        f.writelines(lines)

    return 0


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: user_corpus_extract.py <session-dir>\n")
        return 2
    session_dir = argv[1]
    output_root = os.getcwd()
    return extract(session_dir, output_root)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
