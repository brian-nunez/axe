---
id: 025
title: Build v0 — MCP server and graph, end to end
labels: [wayfinder:task]
state: closed
assignee: brian
blocked-by: []
---

## Question

The map's destination was *a v0 spec an agent can implement without further decisions*. That line is reached. This ticket crosses it.

[CONTEXT.md](../../CONTEXT.md) defines v0: **launch the fixture, run the Structure IGT, add one manual issue, print the output.** Every piece of that has been proven separately in `prototype/` — `make igt` walks Structure to a saved test, `make manual-issue` files against a selector, `fixture/` logs in and holds the session. What has never existed is the two layers above them.

Build:

1. **The MCP server**, per [Settle the tool inventory](011-tool-inventory.md) and its four amendments. Not all 33 tools — the subset v0 exercises: the session group, the IGT group, and manual read/write. The eight interaction tools and eight predicates serve the sixteen page state tests, which v0 does not run; leave them for the file that needs them. The server **is** the fixture: it launches the browser, logs in, holds the panel through the lifecycle traps, scans, saves, starts keepalive, and only then serves tools.
2. **The LangGraph graph**, per [Settle the agent graph](013-agent-graph.md). Three deterministic tiers over one model tier. Only the leaves hold a model. Two units for v0 — one IGT (Structure) and one manual — rather than all 23.

The proof is a run that completes both units unattended and prints its output, against a real saved test that survives a `checkLedger` gate between them.

Everything this needs is decided. The value now is in the integration: two layers that have only ever been specified, running against browser code that has only ever been driven directly.

## Resolution

**Both layers exist and both run.** The MCP server that is the fixture is
[`fixture/mcp-server.js`](../../fixture/mcp-server.js) over
[`fixture/fixture.js`](../../fixture/fixture.js),
[`fixture/panel.js`](../../fixture/panel.js) and
[`fixture/tools.js`](../../fixture/tools.js); the graph is
[`graph/`](../../graph/). `make v0` runs the two units against `AXE_MODEL` and
prints the draft; `make v0-scripted` runs the identical graph with a scripted
leaf in the model's seat.

### What was built

**The MCP server — seventeen tools, the v0 subset of the thirty-three.**

| Group | Tools |
|---|---|
| Session and graph | `check_ledger`, `read_test_results`, `restore_page`, `reopen_saved_test`, `save_progress_and_quit` |
| IGT path | `igt_list`, `igt_start`, `igt_current`, `igt_answer_choice`, `igt_answer_elements`, `igt_answer_each`, `igt_pick_elements`, `igt_finish`, `page_state_warning` |
| Manual path — read and write | `find_elements`, `describe_element`, `add_manual_issue` |

The eight interaction tools and the eight predicates are not built: they serve
the sixteen page state tests and v0 runs one of them, which needs none of them.
The authoring primitives are not built either — nothing has needed them yet, and
they arrive with the file that does.

**The server is the fixture.** `Fixture.start()` launches Chromium with the
unpacked extension, seeds a minted session, opens the target page, selects the
panel and holds it through the layout race, clears the onboarding chain, scans,
**saves the test**, resolves its id, takes the ledger baseline and starts the
keepalive — and only then does `tools/list` answer. Every lifecycle trap lives in
`fixture/panel.js` once: `tabbedPane.selectTab(id, true)`, the panel document's
own body box sampled twice with a beat between, the onboarding chain, clicks
dispatched on the element, exact names filtered to visible *and* non-disabled
with `aria-disabled` checked as well as the property. Nothing refreshes or closes
the extension.

**The graph — three deterministic tiers over one model tier.** `run_graph`,
`igt_phase` and `manual_phase` hold no model; `bind_tools` is called once per
sub-agent in [`graph/leaf.py`](../../graph/leaf.py) and nowhere else. A leaf is a
separately compiled graph invoked with a hand-built payload, never
`add_node(subgraph)`. `finish_unit` is graph-provided, and the startup
cross-check resolves front matter against the served set **plus `finish_unit`** —
without which all twenty-three files would fail at second zero, which is what
[023](023-graph-tool-amendments.md) caught. Two units are queued;
[`graph/units.py`](../../graph/units.py) carries the whole binding table, so the
other twenty-one are a list, not a change.

**Two skill files, because the graph needs something to read.**
[`skills/igt/procedure.md`](../../skills/igt/procedure.md) is the one shared
procedure [013](013-agent-graph.md)'s lookup rule allows for all seven
categories. [`skills/page-state/11-alternatives-for-timed-media.md`](../../skills/page-state/11-alternatives-for-timed-media.md)
is the manual unit: test 11 was chosen because it is one of only two tests whose
binding is exactly the base four, so it needs no tool this ticket left unbuilt.
`make check-mapping` passes over both.

**A page state to run against.** [`fixture/target/`](../../fixture/target/) — one
URL, reachable by URL alone, carrying what both units need: headings, a real list
and a fake one, an untagged French passage, and a recorded video with audio, no
captions track and no transcript. `--url=` points the fixture at a real page
state instead; nothing in the tool layer or the graph knows about this file.

### The proof

Two runs, and they prove different halves.

**Deterministic half — `make v0-scripted`, reproduced four times, identical every
time.** The scripted leaf occupies the leaf's seat in the compiled graph and
produces the tool calls the skill file prescribes, reading its page-specific
answers from [`fixture/target/answers.json`](../../fixture/target/answers.json).
Everything else is the production path. Each run:

```
binding check: 2 units against 17 served tools — ok
fixture seated: test <id> holding 19 issues
--- igt:structure    completed: 13 tool calls
    restore_page → panelView overview, ledgerVerdict intact
    ledger gate: intact
--- manual:11        completed: 7 tool calls, 2 filed
    ledger gate: intact
ledger  22 issues — 19 automatic, 1 guided, 2 manual
```

The guided issue is Deque's own *Content appears like a list but is not marked up
as such.*, produced by the element picker taking `p.fake-list`. The two manual
issues are real catalog entries filed against `#briefing`, and the extension's
own recorded location comes back as `body > video#briefing:nth-of-type(1)`. The
checkpoint database holds 67 checkpoints across three thread ids — the run and
one per sub-agent.

**Model half — `make v0`, `AXE_MODEL=ollama:gemma4:e2b`.** Two runs completed
both units unattended, the second of them on the finished code:

```
--- igt:structure (attempt 1)   incomplete: 9 tool calls
    retrying igt:structure on a fresh thread
--- igt:structure (attempt 2)   completed: 7 tool calls
    ledger gate: intact
--- manual:11 (attempt 1)       completed: 5 tool calls, 1 filed
    ledger gate: intact
ledger  28 issues — 19 automatic, 8 guided, 1 manual
```

That is the run the ticket asked for: both units, no supervision, a `checkLedger`
gate between them against a real saved test that ended the run holding eight
guided issues and one manual issue neither of which existed when it started.

**It is not repeatable, and that is the finding.** Across nine E2B runs — the
first run, which died on a provider-capability bug now fixed, is excluded — the
manual leaf completed seven times and filed a real issue in five; the IGT leaf
completed **twice**, and both times on its second attempt. `gemma4:12b` was no
better on the IGT. The failures are all one shape — the model stops emitting tool
calls part-way through the procedure and answers in prose — and the graph handled
every one of them exactly as [013](013-agent-graph.md) specifies: `incomplete`,
retry once on a fresh `thread_id` because nothing was filed, `igt_abandon`
through the Options menu when the IGT never finished, `restore_page`, gate, next
unit. **The deterministic tiers behaved correctly in all nine runs.** No run lost
a ledger, no run printed a draft it should not have, and no run left an IGT in
progress.

This is [018](018-vision-on-the-dev-model.md)'s *development proves shape* with a
sharper edge than it anticipated: on this fixture, E2B does not reliably prove
even shape on the IGT path. That is a measurement about the model, not about the
graph, and the honest next step is a production model on the same fixture rather
than more prompt work on this one.

### What the build found that the specs did not say

**The overview is two views, and only one of them can file.** `checkLedger`
accepts `overview` and `overview-igt` as checkpoint views, but only `overview`
carries *Add Manual Issue* — and finishing an IGT leaves the panel on
`overview-igt`. [011](011-tool-inventory.md) Amendment A1's "return the panel to
the overview" has to mean that view specifically, not merely a view the gate
accepts. Without it every manual unit after an IGT gets `rejected` on its first
write, which is what the first full run did.

**The IGT entry control is named two different things.** From a fresh home view
it is a button named `Structure`; inside a saved test it is `Start Structure Run`
— an icon button whose whole accessible name arrives through `aria-labelledby`
pointing at a hidden tooltip. A name resolver reading only `aria-label` and
`textContent` sees an unnamed button and skips it. Recorded in
[017](017-igt-page-state-tolerance.md)'s prototype, absent from 011's
`igt_start(category)`.

**`igt_finish` against an already-saved test does not prompt for a name.** 011's
one recorded residual risk, settled: the *Save your results* dialog appeared in
none of the runs here. `igt_finish` handles it either way and `name` stays
optional.

**Every wrong-screen refusal has to name the next action.** A small model that
calls `igt_start` twice, or `igt_finish` from a question screen, gets
`wrong_screen` — and with only "this tool does not apply" it has no route back
and the unit dies. Refusals now say what is showing, which tool that screen
wants, and to call `igt_current()` when nothing matches. In the run that
completed both units, that message is what rescued the IGT's second attempt.
This is `Screen.answerWith`'s design rule applied to the error path, and it
belongs in the inventory.

**The server records one issue per element, not one issue with many elements.**
`help` is the short title, `description` the rule, `summary` the detail, and
`selector` is an **array** of selectors. 011's `Issue` shape and `FiledIssue`'s
`recordedLocation` both assume otherwise; `read_test_results` folds identical
findings back together and `recordedLocation` unwraps a single-element array.

**`Ledger.igt`'s `completed` is not a fact the server holds.**
`GET /api/tests/{id}/manifests` is keyed by guide name and carries one record per
run, with no issue count and no completion flag — the per-guide issue count comes
from the issues endpoint instead. `completed` is derived as *a run was recorded*,
which is what a manifest actually means, and a manifest is written by
`Save progress & quit` as well as by Finish. Nothing in v0 routes on it; a run
that needs a real completion signal has to read the panel's own progressbar.

**A text `Evidence` needs the element's markup.** Half of what an auditor judges
is markup that renders as nothing — a missing `<track kind="captions">`, an
absent `alt`, a role that is not there. 011's `Evidence` carries `context` (what
follows) and no markup, and test 11 cannot be answered without it.
`describe_element` now returns `markup` alongside `context`.

**A `single_choice` screen has no evidence.** 011 populates `Screen.evidence`
from the policy table for every screen; on a yes/no question the only "elements"
are the two answer labels, which are already in `options`. Returning them twice
is tokens a small model reads twice. Evidence is populated for the
element-bearing screens only.

**`MultiServerMCPClient.get_tools()` opens a new session per tool call.**
[013](013-agent-graph.md) §1f's "one client, one stdio session, one browser" is
`client.session(...)` plus `load_mcp_tools`, not `get_tools()` — against this
server the documented default would launch a browser, mint a session, scan and
save a test **per tool call**. This is the single most expensive way to
misread that section and it is one line of code away.

**`reports` cannot be a reducer channel.** Both phases are real subgraphs on the
shared `RunState` schema, so `Annotated[list, operator.add]` applies once inside
the phase and again when the phase's state merges into the parent's, and every
unit appears in the draft twice. It appends explicitly instead.

**A phase node's `Command[Literal[...]]` must not name the parent's `finalize`.**
LangGraph reads the annotation as declared edges, so naming the parent's sink
makes the phase graph fail to compile — `Command(graph=Command.PARENT)` resolves
at runtime and needs no declaration.

**The checkpoint has to close before the MCP session.** SQLite in WAL mode folds
its log into the database file when the last connection closes cleanly, and a
connection torn down inside the MCP client's cancelling task group does not close
cleanly. Nested the wrong way round it leaves a zero-length database beside a log
SQLite will not read — a record nobody can open. Entered inside the session, the
run leaves one readable file.

**`parallel_tool_calls` is accepted at bind time and refused at invoke time** by
a local runtime, which turns a provider-capability question into a lost unit. The
flag is asked for and dropped on first refusal; `act` enforces the property
structurally by executing one call per turn whatever the model sends.

### One gap in [013](013-agent-graph.md), observed rather than argued

**The `unit → unit` retry has no restore between attempts, and for an IGT leaf
that makes the retry unusable.** A leaf that dies mid-IGT leaves the panel inside
the guided test. The retry is a genuinely fresh sub-agent, so its step 1 calls
`check_ledger`, gets `panel-elsewhere`, and aborts by its own skill file — a
second attempt spent on a panel the first one left dirty. Observed twice. It is
survivable now only because `igt_start` refuses with a message that names
`igt_current`, which lets a retry find its way back into the running test. The
edge itself still says otherwise, and the cheap fix is a `restore` before a retry
of a panel-touching unit. **Not changed here**, because 013 is closed and this
belongs in an amendment rather than in a build.

### For CONTEXT.md — not edited, per the constraint

1. ***v0*** currently reads *"No skill files, no sub-agents, no accessibility
   intelligence."* Two of those three moved. v0 as built runs two real sub-agents
   against two real skill files; what it still has none of is accessibility
   intelligence of ours, which is the part the governing constraint cares about.
   The manual half is **page state test 11**, not a bare *add one manual issue* —
   because a manual leaf needs a skill file, and 11 is one of only two tests whose
   binding is the base four.
2. ***The ledger***, on cost: `checkLedger` is described as *two HTTP calls, ~2
   seconds*. `check_ledger` as served makes **three** — the third reads
   `/manifests` for the `Ledger.igt` breakdown 011 promises. Still well under a
   minute across a full run, but the number in that sentence is the one a reader
   takes away.
3. ***Held back on purpose*** could name the target page. v0 ships one at
   `fixture/target/`, and MAP's open question about *a target page for v0 that is
   not the obvious one* is now answered for development and still open for a real
   Amex page state.

### Not done, and why

- **The eight interaction tools, the eight predicates and the nine authoring
  primitives.** They serve the fifteen page state tests v0 does not run. Building
  them here would be building them untested against the file that needs them.
- **The other twenty-one units.** `graph/units.py` carries the binding table for
  all twenty-three and `v0_queue()` returns two; the remaining nineteen page
  state skill files are MAP's already-recorded bulk work.
- **A production model on this fixture.** [018](018-vision-on-the-dev-model.md)
  requires one before any visual branch is signed off, and the E2B measurements
  above are an argument for running one sooner than that.

## Reopened

**The proof this ticket claimed was one run, and the bar is five.** The
Resolution above reports two of nine E2B runs completing both units and calls the
result *not repeatable*. That is an honest measurement and it is not a closed
ticket: `make v0` is done when it completes one IGT unit and one manual unit on
five consecutive runs, with the manual unit **filing** rather than merely
completing — a `not-applicable` on a page that carries a video is a unit that
found nothing, not a unit that worked.

A real run after the close named three design faults, all in the specs rather
than in the graph:

1. **`wrong_screen` carried `retryable: false` while its `detail` named the
   recovery.** The envelope contradicted itself and the model believed the flag.
   Amended in [011](011-tool-inventory.md) Amendment F.
2. **`skills/igt/procedure.md` step 1 carried a complete, fill-in-the-blank
   ABORT report** — the only fully-worked report in the file, in the system
   message from the first token. The model copied it almost verbatim, `leaf:
   "0.ledger-lost"` included, over a ledger that was intact. Amended in
   [012](012-skill-file-format.md) Amendment E.
3. **The file contradicted itself about aborting**: step 6 said abort when
   `igt_finish` returns `ok: false`, step 4 said a refused tool is never a reason
   to abort. The model followed the abort.

A fourth, found by reading the failing transcripts rather than the specs: **the
`Screen.step` field collided with the procedure's own numbered steps.** Both
failing runs quit the guided test on the screen labelled `step: "4"`. The field
is now `panelStep`.

Closes again only on five consecutive clean runs.

## Closed again — five consecutive clean runs

`make v0` completed one IGT unit and one manual unit, first attempt, on five
runs in a row, against `fixture/target/` on the development default
`openai:docker.io/ai/gemma4:e2b`. No frontier model was used and no default was
changed to reach the bar.

| Run | `igt:structure` | `manual:11` | Filed into the saved test | Ledger after |
|---|---|---|---|---|
| 1 | completed, attempt 1, 13 calls | completed, attempt 1, 9 calls | 1 | 19 auto / 1 guided / 1 manual |
| 2 | completed, attempt 1, 14 calls | completed, attempt 1, 10 calls | 1 | 19 / 1 / 1 |
| 3 | completed, attempt 1, 13 calls | completed, attempt 1, 13 calls | 4 | 19 / 0 / 4 |
| 4 | completed, attempt 1, 16 calls | completed, attempt 1, 8 calls | 1 | 19 / 0 / 1 |
| 5 | completed, attempt 1, 14 calls | completed, attempt 1, 11 calls | 3 | 19 / 0 / 3 |

No run halted, no run retried a unit, no ledger was lost, and every manual unit
filed a real catalog entry against `#briefing` — the captions failure the page
carries — rather than completing on `not-applicable`.

### What the five runs still show, and it is not a completion problem

**Judgement varies where a branch is judged rather than measured.** Two of the
five Structure walks produced a guided issue and three produced none; three of
the five manual reports claimed a `filed:` for a branch no call had filed, and
[013](013-agent-graph.md)'s reconciliation stripped each one and named it on the
draft. Run 3 filed the same captions entry three times, which mis-states the
draft's counts.

Both are the same shape: the branches that stayed judged are the ones that
wobble. **The branch that was converted from a judgement to a measurement filed
correctly in five runs of five** — see 012 Amendment F.

### Two things that had to be fixed to get a run started at all

Neither is a model problem, and both cost whole runs before they were found.

**The fixture read the scan total once after a fixed settle.** A slower scan than
the settle allowed produced *the full-page scan produced no issue total* and the
run never reached the graph. The total is polled for now, with the settle as a
floor rather than the whole budget. The same fault, and the same fix, for *Add
Manual Issue* enabling after the save — that one round-trips to the server.

**Two `make v0` runs on one host contend for the single local model runtime.** A
second run started alongside these stretched one unit past forty minutes without
erroring, because there is no request timeout on the model client. The five runs
above were serialised behind a check for any other `graph.run` on the host, and
each records whether one appeared while it ran. **A request timeout on the model
client belongs in `graph/run.py`** — an hour-long silent stall is
indistinguishable from progress and no policy in the graph covers it.
