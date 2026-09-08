---
id: 014
title: Settle observability for a four-hour run
labels: [wayfinder:grilling]
state: closed
assignee: brian
blocked-by: [005, 010]
---

## Question

How does a human tell what a four-hour run is doing, and how does a failed run get diagnosed afterwards?

noVNC shows the live browser, which serves watching but not diagnosis. A run that fails at hour three needs enough recorded to understand why without repeating it.

Decide what is captured: per-sub-agent traces, panel state at each transition, screenshots at branch points, the ledger check results. And decide where the fixture's reproducibility is actually exercised — replaying from an identical starting state is the payoff, so something has to make replay a real operation.

Resolve with the trace format and the replay story.

## Resolution

**A run directory, a JSON Lines trace, and replay as a command that runs one
unit.**

The last of those is the answer to the part of the question that matters. A
reproducible fixture whose only replay is *run the four hours again* is a
reproducibility claim nobody exercises, and a claim nobody exercises rots. So
replay is three operations — verify, re-run, **re-run one unit** — and the third
is the one that makes the other two worth having.

---

### 1. What a run leaves behind

One directory per run, created by the container's entrypoint before the fixture
starts, bind-mounted so it survives the container:

```
build/runs/<run-id>/
  provenance/container.json   what the fixture was made of      (entrypoint, implemented)
  provenance/run.json         what the fixture resolved         (fixture)
  trace.jsonl                 the run, one event per line       (all writers)
  units/<unit-id>/report.yaml     finish_unit's argument, verbatim and unparsed
  units/<unit-id>/transcript.json every message and every tool result in full
  units/<unit-id>/evidence/*.png  the images the unit's tools returned
  ledger/<seq>-<unit-id>.json every checkLedger return, verbatim
  checkpoints.sqlite          013's AsyncSqliteSaver
  draft.json / draft.md       the output — or failure.json on halt_void
```

The split between `trace.jsonl` and `units/` is the design decision, not a filing
convention. **The trace is an index; `units/` holds the material.** A trace line
carries a tool call's name, verdict, timing and outcome; the tool's full return
value, the model's messages and every image live in the unit directory and are
referenced by path and digest. Without that split the trace becomes megabytes of
base64 nobody greps, and the one artefact that has to be readable at 2am stops
being readable.

`checkpoints.sqlite` is 013's, and 013 is already explicit that it is a record
rather than live resume — the fixture dies with the Python process and a new
fixture is a different run. It is in this directory because that is where the
rest of the run's record is.

---

### 2. What is captured per unit

013's `SubAgentReport` is the coverage-plus-ledger reconciliation and every field
of it is persisted as-is. Seven more fields are added here, each because a real
diagnostic question cannot be answered without it.

| Added field | The question it answers |
|---|---|
| `started_at`, `ended_at`, `duration_ms` | where four hours went, and which unit to split |
| `steps_used` / `max_steps` | whether an `exhausted` unit was close or nowhere near — 013 calls `exhausted` an authoring signal, and a signal without a number is an opinion |
| `tokens_in`, `tokens_out` per model turn | whether window trimming started dropping evidence, which on an E2B-class window is the difference between a visual test running and not |
| `skill_path` + `skill_sha256` | *which version of the file produced this.* The 16 skill files are under active authoring while runs happen; a report that names a path and not a digest cannot be trusted a week later |
| `tools_bound` | what the binding actually was, not merely that 013 §1e's cross-check passed |
| `panel_view_before` / `panel_view_after` | `restore_page`'s `panelView` either side, which is what distinguishes *the leaf left the form open* from *the panel moved on its own* |
| `evidence[]` | `{path, sha256, kind, caption, condition}` per image, so a finding in the draft can be traced to the picture it was judged from |

Plus, from the gate that follows the unit: the verdict, the full `Ledger`, and
the counts. 013 already puts `ledger_after` on the report; the counts are what
make it possible to date a loss rather than merely notice one.

**Held-back units (2, 10, 13) produce a report too.** They are bound only
`finish_unit`, skip restore and skip the gate, and their `not-run` record with
its reason is the whole reason they stayed in the queue. A run whose trace is
silent about test 13 is exactly the draft CONTEXT argues against.

---

### 3. The trace format

**JSON Lines. One object per line, append-only, flushed per line.**

The format follows from the failure it has to survive: a run that dies at hour
three, possibly by being killed. A JSON document is only valid once it is closed,
and a killed run never closes it. A line-oriented file is complete at every
moment, is readable by `tail -f` while the run is live, and is greppable and
`jq`-able afterwards without a parser that understands it.

It also has to tolerate **more than one writer**. The container's VNC hook is a
shell script appending `console_attached` from outside the Node process
(implemented in `docker/vnc-event.sh`). So: every line is opened `O_APPEND` and
kept under 4 KB, which on Linux makes the write atomic and non-interleaving. That
constraint is what forces values to be summarised in the trace and stored in
full under `units/`, and it is a better reason for the split than tidiness.

Every record carries `ts`, `seq`, `runId`, `event`; unit-scoped records also
carry `unit` and `attempt`. `seq` is monotonic per run and is what a reader sorts
by — timestamps repeat within a millisecond and clocks are not the record.

```json
{"ts":"2026-09-08T02:14:07.412Z","seq":1042,"runId":"20260908T015800Z-9f3c",
 "event":"tool_call","unit":"manual:12","attempt":1,"step":14,
 "tool":"check_table_semantics","ok":true,"ms":812,
 "value":{"outcome":"fails","leaves":["header-markup","header-associations"]},
 "aftermath":{"pageDirty":true,"refsInvalidated":false,"navigated":false}}
```

A value that would exceed the line budget is truncated with `"truncated":true`
and the full value is in that unit's `transcript.json`. `find_elements` over
three hundred elements is a legitimate 200 KB and nobody diagnoses from it.

**The event vocabulary is closed, and it is the graph's own nodes** rather than a
parallel invention — a trace that does not name the same things the graph does
cannot be read against it.

| Event | Written at | Carries |
|---|---|---|
| `run_start` | first line | run id, `provenance/container.json` digest, replay-of |
| `validation` | 013 §1e | 23 units, every front-matter tool resolved, or the mismatch that aborts |
| `fixture_ready` | after `enter_fixture` | `testId`, baseline counts, `provenance/run.json` digest |
| `unit_start` | `unit` node | unit id, kind, attempt, skill digest, tools bound, budget |
| `model_turn` | each `think` | step, tokens in/out, latency, tool calls requested, whether images were trimmed |
| `tool_call` | each `act` | tool, ok/error code, ms, summarised value, `aftermath` |
| `unit_end` | `unit` node | disposition, steps used, filed count, reconciliation mismatches, transcript digest |
| `restore` | `restore` node | `reloaded`, viewport, `panelView`, `ledgerAlive` |
| `gate` | `ledger_gate` | verdict, counts, ms, path to the verbatim `ledger/*.json` |
| `recovery` | `recover_*` | which node, budget remaining, the verdict after |
| `baseline_advance` | `advance_baseline` | old and new floor |
| `keepalive` | each refresh grant | token fingerprint, new expiry |
| `page_state_warning` | a leaf's `page_state_warning()` | unit, view, message |
| `console_attached` / `console_detached` | x11vnc hooks | client address, whether interactive |
| `halt` | either abort | `partial` / `void`, reason, last `intact` gate, last completed unit |
| `run_end` | last line | units by disposition, wall clock, exit code |

Two of those exist for reasons worth stating.

**`keepalive`.** The access token lives 90 minutes and a four-hour run crosses two
expiries out of band. When a run dies at hour three the first question is whether
the session lapsed, and it is unanswerable after the fact unless each refresh was
recorded when it happened.

**`baseline_advance`.** 013 advances the floor on every `intact` gate, which is
what makes `issues-lost` able to fire on work done during the run. The trail of
those advances is the only thing that can **date** a loss: the last gate where
the count was right bounds the window a human has to re-examine.

---

### 4. Screenshots: at branch points, no — at unreproducible transitions, yes

The ticket asks for screenshots at branch points. **Declined as stated, and
replaced with a narrower rule**, because branch points are the part the trace
already reconstructs perfectly: which leaf fired is in the `Verdict`, the
`because` line is in the tool call, and the coverage record names it.

Captured:

1. **Evidence images**, always — every `describe_element(need:"image")` and
   `capture_under` result. They are already being produced, they are part of the
   draft, and a visual finding whose picture was discarded cannot be reviewed.
2. **On any gate verdict that is not `intact`**: one Playwright screenshot of the
   panel and one of the page. This is the case the trace genuinely cannot
   reconstruct — `panel-orphaned` and `panel-hidden` are two lines of identical
   text and two very different pictures, and 010 measured that an orphaned panel
   *looks completely healthy*. It costs nothing on the healthy path because it
   only fires on failure.
3. **On any unit whose disposition is not `completed` or `skipped`**: the same
   pair. A `rejected_writes` unit is diagnosed by seeing which dialog was open;
   an `errored` one by seeing where it stopped.

Not captured: anything per model step or per tool call. Twenty-three units at
sixty steps is well over a thousand images a run, hundreds of megabytes, and
nobody has ever read the four-hundredth one.

Panel screenshots come from Playwright against the DevTools page, never from the
extension — the extension's capture path is `chrome.debugger` on the *inspected*
tab and photographs the wrong thing.

---

### 5. The ledger gates are recorded verbatim, all twenty-two

`checkLedger` returns eight verdicts off five checks, and 013 routes the graph on
them. Every return is written whole to `ledger/<seq>-<unit>.json` — both halves,
the panel read and the server read — not summarised into the trace line.

The reason is 010's central finding: **the two halves disagree, and which one was
wrong is the diagnosis.** A panel reporting the right test name and the right
counts over a ledger that no longer exists is the failure this whole design was
built to catch, and a record that keeps only the verdict throws away the evidence
for how it was reached. Two HTTP kilobytes times twenty-two is free.

---

### 6. Replay

This is what the fixture is for, and it is now a command.

**Replay is not resume, and the distinction is load-bearing.** 013 already
establishes that resuming a graph after a Python-side crash is meaningless: the
fixture died with it, a new fixture means a new `testId`, and a run keyed on a
different saved test is a different run. What can be restored is the **starting
state**. What makes restoring it worth anything is being able to re-run *one
unit* against it.

**Three operations, implemented in `docker/replay.sh`.**

**(a) `--check` — verify the inputs still produce the same fixture.** Seconds, no
browser, no session. Three things must match, and each fails loudly rather than
producing a fixture that is nearly right, because a nearly-identical fixture is
worse than no replay — it reproduces a different run and looks like a result.

| Checked | Against |
|---|---|
| the image | present locally, and its digest equal to the recorded one |
| the pinned extension | `vendor/axe-devtools/axe-extension.lock.json`'s `sha256` equal to the recorded CRX digest |
| the managed policy | **re-rendered inside the recorded image from the recorded environment** and compared key by key with the policy that run actually used |

The third is the one nothing else would catch: a `render-policy.py` edit, or a
Deque `schema.json` that stopped declaring a key, both change the extension's
settings while leaving the image tag and the lock file untouched. Tested against
a run directory with two keys altered by hand — it refused and named both:

```
policy drift:
  AccessibilityStandard: 'wcag21aa' -> 'wcag22aa'
  EnableIssueScreenshots: False -> True
replay: the extension policy has changed since that run; the fixture would not be identical
```

**(b) Full replay — `docker/replay.sh build/runs/<id>`.** The same `docker run -i`
with the inputs read off disk, a fresh run id, and `AXE_REPLAY_OF` recorded so a
chain of attempts at one failure reads as a chain. Crucially it is **the same
mechanism as a normal run, not a parallel one**: because 005 decision 5 makes the
container's stdout the MCP transport, `replay.sh` is itself a valid MCP stdio
command, and the graph replays a run by pointing its client at
`{"command": "docker/replay.sh", "args": [run_dir]}`. Replay that needs its own
code path is replay that stops working; this one is exercised every time it is
used.

**(c) Single-unit replay — `--unit manual:12`.** Sets `AXE_ONLY_UNITS`; the graph
loads a one-unit queue. **This is the operation that makes reproducibility real.**
The run that died on unit nineteen is reproduced in one scan plus one unit —
minutes, one `$20–50` scan — against a fixture proven identical, with the same
skill file digest and the same model. Without it the honest cost of reproducing
any failure is four hours, which means it is never done, which means the fixture's
central claim is decorative.

The three held-back units still emit their `not-run` record under `--unit`, since
that costs nothing and keeps a single-unit replay's output the same shape as a
run's.

**What replay cannot reproduce — recorded, so that divergence is attributable.**
Four things, each cheap to capture and each otherwise the first hour of a
diagnosis:

| Not reproducible | Recorded as |
|---|---|
| **the page** | a DOM digest and a full-page screenshot of the target at fixture time. A replay that diverges is then the page's fault or the agent's, and the record says which |
| **the model** | `model_id` on every report and every `model_turn`. `temperature=0` is not determinism |
| **the axe DevTools Server** | `/api/internal/server-info` verbatim at fixture time. It carries `version`, `screenshotsEnabled`, `mlServiceEnabled` — measured today as `6.1.0` and `true`. If image and policy match and a replay still behaves differently, this is the next suspect and the only place it shows |
| **the catalog** | its entry count and a digest of the option-text list. A mapping row that resolved yesterday can return `ambiguous` today, and 013 calls a repeated `ambiguous` an authoring bug — which it is not, if the catalog moved |

**And what replay is not for.** It does not re-file issues into the original saved
test, it does not delete anything, and it does not merge. A replay produces its
own test on the server, exactly as a run does. There is nothing to reconcile
because CONTEXT already prices the alternative: re-running a page state is the
only recovery, and it is affordable.

---

### 7. What the record has to be able to answer

The design is checked against the questions a person actually asks at hour three,
because an observability design that is a list of what is easy to log is how runs
end up unexplainable.

| Question | Answered by |
|---|---|
| Where did it stop, and what had already been filed? | `halt` — last `intact` gate, last completed unit — plus `ledger/` at that gate |
| Was it the model or the panel? | the unit's `disposition` against the gate that followed it; a leaf that broke the panel ends its transcript in `panel_unavailable` |
| Was the session still alive? | `keepalive` events across both 90-minute expiries |
| Was it the same page all the way through? | `restore` events with the URL, plus the target DOM digest in provenance |
| Did a human touch it? | `console_attached` / `console_detached`, and `console.interactive` in provenance |
| Which version of the skill file produced this finding? | `skill_sha256` on `unit_start` |
| Why does the draft say this? | the coverage record's leaf → the `tool_call` that measured it → the evidence image, all in one unit directory |
| Will it happen again? | `replay.sh --check`, then `--unit <the one that died>` |

The last row is the point of the whole ticket. The rest is what makes it possible
to know which unit to name.

---

### 8. Cost, and what it is measured against

A four-hour run: roughly 23 units × 60 model turns, so a few thousand trace lines
at ~400 bytes — one to two megabytes. Evidence images are however many the visual
branches produced, typically dozens; failure screenshots fire only on failure.
Under 50 MB for a whole run, and every write is a local append.

Against a gate that costs 1.7–2.8 s and a scan that costs \$20–50, none of this is
worth optimising. The thing worth spending on is the split that keeps
`trace.jsonl` small enough to read.

---

### 9. What this asks of the graph and the fixture

Contract notes for whoever builds `fixture/mcp-server.js` and the Python graph.
The container half is implemented.

- **`AXE_RUN_DIR`** — created by the entrypoint, owned by `pwuser`, with
  `provenance/`, `units/`, `ledger/` and an empty `trace.jsonl` already in place.
  Everything above is written there.
- **`provenance/run.json`** — the fixture's half, written once the session exists:
  resolved `testId` and name, target URL, viewport, baseline counts, the
  `server-info` document verbatim, the catalog digest, the target's DOM digest and
  screenshot path, `model_id`, the skill file digests, and the tool names the
  server actually served (013 §1e's validation input). `replay.sh` reads
  `container.json`; a human reads both.
- **`AXE_ONLY_UNITS`** — comma-separated unit ids. The queue is filtered to them;
  everything else about the run is unchanged.
- **`AXE_REPLAY_OF`** — set by `replay.sh`, recorded in provenance.
- **Trace lines are appended `O_APPEND`, one line per event, under 4 KB.** More
  than one process writes this file.
- The trace's event names are the graph's node names. If a node is added, it gets
  an event; if an event has no node, it should not exist.

### Notes for CONTEXT (not edited, per the constraint)

1. ***The fixture***, "The payoff is reproducible failure. A four-hour run that
   breaks at hour three replays from an identical fixture instead of re-deriving
   its own starting state." True, and now it has a command — worth naming
   `docker/replay.sh` and, more importantly, saying that the replay that gets used
   is **one unit**, not the whole run. The sentence as written implies re-running
   four hours, which is the version nobody does.
2. ***Run shape*** could note that a run keeps a directory — provenance, trace,
   per-unit reports and the ledger reads — since three tickets now write into it.
3. ***The ledger***: the eight verdicts are recorded verbatim per gate. This is
   the second ticket to want that sentence to say eight rather than five; 013
   already asked.
