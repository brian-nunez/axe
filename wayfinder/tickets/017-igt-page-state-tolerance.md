---
id: 017
title: Settle what page state changes an in-progress IGT survives
labels: [wayfinder:prototype]
state: closed
assignee: brian
blocked-by: [008]
---

## Question

What can a sub-agent do to the page without losing the test it is running?

CONTEXT says page reloads preserve the ledger and sub-agents may reload freely to reset page state. [Prototype driving the Structure IGT](008-drive-structure-igt.md) found the weaker fact next to it: navigating the tab to a different URL mid-test replaces the panel with *"The state of your page has changed"* and offers only `Save progress & quit` or `Restart test`. The in-progress test is gone either way.

That matters because the run shape has parent agents restoring page state between sub-agents — test #9 sets the viewport to 320px, test #8 mutates state — and because IGT steps themselves say *"do not scroll or interact with the page while we capture screenshots"*.

Find the boundary. Reload of the same URL, in-page navigation, viewport change, scrolling, DOM mutation by script, a form submitted and returned: which of these trip the guard, which are silently tolerated, and does the answer differ between an in-progress IGT and a saved test sitting in the ledger?

Resolve with a table of what survives what, and a rule the parent agents can follow when handing the page from one sub-agent to the next.

## Resolution

**The boundary is not where the URL is. It is whether the elements the running
test recorded are still findable.** Same-origin navigation kills a Structure IGT
and cross-origin navigation does not, when the second page happens to carry the
same headings. Measured with [`prototype/page-state-probe.js`](../../prototype/page-state-probe.js)
over twenty-one perturbations across two runs against one saved test each, then
confirmed against the extension's own source; per-trial record in
`build/page-state/page-state.json` and `build/page-state-2/page-state.json`.

### What survives what

Each trial takes a Structure IGT two screens in, does one thing to the page,
then walks the rest of the test to the results screen — because surviving the
moment of the change proves nothing if the guard fires later.

| Done to the page | In-progress IGT | Saved test |
|---|---|---|
| `window.scrollTo(0, 600)` | survives, runs to results | intact |
| script adds nodes to the DOM | survives, runs to results | intact |
| **WCAG 1.4.12 text-spacing CSS injected** | survives, runs to results | intact |
| **viewport resized to 320×800** | survives, runs to results | intact |
| `location.hash = '#findings'` | survives, runs to results | intact |
| `history.pushState` to the same path with a query | survives, runs to results | intact |
| `history.pushState` to a different path | survives, runs to results | intact |
| `location.reload()`, same URL | survives, runs to results | intact |
| form submitted, then `history.back()` | survives, runs to results | intact |
| navigate: **same origin**, different path, **same headings** | survives, runs to results | intact |
| navigate: **different origin**, identical document | survives, runs to results | intact |
| navigate: **same origin**, different path, **different headings** | **guard fires** | intact |
| navigate: **different origin**, **different headings** | **guard fires** | intact |
| navigate away (guard fires), then straight back | **survives** — banner clears, runs to results | intact |
| navigate to `about:blank` | no guard at all | intact |
| navigate to a port nothing is listening on | no guard at all | intact |
| script **deletes every heading**, no navigation | survives, **runs to results** | intact |
| script deletes every heading, **then a hash change** | **guard fires** | intact |

**The saved test survived every single trial.** Nothing on this list touches it.
Across the thirteen IGT runs of the first matrix the ledger grew monotonically
from 19 issues to 96 (1 manual, 77 guided, 18 automatic), its `url` never
changed, and every stored IGT manifest recorded `testUrl` as the URL the test
*started* on rather than wherever the tab had wandered.

So the answer the ticket asked for, in two parts:

> **An in-progress IGT survives anything that leaves the elements it recorded
> where it found them, and is warned about their loss only if a navigation
> happens afterwards. The saved test is not at risk from any of it.**

The second clause is the uncomfortable half. The warning is a *detector bolted
to navigation*, not a protection: a test whose elements have gone can carry on
to a full set of results with nothing said, and did, in the heading-removal
trial below.

### The mechanism, from the extension's own source

The empirical table is confusing until you read what actually raises the
warning. It is three hops, and none of them compare URLs.

**1. The trigger is a tab navigation, in `background.bundle.js`:**

```js
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const { status } = changeInfo;
  status === 'complete' && send(devtools, 'page:navigation', changeInfo, { tabId });
});
```

That is the *only* thing that starts a check. It covers full document loads and,
measured here, same-document navigation too — a bare `location.hash` assignment
reaches it. What it does not cover is everything that is not a navigation at all:
a viewport resize, an injected stylesheet, a scroll, a DOM mutation. **For those,
no check is ever run.**

The two heading-removal trials isolate this cleanly. Deleting every `h1`-`h4`
from the page — every vital the Structure IGT has — raised nothing, and the test
walked to its results screen answering questions about elements that no longer
existed. Deleting them and *then* changing the hash raised the warning
immediately. Same page, same damage; the difference is only whether a navigation
happened to follow.

**2. On that event the panel asks whether its *vitals* are still there:**

```js
send(content, 'guide:check-vitals', { vitals: resolveVitals(guide.config.vitals, manifest) });
```

**3. The content script rebuilds its virtual tree from the manifest**, collects
the nodes that no longer exist, intersects them with the vitals, and tries to
re-find each survivor by `fallbackSelector` and then by a fuzzy `findOne`. Only
if one cannot be found at all does it send `guide:discarded`, which is what
renders the banner.

The same `page:navigation` event also runs `handleNavigation`, which sets
`discarded: null`. **Every navigation clears the previous warning before the new
check runs** — which is exactly why navigating away and back restores the test
rather than compounding the damage.

### Each IGT has its own sensitivity, and one has none

`vitals` is declared per guide, in the panel bundle:

| IGT | Vitals it will notice the loss of |
|---|---|
| Structure | `headings` |
| Images | `images` |
| Interactive Elements | `interactives` |
| Forms | `forms`, `inputs`, `groups` |
| Table | `tables`, `table`, `data-cells` |
| Keyboard | `focused-element`, `missing`, `select-missing`, `skipped`, `tabStops` |
| **Modal Dialog** | **`[]` — none** |

So the guard is **not a uniform safety net**. Modal Dialog declares no vitals and
can therefore never raise the warning, whatever the tab does. Keyboard, with five
vital keys including the focused element, is the most fragile. A rule written
from watching the Structure IGT does not transfer.

Two further blind spots, both measured:

- **`about:blank` produced no warning, and neither did a connection-refused
  error page** — the extension's content script does not run on either, so the
  check has nothing to answer it. The quietest failures are exactly the ones
  where the extension cannot see the page at all.
- **Removing a vital element by script raises nothing** until some navigation
  happens to follow. The guard is a detector attached to navigation, not a watch
  on the DOM — so it can stay silent long after a test has become invalid.

### The warning is advisory. It does not stop anything.

This is the correction that matters most for the agent design.

[Prototype driving the Structure IGT](008-drive-structure-igt.md) recorded that
the warning "replaced the panel body" and that "the only two buttons offered were
`Save progress & quit` and `Restart test`." **Both halves are wrong.** In the
source it is an `Alert` of type `action-needed` rendered as a *sibling* of the
question, and the buttons visible and enabled when it fired here were:

```
Save progress & quit, Restart test, Close, Options,
Mouse Selection, View element selector, Back, Next
```

The question screen is entirely intact underneath. Pressing `Next` with the
warning showing **advanced the test to the next screen**, and the banner stayed
up. An agent that does not look for it will sail straight past it and keep
answering questions about elements that are no longer on the page.

That makes detection a sub-agent's own responsibility on the IGT path.
[`fixture/ledger.js`](../../fixture/ledger.js) exposes it from the read it
already does — `readPanel(frame).pageStateChanged`, and `view` resolving to
`page-state-warning` — so the check costs nothing extra.

### Also worth knowing: `Save progress & quit` is not on the question screens

It is not a button on any IGT question, picker or grid. Those carry only
`Close`, `Options`, `View element selector`, `Back` and `Next`. The quit control
lives **inside the `Options` menu**, whose only item during a run is
`Save progress & quit`. It appears as a top-level button only on the warning
banner itself. Any tool that leaves a test part-way has to open that menu.

### The rule for parent agents

1. **Between sub-agents, nothing is at risk.** The run shape finishes and saves
   each IGT before the next sub-agent starts, so no test is in progress when the
   page is restored. Restore freely; then call `checkLedger` from
   [Detect ledger loss](010-ledger-loss-detection.md).
2. **Page state test #9 is safe as specified.** Both of its page changes — the
   320px viewport and the text-spacing stylesheet — were tolerated with an IGT
   *actually running*, and neither can trip the guard because neither is a
   navigation. **Still restore the viewport before the next sub-agent**, because the
   scan and every IGT capture element boxes at the current width; that is a
   correctness duty, not a ledger one.
3. **Inside an IGT, do not change the page at all, and do not navigate.**
   Reloading the same URL is safe in practice, and it is safe for the wrong
   reason — the vitals happen to re-resolve. Treat it as forbidden rather than
   as a licence: nothing about it is guaranteed, and the same reload against a
   page that renders differently on a second visit would take the test with it.
   Note that the two rules are separate. Not navigating keeps the test valid;
   not changing the page is what keeps it *correct*, because a change with no
   navigation after it is never checked.
4. **If a navigation happens anyway, put the page back and navigate to it.**
   The warning is cleared by the next navigation and the test resumes on the
   same question. This is a real recovery, proven end to end: navigate away,
   navigate back, walk the test to its results screen. It is cheaper than every
   alternative and it should be tried before `Restart test`.
5. **Check `pageStateChanged` after every step that could have moved the page**,
   and before trusting any answer given after one. The panel will not refuse the
   answer, and on a change with no navigation after it there is nothing to
   check — which is the argument for rule 3 being absolute rather than
   risk-weighted.

### What this changes in CONTEXT

*The ledger* currently reads: "Navigating the tab to a different URL loses an
in-progress IGT. The panel replaces itself with a page-state warning offering
only *Save progress & quit* or *Restart test*. Where the boundary sits between a
tolerated reload and a fatal navigation is still open."

Four corrections:

- **The URL is not the criterion.** A different URL with the same elements is
  tolerated; the same origin with different elements is not.
- **The panel does not replace itself**, and those are not the only two buttons.
  It is a banner over a fully live question screen.
- **The in-progress test is not gone.** Restoring the page and navigating to it
  clears the warning, and the test carries on from the same question.
- **The boundary is no longer open**: a tab navigation of any kind, plus at
  least one of the running guide's declared vitals that cannot be re-found. And
  the guard detects rather than protects — lose the vitals without navigating
  and it never fires at all.

And the sentence "Sub-agents reload freely to reset page state" is true as
measured but rests on a coincidence rather than a guarantee. Better stated as:
*sub-agents may change the page freely between tests, and must change nothing
during one.*

### Notes for later tickets

- [Settle the agent graph](013-agent-graph.md) is not constrained by this. The
  sequential shape already guarantees no test is in progress when a parent
  restores page state, and the saved test survived every perturbation measured.
  What the graph does need is the viewport restoration in rule 2, for
  measurement correctness rather than for the ledger.
- [Settle the tool inventory](011-tool-inventory.md) should carry
  `page_state_warning()` as a first-class read on the IGT path, and should make
  `save_progress_and_quit()` go through the `Options` menu.
- The Modal Dialog IGT's empty `vitals` means it has **no** page-change
  protection at all. Whichever skill file drives it carries the whole burden.
- The results screen displays `location.href` at completion, not the URL the
  test started on — so a test finished after a tolerated navigation *reads* as
  belonging to the new page. The stored record is correct: every manifest
  written to `/api/tests/{id}/manifests` recorded `testUrl` as the starting URL,
  and the saved test's own `url` never moved. Display-only, but misleading in a
  screenshot.
