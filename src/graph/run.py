"""The run: enter the fixture, the IGT phase, the manual phase, finalize.

Three graph tiers over one model tier. `run_graph` and both phase graphs hold no
model at all; the leaves do, and `bind_tools` is called once per sub-agent and
nowhere else.

    run_graph            StateGraph(RunState)     deterministic
    ├── igt_phase        StateGraph(RunState)     deterministic   subgraph node
    │   └── igt leaf     StateGraph(LeafState)    the model       invoked, not composed
    └── manual_phase     StateGraph(RunState)     deterministic   subgraph node
        └── manual leaf  StateGraph(LeafState)    the model       invoked, not composed
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from langchain.chat_models import init_chat_model
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from .leaf import build_leaf, model_thinker
from .mcp import build_client, call, open_session, tools_for
from .phase import build_phase, ledger_baseline
from .scripted import scripted_thinker
from .state import RunState, SubAgentReport, UnitBrief
from .units import v0_queue, validate_bindings

# src/graph/<file> -> the repository root is two levels up.
REPO = Path(__file__).resolve().parents[2]


class Runtime:
    """Everything the deterministic tiers reach for that is not run state.

    Held here rather than in `RunState` because none of it is a checkpointable
    fact about the run: the MCP tools are live handles, and the compiled leaf
    graphs are a cache.
    """

    def __init__(
        self, *, run_id, model_id, all_tools, parent_tools, thinker_for, window_tokens, out, checkpointer
    ):
        self.run_id = run_id
        self.checkpointer = checkpointer
        self.model_id = model_id
        self.all_tools = all_tools
        self.parent_tools = parent_tools
        self._thinker_for = thinker_for
        self.window_tokens = window_tokens
        self._leaves: dict[tuple, Any] = {}
        self.out = out

    def log(self, message: str) -> None:
        print(message, file=self.out, flush=True)

    def leaf_for(self, brief: UnitBrief):
        """One compiled graph per binding signature, not one per unit.

        Seven IGT leaves share one; the held-back leaves share one; the active
        manual leaves group by predicate set. A cache, not a design decision.
        """
        signature = (tuple(sorted(brief.tools)), brief.max_steps)
        if signature not in self._leaves:
            tools = [t for t in self.all_tools if t.name in brief.tools]
            self._leaves[signature] = build_leaf(
                self._thinker_for(brief, tools),
                tools,
                brief.max_steps,
                checkpointer=self.checkpointer,
                log=self.log,
            )
        return self._leaves[signature]


def build_run(runtime: Runtime, queue: list[UnitBrief], fixture: dict[str, Any]):
    async def enter_fixture(state: RunState) -> Command[Literal["igt_phase", "finalize"]]:
        served = {tool.name for tool in runtime.all_tools}
        problems = validate_bindings(queue, served)
        if problems:
            for problem in problems:
                runtime.log(f"binding check failed — {problem}")
            return Command(
                goto="finalize",
                update={"halt": ("void", "skill file bindings do not match the inventory")},
            )
        runtime.log(f"binding check: {len(queue)} units against {len(served)} served tools — ok")

        result = await call(runtime.parent_tools, "check_ledger")
        if not result.get("ok") or result["value"]["verdict"] != "intact":
            detail = result.get("detail") or result.get("value", {}).get("verdict", "unreadable")
            runtime.log(f"the fixture did not hand over an intact ledger: {detail}")
            return Command(goto="finalize", update={"halt": ("void", f"first gate {detail}")})

        ledger = result["value"]
        runtime.log(
            f"fixture seated: test {fixture['testId']} holding {ledger['totals']['total']} issues"
        )
        return Command(
            goto="igt_phase",
            update={"ledger": ledger, "baseline": ledger_baseline(ledger["ledger"])},
        )

    async def between_phases(state: RunState) -> dict[str, Any]:
        # Phase order is load-bearing rather than conventional: IGT before manual
        # is what puts guided issues on the server before test 16 goes looking
        # for them through `read_test_results`.
        return {}

    def after_igt(state: RunState) -> str:
        return "finalize" if state.get("halt") else "manual_phase"

    async def finalize(state: RunState) -> dict[str, Any]:
        """The last gate. A run must not print a draft over a ledger that died
        on the last unit — and must not throw away a good one over a hiccup."""
        for attempt in range(2):
            result = await call(runtime.parent_tools, "check_ledger")
            verdict = result["value"]["verdict"] if result.get("ok") else "server-unreachable"
            # One retry, and only for the verdict the loss policy allows one for.
            if verdict != "server-unreachable" or attempt == 1:
                break

        if verdict == "intact":
            return {"ledger": result["value"]}
        runtime.log(f"final gate: {verdict}")
        if state.get("halt"):
            return {}
        # A degraded final read does not overwrite the last intact one: the
        # draft's totals are a fact about the saved test, and the freshest
        # *readable* fact serves a reviewer better than the freshest attempt.
        shape = "void" if verdict in ("test-lost", "issues-lost") else "partial"
        update: dict[str, Any] = {"halt": (shape, f"{verdict} at the final gate")}
        if shape == "void":
            update["ledger"] = result.get("value")
        return update

    builder = StateGraph(RunState)
    builder.add_node("enter_fixture", enter_fixture)
    builder.add_node("igt_phase", build_phase("igt", runtime))
    builder.add_node("between_phases", between_phases)
    builder.add_node("manual_phase", build_phase("manual", runtime))
    builder.add_node("finalize", finalize)

    builder.add_edge(START, "enter_fixture")
    builder.add_edge("igt_phase", "between_phases")
    builder.add_conditional_edges(
        "between_phases", after_igt, {"manual_phase": "manual_phase", "finalize": "finalize"}
    )
    builder.add_edge("manual_phase", "finalize")
    builder.add_edge("finalize", END)
    return builder.compile(checkpointer=runtime.checkpointer)


def draft(state: RunState, fixture: dict[str, Any], model_id: str, queue: list[UnitBrief]) -> str:
    """The run's output. v1 prints it; a human confirms, corrects or rejects it.

    Two abort shapes, and they are not interchangeable. `halt_partial` emits the
    draft marked partial from the server-side ledger read, listing what never
    ran. `halt_void` emits **no draft at all**: a draft that silently
    under-reports gets 5–30 minutes of human confidence and the missing findings
    are never looked for again.
    """
    halt = state.get("halt")
    reports: list[SubAgentReport] = state.get("reports", [])
    lines: list[str] = []
    add = lines.append

    if halt and halt[0] == "void":
        add("=" * 72)
        add("NO DRAFT — the ledger is provably damaged.")
        add(f"reason: {halt[1]}")
        last_intact = next(
            (r.unit_id for r in reversed(reports) if r.ledger_after == "intact"), "none"
        )
        add(f"last intact gate: {last_intact}")
        add(f"last completed unit: {reports[-1].unit_id if reports else 'none'}")
        add(f"saved test: {fixture['testId']} on {fixture['serverUrl']}")
        add("A replay keys on those two lines. Re-run from the fixture.")
        add("=" * 72)
        return "\n".join(lines)

    ledger = state.get("ledger") or {}
    totals = ledger.get("totals") or {}
    ran = {r.unit_id for r in reports}
    never_ran = [u.unit_id for u in queue if u.unit_id not in ran]

    add("=" * 72)
    add(f"ACCESSIBILITY AUDIT DRAFT{'  (PARTIAL)' if halt else ''}")
    add("=" * 72)
    add(f"page state   {fixture['url']}")
    add(f"saved test   {fixture['testName']}  ({fixture['testId']})")
    add(f"server       {fixture['serverUrl']}")
    add(f"model        {model_id}")
    add(f"ledger       {totals.get('total', '?')} issues — "
        f"{totals.get('automatic', '?')} automatic, {totals.get('guided', '?')} guided, "
        f"{totals.get('manual', '?')} manual")
    if halt:
        add(f"halted       {halt[1]}")
    if never_ran:
        add(f"never ran    {', '.join(never_ran)}")
    add("")
    add("This is a draft. A human confirms, corrects or rejects each finding.")

    for report in reports:
        add("")
        add("-" * 72)
        add(f"{report.unit_id}  [{report.disposition}]  {report.tool_calls} tool calls, "
            f"ledger after: {report.ledger_after or 'not gated'}")
        if report.detail:
            add(f"  note: {report.detail}")
        if report.visual_signoff != "not-required":
            add(f"  visual sign-off: {report.visual_signoff}")
        if report.igt_outcome:
            outcome = report.igt_outcome
            add(f"  guided test {outcome.get('category')}: {outcome.get('issueCount')} issues, "
                f"{outcome.get('durationMinutes')} min, saved as {outcome.get('savedAs')!r}")
            for issue in outcome.get("issues", []):
                add(f"    - {issue.get('title')}")
        for entry in report.filed:
            add(f"  filed  {entry.get('issue')}")
            add(f"         against {entry.get('recordedLocation') or entry.get('selector')}")
        coverage = report.coverage or {}
        for record in coverage.get("records") or []:
            if not isinstance(record, dict):
                continue
            line = (
                f"  check {record.get('check')}  {record.get('outcome')}  "
                f"leaf {record.get('leaf')}  subject {record.get('subject')}"
            )
            add(line)
            if record.get("note"):
                add(f"         note: {record['note']}")
            if record.get("unverified"):
                add(f"         UNVERIFIED claim, stripped: {record['unverified']}")
        for mismatch in report.reconciliation:
            add(f"  reconciliation [{mismatch.kind}] {mismatch.detail}")
        for name, code in report.tool_errors:
            add(f"  tool error  {name} -> {code}")

    add("")
    add("=" * 72)
    return "\n".join(lines)


async def run(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="axedevtools-v0")
    parser.add_argument("--out", default=None, help="run directory (default build/run/<id>)")
    parser.add_argument(
        "--leaf",
        default=os.environ.get("AXE_LEAF", "model"),
        choices=["model", "scripted"],
        help="'model' binds AXE_MODEL to every leaf; 'scripted' runs the same graph and the same "
        "tools with a deterministic policy in the leaf's place",
    )
    args = parser.parse_args(argv)

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    out_dir = Path(args.out) if args.out else REPO / "build" / "run" / run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    queue = v0_queue()
    print(f"run {run_id} -> {out_dir}", flush=True)
    print("starting the fixture (launch, log in, scan, save, keepalive)…", flush=True)

    # A record, not live resume. Resuming after a Python-side crash is
    # meaningless — the fixture died with it, and a new fixture means a new saved
    # test and therefore a different run. What this buys is that the reports and
    # the transcript of a four-hour run that died at hour three are on disk
    # without having had to stream them anywhere.
    # The MCP session is entered first and the checkpointer inside it, so the
    # checkpointer closes first. SQLite in WAL mode folds the write-ahead log
    # back into the database file when its last connection closes cleanly, and a
    # connection torn down inside the MCP client's cancelling task group does
    # not close cleanly — which leaves a zero-length database beside a log
    # SQLite will not read, and a record nobody can open is not a record.
    async with (
        open_session(build_client()) as session,
        AsyncSqliteSaver.from_conn_string(str(out_dir / "checkpoints.sqlite")) as checkpointer,
    ):
        return await _run_against(session, args, run_id, out_dir, queue, checkpointer)


async def _run_against(session, args, run_id, out_dir, queue, checkpointer) -> int:
    all_tools = await tools_for(session)
    served = {tool.name: tool for tool in all_tools}
    print(f"MCP server serving {len(all_tools)} tools", flush=True)

    fixture_result = await call(served, "check_ledger")
    if not fixture_result.get("ok"):
        print(f"the fixture did not answer: {fixture_result}", file=sys.stderr)
        return 1
    fixture = {
        "testId": fixture_result["value"]["ledger"]["testId"],
        "testName": fixture_result["value"]["testName"],
        "url": fixture_result["value"]["testUrl"],
        "serverUrl": os.environ.get("AXE_SERVER_URL", ""),
    }

    if args.leaf == "model":
        model_id = os.environ["AXE_MODEL"]
        # `init_chat_model` rather than a concrete class, because the same skill
        # file has to run against the development model and a production model on
        # the same fixture before a visual branch is done. Swapping models is an
        # environment variable, not an edit — and so is whatever that provider
        # needs said to it, which for the local runtime is the endpoint: Docker
        # Model Runner serves llama.cpp behind an OpenAI-compatible API, so it is
        # the `openai:` provider with `base_url` moved rather than a runtime of
        # its own. Its context window is set where the model is loaded, not per
        # request, so nothing here asks for one.
        extra = json.loads(os.environ.get("AXE_MODEL_KWARGS", "{}"))
        model = init_chat_model(model_id, temperature=0, **extra)

        def thinker_for(brief, tools):
            return model_thinker(model, tools, int(os.environ.get("AXE_WINDOW_TOKENS", "24000")))
    else:
        model_id = "scripted-leaf"

        def thinker_for(brief, tools):
            return scripted_thinker(brief)

    runtime = Runtime(
        run_id=run_id,
        model_id=model_id,
        all_tools=all_tools,
        parent_tools={
            name: tool
            for name, tool in served.items()
            # Main is bound six tools, and `restore_page` is bound to no leaf at
            # all: a sub-agent cannot restore the page because it cannot reach
            # the tool, which is how "never restore mid-unit" is enforced
            # structurally rather than by instruction.
            if name
            in {
                "check_ledger",
                "read_test_results",
                "restore_page",
                "reopen_saved_test",
                "save_progress_and_quit",
                "igt_list",
            }
        },
        thinker_for=thinker_for,
        window_tokens=int(os.environ.get("AXE_WINDOW_TOKENS", "24000")),
        out=sys.stdout,
        checkpointer=checkpointer,
    )

    graph = build_run(runtime, queue, fixture)
    initial: RunState = {
        "fixture": fixture,
        "model_id": model_id,
        "baseline": {},
        "queue": list(queue),
        "cursor": None,
        "attempt": 1,
        "reports": [],
        "ledger": None,
        "recoveries": {},
        "consecutive_failures": 0,
        "halt": None,
        "last_report": None,
    }

    # `durability="sync"` because the checkpoint is a *record*: a four-hour run
    # that dies at hour three has to leave its transcript on disk, and an
    # asynchronous write is one the dying process can outrun.
    state = await graph.ainvoke(
        initial,
        {"recursion_limit": 200, "configurable": {"thread_id": run_id}},
        durability="sync",
    )

    text = draft(state, fixture, model_id, queue)
    print("\n" + text, flush=True)
    (out_dir / "draft.txt").write_text(text + "\n")
    (out_dir / "run.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
                "model_id": model_id,
                "leaf": args.leaf,
                "fixture": fixture,
                "halt": list(state["halt"]) if state.get("halt") else None,
                "ledger": state.get("ledger"),
                "reports": [r.as_dict() for r in state.get("reports", [])],
            },
            indent=2,
            default=str,
        )
        + "\n"
    )
    print(f"\nwritten to {out_dir}", flush=True)

    halt = state.get("halt")
    return 0 if not halt else 1


def main() -> None:
    sys.exit(asyncio.run(run(sys.argv[1:])))


if __name__ == "__main__":
    main()
