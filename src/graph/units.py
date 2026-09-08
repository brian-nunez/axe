"""Skill files in, unit briefs out — and the cross-check that runs at second zero.

A skill file declares its own tool binding in front matter so the file and the
binding cannot drift. Two declarations of one fact drift unless something
compares them, so `enter_fixture` compares them for every unit before any work:
every name must resolve to a tool the MCP server actually served (plus
`finish_unit`, which the leaf graph provides and no server serves), and the set
must equal the inventory's binding table for that unit.

This is the cheapest failure in the design and it catches the most expensive
class — a typo in a skill file that a four-hour run discovers on unit nineteen.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .state import UnitBrief

# src/graph/<file> -> the repository root is two levels up.
REPO = Path(__file__).resolve().parents[2]
SKILLS = REPO / "skills"

# `finish_unit` is provided by the leaf graph, not by the MCP server. Resolving
# front matter against the served set alone fails every skill file at second zero.
GRAPH_PROVIDED = {"finish_unit"}

# One answering tool, not five. A screen that named its own answerer was not
# enough for a small model carrying momentum from the screen before, and the one
# screen where the wrong call cannot be recovered from is the results screen —
# see the note on `ANSWER_TOOL` in `fixture/tools.js`.
IGT_BINDING = {
    "check_ledger",
    "igt_start",
    "igt_current",
    "igt_answer",
    "page_state_warning",
    "finish_unit",
}

MANUAL_BASE = {"check_ledger", "find_elements", "describe_element", "add_manual_issue", "finish_unit"}

# What each page state test adds to the base four, from the tool inventory.
MANUAL_EXTRAS: dict[int, set[str]] = {
    1: {"observe_page_activity", "operate_element"},
    2: set(),
    3: {"tab_through_focusables", "operate_element"},
    4: {
        "tab_through_focusables",
        "probe_focus_effects",
        "operate_element",
        "change_setting",
        "check_accessible_name",
        "check_text_contrast",
    },
    5: {"check_text_contrast", "check_link_in_text_distinction"},
    6: set(),
    7: {"check_autocomplete_purpose"},
    8: {"operate_element"},
    9: {"capture_under", "check_reflow"},
    10: set(),
    11: set(),
    12: {"check_table_semantics", "check_sort_state"},
    13: set(),
    14: {"probe_single_key_shortcuts", "operate_element"},
    15: {"probe_pointer_alternatives", "observe_page_activity"},
    16: {"check_target_size", "read_test_results"},
}

# Budgets, not measurements. The first full run against a real page replaces
# them, and an `exhausted` disposition is the signal that one is wrong.
MAX_STEPS = {"igt": 80, "manual": 60, "manual:4": 120, "manual:12": 100, "held_back": 2}


def read_skill_file(path: Path) -> tuple[dict[str, Any], str]:
    """Front matter and body. The body is what the leaf reads; the front matter
    is the contract this module checks."""
    text = path.read_text()
    if not text.startswith("---"):
        raise ValueError(f"{path} has no front matter")
    _, raw, body = text.split("---", 2)
    return yaml.safe_load(raw) or {}, body.strip()


def igt_skill_path(category: str) -> Path:
    """One shared procedure serving all seven is a legitimate outcome of this
    lookup; a category that needs its own file gets one by existing."""
    specific = SKILLS / "igt" / f"{category.lower().replace(' ', '-')}.md"
    return specific if specific.exists() else SKILLS / "igt" / "procedure.md"


def igt_unit(category: str) -> UnitBrief:
    path = igt_skill_path(category)
    front, _ = read_skill_file(path)
    return UnitBrief(
        unit_id=f"igt:{category.lower().replace(' ', '-')}",
        kind="igt",
        skill_path=path,
        tools=tuple(front.get("tools", ())),
        max_steps=MAX_STEPS["igt"],
        held_back=False,
        visual_signoff=front.get("visualSignoff", "not-required"),
        subject=category,
    )


def manual_unit(test: int) -> UnitBrief:
    matches = sorted((SKILLS / "page-state").glob(f"{test}-*.md"))
    if not matches:
        raise FileNotFoundError(f"no skill file for page state test {test} in {SKILLS / 'page-state'}")
    front, _ = read_skill_file(matches[0])
    held_back = front.get("status") == "held-back"
    return UnitBrief(
        unit_id=f"manual:{test}",
        kind="manual",
        skill_path=matches[0],
        tools=tuple(front.get("tools", ())),
        max_steps=MAX_STEPS["held_back"]
        if held_back
        else MAX_STEPS.get(f"manual:{test}", MAX_STEPS["manual"]),
        held_back=held_back,
        visual_signoff=front.get("visualSignoff", "not-required"),
        subject=f"{test} — {front.get('name', matches[0].stem)}",
    )


def expected_binding(unit: UnitBrief) -> set[str]:
    if unit.kind == "igt":
        return IGT_BINDING
    if unit.held_back:
        return {"finish_unit"}
    test = int(unit.unit_id.split(":")[1])
    return MANUAL_BASE | MANUAL_EXTRAS[test]


def validate_bindings(units: list[UnitBrief], served: set[str]) -> list[str]:
    """Every front matter name against the served set plus `finish_unit`, and the
    whole set against the inventory's table. Returns the problems, empty when
    there are none."""
    problems: list[str] = []
    resolvable = served | GRAPH_PROVIDED
    for unit in units:
        declared = set(unit.tools)
        if not declared:
            problems.append(f"{unit.unit_id}: {unit.skill_path.name} declares no tools")
            continue
        unknown = sorted(declared - resolvable)
        if unknown:
            problems.append(
                f"{unit.unit_id}: {unit.skill_path.name} names {', '.join(unknown)}, "
                f"which the MCP server does not serve"
            )
        expected = expected_binding(unit)
        if declared != expected:
            missing = sorted(expected - declared)
            extra = sorted(declared - expected)
            problems.append(
                f"{unit.unit_id}: {unit.skill_path.name} declares a binding the inventory does "
                f"not: missing {missing or 'nothing'}, unexpected {extra or 'nothing'}"
            )
    return problems


def v0_queue() -> list[UnitBrief]:
    """The two units v0 runs: one IGT and one page state test.

    The full run is twenty-three — seven IGT categories and all sixteen page
    state tests — and building it is a matter of extending this list, not of
    changing anything above or below it.
    """
    return [igt_unit("Structure"), manual_unit(11)]
