---
id: 013
title: Settle the agent graph
labels: [wayfinder:grilling]
state: closed
assignee: brian
blocked-by: [011]
---

## Question

How is the sequential agent tree expressed in LangGraph?

The shape is fixed: main agent takes the fixture, IGT agent runs one sub-agent per category in series, manual agent runs one per page state test in series. Nothing parallel. Each sub-agent starts with fresh context, one skill file, and a narrow tool set.

Decide: how a sub-agent is spawned with exactly its own context, what it returns to its parent, how a parent restores page state before starting the next one, and what happens when a sub-agent fails rather than finishing.

Confirm here whether LangGraph is the intended piece of LangChain, or whether plain LangChain agents are the requirement.

Resolve with a graph an implementer can build from.

## Resolution

**LangGraph, and only the leaves hold a model.**

The ticket's last question first: **LangGraph, not `AgentExecutor`.** Plain
LangChain agents cannot express any of the four things this run actually needs —
a bounded recovery transition per ledger verdict, a per-sub-agent checkpoint
namespace, a state channel that survives a leaf failing, or a structural
guarantee that two panel actions never overlap. Those are graph properties, not
agent properties. CONTEXT already says LangGraph; this confirms it on grounds
rather than by assertion.

The decision everything else falls out of: **the main, IGT and manual "agents"
are not agents.** They are `StateGraph`s with no model bound. Their whole job —
pop the next unit, spawn it, restore the page, check the ledger, route on the
verdict — is mechanical, and putting a model on it buys nondeterminism at exactly
the points where the run is most expensive to lose. The tools
[Settle the tool inventory](011-tool-inventory.md) binds to "Main" are called as
ordinary Python coroutines from node functions. **`bind_tools` is called once per
sub-agent and nowhere else in the run.**

Three graph tiers, one model tier:

```
run_graph            StateGraph(RunState)     deterministic
├── igt_phase        StateGraph(RunState)     deterministic   subgraph node
│   └── igt leaf     StateGraph(LeafState)    Gemma / prod    invoked, not composed
└── manual_phase     StateGraph(RunState)     deterministic   subgraph node
    └── manual leaf  StateGraph(LeafState)    Gemma / prod    invoked, not composed
```

**Twenty-three units per run: 7 IGT categories and all 16 page state tests.**
The three screen-reader tests are in the queue rather than filtered out of it,
because [Settle the skill file format](012-skill-file-format.md) makes a
held-back file executable — `tools: []`, one `not-run` record, stop. Running them
costs nothing, and it is the difference between a draft that says *test 13 was
not run and here is why* and a draft that is silently missing a test. A
held-back unit is bound no tools at all, so it is structurally incapable of
touching the page or the ledger, and the graph therefore skips its restore and
its gate. **Twenty units touch the panel; twenty-two ledger gates in a run.**

---

### 1. How a sub-agent gets its own context and its own tool binding

Six constructs, each doing one job.

**a. A separately compiled graph, invoked from inside a node function — never
`add_node(subgraph)`.**

A subgraph added as a node shares state by channel name. That is right for the
two phase graphs, which are the same trust tier as the run and want the same
channels. It is wrong for a leaf: a shared channel is precisely how the last
test's element refs, screenshots and reasoning leak into the next one. So a leaf
is reached by an ordinary `await leaf.ainvoke(payload, config)` inside the
`unit` node, with a hand-built payload. `LeafState` shares no channel name with
`RunState`, so there is no path for anything to arrive that the parent did not
put in the dict.

**b. A fresh message list per invocation.** This is what "fresh context" means
concretely:

```python
payload = {
    "messages": [
        SystemMessage(brief.skill_path.read_text()),   # exactly one skill file
        HumanMessage(brief.as_prompt()),               # unit id, subject scope, budget
    ],
    "unit": brief,
    "steps": 0,
    "done": False,
    "exhausted": False,
    "report_yaml": None,
}
```

The skill file is read from disk at spawn time and is **not** held in `RunState`
— twenty-three Markdown files in every checkpoint would make the run's own record
the largest thing in it.

On the manual path `skill_path` is `skills/page-state/<n>-<slug>.md` from 012.
On the IGT path 012 is explicit that there is no file of that shape — *"an IGT
sub-agent needs a category name and nothing else"* — so the IGT leaf loads
`skills/igt/<category>.md` if the file exists and `skills/igt/procedure.md`
otherwise, and the category name travels in the `HumanMessage`. One shared
procedure serving all seven is a legitimate outcome of that lookup; which files
exist is 012's follow-on, and the graph only needs the rule.

**c. A distinct `thread_id` per sub-agent.**

```python
config = {
    "configurable": {"thread_id": f"{run_id}/{brief.unit_id}#{attempt}"},
    "recursion_limit": brief.max_steps * 2 + 10,
    "run_name": brief.unit_id,
}
```

Distinct thread ids are what make the isolation durable rather than incidental:
with a checkpointer attached, a shared thread replays the previous unit's
messages into this one on any resume. The `#attempt` suffix means a retry is a
genuinely fresh sub-agent, not a continuation of the one that failed.

**d. The binding is baked into the compiled graph, not passed at call time.**

```python
def build_leaf(model, tools: list[BaseTool], max_steps: int) -> CompiledStateGraph:
    bound = model.bind_tools([*tools, finish_unit], parallel_tool_calls=False)
    by_name = {t.name: t for t in (*tools, finish_unit)}
    ...
```

The tool list is closed over by both the `think` node — which is what the model
sees a schema for — and the `act` node, which is what can actually execute. A
sub-agent cannot call a tool it was not given, because the tool is in neither
place. That is what *a narrow tool set* means mechanically, as against an
instruction in a prompt that a 2B model may or may not honour.

Graphs are compiled once at startup and cached by binding signature: **one**
serves all seven IGT leaves (identical 7-tool binding, per 011), **one** serves
the three held-back leaves (`[finish_unit]` only), and **six** serve the thirteen
active manual leaves, grouped by predicate set — tests 4, 5, 7, 12, 16, and the
eight with no predicates at all.

**e. The binding is cross-checked against the skill file at startup, not at hour
three.**

012 puts a `tools:` list in every skill file's front matter *"so the file and the
binding cannot drift"*. Two declarations of one fact drift unless something
compares them, so `enter_fixture` does, for all twenty-three units, before any
work: every name in every front matter must resolve to a tool the MCP server
actually served, and the set must equal 011's binding table for that unit. A
mismatch aborts at second zero. This is the cheapest failure in the whole design
and it catches the most expensive class — a typo in a skill file that a
four-hour run discovers on unit nineteen.

**f. One MCP client for the whole run.**

```python
client = MultiServerMCPClient({
    "axe": {"transport": "stdio", "command": "node", "args": ["fixture/mcp-server.js"]},
})
all_tools = await client.get_tools()          # once, at startup
```

Stated because getting it wrong is catastrophic and easy: **the server is the
fixture**, so a per-agent MCP session would launch a browser, mint a session and
run a scan per sub-agent. One client, one stdio session, one browser, for the
life of the run. Per-unit narrowing is
`[t for t in all_tools if t.name in brief.tools]` over that one list — never a
second connection.

---

### 2. What a sub-agent returns, and what the parent carries forward

012 landed the leaf's half of this while the ticket was open: a manual sub-agent
ends with a YAML block, one record per check per subject, carrying `outcome`,
`leaf`, `filed` and `note` — and says *"what the parent does with this is 013's
business."* So:

**A sub-agent returns two halves, and each is authoritative for what only it can
know.**

| Half | Source | Authoritative for |
|---|---|---|
| **Coverage** | the leaf's YAML report | which checks ran, which leaf fired, `pass` / `not-applicable` / `unfileable` / `blocked` / `not-run` |
| **Ledger** | the tool transcript, parsed by the parent | what was actually filed, what the predicates measured, what the panel refused |

Neither half can be dropped, and this is the correction to the obvious design.
The ledger half cannot be taken from the model, because a Gemma-class model's
account of what it filed is the least reliable artefact available. But the
coverage half **cannot be derived from the transcript at all**: `pass`,
`not-applicable`, `unfileable` and `blocked` all file nothing, so all four look
identical from outside — and 012's whole argument for a six-outcome set is that
*no tables on this page* and *the tables are fine* are opposite findings wearing
the same silence.

**The parent reconciles the two, and reconciliation is mechanical.** 012 designed
for it — *"`filed` appears only after an `add_manual_issue`, so the report and the
ledger can be reconciled without reading the panel"*. Two mismatch classes, both
detected without trusting anybody:

- a record carries `filed:` with no matching ok `add_manual_issue` in the
  transcript → the filing did not happen. The claim is stripped, the record is
  re-marked `unverified`, and the unit's disposition becomes `rejected_writes`.
- an ok `add_manual_issue` with no record naming it → a real issue is on the
  server and unaccounted for in coverage. A synthetic record is appended and
  flagged, because the ledger is the thing a human will review and an unexplained
  entry in it is worse than an explained one.

**Delivery: the YAML block is the argument of `finish_unit`, not free text at the
end of a message.** 012 says "one YAML block at the end"; making it a tool
argument costs the format nothing, gives the parent a parse point instead of a
scrape, and gives the graph its completion signal in the same move. A block that
fails `yaml.safe_load` is a coverage half that is missing, not a unit that
failed — the ledger half still stands, and the disposition is `incomplete`.
Recorded below as a small amendment to 012.

```python
@dataclass(frozen=True)
class SubAgentReport:
    unit_id: str                     # "igt:structure" | "manual:12"
    kind: Literal["igt", "manual"]
    attempt: int
    disposition: Disposition         # the graph's view — see §5
    coverage: UnitReport | None      # 012's parsed YAML: status, subjects, records[]
    filed: list[FiledIssue]          # every ok add_manual_issue result
    igt_outcome: IgtOutcome | None   # the ok igt_finish result, if any
    verdicts: list[Verdict]          # every ok check_* result
    tool_errors: list[tuple[str, ErrorCode]]
    reconciliation: list[Mismatch]   # empty is the healthy case
    tool_calls: int
    model_id: str                    # for 018's visualSignoff audit
    ledger_after: str                # the verdict at the gate that followed
    cost: Cost
```

`disposition` is deliberately not called `status`: 012 already uses `status` for
`complete | not-run | aborted` *inside* the report, and that is the leaf's view
of its own checks while `disposition` is the graph's view of the sub-agent. Two
different questions; two different fields.

**Subject iteration stays inside the leaf.** 012's `scope: per-subject` test 12
reports `subjects: 2`. That loop is the skill file's, not the graph's — one leaf
per test, whatever the test's subject count, because a graph-level fan per
subject would be either a parallel superstep or a second cursor, and both cost
more than they buy.

**What the parent carries to the next sub-agent: nothing from the last one.**
This is the whole of MAP's *Sub-agent context handoff*, as a rule:

> **Sub-agents communicate through the ledger, never through the graph.**

Carried in `RunState`: the fixture handle, the *advanced* ledger baseline, the
last ledger verdict, and the accumulating `reports` list — which is the run's
output and is never injected into a leaf. Not carried: messages, transcripts,
`ElementRef` handles, screenshots, or any finding.

The one apparent counter-example proves the rule. Page state test 16's
prerequisite needs issues earlier work produced; it gets them by calling
`read_test_results()`, which reads the saved test — not by the parent injecting
test 3's report. That is also why **phase order is load-bearing rather than
conventional**: IGT before manual is what puts guided issues on the server before
test 16 goes looking for them.

**The baseline advances, and this is a correctness requirement, not tidiness.**

`checkLedger` compares held counts against `baseline.issues`, and 010 takes that
baseline once, at fixture setup. If the graph never advances it, losing every
issue filed *during* the run still reads `intact` — `issues-lost` would only ever
fire on damage to the fixture's own automated scan. So, on `intact` only:

```python
{"baseline": ledger_baseline(result["ledger"]),
 "filed_floor": result["ledger"]["issues"]}
```

Monotone, and only from an `intact` read, so a partially-visible ledger can never
lower the floor.

---

### 3. `checkLedger`: where it is called, and the eight transitions

**Three kinds of place, twenty-two calls in a run:**

| Where | Node | Why |
|---|---|---|
| once, after the fixture hands over | `enter_fixture` | takes the baseline via `readLedger` + `ledgerBaseline`, then one `check_ledger()` to prove the panel is seated before any work |
| once per panel-touching unit, **after** restore | `ledger_gate` | 017 rule 1: nothing is in progress between units, so restore first, then check |
| once, before the draft is emitted | `finalize` | a run must not print a draft over a ledger that died on the last unit |

Twenty gates plus two, at 1.7–2.8 s each: under a minute across four hours. The
three held-back units are bound no tools and are routed past both `restore` and
`ledger_gate` — checking whether a sub-agent that could not call a tool broke
something is theatre.

**Order is restore-then-check.** 017 prescribes it, and `restore_page()` already
reports `ledgerAlive` itself, so a restore that breaks the ledger is attributed
without a second call. A leaf that broke it is attributed for free too — its
transcript ends in `panel_unavailable`.

**The eight verdicts and their transitions.** `checkLedger` returns eight, not
five (see the flags at the end):

| Verdict | Graph transition | Bound |
|---|---|---|
| `intact` | → `advance_baseline` → `dispatch` | — |
| `panel-elsewhere` | → `recover_overview` → `ledger_gate` | 1 per gate, then `halt_partial` |
| `panel-detached` | → `recover_reopen` → `ledger_gate` | 1 per gate, then `halt_partial` |
| `server-unreachable` | → `ledger_gate`, no action, just re-read | 1 per gate, then `halt_partial` |
| `panel-hidden` | → `halt_partial` **immediately** | its retry is already spent — below |
| `panel-orphaned` | → `halt_partial` immediately | none. Not recoverable in place |
| `test-lost` | → `halt_void` immediately | none |
| `issues-lost` | → `halt_void` immediately | none |

**`panel-hidden` gets no retry from the graph, and this sharpens 010's policy
rather than contradicting it.** `fixture/ledger.js` takes a `reselect` callback
and, when the panel is not laid out, *calls it and re-reads before returning a
verdict*. The graph always passes `reselect`. So by the time `panel-hidden`
reaches a conditional edge the one bounded re-selection has already happened and
already failed, and a graph-level retry would be the second attempt 010
explicitly forbids. The `action: 'reselect-then-abort'` string states the policy;
the function has already performed its first half.

`panel-detached` is the opposite case — `ledger.js` has no reopen logic, so the
graph owns that attempt. 010 proved the mechanism: press *view saved tests* and
click the test's own entry, which is an `<a>` and not a button. It needs a tool
011 does not list (flagged below).

**What "abort" means for work already filed.** Two abort classes, because the
findings are in two different conditions.

**`halt_partial`** — `panel-hidden`, `panel-orphaned`, `panel-detached`,
`server-unreachable`, cascading unit failures. The panel is unusable; **the saved
test is intact on the server.** 017 measured it surviving all twenty-one
perturbations and 010 measured it surviving an extension refresh. So the work is
real and reviewable:

- stop issuing new units;
- emit the draft, marked `partial`, sourced from `state.ledger.ledger` — the
  server-side read `checkLedger` has already performed — and **not** from
  `read_test_results()`, which is a panel tool and the panel is why we are here;
- list every unit that completed and every unit that never ran, by id, so the
  reviewer sees the shape of the gap instead of inferring it from silence;
- exit non-zero.

**`halt_void`** — `test-lost` and `issues-lost`. The ledger is provably damaged.
**No draft is emitted.** Straight from CONTEXT's own argument: a draft that
silently under-reports gets 5–30 minutes of human confidence and the missing
findings are never looked for again. Emit a failure record naming the last
`intact` gate and the last completed unit — which is what a replay keys on — and
exit non-zero. Re-running from the fixture at \$20–50 is the only recovery, and
CONTEXT already prices it.

In neither case does the graph delete, roll back or clean up anything
server-side. There is nothing to undo: the issues filed are correct issues, there
are simply fewer of them than a complete run would have produced.

---

### 4. Page state restoration between sub-agents

017 makes this cheaper and changes its justification entirely. **Nothing is
restored for the ledger's sake. Restoration exists so the next test measures the
right page.**

`restore_page()` runs unconditionally between every panel-touching unit, on both
phases. Unconditional rather than dirty-flagged, because "did that test dirty the
page" would be a judgement by the model, and a 1–2 s reload is cheaper than being
wrong about it twenty times.

**What must be restored:**

| | Why, post-017 |
|---|---|
| **Viewport → the fixture's** | measurement correctness only. Test 9 leaves it at 320×800; the scan and every IGT capture element boxes at the current width, and `check_target_size` and `check_text_contrast` would then be measuring a phone. The ledger does not care — a resize fires nothing. |
| **Injected CSS removed** | same argument, sharper. Test 9's WCAG 1.4.12 text-spacing stylesheet changes every box on the page. Cleared by the reload. |
| **DOM and page-script state** | test 8 opens components and moves focus; test 1 may have triggered automatic behaviour; test 12 sorts a table. Cleared by the reload. |
| **Panel view → the overview** | not a page duty but a graph duty: `checkLedger` returns `panel-elsewhere` unless `view ∈ {overview, overview-igt}`, and a manual leaf that stops with the *Add Manual Issue* form open leaves it exactly there. Reloading the page does not move the panel. |

**What can be left alone:**

- **Scroll position.** Every tool works from a CSS selector and nothing is
  coordinate-dependent, per CONTEXT's *Select elements by CSS selector*. Scroll
  fires no guard.
- **Anything at all, as far as the ledger is concerned.** This is the material
  change from what CONTEXT assumed. The saved test survived every one of 017's
  twenty-one perturbations; restoration has no ledger duty left.
- **Mid-unit restoration: never.** 017 rule 3 — inside an IGT, change nothing and
  navigate nowhere. **The graph enforces this structurally rather than by
  instruction:** `restore_page` appears in no leaf binding in 011's table. It is
  a parent-tier call, and a sub-agent cannot restore the page because it cannot
  reach the tool.

**One assumption this inherits, worth recording rather than leaving implicit.**
`restore_page()` reloads the same URL, so it assumes the target page state is
reachable by URL alone. 017 rule 3 warns in passing that a page rendering
differently on a second visit takes the test with it. For v1 the fixture contract
implies a URL-addressable state and page state *discovery* is out of scope — but
a state that required interaction to reach cannot survive twenty reloads, and
MAP's open question about a v0 target page that is not the obvious one is exactly
where that will surface.

---

### 5. When a sub-agent fails rather than finishing

Six dispositions, all derived mechanically. **No disposition depends on the
model's account of how it went.**

```python
Disposition = Literal[
    "completed",       # finish_unit called, YAML parsed, reconciliation clean
    "skipped",         # held back (tools: []), or the unit's subject is not on this page
    "incomplete",      # stopped without finish_unit, or the YAML did not parse
    "exhausted",       # hit the step budget
    "errored",         # the leaf raised, or its report declared status: aborted
    "rejected_writes", # every write attempted was refused, or reconciliation stripped them all
]
```

Note what is *not* here: 012's check-level `blocked` and `unfileable` outcomes.
Those are normal results of a completed unit, not failures. `blocked` in
particular will be common until the page-interaction tool set 012 asks for
exists — six of the sixteen tests need it — and a graph that treated `blocked` as
a failure would retry, exhaust the failure budget, and halt a run that is working
exactly as designed.

**(a) The sub-agent errors.** MCP transport drops, a tool raises, the model
provider fails. `.ainvoke()` raises; the `unit` node catches it and returns
`disposition="errored"` with the exception text. The transition is **always
`ledger_gate` first** — *is the ledger still there* outranks *did that test
finish*, and an exception out of a leaf is a decent prior that something broke
below it.

If the gate says `intact`:

- **retry once, on a fresh `thread_id`, only if the attempt filed nothing** —
  mechanically decidable as `report.filed == [] and report.igt_outcome is None`.
  A fresh sub-agent with a fresh context is what this design already produces
  cheaply, so it is the natural retry.
- **if it filed anything, do not retry.** A second attempt re-walks the same
  checklist and files duplicates, which costs the reviewer time and mis-states
  every count on the draft. Mark `errored`, keep what was filed and whatever
  coverage survived, move on.

**A unit error never halts the run.** One missing test is a named gap in a draft
a human is going to review anyway; halting throws away twenty-two other units.
The one exception is a cap: **three consecutive units failing → `halt_partial`,
reason `cascading_unit_failures`** — at that point the failure is the
environment, not the tests.

**(b) The sub-agent runs out of context.** Two distinct exhaustion modes, handled
separately.

*Step exhaustion* is handled in the graph, not by an exception. `LeafState.steps`
increments in `act`; the router sends the leaf to `END` with `exhausted=True` at
`max_steps`, so the parent still gets the ledger half of a report for everything
filed before it ran long. `recursion_limit = max_steps * 2 + 10` is the backstop
for a `GraphRecursionError` if that accounting is ever wrong.

*Window exhaustion* is handled before every model call, in `think`:

```python
msgs = trim_messages(
    state["messages"],
    max_tokens=budget, token_counter=model, strategy="last",
    include_system=True, start_on="human", allow_partial=False,
)
```

`include_system=True` is load-bearing: the system message **is** the skill file,
and a trim that drops it leaves the model executing a procedure it can no longer
read. One pre-pass matters more than the trim itself on this model: **image
content is stripped from every `ToolMessage` except the most recent one.** A
screenshot in 011's `Evidence` is thousands of tokens, tests 5, 6 and 9 fetch
several, and a stale one is never re-consulted. On an E2B-class window that
single rule is the difference between a visual test running and not.

An exhausted unit is **never retried** — same file, same model, same budget, same
outcome. It is also the most useful failure this design produces: it is a direct
signal that the skill file is too large for the development model, which is 012's
problem and precisely the *development proves shape* property
[018](018-vision-on-the-dev-model.md) argues for. Reported as an authoring signal,
not merely as a failure.

**(c) The sub-agent returns a bad answer.** Split into what the graph can detect
and what it cannot, and the line between them must not be blurred.

*Detectable, and detected:*

- **`incomplete`** — `finish_unit` never called, or its YAML would not parse.
  Retried once only if it also filed nothing and made fewer than three tool
  calls, i.e. it barely tried. Otherwise recorded as a gap, with the ledger half
  kept.
- **`rejected_writes`** — every `add_manual_issue` came back `ok:false`, or
  reconciliation stripped every `filed:` the report claimed. The model believes it
  filed findings; the server holds none. This is exactly the `rejected` and
  `ambiguous` envelope 011 built for. Retried once; a repeated `ambiguous` is an
  authoring bug in the skill file's catalog label and is reported as one, with the
  candidate list 011 puts in `detail`. 012's checker pass over `skills/**` would
  move this class from hour three to second zero, which is the argument for
  building it.
- **An IGT that never returned an ok `igt_finish`.** This one has a consequence
  beyond the report: an unfinished IGT leaves a test *in progress*, which destroys
  017 rule 1's guarantee that nothing is running when the parent restores the
  page. So the parent routes through **`igt_abandon`**, which calls
  `save_progress_and_quit()` — through the `Options` menu, per 017, since it is
  not a button on question screens — before restoring. Without that node, one bad
  IGT leaf makes every subsequent restore unsafe.

*Not detectable, and deliberately not attempted:* the sub-agent that finishes
cleanly and is simply **wrong** — files the wrong catalog entry, misses a real
violation, answers Deque's question incorrectly. The graph has no node for this
and should not grow one. A self-critique step or an LLM judge would be a rule of
our own about what a correct accessibility finding looks like, which is what the
governing constraint exists to forbid, and CONTEXT already names the mechanism:
the output is a draft and a human signs off. The graph's only obligation is to
make wrongness *cheap to see* — which is why every `FiledIssue` carries the
`recordedLocation` selector the extension stored, why every coverage record names
its leaf, and why 012's low-confidence `note:` text is carried through to the
draft rather than summarised away.

---

### The graph

#### State

```python
class RunState(TypedDict):
    fixture: Fixture                                  # testId, name, url, viewport, serverUrl, userId
    model_id: str
    baseline: LedgerBaseline                          # advanced on every intact gate
    queue: list[UnitBrief]                            # consumed head-first by the active phase
    cursor: UnitBrief | None
    attempt: int
    reports: Annotated[list[SubAgentReport], operator.add]
    ledger: LedgerResult | None                       # the last checkLedger return, verbatim
    recoveries: dict[str, int]                        # "gate:{unit}:{verdict}" -> count, cap 1
    consecutive_failures: int
    halt: HaltReason | None                           # ("partial" | "void", detail)

class LeafState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    unit: UnitBrief
    steps: int
    done: bool
    exhausted: bool
    report_yaml: str | None                           # finish_unit's argument, unparsed

@dataclass(frozen=True)
class UnitBrief:
    unit_id: str            # "igt:structure" | "manual:12"
    kind: Literal["igt", "manual"]
    skill_path: Path
    tools: tuple[str, ...]  # from the skill file's front matter, validated at startup
    max_steps: int
    held_back: bool         # tools == () — skips restore and gate
    visual_signoff: str     # 012's front matter field, carried to the report
```

One queue, not two: the phases are the same builder run twice, and
`enter_fixture` and the `igt_phase → manual_phase` edge each load it.

#### Nodes and edges

`run_graph`:

| From | To | Condition |
|---|---|---|
| `START` | `enter_fixture` | |
| `enter_fixture` | `igt_phase` | skill files validated, baseline taken, panel seated |
| `enter_fixture` | `finalize` | validation failed, or the first gate was not `intact` → `halt_void` |
| `igt_phase` | `manual_phase` | queue drained, `halt is None` |
| `manual_phase` | `finalize` | queue drained |
| `finalize` | `END` | |

Both phases are `add_node("igt_phase", build_phase("igt").compile())` — real
subgraph composition on a shared schema. Every halt inside a phase leaves it with
`Command(graph=Command.PARENT, goto="finalize", update={"halt": ...})`, so
`finalize` is the single sink and no terminal path skips it.

`build_phase(kind)` — the same seven nodes for both phases, one of them IGT-only:

| From | To | Condition |
|---|---|---|
| `START` | `dispatch` | |
| `dispatch` | `END` | `queue` empty |
| `dispatch` | `unit` | pops head → `cursor`, `attempt = 1` |
| `unit` | `dispatch` | `cursor.held_back` — no restore, no gate |
| `unit` | `unit` | retryable disposition **and** nothing filed **and** `attempt == 1` |
| `unit` | `igt_abandon` | `kind == "igt"` and no ok `igt_finish` |
| `unit` | `restore` | otherwise |
| `igt_abandon` | `restore` | |
| `restore` | `ledger_gate` | |
| `ledger_gate` | `advance_baseline` | `intact` |
| `ledger_gate` | `recover_overview` | `panel-elsewhere`, budget left |
| `ledger_gate` | `recover_reopen` | `panel-detached`, budget left |
| `ledger_gate` | `ledger_gate` | `server-unreachable`, budget left |
| `ledger_gate` | ⇒ parent `finalize` | `panel-hidden`, `panel-orphaned`, or any budget spent → `halt_partial` |
| `ledger_gate` | ⇒ parent `finalize` | `test-lost`, `issues-lost` → `halt_void` |
| `recover_overview` | `ledger_gate` | `restore_page()` again |
| `recover_reopen` | `ledger_gate` | `reopen_saved_test()` |
| `advance_baseline` | ⇒ parent `finalize` | `consecutive_failures >= 3` → `halt_partial` |
| `advance_baseline` | `dispatch` | otherwise |

`leaf_graph`:

| From | To | Condition |
|---|---|---|
| `START` | `think` | |
| `think` | `act` | last message has tool calls |
| `think` | `END` | no tool calls → `incomplete` |
| `act` | `END` | `done` (finish_unit called) or `steps >= max_steps` → `exhausted` |
| `act` | `think` | otherwise |

**Strict sequence is a structural property, not a convention.** No `Send`, no
conditional edge returning a list of targets, and no two nodes sharing a
predecessor — any of the three puts LangGraph into a parallel superstep, and
there is one browser and one panel. `act` executes the **first** tool call in a
turn and answers every additional call with a `ToolMessage` telling the model to
re-issue it, because `parallel_tool_calls=False` is honoured by the hosted
production models and not reliably by a local one. `ToolNode` is deliberately not
used: it may execute a turn's calls concurrently, and it has nowhere to put the
step accounting.

#### The one number that must be measured rather than chosen

`max_steps`. 008 walked Structure in ten screens against a fixture page carrying
three heading levels, two lists and a `lang`-tagged passage. A real Amex page
state will be several times that, and an `element_multiselect` over fifty images
is one screen but a large one.

| Unit | `max_steps` | `recursion_limit` |
|---|---|---|
| IGT, any category | 80 | 170 |
| manual, default | 60 | 130 |
| manual #4 (two passes) | 120 | 250 |
| manual #12 (per data table) | 100 | 210 |
| held back (2, 10, 13) | 2 | 14 |

Budgets, not measurements. The first full run against a real page replaces them,
and an `exhausted` disposition is the signal that one is wrong.

#### Model and checkpointing

```python
model = init_chat_model(os.environ["AXE_MODEL"], temperature=0)
```

`init_chat_model` rather than a concrete class, because 018 requires the same
skill file to run against the development model and a production model on the
same fixture before a visual branch is done. Swapping models must be an
environment variable, not an edit. The model id is recorded on every
`SubAgentReport` alongside the unit's `visualSignoff`, which is what makes an
018 sign-off run auditable afterwards; nothing routes on either.

`AsyncSqliteSaver` on a file in the run directory, one thread per sub-agent under
one run id. **An honest limit, and it belongs to
[Settle observability](014-observability.md) rather than here:** this is a
*record*, not live resume. Resuming the graph after a Python-side crash is
meaningless because the fixture died with it, and a new fixture means a new
`testId` and therefore a different run. What the checkpoint buys is that the
reports and the transcript of a four-hour run that died at hour three are on disk
without having had to stream them anywhere.

---

### What this changes elsewhere

**Four amendments to [Settle the tool inventory](011-tool-inventory.md).** The
graph needs four things the inventory does not carry. Three of them 017 already
asked for.

1. **`restore_page()` must also return the panel to the overview**, and report it:
   `Result<{ reloaded, viewport, panelView, ledgerAlive }>`. Reloading the page
   does not move the panel, and a manual leaf that stops on the *Add Manual Issue*
   form makes the very next `checkLedger` return `panel-elsewhere`. Without this,
   the recovery path fires on nearly every manual unit — which is exactly the
   recovery-stops-being-exceptional failure 010 warns about.
2. **`reopen_saved_test()`** — press *view saved tests*, click the run's own entry
   (an `<a>`, not a button). 010 proved it end to end and 010's policy depends on
   it; the graph's `panel-detached` recovery has no other way to act.
3. **`save_progress_and_quit()`**, through the `Options` menu. 017 asked for it.
   `igt_abandon` cannot exist without it, and without `igt_abandon` a leaf that
   dies mid-IGT leaves a test in progress and makes every subsequent restore
   unsafe.
4. **`page_state_warning()`**, or `pageStateChanged` as a field on 011's `Screen`.
   017 asked for it, and `fixture/ledger.js` already computes it in `readPanel`,
   so it is free. This is a leaf obligation rather than a graph node — 017 rule 5
   — but a leaf cannot honour it if no tool exposes it.

**One amendment to [Settle the skill file format](012-skill-file-format.md).**
The closing YAML block is delivered as the argument of a `finish_unit` tool
rather than as free text in the last message. It changes nothing about the
format, gives the parent a parse point instead of a scrape, and gives the graph
its completion signal in the same move. Every skill file's `tools:` list gains
`finish_unit` — including the held-back files, whose `tools: []` becomes
`tools: [finish_unit]` so that *"emit this report and stop"* is something the file
can actually do.

**Three notes for CONTEXT** (not edited, per the constraint):

1. ***The ledger***, last paragraph: "two HTTP calls, ~2 seconds, **five
   verdicts**". `checkLedger` returns **eight** — `intact`, `panel-hidden`,
   `panel-elsewhere`, `panel-detached`, `panel-orphaned`, `test-lost`,
   `issues-lost`, `server-unreachable`. Five is the number of *checks*. The graph
   routes on eight, and the two numbers should not be conflated in the one
   sentence a reader will take the policy from.
2. ***Run shape***: "Main agent", "IGT agent", "manual agent". Under this
   resolution none of the three holds a model — they are deterministic
   `StateGraph`s, and only the twenty-three leaves are agents. Worth a clause,
   because "agent" currently implies a model is making the sequencing decisions
   and the whole argument here is that it must not.
3. ***Run shape***, the remediation sentence: "Parent agents own remediation.
   When a test leaves the page dirty… the parent restores it before the next
   sub-agent starts." Still true, but it reads as ledger-protective and 017 has
   moved it. *The ledger* already carries the corrected reason two sections
   earlier; the two sentences should agree that restoration is for measurement
   correctness alone.

**One note for MAP** (not edited, per the constraint): *Not yet specified →
**Sub-agent context handoff*** is settled by §2 and can come off the list.

---

# Amendments

Everything above is the resolution as it closed and is left as written. Each
section below is an amendment, named for the ticket that caused it.

## Amendment A — from [027](027-graph-amendments-from-the-build.md): the retry is a unit boundary, and §1f named the wrong construct

### A1. `unit → unit` is deleted. The retry decision moves behind the cleanup and the gate.

**The defect is that this section's prose and its edge table disagree, and the
build implemented the table.** §5(a) says, of a failed attempt, that *"the
transition is **always `ledger_gate` first** — is the ledger still there outranks
did that test finish"*, and only then *"if the gate says `intact`: retry once, on
a fresh `thread_id`, only if the attempt filed nothing."* The **Nodes and edges**
table above instead carries `unit → unit` on *"retryable disposition and nothing
filed and `attempt == 1`"*, ahead of the `igt_abandon` and `restore` rows — so a
retry skipped the cleanup, skipped the restore and skipped the gate.

For an IGT leaf that makes the retry unusable, and it was observed twice in
[025](025-build-v0.md) and reproduced deterministically here:

```
--- igt:structure (attempt 1)   errored: 9 tool calls, 0 filed, 1 tool errors
    retrying igt:structure on a fresh thread
--- igt:structure (attempt 2)   errored: 2 tool calls, 0 filed, 0 tool errors
        note: check_ledger returned panel-elsewhere
    igt_abandon: {'quit': True, ...}
```

Attempt 2 died on its **second** tool call. A leaf that dies mid-IGT leaves the
panel inside the guided test; the retry is a genuinely fresh sub-agent, so its
step 1 is `check_ledger`, which reads `panel-elsewhere` and aborts by the skill
file — a second attempt spent before the model decided anything. `igt_abandon`
then fired once, after *both* attempts. Since both of the two IGT runs that ever
completed in 025 completed on a retry, this is the transition IGT reliability
actually lives on.

**The shape, not a patch.** The fix is not "insert a restore before the retry" —
a bare restore would not have worked, because `restore_page` deliberately leaves
a running guided test alone (quitting one is a parent-tier decision, per 011
Amendment A3). The fix is to stop treating a retry as a special edge at all:

> **A retry is a new sub-agent on the same browser, so from the panel's point of
> view it is indistinguishable from the next unit — and every unit boundary is
> `cleanup → restore → gate`.**

So the retry decision moves out of `after_unit` and into `advance_baseline`,
which is the first place an `intact` gate is known. The revised rows:

| From | To | Condition |
|---|---|---|
| `unit` | `dispatch` | `cursor.held_back` — no restore, no gate |
| `unit` | `igt_abandon` | `kind == "igt"` and no ok `igt_finish` |
| `unit` | `restore` | otherwise |
| `igt_abandon` | `restore` | |
| `restore` | `ledger_gate` | |
| `advance_baseline` | `retry` | retryable disposition **and** nothing filed **and** `attempt == 1` |
| `advance_baseline` | ⇒ parent `finalize` | `consecutive_failures >= 3` → `halt_partial` |
| `advance_baseline` | `dispatch` | otherwise |
| `retry` | `unit` | `attempt += 1` |

`unit → unit` no longer exists.

**Does an IGT retry need `save_progress_and_quit` first? Yes, and the argument is
already in §5(c).** *"An unfinished IGT leaves a test in progress, which destroys
017 rule 1's guarantee that nothing is running when the parent restores the
page."* That sentence does not care whether what follows is the next unit or a
second attempt at this one. The routing rule is therefore unchanged — it is only
its position that moves — and `igt_abandon` now fires **between** attempts as
well as after the last one.

**What it does to the attempt budget: nothing to the count, and one unit boundary
to the cost.** The predicate is untouched — one retry, `attempt == 1`, only when
`report.filed == [] and report.igt_outcome is None`. What changes is that the
retry is now *paid for*: `save_progress_and_quit`, a reload, and a `check_ledger`
— roughly the ten to fifteen seconds every unit boundary already costs, and the
same boundary the run pays after the last attempt rather than an extra one. 010's
"a retry only when nothing was filed" is a rule about **duplicate findings**, not
about page reloads; §4 already prices the reload at 1–2 s and buys it
unconditionally between units for measurement correctness, which is exactly as
true for a second attempt at test 9 as for the test after it.

Two consequences worth stating, because both are policy touched in passing:

- **A retry now requires an `intact` gate.** If attempt 1 orphaned the panel, the
  run halts instead of spending attempt 2 writing into a panel that silently
  drops what it is given. That is a strict improvement and it is what §5(a)'s
  prose asked for.
- **`consecutive_failures` still counts units, not attempts.** The counter is
  folded in only on the non-retry path. The cap exists to say *the failure is the
  environment, not the tests*; counting attempts would halt a run two units
  earlier than the policy means to.
- **`recoveries` is keyed `gate:{unit}#{attempt}:{verdict}`, not
  `gate:{unit}:{verdict}`.** A retry crosses the gate a second time, separated
  from the first by a whole sub-agent run, and that is not the loop
  [010](010-ledger-loss-detection.md) forbids — the loop is
  `gate → recover → gate → recover` at one crossing. Keying on the unit alone
  would have let this fix silently halve an unrelated policy's budget.

### A2. §1f names the construct that defeats it.

The code block under **f. One MCP client for the whole run** reads:

```python
all_tools = await client.get_tools()          # once, at startup
```

`MultiServerMCPClient.get_tools()` opens a **new session per tool call**. Against
a server that *is* the fixture, that is a browser launch, a login, a scan and a
saved test per call — the single most expensive way to misread the paragraph the
line sits under, and the paragraph is right. The working form is one session held
open for the life of the run:

```python
async with client.session("axe") as session:
    all_tools = await load_mcp_tools(session)   # once, at startup
```

`from langchain_mcp_adapters.tools import load_mcp_tools`. Per-unit narrowing is
still `[t for t in all_tools if t.name in brief.tools]` over that one list, and
still never a second connection.

**`graph/mcp.py` was already built this way** — 025 caught the discrepancy during
the build and wrote the session form. This amendment corrects the spec so it
stops naming the wrong construct to the next reader.
