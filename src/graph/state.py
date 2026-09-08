"""The channels the run carries, and the two report halves a unit returns.

`disposition` is deliberately not called `status`: the skill file format already
uses `status` for `complete | not-run | aborted` *inside* the report, and that is
the leaf's view of its own checks while `disposition` is the graph's view of the
sub-agent. Two different questions; two different fields.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Literal, TypedDict

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages

Disposition = Literal[
    "completed",  # finish_unit called, YAML parsed, reconciliation clean
    "skipped",  # held back, or the unit's subject is not on this page
    "incomplete",  # stopped without finish_unit, or the YAML did not parse
    "exhausted",  # hit the step budget
    "errored",  # the leaf raised, or its report declared status: aborted
    "rejected_writes",  # every write attempted was refused, or all were stripped
    # An IGT unit that reported itself but never finished its guided test. It is
    # its own disposition rather than a shade of `incomplete` because the leaf
    # did everything asked of it — the walk simply never reached Finish, so
    # Deque recorded nothing and the draft would otherwise carry a report of
    # findings the saved test does not hold.
    "abandoned",
]

RETRYABLE = {"errored", "incomplete", "rejected_writes", "abandoned"}


@dataclass(frozen=True)
class UnitBrief:
    """One unit of the run: a skill file, a tool binding and a budget."""

    unit_id: str  # "igt:structure" | "manual:11"
    kind: Literal["igt", "manual"]
    skill_path: Path
    tools: tuple[str, ...]  # from the skill file's front matter
    max_steps: int
    held_back: bool  # bound nothing but finish_unit — skips restore and gate
    visual_signoff: str
    subject: str  # the IGT category, or the page state test's name

    @property
    def recursion_limit(self) -> int:
        return self.max_steps * 2 + 10

    def as_prompt(self) -> str:
        """The one human turn a leaf gets: what it is auditing, and its budget."""
        if self.kind == "igt":
            return (
                f"Run the {self.subject} intelligent guided test on the page state that is "
                f"already loaded, following the procedure above exactly.\n"
                f"Unit id: {self.unit_id}. You have at most {self.max_steps} tool calls.\n"
                f"Call one tool at a time and read its result before the next one.\n"
                f"Begin now with step 1. Answer with a tool call, never with prose."
            )
        return (
            f"Audit this page state for page state test {self.subject}, following the "
            f"procedure above exactly. Start at step 1 and do not skip a step.\n"
            f"Unit id: {self.unit_id}. You have at most {self.max_steps} tool calls.\n"
            f"Call one tool at a time and read its result before the next one.\n"
            f"Begin now with step 1. Answer with a tool call, never with prose."
        )


@dataclass(frozen=True)
class Mismatch:
    """A disagreement between what the model reported and what the server holds."""

    kind: Literal["claimed_not_filed", "filed_not_claimed"]
    detail: str


@dataclass
class SubAgentReport:
    """Two halves, each authoritative for what only it can know.

    The coverage half cannot be derived from the transcript: `pass`,
    `not-applicable`, `unfileable` and `blocked` all file nothing, so all four
    look identical from outside. The ledger half cannot be taken from the model,
    because a small model's account of what it filed is the least reliable
    artefact available.
    """

    unit_id: str
    kind: str
    attempt: int
    disposition: Disposition
    coverage: dict[str, Any] | None  # the parsed YAML report
    filed: list[dict[str, Any]] = field(default_factory=list)
    igt_outcome: dict[str, Any] | None = None
    verdicts: list[dict[str, Any]] = field(default_factory=list)
    tool_errors: list[tuple[str, str]] = field(default_factory=list)
    reconciliation: list[Mismatch] = field(default_factory=list)
    tool_calls: int = 0
    model_id: str = ""
    visual_signoff: str = "not-required"
    ledger_after: str = ""
    detail: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "unit_id": self.unit_id,
            "kind": self.kind,
            "attempt": self.attempt,
            "disposition": self.disposition,
            "coverage": self.coverage,
            "filed": self.filed,
            "igt_outcome": self.igt_outcome,
            "verdicts": self.verdicts,
            "tool_errors": [list(pair) for pair in self.tool_errors],
            "reconciliation": [{"kind": m.kind, "detail": m.detail} for m in self.reconciliation],
            "tool_calls": self.tool_calls,
            "model_id": self.model_id,
            "visual_signoff": self.visual_signoff,
            "ledger_after": self.ledger_after,
            "detail": self.detail,
        }


class RunState(TypedDict, total=False):
    """Shared by the run graph and both phase graphs — the same trust tier.

    What is carried between units: the fixture handle, the advanced baseline, the
    last ledger verdict, and the accumulating reports. What is not carried:
    messages, transcripts, element refs, screenshots, or any finding. Sub-agents
    communicate through the ledger, never through the graph.
    """

    fixture: dict[str, Any]
    model_id: str
    baseline: dict[str, Any]
    queue: list[UnitBrief]
    cursor: UnitBrief | None
    attempt: int
    # Appended to explicitly rather than through a reducer. Both phases are real
    # subgraphs on this schema, so a reducer would apply once inside the phase
    # and again when the phase's final state merged into the parent's, and every
    # unit would appear in the draft twice.
    reports: list[SubAgentReport]
    ledger: dict[str, Any] | None
    recoveries: dict[str, int]
    consecutive_failures: int
    halt: tuple[str, str] | None
    # The report for the unit currently under the cursor. `reports` accumulates
    # and is the run's output; this is the one the edges after `unit` route on,
    # and it is overwritten by every unit rather than added to.
    last_report: SubAgentReport | None


class LeafState(TypedDict, total=False):
    """Shares no channel name with RunState, so nothing can arrive that the
    parent did not put in the payload."""

    messages: Annotated[list[AnyMessage], add_messages]
    unit: UnitBrief
    steps: int
    done: bool
    exhausted: bool
    report_yaml: str | None
