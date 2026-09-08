---
id: 027
title: Amend the graph and the tool contract from what the build found
labels: [wayfinder:task]
state: closed
assignee: brian
blocked-by: []
---

## Question

[Build v0](025-build-v0.md) built [013](013-agent-graph.md) and [011](011-tool-inventory.md) and found four places where the specs are wrong or incomplete. Three are corrections; one is a gap observed failing twice in real runs.

**1. `MultiServerMCPClient.get_tools()` opens a new session per tool call.** 013 §1f says one MCP client for the whole run, which is right, but names the construct that defeats it. Against a server that *is* the fixture, a session per tool call means a browser launch, a login, a scan and a saved test **per call**. The working form is `client.session(...)` plus `load_mcp_tools`. This is the single most expensive mistake in the specs as written.

**2. The overview is two views, and only one of them can file.** `overview` carries *Add Manual Issue*; finishing an IGT lands on `overview-igt`, which does not. [011](011-tool-inventory.md) Amendment A1 says `restore_page` returns the panel "to the overview" — it has to mean `overview` specifically, or a manual unit following an IGT unit finds a panel that cannot write.

**3. A `wrong_screen` refusal must name the next action.** Not a style note: 025 reports it is what rescued both successful IGT runs. A refusal that says only *this tool does not apply here* leaves a small model to guess; one that names the tool that does apply steers it back. This belongs in 011's error contract, not in prose.

**4. The `unit → unit` retry has no restore, and it aborts IGT retries.** Observed twice. 013's retry transition goes straight back to the `unit` node, so an IGT retry begins on a panel still inside the guided test — and the leaf's own step 1 aborts because the panel is not where the skill file says it starts. Every one of the two successful IGT runs succeeded *on a retry*, which makes this the transition that matters most.

The fix is not obviously "always restore before a retry": [010](010-ledger-loss-detection.md)'s policy is a retry only when nothing was filed, and a restore that reloads the page is not free. Decide whether the retry edge routes through `restore`, whether an IGT retry needs `save_progress_and_quit` first so the abandoned attempt does not leave a test in progress, and what that does to the attempt budget.

Resolve by amending 013 and 011 in place, marked as amendments from this ticket, and by making the `unit → unit` retry work for an IGT unit in `graph/`.

## Resolution

**All four are resolved, plus a fifth found in the same run.** Item 4 was
reproduced deterministically, fixed, and the fix exercised on the retry path
against a live panel. [013](013-agent-graph.md) carries **Amendment A** and
[011](011-tool-inventory.md) carries **Amendment E**, both marked as coming from
here.

### 4 — the retry, which was the urgent one

**The defect is that 013's prose and its edge table disagree, and the build
implemented the table.** §5(a) says a failed attempt goes to `ledger_gate`
*first*, and that a retry follows only from an `intact` gate. The **Nodes and
edges** table instead carried `unit → unit` ahead of the `igt_abandon` and
`restore` rows, so a retry skipped all three.

Reproduced before touching anything, by pointing the scripted leaf's answer sheet
at a selector that matches nothing so `igt_pick_elements` fails mid-test:

```
--- igt:structure (attempt 1)   errored: 9 tool calls, 0 filed, 1 tool errors
    retrying igt:structure on a fresh thread
--- igt:structure (attempt 2)   errored: 2 tool calls, 0 filed, 0 tool errors
        note: check_ledger returned panel-elsewhere
    igt_abandon: {'quit': True, 'category': 'Structure', 'panelView': 'overview'}
```

Two tool calls. The retry died on `check_ledger` — one step *earlier* than the
`igt_start → wrong_screen` in the ticket, and the same disease: attempt 2 begins
on a panel still inside attempt 1's guided test. `igt_abandon` fires once, after
both attempts.

**The shape, and it is not "insert a restore".** A bare restore would not have
worked: `restore_page` deliberately leaves a running guided test alone, because
quitting one is a parent-tier decision (011 A3). The answer is to stop treating a
retry as a special edge at all —

> A retry is a new sub-agent on the same browser, so from the panel's point of
> view it is indistinguishable from the next unit, and every unit boundary is
> `cleanup → restore → gate`.

`unit → unit` is deleted. `after_unit` now decides cleanup only (`igt_abandon`
for an IGT with no ok `igt_finish`, `restore` otherwise), and the retry decision
moves into `advance_baseline`, the first place an `intact` gate is known.

**The three questions the ticket asked:**

- **Does it route through `restore`?** Yes, and through `igt_abandon` first where
  the unit is an IGT that never finished — the argument is already in 013 §5(c)
  (*an unfinished IGT leaves a test in progress*) and that sentence does not care
  whether what follows is the next unit or a second attempt at this one. 010's
  "retry only when nothing was filed" is a rule about **duplicate findings**, not
  about reloads; 013 §4 already prices the reload at 1–2 s and buys it
  unconditionally between units for measurement correctness, which is as true for
  a second attempt at test 9 as for the test after it.
- **Does an IGT retry need `save_progress_and_quit` first?** Yes. It now fires
  between attempts as well as after the last one.
- **What does it do to the budget?** Nothing to the count — one retry,
  `attempt == 1`, only when `filed == [] and igt_outcome is None`, unchanged.
  It changes the *cost*: a retry is now paid for at one unit boundary, the same
  boundary the run pays after the last attempt rather than an extra one. Two
  policies were touched in passing and both are recorded in 013 A1:
  `consecutive_failures` still counts **units**, not attempts, so the cascade cap
  keeps its meaning; and `recoveries` is now keyed
  `gate:{unit}#{attempt}:{verdict}`, because a second gate crossing separated by
  a whole sub-agent run is not the loop 010 forbids, and keying on the unit alone
  would have let this fix silently halve an unrelated budget.

**Proved by running.** Same forced-failure sheet, after the change:

```
--- igt:structure (attempt 1)   errored: 9 tool calls, 0 filed, 1 tool errors
    igt_abandon: {'quit': True, 'category': 'Structure', 'panelView': 'overview'}
    restore_page: {..., 'panelView': 'overview', 'ledgerVerdict': 'intact'}
    ledger gate: intact
    retrying igt:structure on a fresh thread
--- igt:structure (attempt 2)   errored: 9 tool calls, 0 filed, 1 tool errors
    igt_abandon: {'quit': True, 'category': 'Structure', 'panelView': 'overview'}
```

**Nine tool calls on attempt 2, against two before** — the retry starts on a
clean `overview`, walks the whole guided test again, and dies where the answer
sheet was deliberately broken rather than where the last attempt left the panel.
The cleanup, restore and gate all appear *between* the attempts.

### 1 — `get_tools()`

`graph/mcp.py` was already correct: `client.session("axe")` held for the life of
the run, `load_mcp_tools` over it, with a docstring saying why `get_tools()` is
the wrong door. Nothing to fix in the code. 013 §1f's code block still showed
`await client.get_tools()`, and 013 Amendment A2 corrects it.

### 2 — the two overviews

`returnToOverview` in `fixture/tools.js` was already correct — it presses the
*Overview* tab off `overview-igt` and confirms the view before returning. 011
Amendment E1 corrects the spec, which said only "the overview". Observed on every
run here: the restore after a **finished** Structure IGT reports
`panelView: 'overview'`, and the manual unit that follows files two issues.

### 3 — a refusal that names the next action

Recorded in 011 Amendment E2 as part of the error contract, and made structural
rather than habitual: there is now exactly **one constructor** for a
`wrong_screen` envelope, it takes the screen, and it appends the next action
itself — so the refusal cannot be built without one. Its IGT rows are derived
from the same table that fills `Screen.answerWith`, so the two cannot drift, and
the non-IGT views get an honest instruction rather than a guess.

`save_progress_and_quit` was the one non-compliant refusal (*"no guided test is
running; the panel is on overview"*). It complies now. Exercised against a live
panel, every shape:

```
save_progress_and_quit @ overview   No guided test is running. Call igt_start(category) to begin one.
igt_answer_choice     @ overview    No guided test is running. Call igt_start(category) to begin one.
igt_finish            @ overview    No guided test is running. Call igt_start(category) to begin one.
igt_start        @ single_choice    A guided test is already running. Do not start it again. Call igt_answer_choice.
igt_finish       @ single_choice    Call igt_answer_choice.
igt_answer_each  @ single_choice    Call igt_answer_choice.
igt_pick_elements@ single_choice    Call igt_answer_choice.
```

One refusal that is not `wrong_screen` now follows the same rule for the same
reason: `add_manual_issue` against a panel where *Add Manual Issue* is
`aria-disabled` names `check_ledger()` and *report this unit blocked*, because
the leaf cannot put the panel back — `restore_page` is bound to no leaf.

### 5 — the screenshot policy table

**Populated, and it stays in the tool layer.** Not relocated, and the reason is
decisive rather than stylistic: **there is nowhere else it could be consulted
from.** No IGT tool takes a `need` parameter — an IGT leaf never asks for
evidence, the screen arrives carrying it — so a skill file could only express
this as prose a small model has to obey, and one shared `procedure.md` serves all
seven categories, so it would carry every category's questions into every unit's
context. It is also not a rule of ours in the sense the governing constraint
forbids: it says nothing about what a correct finding is, only which **modality**
a question Deque already wrote can be answered in.

The line is Deque's own wording. A question that turns on how something *appears*
cannot be answered from the DOM — which is why it is a guided test and not an
axe-core rule, and why Deque's finding reads *"Content appears like a list but is
not marked up as such."* Four of Structure's six ids are `image`
(`mispurposed-headings`, `missing-headings`, `list-misuse`, `missing-lists`); two
are `text` (`missing-langs`, `validate-document-title`). Mapping the text ones
explicitly is what keeps the unmapped-id log a signal — it now means a genuinely
new Deque question. The other six categories' ids are still unknown and still
fall back to text and log.

Populating it surfaced three things, all in 011 Amendment E3:

**`"per-element"` in the question-id slot is a bug, as suspected.** So is
`"element-multiselect"`. Both are constants of ours in the slot 011 defines as
*Deque's own question id*; those two screen kinds have no question id, because
their controls are named for the panel's own element index, which 008 measured is
not even list order. It identifies an element, not a question. Both now report
`questionId: null` — `kind` already carries the screen's identity. Left as it
was, the table would have been keyable on a **screen shape**, applying to every
per-element screen of every category, and the unmapped log fired on those two
constants on every run.

**The image path was broken and the empty table was hiding it.** It put base64
into `evidence[].image.data` *inside* the JSON envelope, where it would have
reached the model as text it cannot see and would have defeated 013's
strip-stale-images pass — the one rule keeping a small model's window survivable
across a ten-screen IGT. The bytes now ride in the `images` side-channel
`describe_element` already uses. Verified in the checkpoint: the image arrives at
the leaf as a `type: "image"` content block and the envelope is still the first
text block.

**The capture is `fullPage`.** Every mapped question asks about the page; a
viewport capture silently answers about the top 720px.

**One obligation this creates.** Answering four questions from a picture makes
the IGT unit a visual one under [018](018-vision-on-the-dev-model.md), so
`skills/igt/procedure.md` ships `visualSignoff: pending` and the draft prints it
per unit. And it puts a standing cost on the development model that
[026](026-local-model-tool-discipline.md) is already open on: the IGT leaf now
receives a full-page screenshot on four of Structure's screens against a model
scoring 44.2% on MMMU Pro. The window cost is bounded — 013 keeps only the newest
image — the judgement cost is not, and it is another argument for 026's *demote
the local model* option.

### What was changed

| File | Change |
|---|---|
| `graph/phase.py` | `unit → unit` deleted; `after_unit` decides cleanup only; `wants_retry` moves into `advance_baseline` behind an intact gate; `consecutive_failures` folded in on the non-retry path only; `recoveries` keyed per attempt |
| `fixture/tools.js` | one constructor for `wrong_screen`, `NEXT_ACTION` derived from `NEXT_TOOL`; `save_progress_and_quit` and `add_manual_issue` refusals name the next action; `IGT_EVIDENCE_POLICY` populated; image evidence moved to the `images` side-channel and captured `fullPage` |
| `fixture/panel.js` | `per_element` and `element_multiselect` report `questionId: null` |
| `skills/igt/procedure.md` | `visualSignoff: pending`; step 3 tells the leaf to look at an `image` evidence entry |
| `wayfinder/tickets/013-agent-graph.md` | Amendment A |
| `wayfinder/tickets/011-tool-inventory.md` | Amendment E |

### The proof

Four runs against the live server, all `--leaf scripted`:

1. **Baseline, before any change.** Reproduces 025 exactly — 13 tool calls, 22
   issues (19 automatic, 1 guided, 2 manual), and seven `unmapped question id`
   lines including `"per-element"` twice.
2. **Forced leaf failure, before.** The retry bug, above: attempt 2 at two tool
   calls on `panel-elsewhere`.
3. **Forced leaf failure, after.** The retry fixed: attempt 2 at nine tool calls
   on a clean panel, with `igt_abandon → restore_page → ledger gate` between the
   attempts.
4. **`make v0-scripted`, after.** Identical to the baseline — 13 tool calls, 22
   issues, the same guided issue and the same two manual issues — with **zero**
   unmapped ids and `visual sign-off: pending` on the IGT report.

`make check-mapping` passes.

**A live-panel refusal probe** (throwaway, not committed) drove the seven
`wrong_screen` shapes listed under item 3 and confirmed `igt_start` on
`mispurposed-headings` returns
`evidence: [{kind: "image", image: {mimeType: "image/png"}, …}]` with one image on
the side-channel.

### For CONTEXT.md — not edited, per the constraint

*v0*, last paragraph, reads: **"The spine holds. The local model does not… the
IGT leaf 2 of 9, both on a retry."** That measurement was taken against a retry
that began on a dirty panel, which is now fixed, so the 2-of-9 figure is a lower
bound on a graph that no longer exists. The sentence is still true about the
model; the number should be re-measured before it is quoted again — and it should
be re-measured *after* whatever [026](026-local-model-tool-discipline.md)
decides, not before, since the IGT leaf now also gets four screenshots per
Structure walk.
