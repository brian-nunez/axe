---
id: 020
title: Add page-interaction tools to the manual path
labels: [wayfinder:grilling]
state: closed
assignee: brian
blocked-by: []
---

## Question

[Settle the tool inventory and the MCP boundary](011-tool-inventory.md) gave the manual path tools that **read** the page and none that **act** on it. No click, no key press, no viewport change. [Settle the skill file format](012-skill-file-format.md) hit the wall while writing the worked example.

Six of the sixteen page state tests need to act on the page:

| Test | What it must do |
|---|---|
| 1 Automatic Behavior | wait and observe, to see whether content updates on its own |
| 4 Interactive Elements | tab through every focusable element, hover, change a setting, press keys |
| 8 Focus Management | activate a component with the keyboard and observe where focus lands |
| 9 Text Resize, Reflow, Spacing | set zoom, set a 320px viewport, inject the text-spacing stylesheet |
| 12 Tables | sort a table, then read `aria-sort` on the header that moved |
| 14 / 15 Shortcuts, Motion | press candidate shortcut keys, perform a drag |

The concrete casualty already written: `12-tables.md` check 2 gates on *is this table sortable*, records `not-applicable` when it is not, and `blocked` when it is — because it can read `aria-sort` but cannot sort. Reading the attribute as the page arrives would pass every unsorted table, which is a false pass on a real audit.

This is the largest gap between 011's inventory and the checklist, and it is not a small addition. Acting on the page is exactly where a small model does damage, so the tools have to be as checklist-shaped as the read tools are.

Settle:

1. **The tool set.** Names, signatures, return shapes in 011's `Result` envelope. Resist a generic `click(selector)` — that is a primitive, and 011 bound primitives to authoring only for good reason.
2. **What the model is allowed to drive versus what a tool drives on its behalf.** `tab_through_focusables()` returning an ordered record is a verdict tool; `press_key(k)` is a primitive wearing a tool's coat.
3. **Ledger safety.** [Settle what page state changes an in-progress IGT survives](017-igt-page-state-tolerance.md) measured that viewport resize, CSS injection, scroll and DOM mutation disturb nothing, and that same-origin navigation to a different document kills a running IGT. Any tool that could navigate needs to say so in its contract.
4. **State restoration.** Which of these tools leave the page dirty, and whether the tool restores or the parent agent does — [Settle the agent graph](013-agent-graph.md) owns the other half of that answer.

Resolve with the added inventory, and with `12-tables.md` check 2 unblocked as the proof.

## Resolution

**Eight interaction tools and two acting predicates, all bound to manual leaves
only, all shaped so the model names *what* and the tool decides *how*.** The full
signatures, return shapes and per-test bindings are
[011](011-tool-inventory.md)'s Amendment B, with the two predicates under
Amendment D. `12-tables.md` check 12.2 is the proof: it was `blocked`, it is now
a computed check, and the leaf its authoring comment carried is live.

### 1. The tool set

| Tool | Serves |
|---|---|
| `tab_through_focusables(opts?)` | 4 pass-all, and 3's skip link |
| `probe_focus_effects(selector)` | 4 pass-element, including all three 1.4.13 branches |
| `operate_element(selector, with, observeSeconds?)` | 8, 4 dual-role, 3 skip link, 1 pause control |
| `change_setting(selector, to?)` | 4 change of context |
| `observe_page_activity(seconds?)` | 1, and 15's motion listeners |
| `capture_under(condition, opts?)` | 9's three visual branches |
| `probe_single_key_shortcuts(opts?)` | 14 |
| `probe_pointer_alternatives(selector)` | 15 |
| `check_reflow(width?)` — predicate | 9.2 — see [019](019-reflow-scroll-predicate.md) |
| `check_sort_state(selector)` — predicate | 12.2 |

**Thirty-three production tools now**, plus the graph's `finish_unit`. A manual
leaf is still bound the base four plus what its own test names: five to seven
tools, with test 4 the exception at eleven.

### 2. What the model drives, and what a tool drives on its behalf

**The model names *which element* and *which condition*. The tool decides *how* —
which key, which pointer sequence, which width, in what order, with what settle
time — and reports what happened.**

There is no `click(selector)` and no `press_key(k)` in this set, and the
resistance the ticket asked for is worth spelling out, because each of these
tools looks at first like a primitive that has been given a longer name.

- **`tab_through_focusables` is a tool because the sweep is the unit of work.**
  It presses Tab three hundred times, records an ordered stop list, computes the
  divergence between focus order and DOM order, and tries exactly the four exits
  Deque's keyboard-trap branch names before declaring a trap. A model given
  `press_key("Tab")` performs that loop itself, in its own head, and loses count.
- **`operate_element` never takes the key.** It derives it from the element's
  role per the WAI-ARIA Authoring Practices. `with: "both"` runs keyboard, reloads,
  runs pointer, and returns **`parity` computed** — because `dual-role` asks
  whether one input method can do what the other cannot, and a 2B model holding
  two records across two calls to compare them is the state-in-the-head failure
  [012](012-skill-file-format.md) exists to prevent.
- **`capture_under` takes a condition out of a closed vocabulary**, not a width
  and a stylesheet. The alternative is `set_viewport(w, h)` plus
  `inject_css(css)` in the hands of a model that might compose the WCAG 1.4.12
  stylesheet itself.
- **`change_setting` exists rather than a `set_value` primitive** because
  Deque's branch says *changing the setting of a component*, and the tool derives
  what the change is from the control's type. The model names the control.
- **`check_sort_state` is a predicate rather than an activate-then-read pair**,
  because the last step — *does this accessible name indicate a sort direction* —
  is a string judgement a 2B model gets wrong in both directions.

**Where a primitive could not be avoided, said plainly.** Four new ones —
`page_click`, `page_key`, `page_set_viewport`, `page_inject_css` — join the five
this ticket's parent bound to authoring, and are **never bound in production**.
They have to exist: an author cannot discover what a procedure is without them,
which is the whole argument for two bindings off one layer. Every tool above is
one of them with the sequencing, the settle time, the verification and the
restore already decided. The only raw values left in a production signature are
`capture_under`'s `width` and `change_setting`'s optional `to`, and both are
copied out of the skill file rather than invented — the same class as the `limit`
on `find_elements`.

One limit is stated rather than papered over: `observe_page_activity` reports a
flash rate and a **viewport-area fraction**, and does not compute the 25% of a
10-degree visual field the branch asks for, which is a fact about viewing
distance and not about the page. That branch stays judged, with the two numbers
in hand.

### 3. Ledger safety

**None of these is bound to an IGT leaf**, so none can run while a guided test is
in progress — the run is strictly sequential and the IGT phase completes first.
That is a structural guarantee, in the same way 013 keeps `restore_page` out of
every leaf binding rather than instructing leaves not to call it.

Against [017](017-igt-page-state-tolerance.md)'s measurements, nothing here fires
the guard except a navigation. Viewport resize, CSS injection, scroll and DOM
mutation were all tolerated with an IGT actually running, and the saved test
survived all twenty-one perturbations.

Four tools **can** navigate, because activating page code is what they do:
`operate_element`, `change_setting`, `probe_single_key_shortcuts`,
`probe_pointer_alternatives`. Each detects it, returns to the unit's document,
verifies the URL, and reports both facts in `aftermath`. If it cannot get back it
returns the new `page_lost` error code and the unit stops — because after that,
every later check measures a different document and nothing downstream would say
so.

### 4. State restoration — three rules

1. **A tool that changes a global page condition restores it itself**, always,
   including on its error path. `capture_under` and `check_reflow` own the
   viewport, the zoom and the injected stylesheet. Not for the ledger's sake, but
   because a self-restoring tool cannot be defeated by a leaf that runs out of
   steps between setting 320px and putting it back.
2. **A tool that changes DOM, focus or scroll state does not restore it**, and
   says so in `aftermath.pageDirty`. The parent reloads between units anyway.
3. **A tool that navigates always restores the navigation.** The failure it
   prevents is silent.

`restore_page()` stays parent-tier and bound to no leaf, exactly as 013 §4
requires. These three rules are what a unit does for *itself*, between its own
checks — which is the half of the answer 013 did not own.

### The proof: `12-tables.md` check 12.2

Was: gate on *is this table sortable*, `not-applicable` when not, `blocked` when
so, with the finished leaf parked in an authoring comment.

Is: a computed check with a routing table, identical in shape to check 12.3 —
`check_sort_state(selector: "{table}")`, `passes` → `12.2.pass`,
`not_applicable` → `12.2.not-sortable`, `fails` → leaf `sort-state` files
`State: Table sort state is missing or incorrect (4.1.2.a, rgaa-7.1.1)`. The
authoring comment is now the ordinary `<!-- from: -->` audit trail.

One ordering constraint fell out of it and is written into the file: the tool
leaves the table sorted, so the *first row is really a caption* check must run
first. The file already ran them in that order; now it says why.

### What this changes elsewhere

- **013's compiled-graph cache.** Tests 1, 3, 8, 14 and 15 are no longer
  predicate-free, so the thirteen active manual leaves group into **twelve**
  distinct bindings rather than six. A cache count, not a design change.
- **`reference/page-state-tests.json`.** Check 12.2 is now `computable: true`,
  and it is computable *only* because the manual path can sort. Recorded in the
  file's own note.
- **012 gains one format rule.** A step that follows a tool reporting
  `aftermath.refsInvalidated` re-runs its `find_elements`, written out as an
  instruction rather than left for the model to remember. Where a tool restores
  its own condition, the file says nothing at all — telling a 2B model to restore
  a viewport it cannot verify is worse than silence.
- **Test 4 is now bound eleven tools against eighteen branches in two passes**,
  and is the one unit that looks too large for the model this design is
  calibrated against. Not split here: 013 already gives it double the step
  budget, and an `exhausted` disposition is the designed signal that it needs it.

### Not resolved here

**Nothing in the inventory fills or submits a form.** CONTEXT's *Scope* names
"form fill and submit" as in scope; no page state test branch needs it, no ticket
has specified it, and `change_setting` is the closest thing this set contains.
Left alone deliberately rather than guessed at — it wants its own ticket, or a
correction to that scope line.
