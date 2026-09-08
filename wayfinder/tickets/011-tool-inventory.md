---
id: 011
title: Settle the tool inventory and the MCP boundary
labels: [wayfinder:grilling]
state: closed
assignee: brian
blocked-by: [008, 009]
---

## Question

What tools does a sub-agent get, and does the tool layer sit behind an MCP server or get called directly from LangChain?

The design rule is that tools return verdicts and the agent routes. That makes the tool boundary checklist-shaped rather than browser-shaped. Name the full set, and decide which page state test branches are computed in a tool rather than judged by the model.

The prototypes will have shown where the panel resists automation; that judgement belongs on this side of the boundary, in one place, rather than in 23 skill files.

Resolve with a tool list, each tool's signature and return shape, and the MCP decision.

## Settled before you start

Established elsewhere. Do not re-open these, and do not put them to Brian as questions.

**The two paths are different machines.** CONTEXT now carries this under *Two paths*. The IGT path is Deque-asks-we-answer, with no branches of ours; the manual path is our-checklist-decides-we-write. The 16 page state tests belong to the manual path alone, and so does the rule about computing branches. Name the two tool sets separately.

**"Every checklist branch that can be computed" means our checklists.** Manual path only. There are no IGT branches to compute — the agent reads Deque's question, answers it, picks an element where asked, and advances. This drops a whole category of tool.

**The 16 page state tests are in [`reference/page-state-tests.json`](../../reference/page-state-tests.json).** Structure, branch conditions, and the Deque issue identifier each leaf raises. Branches carry `computable` and `requiresScreenshot` flags, which map directly onto the manual-path tool set and onto any screenshot policy. Read [`reference/README.md`](../../reference/README.md) first.

**The Deque instance id is not a unique catalog key.** 64 of 90 ids name more than one entry; `4.1.2.a` alone covers 31. The unique key is the catalog entry's full option text. So a `sc` + `id` pair in the reference file identifies a *family*, and whatever `add_manual_issue` takes as its issue argument has to be narrower than an id.

**The fixture must scan *and save* before serving tools.** *Add Manual Issue* stays `aria-disabled` until the test exists server-side, and it is `aria-disabled` rather than natively disabled, so `button.disabled` reads `false` on a dead button. CONTEXT's fixture contract already says this.

**Naming, for the resolution:** CONTEXT excludes *Deque's* axe MCP Server as outside the contract. An MCP server of our own, driving our own licensed extension, is unrelated to that exclusion. Say so explicitly so nobody later reads the two as the same thing.

## Decided — build against these

All five recommendations accepted as proposed. Reasoning recorded so a later reader can see what was traded away.

**1. Our own MCP server over the Node driver.** The graph stays Python; the driver stays Node. Porting to `playwright-python` would discard the one thing this project has actually de-risked — the working panel driver from 007, 008 and 009 — and re-run that risk to save a process boundary. Authoring 23 skill files against exactly what runs in production is worth more than one fewer moving part, and a browser with proven lifecycle instability is better isolated over a four-hour run. An HTTP sidecar buys the isolation but loses the authoring property, which is the half worth paying for.

**2. Two bindings off one layer.** Checklist-shaped tools for production sub-agents; primitives — click, read_panel, eval — on the same server, bound only for authoring and debugging. Same code, different binding per role. The primitives must exist because they are how the skill files get written; a small local model handed a raw click will use it, and the Next-dispatch trap and the picker's stateful re-click are exactly what it gets wrong silently.

**3. Policy table keyed on the IGT question id.** Defaults to text; an unmapped id falls back to text and logs, which is also how a new Deque question announces itself. This makes both paths declare evidence mode the same way — `requiresScreenshot` on a manual branch, a table row on an IGT question. Asking the model to notice it lacks visual evidence is the judgement it is worst at, and returning both burns vision tokens on every screen of every IGT.

**4. The server is the fixture.** It launches Chromium, runs keepalive, scans, saves, then serves tools against the live panel. The panel frame handle, the keepalive timer, and 007's selection re-assertion all need the same long-lived object; splitting them across processes means passing a CDP endpoint around and duplicating lifecycle logic in both.

**5. `add_manual_issue` takes the exact catalog label.** The tool takes a string and fails loudly unless it filters to exactly one entry, as 009's prototype already does. The 92 slug-to-label mappings live **beside the skill files, not inside the tool layer** — CONTEXT's rule is that branches map to catalog entries at authoring time, so the skill file carries the resolved label and the tool boundary stays ignorant of Deque's checklist vocabulary. Taking a success criterion is out: the tool would then be choosing the issue type at runtime, which is the thing pre-mapping exists to prevent.

## Two findings from this ticket, already recorded elsewhere

**The checklist slugs do not join to the catalog.** 0 of 92 match. `reference/` has been corrected — the claim that they were the join key was wrong. The shared key is the success criterion only, and it names a family. Consequence for [Export the manual issue catalog](006-export-issue-catalog.md): its open half is 92 hand-mapped rows, not a resolution check.

**Scope is a tool-level concept.** Page state test 4 runs two passes — once across all interactive elements, once per focused element — so `pass` belongs in a tool signature rather than in a skill-file convention. And test 16's prerequisite reads the saved test's Overview for specific issue text, which is a results-reading tool, not a panel-reading one.

## Resolution

**An MCP server of our own, in Node, over the proven Playwright driver.** The Python LangGraph process is its client. Twenty production tools across three groups, bound narrowly per sub-agent, plus five primitives bound only for authoring.

To say it once, plainly: **this is not Deque's axe MCP Server.** That product is outside our licence and CONTEXT excludes it. This is our own code, driving our own licensed extension, speaking a protocol that happens to share a name. Nothing about building it touches that exclusion.

### Shape of the thing

The server **is** the fixture. On startup it launches Chromium with the unpacked extension, mints and seeds the session, opens DevTools, selects the panel and holds it through 007's layout race, clears the onboarding chain, runs the full-page scan, saves the test, and starts the keepalive timer. Only then does it serve tools. Every lifecycle trap the prototypes found lives in that startup and in one `ensurePanel` guard the tools share — not in 23 skill files.

The graph never sees a browser. It sees a checklist.

### The envelope every tool shares

No tool raises for a dead panel. Every one returns:

```
Result<T> = { ok: true,  value: T }
          | { ok: false, error: ErrorCode, detail: string, retryable: boolean }

ErrorCode = "panel_unavailable"  // the panel is gone; [Detect ledger loss](010-ledger-loss-detection.md) settles how this is decided
          | "wrong_screen"       // this tool does not apply to the screen showing
          | "not_found"          // the selector matched nothing
          | "ambiguous"          // matched more than one where exactly one was required
          | "rejected"           // the panel refused; state unchanged
```

`rejected` exists because of a specific measured behaviour: 008's element picker silently ignores a re-click of something it has just dropped, and the only evidence is a counter that fails to move. Every action tool verifies its own effect and returns `rejected` rather than reporting a success that did not happen.

Two shared types:

```
ElementRef = { ref, selector, tag, role, name, text, box }
Evidence   = { kind: "text",  element: ElementRef, context: string | null }
           | { kind: "image", element: ElementRef, image: <MCP image content>, caption }
```

`selector` is the canonical identity — it is what the extension itself records back on a filed issue, so a finding round-trips. `ref` is a short handle so a small model passes tokens rather than re-typing selectors. `context` carries relational text: what *follows* a heading, for the question that asks whether it describes what follows.

### Session tools — bound to every agent

**`check_ledger()` → `Result<Ledger>`**
```
Ledger = { alive, testName, testUrl,
           totals: { automatic, guided, manual, total },
           igt: { category, runs, issues, completed }[] }
```
The cheap explicit probe. Parent agents call it between sub-agents; it is the "option C backup" from the failure-surface decision.

**`read_test_results(match?: string)` → `Result<Issue[]>`**
```
Issue = { title, count, source: "automatic" | "guided" | "manual", impact, elements: { selector, snippet }[] }
```
Reads the saved test's Overview. Not optional garnish — page state test 16 has a prerequisite that reads it for issues whose text mentions a missing or incorrect role.

**`restore_page()` → `Result<{ reloaded, viewport, ledgerAlive }>`**
Reloads the same URL, resets the viewport to the fixture's, re-asserts panel selection, and confirms the ledger survived. This is how a parent agent cleans up after test 9 leaves the viewport at 320px or test 8 mutates state. **It reloads; it never navigates**, because 008 measured that pointing the tab at a different URL replaces the panel with a page-state warning and offers only *Save progress & quit* or *Restart test*.

### IGT path — Deque asks, we answer

**`igt_list()` → `Result<IgtCategory[]>`** — the seven categories with run counts and completion.

**`igt_start(category)` → `Result<Screen>`** — enters, **unticks `#enableAiAssist`**, presses Start, returns the first screen. The untick is unconditional and deliberately not a parameter: it arrives ticked, it spends AI credits, and Automated IGT is outside the contract. It disappears once the test begins, so there is no second chance and no reason to let a caller opt in.

**`igt_current()` → `Result<Screen>`** — re-read without acting. The recovery path after a `panel_unavailable`.

```
Screen = {
  kind: "single_choice" | "element_multiselect" | "per_element" | "element_picker" | "results",
  step,          // the aria-current step label — reported, never used as a cursor
  questionId,    // the `name` on the answer radios: Deque's own question id
  question,      // #question-text
  help,          // #question-help
  answerWith,    // the exact tool name to call next
  evidence: Evidence[],
  // then, by kind:
  //   single_choice        options: { value: "yes" | "no", label }[]
  //   element_multiselect  options: { ref, label, element: ElementRef }[]
  //   per_element          groups:  { ref, label, element: ElementRef }[]
  //   element_picker       alreadySelected: int
  //   results              issueCount, issues: { title, elements: ElementRef[] }[]
}
```

Two fields carry most of the weight.

**`questionId` is the anchor, not `step`.** 008 measured a step number spanning three screens and the run jumping 4 → 7 because steps 5 and 6 had no applicable content. `step` is returned for the transcript and nothing routes on it. The radio-group `name` — `mispurposed-headings`, `list-misuse`, `validate-document-title` — is Deque's own identifier and is what a skill file keys on.

**`answerWith` names the next tool.** The screen tells the model which of four tools to call, so the model never classifies anything. That is the whole design rule in one field.

`evidence` is populated from the policy table keyed on `questionId`, defaulting to text. An unmapped id returns text and logs `unmapped question id`, which is how a new Deque question announces itself rather than failing silently.

Four answer tools, each valid on exactly one kind, each returning the next `Screen`:

| Tool | Screen kind | Notes |
|---|---|---|
| `igt_answer_choice(choice)` | `single_choice` | `"yes"` / `"no"` |
| `igt_answer_elements(refs)` | `element_multiselect` | empty array is legal |
| `igt_answer_each(answers)` | `per_element` | **every ref must be present** |
| `igt_pick_elements(selectors)` | `element_picker` | CSS selectors on the page |

`igt_answer_each` rejecting a partial map is deliberate. 008 found every question arrives pre-answered and the default is usually "Yes"; a missing ref would silently record a problem the agent never asserted. The tool sets every group explicitly or fails.

`igt_pick_elements` carries the picker's whole measured protocol — arm Mouse Selection, click *Remove all selections* first, click each element on the inspected page, then verify the counter reached `selectors.length` and return `rejected` if it did not. The caller supplies selectors; Playwright resolves them; nothing depends on coordinates.

**`igt_finish(name?)` → `Result<IgtOutcome>`**
```
IgtOutcome = { category, issueCount, issues: { title, elements }[], durationMinutes, savedAs }
```
Presses Finish, handles the *Save your results* dialog if it appears, confirms. `name` is optional — see the residual risk below.

### Manual path — our checklist decides, we write

**`find_elements(query, opts?: { pass?: "static" | "focused", limit? })` → `Result<ElementRef[]>`**

`pass` is a tool parameter rather than a skill-file convention because page state test 4 runs two passes — once across all interactive elements, then once per focused element. `"focused"` focuses each match before capturing its evidence. Test 12's per-data-table scope is expressed as the query.

**`describe_element(selector, need?: "text" | "image")` → `Result<Evidence>`**

`need` comes straight from the branch's `requiresScreenshot` flag in `reference/page-state-tests.json`. One branch of test 5 and the whole of tests 6 and 9 ask for `"image"`; everything else is text.

**`add_manual_issue(selector, issue)` → `Result<FiledIssue>`**
```
FiledIssue = { selector, issue, element, recordedLocation, manualIssueCount }
```
`issue` is the **exact catalog option text**, and the tool fails `ambiguous` unless it filters the 418 entries to precisely one, listing the candidates in `detail`. An ambiguous branch is an authoring bug, not a runtime choice — which is what CONTEXT's pre-mapping rule is protecting.

The tool owns 009's whole write path: open the form, filter the combobox, click the single option, open the Element Selector drawer, drive its selector search to the element wherever it is nested, press Select, verify the read-back, Save, and confirm the manual issue count rose. `recordedLocation` returns the CSS selector the extension stored, so a filed issue can be matched back to the element the skill file named.

### Predicate tools — six, covering nine branches

The reference file's `computable` flags name nine branches across five tests. They collapse to six predicates. Every other branch in the sixteen is the model's judgement.

```
Verdict<M> = { outcome: "fails" | "passes" | "not_applicable" | "undecidable",
               leaf,        // the branch name that fired, or null
               because,     // one line, which is what the agent reports
               measured: M }
```

`leaf` is how "the agent reports which branch fired" becomes mechanical rather than a matter of the model paraphrasing.

`undecidable` is a fourth outcome, added for one branch only and worth its own state: it means the tool could not determine the answer and the model must judge, with `because` naming what it could not see. Nothing else in the design lets a half-computable branch degrade honestly.

| Tool | Signature | Branch |
|---|---|---|
| `check_accessible_name` | `(selector)` → `Verdict<{ visibleText, accessibleName, containsInOrder }>` | #4 — distinguishes `mismatch` from `order` via `leaf` |
| `check_text_contrast` | `(selector, { state?, against? })` → `Verdict<{ ratio, required, largeScale, foreground, background }>` | #4 unfocused and hovered, #5 placeholder |
| `check_link_in_text_distinction` | `(selector)` → `Verdict<{ ratioAgainstSurroundingText, nonColourCues, confident }>` | #5 — **the `undecidable` one** |
| `check_autocomplete_purpose` | `(selector)` → `Verdict<{ hasAutocomplete, value, inferredPurpose, matches }>` | #7 |
| `check_table_semantics` | `(selector)` → `Verdict<{ headerStructure, roleIssues, headerMarkupIssues, associationIssues }>` | #12, all three branches |
| `check_target_size` | `(selector)` → `Verdict<{ width, height, required: 24, exception }>` | #16 |

Two of these deserve a note.

`check_autocomplete_purpose` is the one the reference calls *fully deterministic; the highest-confidence test of the sixteen*. It should be built first — it is the cheapest proof that the verdict-tool idea works at all.

`check_link_in_text_distinction` is the only branch that is **not fully computable**. Contrast against surrounding text and underline, bold, italic and outline all fall out of computed style. Chevrons, arrows and other glyph cues do not. So it returns `undecidable` with `confident: false` when it finds no style-level cue but cannot rule out a glyph, and the model decides. Better an honest third answer than a confident wrong one.

### Authoring primitives — never bound in production

`panel_read()`, `panel_click(name)`, `panel_eval(js)`, `page_eval(js)`, `screenshot(target)`.

Same server, same code, a separate binding. These are how the 23 skill files get written and how [Settle the skill file format](012-skill-file-format.md) builds its worked example — against exactly what runs in production, which is the property that made an MCP server worth the process boundary. `panel_click` is exact-name, visible-and-enabled-filtered, and DOM-dispatched, because a substring match picks `Save Test` when asked for `Save` and a real pointer click is swallowed by the tooltip layer.

### The bindings

A sub-agent never sees the whole inventory. This is what *a narrow tool set* means concretely:

| Agent | Bound tools |
|---|---|
| Main | `check_ledger`, `read_test_results`, `restore_page`, `igt_list` |
| IGT sub-agent, one per category | `check_ledger`, `igt_start`, `igt_current`, the four answer tools, `igt_finish` — **7** |
| Manual sub-agent, one per page state test | `check_ledger`, `find_elements`, `describe_element`, `add_manual_issue`, plus **only** the predicates that test names |
| Authoring harness | everything, plus the five primitives |

Predicates by test: #4 gets `check_accessible_name` and `check_text_contrast`; #5 gets `check_text_contrast` and `check_link_in_text_distinction`; #7 gets `check_autocomplete_purpose`; #12 gets `check_table_semantics`; #16 gets `check_target_size` and `read_test_results` for its prerequisite. **The other eleven tests get no predicates at all** — four tools each, and the model does the judging Deque's checklist asks for.

### Residual risk, untested

**Whether `igt_finish` prompts for a name against an already-saved test.** 008 ran an IGT from a fresh profile with no saved test, and Finish opened *Save your results* with a required name. 009 saved the test first but never then ran an IGT. The fixture now scans *and* saves before serving tools, so the production combination — Finish an IGT against a test that already exists — is one neither prototype exercised. `igt_finish` takes an optional `name` and must handle the dialog appearing or not. Cheap to settle at implementation; recorded because it is the one place this spec is inferring rather than reporting.

---

# Amendments

Everything above is the resolution as it closed and is left as written. Each
section below is an amendment, named for the ticket that caused it, applied in
the order the tickets were worked.

## Amendment A — from [023](023-graph-tool-amendments.md): the four tools the graph could not be built without

[Settle the agent graph](013-agent-graph.md) needed four things this inventory
did not carry, and a fifth that belongs to [012](012-skill-file-format.md).

**A1. `restore_page()` also returns the panel to the overview.**

```
restore_page() → Result<{ reloaded, viewport, panelView, ledgerAlive }>
```

The sequence is: reload the same URL, reset the viewport to the fixture's,
re-assert panel selection, **return the panel to the overview**, then confirm the
ledger survived. Reloading the page does not move the panel, and a manual leaf
that stops on the *Add Manual Issue* form leaves it there, so without this the
very next `checkLedger` returns `panel-elsewhere` on nearly every manual unit — a
recoverable verdict that fires every time is a recovery nobody reads.

`panelView` reports the view it actually left the panel on. A panel it cannot
return still yields `ok: true` with `panelView` naming where it stuck: the ledger
gate is the one authority on whether a view is a loss, and a tool that decides
that for itself is a second opinion in a design that has room for one.

**A2. `reopen_saved_test()` — new.**

```
reopen_saved_test() → Result<{ testId, testName, panelView }>
```

Presses *view saved tests* and clicks the run's own entry, which
[010](010-ledger-loss-detection.md) proved end to end and recorded as an `<a>`
rather than a button. **It takes no argument.** The test id is the one the
fixture resolved once at setup; letting a caller name a test is precisely the
state `panel-detached` exists to detect. Returns `not_found` when the entry is
not in the list, which is `test-lost` territory and the gate that follows says so
properly.

Bound to Main only — it is [013](013-agent-graph.md)'s `recover_reopen` node.

**A3. `save_progress_and_quit()` — new.**

```
save_progress_and_quit() → Result<{ quit, category, panelView }>
```

Opens the `Options` menu and clicks *Save progress & quit*. Through the menu, not
as a button: [017](017-igt-page-state-tolerance.md) found the control is absent
from every question, picker and grid screen and appears top-level only on the
page-state warning banner. Returns `wrong_screen` when no guided test is running.

Bound to Main only — it is 013's `igt_abandon`, and without it a leaf that dies
mid-IGT leaves a test in progress and every later restore is unsafe. Not bound to
an IGT leaf: a leaf that can quit its own test eventually will.

**A4. `page_state_warning()` — new, and `pageStateChanged` on `Screen`.**

```
page_state_warning() → Result<{ changed, view, message }>
Screen.pageStateChanged: boolean          // on every Screen every IGT tool returns
```

Both, because they answer the same question at different costs. The field rides
free on screens the IGT tools already return. The standalone read exists because
`igt_current()` re-fetches the screen's `Evidence` — an image on a mapped
question — to answer a boolean, and 013 strips stale images from the window for
exactly that reason. `fixture/ledger.js` already computes it in `readPanel`,
which performs no clicks and no navigation, so neither costs anything.

Bound to every IGT leaf. 017 rule 5 makes checking it the leaf's own obligation,
and the banner sits over a fully live question screen that will happily accept
the next answer.

**A5. `finish_unit(report)` — the unit's closing report becomes a tool call.**

```
finish_unit(report: string) → Result<{ accepted: true }>
```

012's amendment, restated here because it changes every binding. `report` is the
closing YAML block verbatim and unparsed, per 013's `report_yaml: str | None`;
the parent parses it, and a block that will not `yaml.safe_load` costs the
coverage half of the report rather than the unit.

**`finish_unit` is not an MCP tool.** It is provided by the leaf graph — 013 §1d
binds `[*tools, finish_unit]` — so it never reaches the browser and it works for
a held-back leaf that is bound nothing else. **Consequence for 013 §1e:** the
startup cross-check resolves every front-matter `tools:` name against the MCP
tool set **plus `finish_unit`**. Against the MCP set alone, all twenty-three
skill files fail validation at second zero.

**A correction while here.** The binding table below reads "the four answer
tools, `igt_finish` — **7**" and lists eight names. With `page_state_warning` and
`finish_unit` an IGT leaf is bound **ten**.

## Amendment B — from [020](020-page-interaction-tools.md): the page-interaction set

The manual path could read the page and not act on it. Six of the sixteen tests
need to act. Eight new tools, plus two predicates recorded under Amendments C
and D, all bound to manual leaves only.

### The rule that shapes the set

**The model names *which element* and *which condition*. The tool decides *how* —
which key, which pointer sequence, which width, in what order, with what settle
time — and reports what happened.**

No production tool takes a key, a coordinate, a CSS string, a pixel size or a
value the model invented. There is no `click(selector)` and no `press_key(k)`:
those are the primitives this ticket bound to authoring, and acting on the page
is where a 2B model does damage that reads as a finished audit. Where a number
does appear in a signature — `seconds`, `width` — it is copied out of the skill
file, in the same class as the `limit` on `find_elements`.

### Two shared types

```
Aftermath = { pageDirty, refsInvalidated, navigated, restored, url }
```

Every interaction tool's value carries one. `refsInvalidated` is the load-bearing
field: any tool that reloads or navigates voids every `ElementRef` handed out
before it, and the skill file's next step re-runs its `find_elements` rather than
the model remembering to.

`Evidence.element` widens to `ElementRef | null`, for a page-level capture that
has no element.

### The tools

**`tab_through_focusables(opts?: { limit?, startFrom? })` → `Result<TabRecord>`**

```
TabRecord = {
  stops: { index, domIndex, element: ElementRef, visible, obscured, empty, box }[],
  wrapped, cappedAt,
  trap: { at: ElementRef, escapedWith: "shift-tab" | "escape" | "arrows" | null } | null,
  unreachable: ElementRef[],
  domOrderDivergence: { from: ElementRef, to: ElementRef }[],
  aftermath: Aftermath
}
```

Focuses `document.body`, presses Tab until focus wraps or the cap (300) is
reached, and records every stop in order. One call answers most of test 4's
`pass: "all"` set and both of its geometry branches at once:

- `domOrderDivergence` is the evidence for *focus order is illogical* — the tool
  measures the divergence, the model judges whether it matters.
- `unreachable` is the candidate set for *a component is skipped in the natural
  focus order*: interactive-looking elements that never took focus.
- `trap` is computed, not judged. On a stop that will not advance, the tool tries
  exactly the exits Deque's branch names — Tab, Shift+Tab, arrows, Escape — and
  records which freed it, or `null` for a real trap.
- `obscured` and `empty` are captured at each stop, so
  `focus-on-hidden-item` and `focus-fully-obscured` need no per-element pass.

Test 3's skip-link branch also starts here: the skip link is *among the first
focusable elements*, which is `stops[0..n]`.

**`probe_focus_effects(selector)` → `Result<FocusEffects>`**

```
FocusEffects = {
  focused, focusRetained, focusMovedTo: ElementRef | null,
  newWindow, formSubmitted,
  changedAbove: { region: ElementRef, digestBefore, digestAfter } | null,
  revealed: { element: ElementRef, persistedSeconds, dismissedByEscape,
              survivedPointerOver } | null,
  obscured, empty, box,
  aftermath: Aftermath
}
```

The per-element behaviour probe: focus one element and record what the page did
about it. It covers seven of test 4's `pass: "element"` branches, including all
three of 1.4.13 — content that vanishes on its own, content that cannot be
dismissed from the keyboard, content that disappears when the pointer crosses it.
Those three need three different actions on the revealed content, and they are
one procedure on one element, so they are one tool rather than three primitives
the model sequences.

This does not replace `find_elements(query, { pass: "focused" })`, which stays
the sweep for how an element *looks* while focused. This one is what it *does*.

**`operate_element(selector, with: "keyboard" | "pointer" | "both", observeSeconds?)` → `Result<ActivationRecord>`**

```
ActivationRecord = {
  passes: { with: "keyboard" | "pointer",
            method,                       // the key or pointer sequence the tool chose
            activated,
            focusAfter: ElementRef | null,
            newWindow, dialogOpened, navigated,
            digestBefore, digestAfter, changed,
            activityBefore, activityAfter, activityStopped }[],
  parity: "same" | "keyboard-only" | "pointer-only" | "neither" | null,
  aftermath: Aftermath
}
```

Activates one element and reports the difference it made. The model never
chooses the mechanism: for `"keyboard"` the tool derives the key from the
element's role per the WAI-ARIA Authoring Practices — Enter and Space on a
button, Enter on a link, arrows in a radio group — and for `"pointer"` it clicks
the resolved selector, never a coordinate.

`with: "both"` runs the keyboard pass, reloads, runs the pointer pass, and
returns **`parity` computed**. That exists because test 4's `dual-role` branch
asks whether one input method can do what the other cannot, and a 2B model
holding two records across two calls to compare them is the state-in-the-head
failure the skill-file format was designed to avoid. The reload sets
`refsInvalidated: true`.

`observeSeconds` folds test 1's second observation into the same call: with it
set, the tool measures page activity before and after activation and returns
`activityStopped`, which is the whole of *does the pause control work*.

**Navigation.** This tool can navigate, because activating page code is what it
does. It detects navigation, returns to the unit's document, verifies the URL and
reports both facts in `aftermath`. If it cannot get back, it returns
`ok: false, error: "page_lost"` (below). Same-tab navigation is restored by
`history.back()`; a popup window is recorded and closed. Auto-restore is not
tidiness: leaving the document changed makes every later check in the same unit
measure the wrong page, and nothing downstream would notice.

**`change_setting(selector, to?)` → `Result<ActivationRecord>`**

Changes a control's *setting* rather than activating it, because that is the
wording Deque's branch uses — *changing the setting of a component causes a
change of context without warning*. For a `<select>` the tool picks an option
that is not the current one, for a checkbox or radio it toggles, for a
slider or spinbutton it steps once. `to` is optional and, when present, comes
from the skill file at authoring time; omitted, the tool derives it. Returns the
same before/after record as `operate_element`, and carries the same navigation
contract.

**`observe_page_activity(seconds?)` → `Result<ActivityRecord>`**

```
ActivityRecord = {
  seconds,
  mutations: { count, regions: ElementRef[] },
  animations: { element: ElementRef, kind: "css" | "video" | "canvas" | "marquee",
                durationSeconds, infinite }[],
  mediaAutoplaying: ElementRef[],
  stillMovingAfterSeconds,
  flashes: { element: ElementRef, perSecond, viewportAreaFraction }[],
  motionListeners: ("devicemotion" | "deviceorientation")[],
  candidateControls: ElementRef[],
  aftermath: Aftermath
}
```

Watches the page for a bounded window and reports what moved on its own. This is
the whole of test 1's first two branches, which cannot be answered from a
snapshot at all: *content updates automatically* and *content moves, blinks or
scrolls for more than 5 seconds* are both statements about time.

`candidateControls` are controls whose accessible name matches the pause / stop /
hide / play vocabulary — proposed, not judged. The model picks one and
`operate_element(..., observeSeconds)` settles whether it works.

**One honest limit, stated rather than papered over.** The flashing branch asks
for more than three flashes per second across more than 25% of a 10-degree
visual field. The tool reports `perSecond` and `viewportAreaFraction` from
sampled frames. It does **not** compute the 10-degree field, which is a fact
about viewing distance and not about the page, and it does not pretend to: the
branch stays a judged one with the two numbers in hand.

**`capture_under(condition, opts?: { width?, selector? })` → `Result<Evidence>`**

`condition` is a closed vocabulary — `"baseline" | "zoom-200" | "viewport-320" |
"text-spacing"` — and that is the point. The alternative is a `set_viewport(w, h)`
and an `inject_css(css)` in the hands of a 2B model, which is two primitives and
a stylesheet it might compose itself. Here it names a condition out of the skill
file and gets back an image `Evidence` whose `caption` states the condition.

`"text-spacing"` injects the WCAG 1.4.12 stylesheet — the checklist runs it once
per breakpoint, so `width` carries the breakpoint the skill file lists.

**The tool applies the condition, captures, and restores the page condition
before it returns, on the error path too.** Not because the ledger needs it —
[017](017-igt-page-state-tolerance.md) measured that resize and CSS injection
fire nothing — but because the viewport must be the fixture's for every later
measurement, and a self-restoring tool cannot be defeated by a leaf that runs out
of steps between setting 320px and putting it back.

**`probe_single_key_shortcuts(opts?: { keys?, scope? })` → `Result<ShortcutRecord>`**

```
ShortcutRecord = {
  scope: "page" | selector,
  probed: { key, reacted, effect, collidesWith: "browser" | "screen-reader" | null,
            onlyWhileFocused }[],
  aftermath: Aftermath
}
```

Presses each key of a closed default set with focus on `document.body`, records
whether the page reacted, and cross-references a vendor key map. That map is
data about browsers and screen readers, **not a rule of ours about
accessibility** — the governing constraint forbids the second, and Deque's own
branch asks whether a shortcut *conflicts with an existing browser or screen
reader shortcut*, which is unanswerable without knowing what those are and which
a 2B model certainly does not.

`scope` set to a selector re-probes with focus inside that component, which
settles the *is not restricted to when its component has focus* clause of 14.2.
The remaining clauses — can it be turned off, can it be remapped — are a search
for a settings UI and stay the model's.

Same navigation contract as `operate_element`: a key that navigates is detected,
restored and reported.

**`probe_pointer_alternatives(selector)` → `Result<PointerRecord>`**

```
PointerRecord = {
  singleClick: { changed, digestBefore, digestAfter },
  drag: { performed, path, changed },
  requiresDrag,
  pathGestureHandlers: string[],
  keyboardOperable,
  aftermath: Aftermath
}
```

Test 15. Tries the single pointer action, then a drag along a short path inside
the element's box, and reports which produced a change — `requiresDrag` is
computed as *the drag changed something and the click did not*, which is the
whole of *cannot be operated by a single pointer without dragging*.
`pathGestureHandlers` lists `pointermove` / `touchmove` listeners found on the
element or its ancestors. Whether dragging is *essential* stays judged.

### Ledger and navigation, per tool

None of these is bound to an IGT leaf, so none can run while a guided test is in
progress — the run is strictly sequential and the IGT phase completes first.
Against 017's measurements, everything here except navigation fires no guard at
all.

| Tool | Navigation | Leaves the page |
|---|---|---|
| `tab_through_focusables` | never | focus moved |
| `probe_focus_effects` | never | focus moved; revealed content may be open |
| `operate_element` | **may — detects, restores, verifies**; `both` reloads | DOM and focus state changed |
| `change_setting` | **may — detects, restores, verifies** | the control holds a new value |
| `observe_page_activity` | never | untouched |
| `capture_under` | never | **restores its own condition** |
| `probe_single_key_shortcuts` | **may — detects, restores, verifies** | whatever the keys did |
| `probe_pointer_alternatives` | **may — detects, restores, verifies** | whatever the drag did |
| `check_reflow` | never | **restores the viewport** |
| `check_sort_state` | never | table left sorted |

### State restoration — three rules, and who owns which

1. **A tool that changes a global page condition restores it itself, always,
   including on its error path.** `capture_under` and `check_reflow` own the
   viewport, the zoom and the injected stylesheet.
2. **A tool that changes DOM, focus or scroll state does not restore it**, and
   says so in `aftermath.pageDirty`. The parent reloads between units anyway, and
   a reload per check would cost more than it buys.
3. **A tool that navigates always restores the navigation**, because the failure
   it prevents is silent: every later check in the same unit would measure a
   different document and the record would not say so.

`restore_page()` stays parent-tier and unbound to any leaf, exactly as
[013](013-agent-graph.md) §4 requires. These rules are what a unit does for
*itself*, between its own checks.

### One new `ErrorCode`, and one widened

```
"page_lost"   // an action navigated and the tool could not return to the unit's
              // document. Nothing further in this unit measures the right page.
```

The skill file's response is to stop and report `status: aborted`. The graph
needs no new disposition: the unit ends `incomplete` or `errored`, and the
parent's `restore_page()` reloads the fixture URL before the next one.

`rejected` widens from "the panel refused; state unchanged" to "**the panel or
the page** refused; state unchanged" — an element that will not take focus, a
control with no setting to change, a drag the page ignored.

### Four more authoring primitives — never bound in production

`page_click(selector)`, `page_key(keys)`, `page_set_viewport(w, h)`,
`page_inject_css(css)`.

Said plainly, because the ticket asked where a primitive could not be avoided:
**these are the primitives, and they are exactly the ones production never
sees.** An author needs them to discover what a procedure is before it can be
wrapped in a tool — that is the whole argument for two bindings off one layer —
and every tool above is one of these primitives with the sequencing, the settle
time, the verification and the restore already decided. The two places a
production signature still carries an author's raw value are `capture_under`'s
`width` and `change_setting`'s `to`, both copied from the skill file.

## Amendment C — from [021](021-verdict-leaves-plural.md): `Verdict.leaf` becomes `leaves`

```
Verdict<M> = { outcome: "fails" | "passes" | "not_applicable" | "undecidable",
               leaves: string[],   // every branch that fired; [] otherwise
               because,
               measured: M }
```

`check_table_semantics` covers branches that co-occur constantly — a grid with
the wrong cell roles usually also has the wrong header markup — and a singular
`leaf` files one and drops the rest, which is under-reporting wearing a pass.

**`leaves` is always a list**, `[]` on `passes`, `not_applicable` and
`undecidable`, and a single-element list for every single-branch predicate. No
special case: uniformity is worth more than the saved character, and the skill
file's routing table already reads as *for every name in that list, do its row*.

**`check_table_semantics` gains a fourth leaf.** Deque's association branch cites
both `table-complex-no-header-associations` and
`table-complex-association-incorrect`, and *missing* versus *incorrect* is
already the distinction the tool computes internally — no `headers` attribute at
all, versus a `headers` attribute pointing at ids that do not resolve.
Leaves: `role-markup`, `header-markup`, `header-associations`,
`header-associations-wrong`.

**The other predicates, checked as the ticket asked.**

| Predicate | Leaves | Can two fire at once? |
|---|---|---|
| `check_accessible_name` | `mismatch`, `order` | No — mutually exclusive by definition |
| `check_text_contrast` | `contrast-unfocused`, `contrast-hovered`, `contrast-placeholder` | **Yes — see below** |
| `check_link_in_text_distinction` | `link-contrast` | No; `undecidable` returns `[]` |
| `check_autocomplete_purpose` | `input-purpose` | No |
| `check_table_semantics` | four, above | Yes, and constantly |
| `check_target_size` | `target-small` | No |
| `check_reflow` (Amendment D) | `horizontal-scroll` | No |
| `check_sort_state` (Amendment B/D) | `sort-state` | No |

**`check_text_contrast` is the second predicate the plural earns its keep on.**
Test 4's branch reads *with the element unfocused **and** hovered* — two states,
either of which can fail. So `state` becomes optional in the way that matters:
omitted, the tool measures every state the element supports and returns one leaf
per failing state. Passing `state` explicitly still measures exactly that one,
which is what test 5's placeholder branch wants. Asking the model to call twice
and combine the answers is the same trap `leaves` exists to close.

## Amendment D — from [019](019-reflow-scroll-predicate.md): two more predicates, and the flag moves to the branch

**`check_reflow(width?: number = 320)` → `Verdict<ReflowMeasure>`**

```
ReflowMeasure = { width, scrollWidth, clientWidth, overflowBy,
                  overflowing: ElementRef[],
                  twoDimensionalCandidates: ElementRef[],
                  viewportRestored }
```

*Is horizontal scrolling necessary at a 320px viewport* is `scrollWidth >
clientWidth` — a bright-line measurement of the same species as
`check_target_size`, and it was burning vision tokens and asking a 2B model for a
judgement it does not have to make.

The predicate owns the viewport change end to end: it resizes, measures,
restores and reports `viewportRestored`, so no `set_viewport` primitive is ever
bound. 017 measured a 320px resize as tolerated with an IGT actually running, and
it fires no guard because it is not a navigation; the restore is for measurement
correctness, per 017 rule 2.

**It returns `undecidable`, and that is the honest shape.** The branch has two
clauses and only one is computable: horizontal scrolling is *needed*, and the
content *does not require a two-dimensional layout*. So — no overflow →
`passes`, definitively. Overflow whose subtree is entirely tables, images, SVG,
`role=grid` or a deliberately `overflow-x` scrolling region → `undecidable`, with
`because` naming what it found and `twoDimensionalCandidates` listing it.
Overflow anywhere else → `fails`, leaf `horizontal-scroll`. This is exactly
`check_link_in_text_distinction`'s precedent, and 012 already routes an
`undecidable` to a judged fallback step — and note the judgement it asks for is
*which element overflows*, from text, not from a picture.

**`check_sort_state(selector)` → `Verdict<SortMeasure>`** — Amendment B's
predicate, recorded here with the other one.

```
SortMeasure = { sortableHeaders: ElementRef[],
                sorted: { header: ElementRef, name, ariaSort, announced }[],
                pageDirty: true }
```

Test 12's second check reads *the table is sortable and, **after sorting**, the
sorted header cell neither indicates the sort in its accessible name nor carries
`aria-sort` with a direction*. The tool finds the sortable headers, activates
each in turn, waits for the row order or `aria-sort` to settle, and reads the
header back. `not_applicable` when no header is sortable; `fails` with leaf
`sort-state` when any sorted header announces neither way.

A predicate rather than an `operate_element` plus a read, because the last step —
*does this accessible name indicate a sort direction* — is a string judgement a
2B model gets wrong in both directions, and because two tool calls with a
comparison between them is the shape the format exists to avoid.

It leaves the table sorted. A skill file therefore runs any row-order-dependent
check — test 12's *first row is really a caption* — **before** this one.

**`requiresScreenshot` is a branch-level flag.** `reference/page-state-tests.json`
carried it on the whole of tests 6 and 9, and in both cases one branch did not
deserve it. Test 5 already set it per branch, so the file was inconsistent rather
than wrong; it is now uniform, and the test-level flag is gone:

| Branch | Was | Now |
|---|---|---|
| 6.1 colour conveys information | test-level `true` | `requiresScreenshot: true` |
| 6.2 instructions require perceiving shape, colour, size, location | test-level `true` | `requiresScreenshot: true` |
| 6.3 instructions require perceiving **auditory** characteristics | test-level `true` | **`false`** — the evidence is the instruction's text; a picture answers nothing |
| 9.1 content lost under doubled text | test-level `true` | `requiresScreenshot: true` |
| 9.2 horizontal scrolling needed at 320px | test-level `true` | **`computable: "partly"`, `requiresScreenshot: false`** — `check_reflow`, and `"partly"` for the same reason test 5's link branch carries it: one clause measures, the other degrades to `undecidable` |
| 9.3 content lost at 320px | test-level `true` | `requiresScreenshot: true` |
| 9.4 content lost under injected text spacing | test-level `true` | `requiresScreenshot: true` |
| 12.2 sort state after sorting | — | **`computable: true`** — `check_sort_state`, computable only because Amendment B lets a tool sort |

Eleven computable branches now, across six tests, collapsing to **eight
predicates**. 012's format needs no change for this: `Evidence:` already sits on
the check rather than the test, and had no test-level flag to be wrong with.

## The inventory after these amendments

**Thirty-three production MCP tools**, plus `finish_unit`, which the graph
provides. Nine authoring primitives.

| Group | Tools | Count |
|---|---|---|
| Session and graph | `check_ledger`, `read_test_results`, `restore_page`, `reopen_saved_test`, `save_progress_and_quit` | 5 |
| IGT path | `igt_list`, `igt_start`, `igt_current`, `igt_answer_choice`, `igt_answer_elements`, `igt_answer_each`, `igt_pick_elements`, `igt_finish`, `page_state_warning` | 9 |
| Manual path — read and write | `find_elements`, `describe_element`, `add_manual_issue` | 3 |
| Manual path — interaction | `tab_through_focusables`, `probe_focus_effects`, `operate_element`, `change_setting`, `observe_page_activity`, `capture_under`, `probe_single_key_shortcuts`, `probe_pointer_alternatives` | 8 |
| Predicates | `check_accessible_name`, `check_text_contrast`, `check_link_in_text_distinction`, `check_autocomplete_purpose`, `check_table_semantics`, `check_target_size`, `check_reflow`, `check_sort_state` | 8 |
| Graph-provided | `finish_unit` | 1 |
| Authoring only | `panel_read`, `panel_click`, `panel_eval`, `page_eval`, `screenshot`, `page_click`, `page_key`, `page_set_viewport`, `page_inject_css` | 9 |

### The bindings, restated in full

| Agent | Bound tools | Count |
|---|---|---|
| Main | `check_ledger`, `read_test_results`, `restore_page`, `reopen_saved_test`, `save_progress_and_quit`, `igt_list` | 6 |
| IGT leaf, one per category | `check_ledger`, `igt_start`, `igt_current`, the four answer tools, `igt_finish`, `page_state_warning`, `finish_unit` | 10 |
| Manual leaf, active | base four — `check_ledger`, `find_elements`, `describe_element`, `add_manual_issue` — plus `finish_unit`, plus the tools its own test names | 5 + n |
| Manual leaf, held back | `finish_unit` | 1 |
| Authoring harness | everything, plus the nine primitives | — |

Per manual test, `n` and its tools:

| Test | Adds | Total |
|---|---|---|
| 1 Automatic Behavior | `observe_page_activity`, `operate_element` | 7 |
| 3 Page Structure | `tab_through_focusables`, `operate_element` | 7 |
| 4 Interactive Elements | `tab_through_focusables`, `probe_focus_effects`, `operate_element`, `change_setting`, `check_accessible_name`, `check_text_contrast` | 11 |
| 5 Static Content | `check_text_contrast`, `check_link_in_text_distinction` | 7 |
| 6 Sensory Characteristics | — | 5 |
| 7 Forms | `check_autocomplete_purpose` | 6 |
| 8 Focus Management | `operate_element` | 6 |
| 9 Text Resize, Reflow, Spacing | `capture_under`, `check_reflow` | 7 |
| 11 Alternatives for Timed Media | — | 5 |
| 12 Tables | `check_table_semantics`, `check_sort_state` | 7 |
| 14 Shortcuts | `probe_single_key_shortcuts`, `operate_element` | 7 |
| 15 Motion and Gestures | `probe_pointer_alternatives`, `observe_page_activity` | 7 |
| 16 Target Size | `check_target_size`, `read_test_results` | 7 |
| 2, 10, 13 held back | — | 1 |

**Test 4 is now bound eleven tools against eighteen branches in two passes**, and
is the one unit that looks too large for the model this design is calibrated
against. Recorded, not acted on: 013 already gives it double the step budget, and
an `exhausted` disposition is the signal that it needs splitting. Worth watching
on the first real run.

**Consequence for 013's compiled-graph cache.** 013 caches one graph per binding
signature and counted six for the thirteen active manual leaves, grouped by
predicate set. Tests 1, 3, 8, 14 and 15 are no longer predicate-free, so the
groups are now `{1} {3} {4} {5} {6, 11} {7} {8} {9} {12} {14} {15} {16}` —
**twelve** compiled manual graphs, one IGT graph, one held-back graph. A cache
count, not a design change.

## Amendment E — from [027](027-graph-amendments-from-the-build.md): the overview that can file, the refusal that names the next action, and the screenshot policy table

### E1. Amendment A1's "the overview" means `overview`, not `overview-igt`.

The overview is **two views**, and only one of them can write. `checkLedger`
accepts both `overview` and `overview-igt` as views that render the ledger, but
only `overview` carries *Add Manual Issue* — and finishing a guided test leaves
the panel on the *Guided Tests* tab, which is `overview-igt`. So a manual unit
that follows an IGT unit inherits a panel that passes the gate and cannot file,
and is `rejected` on its first write. 025 reports exactly that on the first full
run.

Amendment A1's sequence is therefore read as: reload, reset the viewport,
re-assert panel selection, **return the panel to `overview` specifically**, then
confirm the ledger survived. `panelView` still reports where it actually landed,
and a panel that could not be returned still yields `ok: true` — the gate remains
the one authority on whether a view is a loss.

Landing on `overview` from `overview-igt` costs one tab press, and it is the view
the next unit needs whichever path that unit is on.

`fixture/tools.js` was already built this way — 025 found it during the build and
`returnToOverview` presses the tab and confirms the view before returning. This
amendment corrects the spec, which said only "the overview". Observed on every
run: the restore after a *finished* Structure IGT reports
`panelView: 'overview'`, and the manual unit that follows files two issues.

### E2. Every `wrong_screen` refusal names the next action, and there is one constructor.

The `ErrorCode` table above defines `wrong_screen` as *"this tool does not apply
to the screen showing"*. That is true and useless on its own: a small model
reading it has no route back and the unit dies there. 025 records the opposite —
a refusal that names the tool the current screen *does* want is what rescued both
IGT runs that completed. This is `Screen.answerWith`'s design rule applied to the
error path, and it belongs in the contract rather than in prose:

> **`wrong_screen` carries three things: what tool was called, what the panel is
> actually showing, and what to call instead.** Where the showing screen has one
> answering tool, name it. Where it does not, say so and name `igt_current()`.

Made structural rather than habitual: there is exactly one constructor for a
`wrong_screen` envelope, it takes the screen, and it appends the next action
itself — so the refusal cannot be built without one. The IGT rows are derived
from the same table that fills `Screen.answerWith`, so the two cannot drift. The
non-IGT views get the honest instruction instead of a guess:

| Panel is showing | The refusal says |
|---|---|
| `single_choice` / `element_multiselect` / `per_element` / `element_picker` / `results` | `Call <the tool `answerWith` names>.` |
| `overview`, `overview_igt` | `No guided test is running. Call igt_start(category) to begin one.` |
| `igt_entry` | `The category is open but not started. Call igt_start(category).` |
| `save_dialog` | `A dialog is asking for a test name. Call igt_finish(name) to complete it.` |
| anything else | `Call igt_current() to re-read the screen, then call the tool its answerWith names.` |

`save_progress_and_quit`'s refusal (Amendment A3) was the one that did not
comply; it does now. Exercised against a live panel, every shape:

```
igt_start @ single_choice
  igt_start answers a view with no guided test running and the panel is showing
  single_choice. A guided test is already running. Do not start it again.
  Call igt_answer_choice.
```

**One refusal that is not `wrong_screen` follows the same rule**, because the
reason is the same: `add_manual_issue` against a panel where *Add Manual Issue*
is absent or `aria-disabled`. It stays `rejected` — the panel is not on a screen
any tool of the model's answers, and it cannot put itself back, since
`restore_page` is bound to no leaf. So the named action is the true one: call
`check_ledger()` and report the unit blocked with the verdict it returns.

### E3. The IGT screenshot policy table, populated — and it belongs here.

The policy table `Screen.evidence` is populated from shipped **empty**, so every
IGT question fell back to text and logged. A real run against the fixture page
logged seven fall-backs across one Structure walk. Empty is a defensible default
and an indefensible steady state: it means the tool layer silently under-serves
every question Deque wrote that cannot be answered from markup.

**It belongs in the tool layer, not with the skill files.** Two reasons, and the
first is decisive:

1. **There is nowhere else it could be consulted from.** No IGT tool takes a
   `need` parameter — an IGT leaf never asks for evidence, the screen arrives
   carrying it. A skill file could only express this as prose a small model has
   to obey, which is the thing this inventory exists to avoid.
2. One shared `skills/igt/procedure.md` serves all seven categories, so a table
   in front matter would carry every category's questions into every unit's
   context, for a small model to read and not use.

It is also not a rule of ours in the sense CONTEXT's governing constraint
forbids. It says nothing about what a correct finding is; it says which
**modality** a question Deque already wrote can be answered in.

**The line is drawn by Deque's own wording.** A question that turns on how
something *appears* cannot be answered from the DOM — which is precisely why it
is a guided test rather than an axe-core rule, and Deque reports the finding as
*"Content appears like a list but is not marked up as such."* A question the
panel's own text already answers gets text.

| Question id (008) | Evidence | Why |
|---|---|---|
| `mispurposed-headings` | `image` | is this marked-up heading actually a heading, or markup used for visual styling |
| `missing-headings` | `image` | is there text that *looks* like a heading and is not one |
| `list-misuse` | `image` | Deque's own finding is *"appears like a list"* |
| `missing-lists` | `image` | same, in the other direction |
| `missing-langs` | `text` | the tagged passage is the whole evidence |
| `validate-document-title` | `text` | the title string is the whole evidence |

These six are Structure's, the only category anybody has walked. The other six
categories' ids are unknown, still fall back to text, and still log. **Mapping
the known text ones explicitly is what keeps that log a signal** rather than a
constant a reader learns to ignore — an unmapped id now means a genuinely new
Deque question, which is what the log was for.

Three consequences, all found by populating it:

**The capture is `fullPage`, not the viewport.** Every mapped question asks about
the page — *is there content that appears like a list* — and a viewport capture
silently answers it about the top 720px instead. That is the class of quiet wrong
answer every other tool here reads back to avoid.

**The image bytes ride *beside* the envelope, never inside it.** The empty table
had hidden a real bug: the image path put base64 into `evidence[].image.data`
inside the JSON, where it would have reached the model as text it cannot see, and
would have defeated 013's strip-stale-images pass — the one rule keeping a small
model's window survivable across a ten-screen IGT. `Evidence` for an image now
carries `image: { mimeType }` and a caption, and the bytes go in the `images`
side-channel `describe_element` already uses, which `mcp-server.js` emits as MCP
image content. Verified end to end: the block arrives at the leaf as a
`type: "image"` content block, and the JSON envelope is still the first text
block.

**`questionId` was carrying a screen shape on two screen kinds, and that is a
bug.** `per_element` reported `questionId: "per-element"` and
`element_multiselect` reported `"element-multiselect"` — constants of ours in the
slot this inventory defines as *"the `name` on the answer radios: Deque's own
question id"*. Those two screens have no Deque question id: their controls are
named `yes-no-<n>`, `thumbnail-yes-no-<n>` and `selection-<n>` for the panel's own
element index, which 008 measured is not even list order. It identifies an
element, not a question. Both now report `questionId: null`; `kind` already
carries the screen's identity. Left as it was, the policy table would have been
keyable on a screen shape — applying to every per-element screen of every
category, which is the wrong granularity — and the unmapped-id log fired on those
two constants on every single run.

**One obligation this creates.** Answering four of Structure's six questions from
a picture makes the IGT unit a visual one under
[018](018-vision-on-the-dev-model.md), whose rule is that a branch judged from a
screenshot is not done until a production model has run it on the same fixture.
`skills/igt/procedure.md` therefore ships `visualSignoff: pending`, which 013
carries onto every IGT `SubAgentReport` and onto the draft. Nothing routes on it;
it is there so the sign-off is auditable. Note the standing cost this puts on the
development model, which [026](026-local-model-tool-discipline.md) is already
open on: the IGT leaf now receives a full-page screenshot on four of Structure's
screens, and E2B scores 44.2% on MMMU Pro. The window cost is bounded — 013 keeps
only the newest image — but the judgement cost is not, and it is another argument
for 026's *demote the local model* option.

## Amendment F — from [025](025-build-v0.md)'s reopening: `retryable` is a promise, the refusal is the recovery, and `step` was ambiguous

Four corrections to the envelope and the `Screen` shape, all of them found by a
real E2B run that abandoned a healthy guided test two screens from its results.

### F1. `retryable` says whether another call can succeed, and it defaults to `true`.

The `ErrorCode` table above defines each code and says nothing about the flag
beside it, so the implementation defaulted it to `false` and every call site
inherited that. The result was a `wrong_screen` refusal that named
`igt_answer_choice` in its `detail` and declared itself unretryable in the same
envelope. **The model believed the flag.** It wrote an `aborted` report over a
ledger that was intact, and the graph — correctly, by
[013](013-agent-graph.md) — recorded the unit `errored`.

The contract now says what the flag means:

> `retryable: true` means **another call from this leaf can still succeed**, and
> `detail` says which one. `retryable: false` means nothing the leaf can call
> changes the answer, so the honest next move is to establish the ledger verdict
> and report the unit blocked.

**Retryable is the default and terminal is asked for**, so a forgotten argument
produces the safe answer rather than the fatal one. Three refusals in the whole
served set are terminal, and each is terminal for the same reason — the leaf has
no tool that reaches the thing that is wrong:

| Terminal refusal | Why nothing the leaf calls helps |
|---|---|
| `panel_unavailable` — the panel has outlived its extension | `chrome.runtime.id` is `null`; the panel accepts writes and drops them, and only the fixture can rebuild it |
| `not_found` — the saved test is gone | this is the ledger loss the whole loss policy exists for |
| `rejected` — *Add Manual Issue* is absent or `aria-disabled` | the panel is off the saved test and `restore_page` is bound to no leaf |

Everything else is retryable, and the reasoning is the same each time — *is there
a different call that gets past this?* A different selector, a narrower issue
text, a re-read, the tool the screen actually names.

**There is no `page_lost` code and there should not be.**
[017](017-igt-page-state-tolerance.md) measured that navigation which costs the
guided test surfaces as a banner over a live question screen, not as a dead run,
so it reaches the leaf as `Screen.pageStateChanged` — a field on a working screen
rather than a refusal.

### F2. A `wrong_screen` refusal carries the screen, not only its name.

Amendment E2 made the refusal name the next action. That was not enough: it left
the model holding a tool name and no question, one `igt_current()` short of being
able to act — and a small model spends that turn abandoning the unit rather than
re-reading. The refusal now carries the screen itself, in the same shape the
answering tools return:

```
{ ok: false, error: "wrong_screen", retryable: true,
  detail: "Call igt_answer_each. The screen is in `screen` below; read it and
           answer it. The panel is showing per_element, and igt_finish answers a
           results screen.",
  screen: { kind, panelStep, questionId, question, help, answerWith, groups } }
```

Two details are load-bearing. **The instruction leads the `detail` string** —
the first clause is the one a small model acts on and everything after it is
justification. And **the screen is built by the same function that builds the
success path's screen**, so a refusal and an `igt_current()` cannot disagree.

Measured on the run this amendment comes from: three premature `igt_finish` calls
in one Structure walk, three recoveries, and the guided test reached its results
screen. Under E2's refusal the same model had ended the unit at the first one.

### F3. `Screen.step` becomes `Screen.panelStep`.

The field is Deque's stepper label, reported for the transcript, and nothing
routes on it. Under the bare name it collided with the numbered steps of
`skills/igt/procedure.md`, which is the other thing in the leaf's context that
calls something a step — and **both failing runs quit the guided test on the
screen labelled `step: "4"`**, the number of the procedure's own recovery step,
two screens before the results. The prefix says whose numbering it is.

The old spec answered this collision with a sentence in the skill file — *the
step number is not where you are*. Naming the field for its owner retires the
sentence, which is the better fix: a prohibition the model has to remember
against a name that no longer misleads.

### F4. `find_elements` answers an empty match with an empty list.

The `ErrorCode` table defines `not_found` as *the selector matched nothing*, and
for `describe_element` and `add_manual_issue` that is right — those tools were
given an element to act on and it is not there. `find_elements` is a search, and
*this page state has none of those* is its **answer**, not its failure: it is the
verdict a `not-applicable` branch routes on, which the design rule says a tool
computes and the agent reports.

Returned as a refusal it cost twice. It put a tool error on the draft for a page
that was simply media-free, and it handed a small model something to recover from
where there was nothing to recover. An invalid selector is still `not_found` —
that one is a genuine authoring fault.
