"""
Test: worker-discipline.md contains a property-based testing rule.

Acceptance contract (chunk 10):
  AC1 - A PBT rule exists in the file (the text mentions property-based test)
  AC2 - It names the property-rich chunk shapes (pure function, parser,
        serializer, mathematical invariants or equivalent)
  AC3 - It names the exempt classes (CRUD and UI)
  AC4 - It is shape-gated, not tier-gated (the rule key-phrase is "shape",
        not a tier label like S/A/B/C)
  AC5 - It is framed as recommended-when-applicable, not mandated everywhere
        (uses language like "recommended" or "when applicable", not "must" or
        "required" applied unconditionally)
"""
import re
import pathlib

DISCIPLINE_PATH = pathlib.Path(__file__).parent.parent / "disciplines" / "worker-discipline.md"


def _load():
    return DISCIPLINE_PATH.read_text(encoding="utf-8").lower()


def test_pbt_rule_exists():
    """AC1: The file contains a property-based testing rule."""
    text = _load()
    assert "property-based test" in text, (
        "disciplines/worker-discipline.md has no property-based test rule. "
        "Expected text containing 'property-based test'."
    )


def test_pbt_rule_names_property_rich_shapes():
    """AC2: The rule names the property-rich chunk shapes."""
    text = _load()
    # Must name at least two of: pure function, parser, serializer, mathematical invariant
    shape_terms = ["pure function", "parser", "serializer", "mathematical invariant"]
    found = [t for t in shape_terms if t in text]
    assert len(found) >= 2, (
        f"PBT rule must name at least 2 property-rich shapes from {shape_terms}. "
        f"Found only: {found}"
    )


def test_pbt_rule_names_exempt_classes():
    """AC3: The rule names the exempt classes (CRUD and UI)."""
    text = _load()
    assert "crud" in text, (
        "PBT rule must name CRUD as an exempt class; 'crud' not found in file."
    )
    assert "ui" in text or "user interface" in text, (
        "PBT rule must name UI as an exempt class; 'ui' not found in file."
    )


def test_pbt_rule_is_shape_gated_not_tier_gated():
    """AC4: The rule is shape-gated (references chunk shape near PBT text, not just tier labels)."""
    text = _load()
    # "shape" must appear within 500 chars of "property-based test" — proximity proxy for co-location
    idx = text.find("property-based test")
    assert idx != -1, "property-based test rule not found; AC4 cannot be evaluated."
    window = text[max(0, idx - 250): idx + 500]
    assert "shape" in window, (
        "PBT rule must be shape-gated: 'shape' not found near the property-based test rule. "
        "The gate must reference chunk shape (pure function / parser / etc.), not tier (S/A/B/C)."
    )


def test_pbt_rule_is_recommended_not_mandated():
    """AC5: The rule is framed as recommended-when-applicable, not unconditionally mandated."""
    text = _load()
    recommended_terms = ["recommended", "when applicable", "where applicable", "if applicable"]
    found = [t for t in recommended_terms if t in text]
    assert found, (
        f"PBT rule must be framed as recommended-when-applicable. "
        f"None of {recommended_terms} found in the file."
    )
