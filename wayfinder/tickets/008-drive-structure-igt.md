---
id: 008
title: Prototype driving the Structure IGT
labels: [wayfinder:prototype]
state: closed
assignee: brian
blocked-by: [007]
---

## Question

What does stepping an IGT to completion actually take?

Structure is the v0 target. Walk it end to end by hand through the automation layer, and find out: how the agent knows which step it is on, how it advances, how it answers, how it recognises completion, and what happens when a step needs an element selected on the page.

Resolve with a run that completes the Structure IGT and a written account of the loop an agent would follow — the shape the skill files are written against.

## Corrected later

[Settle what page state changes an in-progress IGT survives](017-igt-page-state-tolerance.md) measured two claims below and found them wrong:

- **The page-state warning is a banner, not a panel replacement.** It renders as a sibling of a fully live question screen — `Back`, `Next` and `View element selector` stay enabled, `Next` advances with the banner up, and navigating away and back clears it. It is not terminal.
- **`Save progress & quit` is not a button on question screens.** It lives in the `Options` menu.

Also established there: the guard is navigation-triggered, not URL-based, and the Modal Dialog IGT declares no `vitals` at all, so it can never raise the warning.

## Resolution

**Driven end to end, unattended.** [`prototype/igt-structure.js`](../../prototype/igt-structure.js)
walks the Structure IGT from the home view to a saved test and produces a real
finding; `make igt` runs it. The exploration tool that got there is
[`prototype/igt-console.js`](../../prototype/igt-console.js) — one browser held
open, commands on a FIFO, because the saved test is the only record of findings
and re-launching per question would destroy it.

Three runs completed and saved against a page carrying headings, lists, and a
`lang="fr"` passage. The last one, fully unattended, walked ten screens in about
a minute and left the ledger reading *Structure — Runs: 1, Total issues: 1,
Completed, 100%*. Screen-by-screen record in `build/igt/transcript.json`.

### The loop

```
enter the IGT  →  untick automated IGT  →  Start
repeat:
    read the screen
    classify it
    look the question up in the answer sheet
    act
    advance
until the screen is the results screen
Finish  →  name the test  →  Save
```

Nine questions, one element pick, one issue, on that page.

### How the agent knows where it is

**Not from the step number.** The stepper renders seven buttons carrying
`aria-current="step"` on the active one, and it is a coarse phase indicator, not
a cursor:

- **One number spans several screens.** Step 1 asked three separate questions.
- **Numbers are skipped.** The run went 1 → 2 → 3 → 4 → **7**. Steps 5 and 6 have
  no applicable content on that page, so they never render. An agent that waits
  for step 7 by counting to seven waits forever.

**The screen identifies itself instead**, through stable ids that survive across
every view:

| Hook | What it carries |
|---|---|
| `#question-text` | the question, as an `h2` |
| `#question-help` | the elaboration under it |
| `name` on the answer radios | **the machine-readable question id** |

That `name` attribute is the find. It reads `mispurposed-headings`,
`missing-headings`, `list-misuse`, `missing-lists`, `missing-langs`,
`validate-document-title` — Deque's own identifier for the question, not its
prose. **Key the skill files on it.** Question wording is a content contract that
moves when Deque rewrites the copy; these ids are the same thing said in a form
that does not.

### The five screen shapes

Every screen is one of these, and each is distinguishable without touching a
hashed class name:

| Shape | Tell | How it is answered |
|---|---|---|
| **Single choice** | `#yes-igt-radio` / `#no-igt-radio` | click one; `name` gives the question id |
| **Per-element grid** | radio groups named `yes-no-<n>` or `thumbnail-yes-no-<n>` | one yes/no per element, ids `true-<n>` / `false-<n>` |
| **Element multi-select** | `[role=checkbox]` with ids `selection-<n>` | click the ones that apply |
| **Element picker** | the text `Fields selected: <n>` | click the element on the *page* — see below |
| **Results** | a visible `Finish` button | `Finish`, then the save dialog |

The `<n>` in every id is the panel's own element index, and it is **not** list
order — a five-item screen came back as `selection-5, selection-1, selection-2,
selection-4, selection-13`. Match on the item's text, never on id order.

Screens narrow as answers accumulate: marking one heading as mispurposed
dropped it from the "does each heading describe its content" grid that followed.

### Advancing, and the trap in it

`Next` throughout, `Finish` on results, `Back` enabled from the second screen on.

**Every question arrives pre-answered, and the default is usually "Yes".** An
agent that clicks `Next` without setting the answer records "yes, there are
problems" on every screen. Always set the answer explicitly.

**`Next` must be clicked on the element, not through the pointer.** A Playwright
`.click()` on the button is swallowed by the panel's own tooltip layer — no
error, no navigation, and the run loops on the same screen until it gives up.
Dispatching the click on the element works. That was the one genuinely silent
failure in this ticket, and it cost two full runs to find.

Filtering still matters as [Prototype the panel DOM contract](007-panel-dom-contract.md)
found: the panel keeps hidden, disabled copies of `Next`, `Save` and others, and
an unfiltered first match picks one of those.

### When a step needs an element selected on the page

Two different things wear that description, and only one of them is the picker.

**Choosing from what the panel already found** is the multi-select: the panel
lists the candidates *inside the panel*, as `[role=checkbox]` items with their
tag and text. No page interaction at all.

**Adding something the panel missed** opens the picker, and there the panel takes
its answer from a click on the inspected page:

1. Arm `[role=switch][aria-label="Mouse Selection"]` — it defaults to on.
2. Click `Remove all selections` first. The picker keeps per-element state and
   silently ignores a re-click of something it has just dropped; clearing makes
   the sequence reproducible. This cost a debugging cycle.
3. Click the element on the target page. A CSS selector still drives this —
   Playwright resolves the selector and clicks what it finds, so nothing depends
   on coordinates.
4. Verify against `Fields selected: <n>` and the read-back of the chosen element
   printed beneath the counter. **The picker rejects elements it does not
   consider valid candidates, without saying so** — clicking a `<p>` on a
   "select the lists we missed" screen registered, clicking an already-marked
   `<ul>` registered, and a stale click registered nothing. The counter is the
   only confirmation.

**The Element Selector drawer is not the way in.** It looks like it should be —
it renders `role=tree` / `role=treeitem` over the page DOM, each item carrying a
clean `aria-label` like `p class="fake-list"`, with `Select` / `Remove` buttons
and a **CSS selector search box** in its toolbar. All of it works except the part
that matters: reading the tree item's own React handlers shows `onClick`
navigates and `Space` calls the select action, but `Space` never registered, and
`Select` stayed `disabled` through tree clicks, keyboard navigation and a
selector search that correctly reported *1 of 1*. The drawer is for inspection.

Two things about it are still worth having: the tree is **collapsed to 0×0 by
default** — `View element selector` opens it, and acting on it while collapsed
fails the way everything else does when the panel lacks layout — and its
`aria-label`s and `Accessible name: … Calculated role: … TagName: …` descriptions
are a clean read of what the panel thinks each element is.

This qualifies CONTEXT's design rule *Select elements from the DOM tree picker*
for IGT picker screens. The rule was written for Add Manual Issue, which is a
different form; [Prototype adding a manual issue](009-add-manual-issue.md) should
confirm the tree there rather than inherit this.

### Completion

The results screen replaces `Next` with `Finish` and carries the heading
`Structure test results`, an issue count, the account that ran it, elapsed time,
the URL, and each issue in Deque's own words — here *"Content appears like a list
but is not marked up as such."*, produced by the one element the picker took.

`Finish` opens a **`Save your results` dialog with a required test name**. The
input's id is randomly generated per render (`x_8_7561`), so locate it by its
label or as the dialog's only input — never by id. Saving returns the panel to
the home view, where the ledger reads `Structure — Runs: 1, Total issues: 1,
Completed`, alongside a `progressbar` labelled `IGT Completion Progress` at 14%
(one IGT of seven). That progressbar is the natural completion check for a whole
run.

### Two more facts the fixture needs

**Automated IGT arrives ticked.** `#enableAiAssist` on the entry screen is
checked by default, and it spends AI credits on a capability CONTEXT records as
outside this licence. **Untick it before `Start`, every time.** It disappears
once the test begins, so there is no second chance. Raised as an observation in
[Prototype the panel DOM contract](007-panel-dom-contract.md); it is now a hard
requirement on whatever enters an IGT.

**Navigating the page mid-test trips a guard.** Pointing the tab at a different
URL replaced the panel body with *"The state of your page has changed. Please put
it in the state you started testing."* and the only two buttons offered were
`Save progress & quit` and `Restart test`. `Restart test` re-scanned the new page
and dropped straight back into step 1 with no entry screen. CONTEXT says
sub-agents may reload freely to reset page state; that holds for reloading the
same URL, but **navigating away costs the in-progress test**. Worth confirming
per-IGT before sub-agents rely on it.

**And the lifecycle trap from 007 recurs mid-run**, not just at startup: the
panel lost its layout during a page navigation and had to be re-selected. Re-assert
selection before acting, not once at the beginning.

### One caveat on the target page

`https://www.w3.org/WAI/demos/bad/before/home.html`, the obvious demo target, sits
behind a Cloudflare interstitial under this browser and never resolves — the IGT
audits *"Just a moment…"*. The runs here used a locally served page instead. Any
page with headings, lists and a `lang`-tagged passage exercises every step.
