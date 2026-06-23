"""
Tests for chunk-4: coo-sop.md §1 installs the P6 WRITE/READ keystroke test verbatim
and deletes the two-rationalization exception list.

Acceptance contract (pipeline-meritocracy chunk 4):
  - §1 installs the P6 WRITE-gated/READ-free test VERBATIM.
  - The two-rationalization exception list is gone.
  - The rule appears once.
  - 0 em-dashes in §1.
  - The out-of-chunk hook/script/config commit path (codex-review + COMMIT-LEDGER)
    is preserved.
"""

import os
import re
import unittest

WORKTREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOP_PATH = os.path.join(WORKTREE_ROOT, "coo", "coo-sop.md")

# The P6 verbatim text (from specs/current.md § Literal processes, P6).
P6_VERBATIM = (
    "Before a Bash/Edit/commit, ask: am I WRITING a build artifact "
    "(code/test/skill/impl-doc edit or commit)? If yes -> dispatch a worker, "
    "do not type it. Am I only READING/RUNNING to learn the state (a suite run, "
    "a diff, a script)? If yes -> do it; observation bypasses no gate. WRITE is "
    "gated; READ is free."
)


def _read_sop():
    with open(SOP_PATH, encoding="utf-8") as f:
        return f.read()


def _section_1_text(text):
    """Return the body of '## 1. The COO's lane' up to the next top-level '## '."""
    m = re.search(r"^## 1\. The COO's lane\b", text, re.MULTILINE)
    assert m, "Could not find '## 1. The COO's lane' heading"
    start = m.start()
    nxt = re.search(r"^## (?!1\.)", text[m.end():], re.MULTILINE)
    end = m.end() + nxt.start() if nxt else len(text)
    return text[start:end]


class TestP6VerbatimInstalled(unittest.TestCase):
    def test_p6_verbatim_present(self):
        text = _read_sop()
        self.assertIn(
            P6_VERBATIM,
            text,
            "coo-sop.md §1 must install the P6 WRITE/READ test VERBATIM.",
        )

    def test_p6_appears_once(self):
        text = _read_sop()
        # Anchor on the distinctive closing clause to count occurrences of the rule.
        anchor = "WRITE is gated; READ is free."
        self.assertEqual(
            text.count(anchor),
            1,
            f"The P6 rule must appear exactly once; found {text.count(anchor)}.",
        )


class TestTwoRationalizationExceptionListGone(unittest.TestCase):
    def test_two_rationalizations_prose_removed(self):
        sec = _section_1_text(_read_sop())
        self.assertNotIn(
            "Two rationalizations this gate explicitly closes",
            sec,
            "The two-rationalization exception list must be deleted from §1.",
        )


class TestNoEmDashesInSection1(unittest.TestCase):
    def test_no_em_dashes(self):
        sec = _section_1_text(_read_sop())
        self.assertNotIn("—", sec, "§1 must contain 0 em-dashes.")


class TestOutOfChunkCommitPathPreserved(unittest.TestCase):
    def test_codex_review_and_commit_ledger_path_preserved(self):
        sec = _section_1_text(_read_sop())
        self.assertIn(
            "COMMIT-LEDGER",
            sec,
            "The out-of-chunk hook/script/config commit path (COMMIT-LEDGER receipt) "
            "must be preserved in §1.",
        )
        self.assertIn(
            "codex review",
            sec,
            "The out-of-chunk commit path must still reference the codex review gate.",
        )


if __name__ == "__main__":
    unittest.main()
