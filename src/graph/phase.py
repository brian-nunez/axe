"""A phase: pop the next unit, spawn it, restore the page, gate the ledger, route.

No model anywhere in this file. The whole job is mechanical, and putting a model
on it buys nondeterminism at exactly the points where the run is most expensive
to lose. The tools the parent tiers use are called as ordinary coroutines.

Strict sequence is a structural property rather than a convention: no `Send`, no
conditional edge returning a list of targets, and no two nodes sharing a
predecessor. Any of the three puts LangGraph into a parallel superstep, and there
is one browser and one panel.
"""

from __future__ import annotations

import textwrap
from typing import Any, Literal

import yaml
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from .leaf import FINISH_UNIT_NAME, build_leaf, leaf_payload
from .mcp import call, unwrap
from .state import RETRYABLE, Mismatch, RunState, SubAgentReport, UnitBrief
from .units import read_skill_file

# One bounded attempt per verdict per gate. A recovery that needs a second
# attempt is a run that has stopped being reproducible.
RECOVERY_BUDGET = 1

HALT_PARTIAL = {"panel-hidden", "panel-orphaned"}
HALT_VOID = {"test-lost", "issues-lost"}
RECOVERABLE = {
    "panel-elsewhere": "recover_overview",
    "panel-detached": "recover_reopen",
    "server-unreachable": "ledger_gate",
}


def ledger_baseline(ledger: dict[str, Any]) -> dict[str, Any]:
    return {
        "testId": ledger["testId"],
        "name": ledger["name"],
        "url": ledger["url"],
        "issues": dict(ledger["issues"]),
    }


def _parse_transcript(messages: list[Any]) -> dict[str, Any]:
    """The ledger half of a report: what the tools actually did, not what the
    model says they did."""
    filed: list[dict[str, Any]] = []
    verdicts: list[dict[str, Any]] = []
    errors: list[tuple[str, str]] = []
    igt_outcome: dict[str, Any] | None = None
    calls = 0

    for message in messages:
        if isinstance(message, AIMessage):
            calls += len(message.tool_calls or [])
            continue
        if not isinstance(message, ToolMessage) or message.name == FINISH_UNIT_NAME:
            continue
        result = unwrap(message.content)
        if not result.get("ok"):
            errors.append((message.name, result.get("error", "unknown")))
            continue
        value = result.get("value")
        if message.name == "add_manual_issue":
            filed.append(value)
        elif isinstance(value, dict) and value.get("finished"):
            # `igt_answer` answers a question screen and finishes the guided test
            # through one tool name, so the outcome is told by what came back
            # rather than by which tool was called. `finished` is set in exactly
            # one place — the tool layer's Finish path — and it is the only
            # evidence that Deque wrote this walk into the saved test.
            igt_outcome = value
        elif message.name.startswith("check_") and isinstance(value, dict) and "outcome" in value:
            verdicts.append(value)

    return {
        "filed": filed,
        "verdicts": verdicts,
        "tool_errors": errors,
        "igt_outcome": igt_outcome,
        "tool_calls": calls,
    }


def _parse_report(raw: str) -> Any:
    """The closing block, as the model actually delivered it.

    A model shown a fenced YAML block hands back a fenced YAML block, and often
    an indented one. Both are transport rather than content, so the fence is
    removed and the block dedented before parsing. Nothing else about it is
    touched: a report that still will not parse costs the coverage half, which
    is what the graph's `incomplete` disposition is for.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if "```" in text:
            text = text.rsplit("```", 1)[0]
    return yaml.safe_load(textwrap.dedent(text))


def _reconcile(coverage: dict[str, Any] | None, filed: list[dict[str, Any]]):
    """Two mismatch classes, both detected without trusting anybody.

    `filed:` appears in a record only after an `add_manual_issue`, so the report
    and the ledger reconcile without reading the panel.
    """
    mismatches: list[Mismatch] = []
    if coverage is None:
        return mismatches

    on_server = [entry.get("issue") for entry in filed]
    records = coverage.get("records") or []
    claimed = [r.get("filed") for r in records if isinstance(r, dict) and r.get("filed")]

    unmatched = list(on_server)
    for claim in claimed:
        if claim in unmatched:
            unmatched.remove(claim)
        else:
            # The claim did not happen. The record is re-marked rather than
            # deleted: a reviewer needs to see that the model believed it filed.
            for record in records:
                if isinstance(record, dict) and record.get("filed") == claim:
                    record["filed"] = None
                    record["unverified"] = claim
            mismatches.append(
                Mismatch("claimed_not_filed", f"the report claims {claim!r} but no tool filed it")
            )
    for orphan in unmatched:
        # A real issue is on the server and unaccounted for in coverage. An
        # unexplained entry in the ledger is worse than an explained one.
        records.append(
            {
                "check": "reconciled",
                "subject": next(
                    (e.get("selector") for e in filed if e.get("issue") == orphan), "page"
                ),
                "outcome": "fail",
                "leaf": "reconciled.unreported",
                "filed": orphan,
                "note": "filed by a tool call the unit's report did not account for",
            }
        )
        mismatches.append(
            Mismatch("filed_not_claimed", f"{orphan!r} is on the server and not in the report")
        )
    coverage["records"] = records
    return mismatches


def build_phase(kind: str, runtime):
    """`igt_phase` and `manual_phase` are the same seven nodes, one IGT-only."""

    async def dispatch(state: RunState) -> dict[str, Any]:
        mine = [unit for unit in state["queue"] if unit.kind == kind]
        if not mine:
            return {"cursor": None}
        head, *rest = mine
        keep = [unit for unit in state["queue"] if unit.kind != kind]
        return {"queue": rest + keep, "cursor": head, "attempt": 1}

    def after_dispatch(state: RunState) -> str:
        return "unit" if state.get("cursor") is not None else END

    async def unit(state: RunState) -> dict[str, Any]:
        brief: UnitBrief = state["cursor"]
        runtime.log(f"--- {brief.unit_id} (attempt {state['attempt']}) — {brief.skill_path.name}")

        _, body = read_skill_file(brief.skill_path)
        leaf = runtime.leaf_for(brief)
        config = {
            "configurable": {"thread_id": f"{runtime.run_id}/{brief.unit_id}#{state['attempt']}"},
            "recursion_limit": brief.recursion_limit,
            "run_name": brief.unit_id,
        }

        disposition = "completed"
        detail = ""
        coverage = None
        try:
            final = await leaf.ainvoke(leaf_payload(brief, body), config, durability="sync")
        except Exception as error:  # noqa: BLE001 — a leaf fault is a unit gap, not a run end
            runtime.log(f"    leaf raised: {error}")
            report = SubAgentReport(
                unit_id=brief.unit_id,
                kind=brief.kind,
                attempt=state["attempt"],
                disposition="errored",
                coverage=None,
                model_id=runtime.model_id,
                visual_signoff=brief.visual_signoff,
                detail=str(error)[:600],
            )
            return {"reports": [*state["reports"], report], "last_report": report}

        transcript = _parse_transcript(final["messages"])
        if final.get("report_yaml"):
            try:
                parsed = _parse_report(final["report_yaml"])
                coverage = parsed if isinstance(parsed, dict) else None
                if coverage is None:
                    disposition, detail = "incomplete", "the report was not a YAML mapping"
            except yaml.YAMLError as error:
                disposition, detail = "incomplete", f"the report did not parse: {error}"
        elif final.get("exhausted"):
            disposition, detail = "exhausted", f"hit the {brief.max_steps} step budget"
        else:
            disposition, detail = "incomplete", "the unit stopped without calling finish_unit"

        if coverage is not None and coverage.get("status") == "aborted":
            disposition, detail = "errored", "the unit's own report declared status: aborted"
        elif brief.held_back and disposition == "completed":
            disposition = "skipped"

        mismatches = _reconcile(coverage, transcript["filed"])
        write_errors = [e for e in transcript["tool_errors"] if e[0] == "add_manual_issue"]
        if write_errors and not transcript["filed"]:
            disposition, detail = "rejected_writes", f"every write was refused: {write_errors}"

        # An IGT that never finished wrote nothing into the saved test, whatever
        # its report says. The guided test files its issues on Finish, so a unit
        # whose walk never came back `finished` is a unit the ledger
        # records nothing for — and reporting it `completed` in the same breath
        # as `igt_abandon` is the silent under-reporting the ledger argument
        # exists against. It is also what suppressed the retry that would have
        # saved the unit: `completed` is not in RETRYABLE, so the run walked past
        # an IGT it could have run again on a clean panel.
        if brief.kind == "igt" and transcript["igt_outcome"] is None and disposition == "completed":
            disposition = "abandoned"
            detail = (
                "the guided test never reached its results screen, so Deque recorded nothing; "
                "the unit's own report describes a walk the saved test does not hold"
            )

        report = SubAgentReport(
            unit_id=brief.unit_id,
            kind=brief.kind,
            attempt=state["attempt"],
            disposition=disposition,
            coverage=coverage,
            filed=transcript["filed"],
            igt_outcome=transcript["igt_outcome"],
            verdicts=transcript["verdicts"],
            tool_errors=transcript["tool_errors"],
            reconciliation=mismatches,
            tool_calls=transcript["tool_calls"],
            model_id=runtime.model_id,
            visual_signoff=brief.visual_signoff,
            detail=detail,
        )
        runtime.log(
            f"    {disposition}: {transcript['tool_calls']} tool calls, "
            f"{len(transcript['filed'])} filed, {len(transcript['tool_errors'])} tool errors"
        )
        return {"reports": [*state["reports"], report], "last_report": report}

    def after_unit(state: RunState) -> str:
        """Cleanup only. Whether to retry is decided after the gate, not here.

        A retry is a genuinely fresh sub-agent on the same browser, so from the
        panel's point of view it is indistinguishable from the next unit — and
        every unit boundary is `cleanup → restore → gate`. An edge that jumped
        straight back to `unit` gave a retry none of it: an IGT leaf that died
        mid-test left the panel inside the guided test, and the retry's own step
        1 aborted on it before the model did anything.
        """
        brief: UnitBrief = state["cursor"]
        report: SubAgentReport = state["last_report"]
        # A held-back unit is bound no tools, so it is structurally incapable of
        # touching the page or the ledger. Checking whether it broke something is
        # theatre.
        if brief.held_back:
            return "dispatch"
        if brief.kind == "igt" and report.igt_outcome is None:
            # An unfinished IGT leaves a test *in progress*, which destroys the
            # guarantee that nothing is running when the parent restores. That is
            # as true between two attempts at one unit as it is between units:
            # `restore_page` deliberately leaves a running test alone, so without
            # this the reload lands the retry back on the same question screen.
            return "igt_abandon"
        return "restore"

    def wants_retry(state: RunState) -> bool:
        """Retry once, on a fresh thread id, only if the attempt filed nothing.

        A second attempt that re-walks the checklist files duplicates, which
        costs the reviewer time and mis-states every count on the draft.
        """
        report: SubAgentReport = state["last_report"]
        return (
            report.disposition in RETRYABLE
            and state["attempt"] == 1
            and not report.filed
            and report.igt_outcome is None
        )

    async def retry(state: RunState) -> dict[str, Any]:
        runtime.log(f"    retrying {state['cursor'].unit_id} on a fresh thread")
        return {"attempt": state["attempt"] + 1}

    async def igt_abandon(state: RunState) -> dict[str, Any]:
        result = await call(runtime.parent_tools, "save_progress_and_quit")
        runtime.log(f"    igt_abandon: {result.get('value') or result.get('error')}")
        return {}

    async def restore(state: RunState) -> dict[str, Any]:
        result = await call(runtime.parent_tools, "restore_page")
        runtime.log(f"    restore_page: {result.get('value') or result.get('detail')}")
        return {}

    async def ledger_gate(
        state: RunState,
    ) -> Command[
        Literal["advance_baseline", "recover_overview", "recover_reopen", "ledger_gate"]
    ]:
        # A halt leaves the phase with `Command(graph=Command.PARENT, goto=...)`,
        # which is resolved at runtime. `finalize` is deliberately absent from
        # the annotation: it is a node of the parent graph, and naming it here
        # would ask this graph to add an edge to a node it does not contain.
        result = await call(runtime.parent_tools, "check_ledger")
        if not result.get("ok"):
            verdict = "server-unreachable"
            ledger = None
        else:
            ledger = result["value"]
            verdict = ledger["verdict"]
        runtime.log(f"    ledger gate: {verdict}")

        update: dict[str, Any] = {"ledger": ledger}
        if verdict == "intact":
            return Command(goto="advance_baseline", update=update)
        if verdict in HALT_VOID:
            return Command(
                graph=Command.PARENT,
                goto="finalize",
                update={**update, "halt": ("void", f"{verdict} at {state['cursor'].unit_id}")},
            )
        if verdict in HALT_PARTIAL:
            return Command(
                graph=Command.PARENT,
                goto="finalize",
                update={**update, "halt": ("partial", f"{verdict} at {state['cursor'].unit_id}")},
            )

        # Keyed on the attempt, not just the unit. A retry crosses this gate a
        # second time, separated from the first by a whole sub-agent run, and
        # that is not the loop 010 forbids — the loop is
        # `gate → recover → gate → recover` at one crossing. Keying on the unit
        # alone would let this ticket's retry fix silently halve an unrelated
        # policy's budget.
        key = f"gate:{state['cursor'].unit_id}#{state['attempt']}:{verdict}"
        spent = state["recoveries"].get(key, 0)
        if spent >= RECOVERY_BUDGET:
            return Command(
                graph=Command.PARENT,
                goto="finalize",
                update={
                    **update,
                    "halt": ("partial", f"{verdict} at {state['cursor'].unit_id}, recovery spent"),
                },
            )
        update["recoveries"] = {**state["recoveries"], key: spent + 1}
        return Command(goto=RECOVERABLE[verdict], update=update)

    async def recover_overview(state: RunState) -> dict[str, Any]:
        result = await call(runtime.parent_tools, "restore_page")
        runtime.log(f"    recover_overview: {result.get('value') or result.get('detail')}")
        return {}

    async def recover_reopen(state: RunState) -> dict[str, Any]:
        result = await call(runtime.parent_tools, "reopen_saved_test")
        runtime.log(f"    recover_reopen: {result.get('value') or result.get('detail')}")
        return {}

    async def advance_baseline(state: RunState) -> Command[Literal["dispatch", "retry"]]:
        # The baseline advances on every intact gate. Otherwise issues filed
        # during the run are invisible to the comparison, and a later loss still
        # reads intact. Monotone, and only from an intact read.
        ledger = state["ledger"]
        update: dict[str, Any] = {"baseline": ledger_baseline(ledger["ledger"])}
        state["last_report"].ledger_after = "intact"

        # The retry decision lives here rather than on the edge out of `unit`.
        # *Is the ledger still there* outranks *did that test finish*, so a
        # second attempt is spent only once the panel has been cleaned, the page
        # restored and the ledger read intact — never on a panel the first
        # attempt left dirty, and never into a ledger it broke.
        if wants_retry(state):
            return Command(goto="retry", update=update)

        # Consecutive failures count units, not attempts. The cap exists to say
        # "the failure is the environment, not the tests", and a unit that failed
        # twice is still one unit; counting attempts would halt a run two units
        # earlier than the policy means to.
        failed = state["last_report"].disposition != "completed"
        consecutive = state["consecutive_failures"] + 1 if failed else 0
        update["consecutive_failures"] = consecutive
        if consecutive >= 3:
            return Command(
                graph=Command.PARENT,
                goto="finalize",
                update={**update, "halt": ("partial", "cascading_unit_failures")},
            )
        return Command(goto="dispatch", update=update)

    builder = StateGraph(RunState)
    builder.add_node("dispatch", dispatch)
    builder.add_node("unit", unit)
    builder.add_node("retry", retry)
    builder.add_node("igt_abandon", igt_abandon)
    builder.add_node("restore", restore)
    builder.add_node("ledger_gate", ledger_gate)
    builder.add_node("recover_overview", recover_overview)
    builder.add_node("recover_reopen", recover_reopen)
    builder.add_node("advance_baseline", advance_baseline)

    builder.add_edge(START, "dispatch")
    builder.add_conditional_edges("dispatch", after_dispatch, {"unit": "unit", END: END})
    builder.add_conditional_edges(
        "unit",
        after_unit,
        {"dispatch": "dispatch", "igt_abandon": "igt_abandon", "restore": "restore"},
    )
    builder.add_edge("retry", "unit")
    builder.add_edge("igt_abandon", "restore")
    builder.add_edge("restore", "ledger_gate")
    builder.add_edge("recover_overview", "ledger_gate")
    builder.add_edge("recover_reopen", "ledger_gate")
    return builder.compile()
