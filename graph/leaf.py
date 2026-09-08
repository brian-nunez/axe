"""The one tier that holds a model.

A leaf is a separately compiled graph, invoked from inside the `unit` node with a
hand-built payload — never `add_node(subgraph)`. A subgraph added as a node
shares state by channel name, and a shared channel is precisely how the last
test's element refs, screenshots and reasoning leak into the next one.

The tool binding is baked into the compiled graph rather than passed at call
time: the tool list is closed over by both the node the model sees a schema from
and the node that can actually execute. A sub-agent cannot call a tool it was not
given, because the tool is in neither place.
"""

from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable

from langchain_core.messages import AIMessage, AnyMessage, SystemMessage, ToolMessage, trim_messages
from langchain_core.messages.utils import count_tokens_approximately
from langchain_core.tools import BaseTool, tool
from langgraph.graph import END, START, StateGraph

from .mcp import unwrap
from .state import LeafState

Thinker = Callable[[list[AnyMessage]], Awaitable[AIMessage]]


@tool
def finish_unit(report: str) -> str:
    """Report this unit and stop. `report` is the closing YAML block, verbatim.

    Every `filed:` line in the report names an issue an `add_manual_issue` call in
    this unit has already returned.
    """
    return "accepted"


# The leaf graph provides this; it never reaches the browser, so it works for a
# held-back leaf that is bound nothing else.
FINISH_UNIT_NAME = finish_unit.name

WRITE_TOOL = "add_manual_issue"

# A `filed:` line is the skill file format's one claim about the ledger, and the
# only field in a record that a tool result — never the model — is the source of.
# `subject:` is read alongside it because it sits in the same record, ahead of
# `filed:`, and it is the selector the write that never happened was to carry.
FILED_CLAIM = re.compile(r"^[ \t-]*filed:[ \t]*(.+?)[ \t]*$")
SUBJECT_FIELD = re.compile(r"^[ \t-]*subject:[ \t]*(.+?)[ \t]*$")
NO_VALUE = {"null", "none", "~", "''", '""'}


def _scalar(raw: str) -> str:
    value = raw.strip()
    if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1].strip()
    return "" if value.lower() in NO_VALUE else value


def _claimed_filings(report: str) -> list[tuple[str, str]]:
    """Every `filed:` a report asserts, in order, each with its record's subject."""
    claims: list[tuple[str, str]] = []
    subject = ""
    for line in report.splitlines():
        found = SUBJECT_FIELD.match(line)
        if found:
            subject = _scalar(found.group(1))
            continue
        found = FILED_CLAIM.match(line)
        if found:
            value = _scalar(found.group(1))
            if value:
                claims.append((value, subject))
    return claims


def _filings_on_record(messages: list[AnyMessage]) -> list[str]:
    """What the write tool actually returned, read from the tool transcript."""
    filed: list[str] = []
    for message in messages:
        if not isinstance(message, ToolMessage) or message.name != WRITE_TOOL:
            continue
        result = unwrap(message.content)
        value = result.get("value")
        if result.get("ok") and isinstance(value, dict) and value.get("issue"):
            filed.append(value["issue"])
    return filed


def unbacked_claim(report: str, messages: list[AnyMessage]) -> tuple[str, str] | None:
    """The first `filed:` in the report that no call produced, with its subject.

    This is the same comparison the parent's reconciliation makes, made one turn
    earlier and for a different purpose. The parent's verdict is what reaches the
    draft and it stays exactly as strict; this one exists because a stripped
    claim is a **lost finding** — the page really does carry the failure, and the
    saved test a human opens does not say so. Catching a fabrication is not the
    same as filing the issue, and at this point in the unit the tool is still
    bound and the panel is still on the saved test.

    Read from the full transcript rather than from the model's account of it, for
    the reason the two report halves exist at all.
    """
    on_record = _filings_on_record(messages)
    for claim, subject in _claimed_filings(report):
        if claim in on_record:
            on_record.remove(claim)
        else:
            return claim, subject
    return None


def strip_stale_images(messages: list[AnyMessage]) -> list[AnyMessage]:
    """Image content is removed from every ToolMessage except the most recent.

    A screenshot is thousands of tokens, the visual tests fetch several, and a
    stale one is never re-consulted. On a small model's window that single rule
    is the difference between a visual test running and not.
    """
    newest_tool = max(
        (i for i, m in enumerate(messages) if isinstance(m, ToolMessage)),
        default=None,
    )
    trimmed: list[AnyMessage] = []
    for index, message in enumerate(messages):
        if (
            isinstance(message, ToolMessage)
            and index != newest_tool
            and isinstance(message.content, list)
        ):
            kept = [block for block in message.content if block.get("type") != "image"]
            trimmed.append(message.model_copy(update={"content": kept or "[image dropped]"}))
        else:
            trimmed.append(message)
    return trimmed


def model_thinker(model, tools: list[BaseTool], window_tokens: int) -> Thinker:
    """One `bind_tools` call per sub-agent, here and nowhere else in the run.

    `parallel_tool_calls=False` is asked for and not relied on. Hosted providers
    honour it, and so does Docker Model Runner — measured, both at bind time and
    at invoke time, and it is the difference between this model emitting one call
    a turn and emitting two. A runtime that takes the keyword at bind time and
    refuses it at invoke time would otherwise cost a unit to a provider
    capability question, so the flag is dropped for the rest of the run the first
    time it is refused — the property it asks for is enforced structurally by
    `act`, which executes one call per turn whatever the model sends.
    """
    schema = [*tools, finish_unit]
    plain = model.bind_tools(schema)
    try:
        bound = model.bind_tools(schema, parallel_tool_calls=False)
    except TypeError:
        bound = plain
    sequential_flag_accepted = bound is not plain

    async def think(messages: list[AnyMessage]) -> AIMessage:
        nonlocal sequential_flag_accepted
        # `include_system=True` is load-bearing: the system message *is* the
        # skill file, and a trim that drops it leaves the model executing a
        # procedure it can no longer read.
        window = trim_messages(
            strip_stale_images(messages),
            max_tokens=window_tokens,
            token_counter=count_tokens_approximately,
            strategy="last",
            include_system=True,
            start_on="human",
            allow_partial=False,
        )
        if sequential_flag_accepted:
            try:
                return await bound.ainvoke(window)
            except TypeError as error:
                if "parallel_tool_calls" not in str(error):
                    raise
                sequential_flag_accepted = False
        return await plain.ainvoke(window)

    return think


def build_leaf(think: Thinker, tools: list[BaseTool], max_steps: int, *, checkpointer=None):
    """Compile one leaf. Cached by binding signature by the caller."""
    by_name = {t.name: t for t in (*tools, finish_unit)}

    async def think_node(state: LeafState) -> dict[str, Any]:
        return {"messages": [await think(state["messages"])]}

    async def act_node(state: LeafState) -> dict[str, Any]:
        last = state["messages"][-1]
        calls = list(last.tool_calls)
        first, rest = calls[0], calls[1:]

        update: dict[str, Any] = {"steps": state["steps"] + 1}
        messages: list[AnyMessage] = []

        if first["name"] == FINISH_UNIT_NAME:
            raw = first.get("args", {}).get("report", "")
            report = raw if isinstance(raw, str) else json.dumps(raw)
            # One hand-back, and only one. A recovery that needs a second attempt
            # is a unit that has stopped being reproducible, and a leaf that can
            # be refused twice can be refused forever; the second report is taken
            # as written and the parent's reconciliation says what it is.
            refused_before = any(
                isinstance(message, ToolMessage)
                and message.name == FINISH_UNIT_NAME
                and message.content != "accepted"
                for message in state["messages"]
            )
            unbacked = None if refused_before else unbacked_claim(report, state["messages"])
            if unbacked is not None and WRITE_TOOL in by_name:
                # The hand-back is the call, written out. An instruction to
                # compose one from the report is an instruction a 2B model
                # answers by sending the report again — measured, twice — and a
                # complete copyable artefact beats one it has to synthesise.
                claim, subject = unbacked
                # `page` is the per-page tests' subject and is not a selector, so
                # there the call cannot be written out and the model is asked for
                # the element the step named instead.
                action = (
                    f'Make this call now:\n\n{WRITE_TOOL}(selector: "{subject}", issue: "{claim}")'
                    if subject and subject != "page"
                    else f"Call {WRITE_TOOL} now with that issue text and the element the step "
                    f"that found it named."
                )
                messages.append(
                    ToolMessage(
                        content=(
                            f"Not accepted yet. The report has filed: {claim!r}, and no "
                            f"{WRITE_TOOL} call in this unit returned that issue, so that finding "
                            f"is not in the saved test.\n\n"
                            f"{action}\n\n"
                            f"Then call {FINISH_UNIT_NAME} again with the same report."
                        ),
                        tool_call_id=first["id"],
                        name=FINISH_UNIT_NAME,
                    )
                )
            else:
                messages.append(
                    ToolMessage(content="accepted", tool_call_id=first["id"], name=FINISH_UNIT_NAME)
                )
                update["report_yaml"] = report
                update["done"] = True
        else:
            handler = by_name.get(first["name"])
            if handler is None:
                content = json.dumps(
                    {
                        "ok": False,
                        "error": "not_found",
                        "detail": f"{first['name']} is not one of your tools: "
                        + ", ".join(sorted(by_name)),
                        "retryable": False,
                    }
                )
            else:
                try:
                    content = await handler.ainvoke(first.get("args", {}) or {})
                except Exception as error:  # noqa: BLE001 — a tool fault is a result, not a crash
                    content = json.dumps(
                        {
                            "ok": False,
                            "error": "rejected",
                            "detail": f"{first['name']} raised: {error}",
                            "retryable": False,
                        }
                    )
            messages.append(
                ToolMessage(content=content, tool_call_id=first["id"], name=first["name"])
            )

        # Every additional call in the turn is answered, not executed. There is
        # one browser and one panel, and `parallel_tool_calls=False` is honoured
        # by hosted models and not reliably by a local one.
        for call in rest:
            messages.append(
                ToolMessage(
                    content="Only one tool runs per turn. Read the result above, then call this "
                    "tool again on its own if you still need it.",
                    tool_call_id=call["id"],
                    name=call["name"],
                )
            )

        update["messages"] = messages
        return update

    def after_think(state: LeafState) -> str:
        last = state["messages"][-1]
        return "act" if getattr(last, "tool_calls", None) else END

    def after_act(state: LeafState) -> str:
        if state.get("done"):
            return END
        if state["steps"] >= state["unit"].max_steps:
            return "exhaust"
        return "think"

    def exhaust(state: LeafState) -> dict[str, Any]:
        return {"exhausted": True}

    builder = StateGraph(LeafState)
    builder.add_node("think", think_node)
    builder.add_node("act", act_node)
    builder.add_node("exhaust", exhaust)
    builder.add_edge(START, "think")
    builder.add_conditional_edges("think", after_think, {"act": "act", END: END})
    builder.add_conditional_edges("act", after_act, {"think": "think", "exhaust": "exhaust", END: END})
    builder.add_edge("exhaust", END)
    return builder.compile(checkpointer=checkpointer)


def leaf_payload(unit, skill_body: str) -> dict[str, Any]:
    """A fresh message list per invocation. This is what "fresh context" means.

    The skill file is read from disk at spawn time and is not held in `RunState`
    — twenty-three Markdown files in every checkpoint would make the run's own
    record the largest thing in it.
    """
    from langchain_core.messages import HumanMessage

    return {
        "messages": [SystemMessage(skill_body), HumanMessage(unit.as_prompt())],
        "unit": unit,
        "steps": 0,
        "done": False,
        "exhausted": False,
        "report_yaml": None,
    }
