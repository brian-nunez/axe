"""A scripted leaf: the same graph, the same tools, no model.

Every tier above a leaf is deterministic by design, and proving those tiers
should not depend on a model behaving. This policy occupies the leaf's seat in
the compiled graph and produces exactly the tool calls a skill file prescribes,
in the order it prescribes them — so a run under `--leaf scripted` exercises the
identical `think`/`act` loop, step budget, ledger gates, restore, reconciliation
and draft, with the one non-deterministic component removed.

It is not a model substitute and makes no judgement. Where a skill file asks the
model to look at the page, this policy reads an **answer sheet** written for that
page state — `AXE_SCRIPT=<file>`. Without one it takes the least destructive
route through an IGT (answer "no", select nothing, pick nothing) and files
nothing on the manual path, which completes a run and finds nothing, honestly.

The answer sheet belongs to the page, not to the code: it is the operator saying
"on this page state, these are the answers", which is precisely the judgement a
model makes at runtime and a script cannot.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

import yaml
from langchain_core.messages import AIMessage, AnyMessage, ToolMessage

from .mcp import unwrap
from .state import UnitBrief


def load_script() -> dict[str, Any]:
    path = os.environ.get("AXE_SCRIPT")
    if not path:
        return {}
    return json.loads(Path(path).read_text())


def _call(name: str, args: dict[str, Any]) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": f"scripted-{uuid.uuid4().hex[:8]}"}],
    )


def _history(messages: list[AnyMessage]) -> list[tuple[str, dict[str, Any]]]:
    """Every tool result so far, oldest first, as (name, parsed envelope)."""
    return [
        (m.name, unwrap(m.content))
        for m in messages
        if isinstance(m, ToolMessage) and m.name and m.content != "accepted"
    ]


def _report(unit: UnitBrief, status: str, records: list[dict[str, Any]], subjects: int) -> str:
    test = unit.unit_id.split(":")[1]
    return yaml.safe_dump(
        {
            "test": test,
            "name": unit.subject,
            "status": status,
            "subjects": subjects,
            "records": records,
        },
        sort_keys=False,
    )


def scripted_thinker(unit: UnitBrief):
    script = load_script()

    async def igt_think(messages: list[AnyMessage]) -> AIMessage:
        history = _history(messages)
        sheet = script.get("igt", {}).get(unit.subject.lower(), {})
        questions = sheet.get("questions", {})
        per_element = sheet.get("perElement", "yes")
        multiselect = sheet.get("multiselect", [])

        if not history:
            return _call("check_ledger", {})

        name, result = history[-1]
        if not result.get("ok"):
            return _call(
                "finish_unit",
                {
                    "report": _report(
                        unit,
                        "aborted",
                        [
                            {
                                "check": "0",
                                "subject": "page",
                                "outcome": "blocked",
                                "leaf": "0.tool-refused",
                                "note": f"{name} returned {result.get('error')}: {result.get('detail')}",
                            }
                        ],
                        0,
                    )
                },
            )

        if name == "check_ledger":
            if not result["value"].get("alive"):
                return _call(
                    "finish_unit",
                    {
                        "report": _report(
                            unit,
                            "aborted",
                            [
                                {
                                    "check": "0",
                                    "subject": "page",
                                    "outcome": "blocked",
                                    "leaf": "0.ledger-lost",
                                    "note": f"check_ledger returned {result['value']['verdict']}",
                                }
                            ],
                            0,
                        )
                    },
                )
            return _call("igt_start", {"category": unit.subject})

        if isinstance(result.get("value"), dict) and result["value"].get("finished"):
            outcome = result["value"]
            records = [
                {
                    "check": f"{outcome['category'].lower()}.{index + 1}",
                    "subject": "page",
                    "outcome": "fail",
                    "leaf": f"{outcome['category'].lower()}.deque-reported",
                    "note": issue["title"],
                }
                for index, issue in enumerate(outcome.get("issues", []))
            ] or [
                {
                    "check": f"{outcome['category'].lower()}.0",
                    "subject": "page",
                    "outcome": "pass",
                    "leaf": f"{outcome['category'].lower()}.no-issues",
                }
            ]
            return _call("finish_unit", {"report": _report(unit, "complete", records, 1)})

        screen = result["value"]
        kind = screen.get("kind")
        if kind == "single_choice":
            answer = questions.get(screen["questionId"], {})
            return _call("igt_answer", {"choice": answer.get("choice", "no")})
        if kind == "per_element":
            return _call(
                "igt_answer",
                {"answers": [{"ref": group["ref"], "answer": per_element} for group in screen["groups"]]},
            )
        if kind == "element_multiselect":
            return _call("igt_answer", {"refs": list(multiselect)})
        if kind == "element_picker":
            # A picker always follows the question that opened it, so the answer
            # sheet entry for the last question asked names the elements.
            last_question = next(
                (
                    r["value"]["questionId"]
                    for _, r in reversed(history)
                    if r.get("ok") and isinstance(r.get("value"), dict) and r["value"].get("questionId")
                ),
                None,
            )
            return _call(
                "igt_answer",
                {"selectors": questions.get(last_question, {}).get("select", [])},
            )
        if kind == "results":
            return _call("igt_answer", {})

        return _call(
            "finish_unit",
            {
                "report": _report(
                    unit,
                    "aborted",
                    [
                        {
                            "check": "0",
                            "subject": "page",
                            "outcome": "blocked",
                            "leaf": "0.unknown-screen",
                            "note": f"the panel showed {kind}",
                        }
                    ],
                    0,
                )
            },
        )

    async def manual_think(messages: list[AnyMessage]) -> AIMessage:
        history = _history(messages)
        test = unit.unit_id.split(":")[1]
        sheet = script.get("manual", {}).get(test, {})
        findings: list[dict[str, Any]] = sheet.get("file", [])

        if not history:
            return _call("check_ledger", {})

        name, result = history[-1]
        if not result.get("ok") and name != "add_manual_issue":
            return _call(
                "finish_unit",
                {
                    "report": _report(
                        unit,
                        "aborted",
                        [
                            {
                                "check": f"{test}.0",
                                "subject": "page",
                                "outcome": "blocked",
                                "leaf": f"{test}.0.tool-refused",
                                "note": f"{name} returned {result.get('error')}: {result.get('detail')}",
                            }
                        ],
                        0,
                    )
                },
            )

        if name == "check_ledger":
            if not result["value"].get("alive"):
                return _call(
                    "finish_unit",
                    {
                        "report": _report(
                            unit,
                            "aborted",
                            [
                                {
                                    "check": f"{test}.0",
                                    "subject": "page",
                                    "outcome": "blocked",
                                    "leaf": f"{test}.0.ledger-lost",
                                    "note": f"check_ledger returned {result['value']['verdict']}",
                                }
                            ],
                            0,
                        )
                    },
                )
            return _call("find_elements", {"query": sheet.get("find", "body")})

        if name == "find_elements":
            if not findings:
                return _call(
                    "finish_unit",
                    {
                        "report": _report(
                            unit,
                            "complete",
                            [
                                {
                                    "check": f"{test}.0",
                                    "subject": "page",
                                    "outcome": "not-applicable",
                                    "leaf": f"{test}.0.nothing-scripted",
                                    "note": "the answer sheet names no finding for this page state",
                                }
                            ],
                            0,
                        )
                    },
                )
            return _call("describe_element", {"selector": findings[0]["selector"], "need": "text"})

        done = sum(1 for n, _ in history if n == "add_manual_issue")
        if name == "describe_element":
            return _call("add_manual_issue", findings[done])

        if name == "add_manual_issue":
            if done < len(findings):
                return _call(
                    "describe_element", {"selector": findings[done]["selector"], "need": "text"}
                )
            records = []
            for index, (finding, (_, outcome)) in enumerate(
                zip(findings, [h for h in history if h[0] == "add_manual_issue"])
            ):
                records.append(
                    {
                        "check": finding.get("check", f"{test}.{index + 1}"),
                        "subject": finding["selector"],
                        "outcome": "fail" if outcome.get("ok") else "blocked",
                        "leaf": finding.get("leaf", f"{test}.{index + 1}.scripted"),
                        **({"filed": finding["issue"]} if outcome.get("ok") else {}),
                        **(
                            {}
                            if outcome.get("ok")
                            else {"note": f"add_manual_issue returned {outcome.get('error')}"}
                        ),
                    }
                )
            return _call(
                "finish_unit", {"report": _report(unit, "complete", records, len(findings))}
            )

        return _call(
            "finish_unit",
            {
                "report": _report(
                    unit,
                    "aborted",
                    [
                        {
                            "check": f"{test}.0",
                            "subject": "page",
                            "outcome": "blocked",
                            "leaf": f"{test}.0.off-script",
                            "note": f"the policy has no next step after {name}",
                        }
                    ],
                    0,
                )
            },
        )

    return igt_think if unit.kind == "igt" else manual_think
