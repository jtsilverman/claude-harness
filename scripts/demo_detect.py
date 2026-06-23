#!/usr/bin/env python3
"""demo_detect.py -- the CEO-demo PUSH detection primitive (ceo-demo-layer ch 3).

The mechanical, directly-testable half of the cockpit's PUSH demo lifeline. The
cockpit's `## Merge` handler, right after it flips the board to `merged` and
before it re-ticks, asks: did that merge just complete a CEO-demo milestone's
FULL trigger chunk set, and has that milestone NOT already fired? This module
answers that with a pure function over the spec text plus the persisted
fired-milestone set -- the same codec shape as exec_state.parse_execution_state
(spec text -> board) and runnable_set.runnable_set (board -> what to act on).
The fire / sole-write demos/<slug>/M<n>.md / surface-the-FYI half is Claude
orchestration in skills/cockpit/SKILL.md, not here (detection stays separate
from fire mechanics so it is directly unit-testable).

A milestone is one row of the spec's `## CEO demo plan` section. Two table
shapes are supported:

  - 5-column table (the shape used by specs/current.md as of 2026-06-06):
        | Milestone | Trigger chunks | What + how | Shows | Fork? |
    The Milestone cell carries the explicit `M<n>` id (e.g. "M1 -- label").
    Trigger ids come from column 1 (Trigger chunks); fork from column 4 (Fork?).

  - 4-column table (the original suggested form):
        | Trigger chunks | What + how | What it shows | Fork? |
    No Milestone column; id is positional (1-based over data rows).
    Trigger ids come from column 0; fork from column 3.

  - Bullet form:
        - **M<n>** | trigger: 1, 2 | what+how: ... | shows: ... | **fork**.
    Literal id in cell 0; triggers in cell 1; fork is the last cell.

This module reads two columns from each row: the trigger chunk ids (whose
completion fires the demo) and the fork flavor (show-and-tell vs direction-fork
-- carried through so the cockpit can rise a vision prompt on a direction-fork;
NOT validated against a closed enum, because the flavor is per-milestone
judgment, not a fixed allowed-value list).

THE EXACTLY-ONCE INVARIANT: a milestone is `due` on the tick where its full
trigger set first reaches `merged`, but NEVER again -- the cockpit persists the
fired ids and passes them in, and a milestone already in that set is skipped.
A partially-merged trigger set is not due (every trigger id must be `merged`).
An absent `## CEO demo plan` section yields no milestones -> [] -> a clean
no-op (the cockpit fires nothing on specs with no demo plan).
"""
import datetime
import os
import re

from exec_state import parse_execution_state
from runnable_set import MERGED


def _runlog(msg):
    """Append a timestamped progress line to DEMO_DETECT_RUNLOG. No-op if unset."""
    path = os.environ.get("DEMO_DETECT_RUNLOG")
    if not path:
        return
    ts = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    with open(path, "a") as f:
        f.write(f"{ts} {msg}\n")

HEADING = "## CEO demo plan"

# Body of the ## CEO demo plan section: everything between its heading and the
# next `## ` heading (or end of file). Same section-capture shape exec_state
# uses for ## Execution state. The heading literal is sourced from HEADING (one
# definition, no drift between the constant and the regex).
_SECTION = re.compile(
    rf"^{re.escape(HEADING)}[ \t]*\n(.*?)(?=\n## |\Z)", re.M | re.S
)

# An explicit milestone id cell: a leading `- ` (bullet rows) and/or surrounding
# `**` bold are optional, then `M<n>` with one or more digits (multi-digit ids
# like M10 are read literally, never synthesized from a positional counter).
_MID = re.compile(r"^(?:-\s*)?\*{0,2}(M\d+)\*{0,2}$")

# An optional leading label on the trigger cell: `trigger:` or `trigger chunks:`
# (case-insensitive), stripped before the bare ids are read.
_TRIGGER_LABEL = re.compile(r"^\s*trigger(?:\s+chunks)?\s*:\s*", re.I)


def _split_row(line):
    """Split a markdown table/bullet row into its cell strings, tolerant of
    optional leading/trailing pipes. Returns [] for a line that is not a
    pipe-delimited row."""
    s = line.strip()
    if "|" not in s:
        return []
    s = s.strip("|")
    return [cell.strip() for cell in s.split("|")]


def _is_separator(cells):
    """True for a markdown header-separator row (cells are all dashes/colons)."""
    return bool(cells) and all(set(c) <= set("-: ") and "-" in c for c in cells)


def _milestone_id(cell):
    """The literal `M<n>` id from a first cell, or None if the cell is not an
    explicit milestone id. Tolerates a leading `- ` and surrounding `**` bold,
    e.g. '- **M1**' -> 'M1', '**M10**' -> 'M10', '1, 2' -> None."""
    m = _MID.match(cell.strip())
    return m.group(1) if m else None


def _trigger_ids(cell):
    """The bare chunk ids in a trigger cell, e.g. 'trigger: 1, 2' -> ['1', '2'],
    or set notation '{7, 8, 9}' -> ['7', '8', '9'] and '{12}' -> ['12']. Strips
    an optional leading `trigger:` / `trigger chunks:` label, then splits on
    commas, whitespace, and `{}` braces; drops empties. Brace tolerance matters
    because a demo plan written with set notation ({12}, {7, 8, 9}) would
    otherwise yield brace-laden tokens ('{12}', '{7') that never match the clean
    board ids, so no milestone would ever fire."""
    cell = _TRIGGER_LABEL.sub("", cell.strip())
    return [tok for tok in re.split(r"[,\s{}]+", cell.strip()) if tok]


def due_milestones(spec_text, fired_ids):
    """Milestones of spec_text's ## CEO demo plan that are due to fire NOW.

    A milestone is due iff every chunk id in its trigger cell has status
    `merged` on the ## Execution state board AND its own `M<n>` id is NOT in
    fired_ids. Returns a list (document order) of
    {"id": "M<n>", "triggers": [ids], "fork": <fork-cell text>}; the cockpit
    uses `triggers`/`fork` to draft the demo and to rise a vision prompt on a
    direction-fork. Absent section -> []. A row with no trigger ids never fires
    (an empty trigger set is treated as not-yet-complete, never as
    vacuously-done).

    Three legal row shapes are parsed:

      - BULLET form -- `- **M<n>** | trigger: 1, 2 | what+how: ... | shows: ... |
        **fork** .` The first cell is the LITERAL `M<n>` id (read verbatim, so a
        multi-digit M10 is M10, never a positional M4); the trigger cell carries
        a `trigger:` / `trigger chunks:` label that is stripped before the ids
        are read; the fork flavor is the LAST cell. No header/separator row.

      - 5-column TABLE form (used by specs/current.md):
        `| Milestone | Trigger chunks | What + how | Shows | Fork? |` with a
        `|---|` separator. The Milestone cell carries the explicit `M<n>` id
        (e.g. "M1 -- label"); triggers come from column 1; fork from column 4.
        Detected when the header row's first cell is "Milestone" (case-insensitive).

      - 4-column TABLE form (original suggested form):
        `| trigger chunks | what+how | shows | fork? |` with a `|---|` separator.
        No Milestone column; the `M<n>` id is positional (1-based over data rows);
        triggers come from column 0; fork from column 3.

    A row is BULLET iff its first cell is an explicit `M<n>` id; otherwise it is
    treated as TABLE (header skipped). The italic caption line under the heading
    and blank lines carry no `|` and are ignored.
    """
    _runlog("demo_detect: due_milestones start")
    m = _SECTION.search(spec_text)
    if not m:
        _runlog("demo_detect: due_milestones done, no CEO demo plan section")
        return []

    merged = {
        e["id"] for e in parse_execution_state(spec_text) if e["status"] == MERGED
    }

    due = []
    table_index = 0  # 1-based positional id over TABLE data rows only (4-col only)
    seen_table_header = False
    table_has_milestone_col = False  # True for 5-col tables with a leading Milestone column
    for line in m.group(1).splitlines():
        cells = _split_row(line)
        if not cells:
            continue
        if _is_separator(cells):
            continue

        mid = _milestone_id(cells[0])
        if mid is not None:
            # BULLET row: literal id in cell 0, trigger in cell 1, fork is last.
            # A well-formed milestone carries at least id | trigger | fork, so a
            # row with < 3 cells is malformed -- skip it (and never let cells[-1]
            # collapse onto the trigger cell as a phantom fork).
            if len(cells) < 3:
                continue
            triggers = _trigger_ids(cells[1])
            fork = cells[-1].strip()
        else:
            # TABLE row: skip the one column-header row, then id is positional
            # (4-col) or read from the Milestone column (5-col).
            if not seen_table_header:
                seen_table_header = True
                # Detect 5-col table: first header cell is "Milestone".
                table_has_milestone_col = cells[0].strip().lower() == "milestone"
                continue
            if table_has_milestone_col:
                # 5-col: | Milestone | Trigger chunks | What + how | Shows | Fork? |
                # Extract the M<n> id from the leading Milestone cell (e.g. "M1 -- label").
                id_match = re.match(r"(M\d+)", cells[0].strip())
                if id_match is None:
                    continue
                mid = id_match.group(1)
                triggers = _trigger_ids(cells[1]) if len(cells) > 1 else []
                fork = cells[4].strip() if len(cells) > 4 else ""
            else:
                # 4-col: | Trigger chunks | What + how | What it shows | Fork? |
                table_index += 1
                mid = f"M{table_index}"
                triggers = _trigger_ids(cells[0])
                fork = cells[3].strip() if len(cells) > 3 else ""

        if mid in fired_ids:
            continue
        if triggers and all(t in merged for t in triggers):
            due.append({"id": mid, "triggers": triggers, "fork": fork})
    _runlog(f"demo_detect: due_milestones done, due={[d['id'] for d in due]}")
    return due
