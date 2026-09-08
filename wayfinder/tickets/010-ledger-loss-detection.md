---
id: 010
title: Detect ledger loss
labels: [wayfinder:prototype]
state: closed
assignee: brian
blocked-by: [007]
---

## Question

How does a run notice that the ledger is gone?

The extension's saved test is the only record of findings until submission. Page reloads preserve it; closing or refreshing the extension destroys it. A four-hour run that loses the panel and keeps working produces nothing, and the loss is silent.

Find a cheap check that confirms the ledger is intact — issue count, test unit identity, something readable from the panel between sub-agents. Then decide what a run does on detection: abort immediately, or attempt recovery.

Resolve with a check the orchestrator can call between every sub-agent, and a stated failure policy.

## Resolution

**Two reads, four HTTP kilobytes short of nothing, and five distinct verdicts.**
[`fixture/ledger.js`](../../fixture/ledger.js) is the check;
[`prototype/ledger-check.js`](../../prototype/ledger-check.js) breaks a real
ledger five ways and shows each break caught. `make ledger-check` runs it.
Evidence in `build/ledger/ledger-check.json`.

### The check reads two places, and neither alone is enough

[Prototype the panel DOM contract](007-panel-dom-contract.md) offered the panel
half for free: a 0x0 `document.body` or a missing heading means no finding can be
recorded. That half is necessary and, used alone, **wrong in both directions**.

- It **fails healthy runs.** DevTools takes the tab back on its own; 007 and
  [Prototype driving the Structure IGT](008-drive-structure-igt.md) both had to
  re-assert selection mid-run. A 0x0 body is usually a transient, not a loss.
- It **passes dead ones.** Measured below: a panel can render the test name,
  every issue count and a working *Add Manual Issue* form while connected to
  nothing at all.

So the check also reads the server, out of band, with the token the keepalive
already holds. **The saved test is server-side and readable without touching the
panel** — which the ticket did not assume and which is the finding everything
else here rests on:

| Call | What it gives |
|---|---|
| `GET /api/users/{userId}/tests?limit=25` | every saved test, newest first, with `name`, `url`, `created_at` and server-computed counts |
| `GET /api/tests/{testId}` | the test, or `404 {"error":"Test not found"}` |
| `GET /api/tests/{testId}/issues` | every issue, each flagged `is_manual` and `manifest_guide` |
| `GET /api/tests/{testId}/manifests` | the raw per-IGT run record, keyed by guide name |

Authorisation is the extension's own bearer token. `Accept: application/json`
is **not optional**: the SPA shell answers `200 text/html` to any path the API
does not route, so a check that skips the header reads success out of a web
page. `fixture/ledger.js` treats a non-JSON response as a bug in the path, not
as a missing test — the two must not collapse into one verdict.

**`is_manual` does not mean "added by hand".** It is true for everything a
person contributed, which is both paths at once. `manifest_guide` separates
them: `null` for *Add Manual Issue*, `"structure"` for an issue the Structure
IGT produced. Counting them apart matters because a run can lose one path's work
and keep the other's, and a single total hides exactly that.

### The check

```js
const baseline = ledgerBaseline(await readLedger({ serverUrl, accessToken, testId }));
// ... between every sub-agent:
const verdict = await checkLedger({ frame, reselect, serverUrl, accessToken, baseline });
```

Five checks, ordered so the cheapest disqualifier wins:

| Check | Reads |
|---|---|
| panel laid out | the panel document's own `document.body` box, sampled twice with a beat between |
| panel connected to the extension | `chrome.runtime.id` inside the panel document |
| saved test exists | `GET /api/tests/{id}` — 404, or `is_active: false` |
| saved test holds its issues | total, manual and guided counts, each `>=` baseline |
| panel at a checkpoint view, bound to the saved test | the panel's own view and the `Test Name` it renders |

`readPanel` performs **no clicks and no navigation**. A health check that moves
the panel to find out whether the panel is healthy is itself a way to lose the
view a sub-agent was part-way through.

**Cost, measured.** Baseline read 54 KB in 843 ms. A full `checkLedger` runs
1.7-2.8 s, and ~1.5 s of that is the deliberate second sample of the body box.
Two HTTP calls. Against 23 sub-agents in a four-hour run this is free.

### The verdicts, and the failure policy

**Abort. With two named exceptions, and no third.**

The reasoning is that a partially-lost ledger is worse than no ledger. The run
produces a draft that silently under-reports, a human reviews it in 5-30 minutes
believing it is thorough, and the missing findings are never looked for again.
CONTEXT already prices the alternative: re-running the page from the fixture at
$20-50 against a quarterly window is acceptable, and it is the only recovery.
So recovery is permitted only where the findings are provably still on the
server and the panel is provably still able to write to them.

| Verdict | What happened | Action |
|---|---|---|
| `intact` | — | continue |
| `panel-hidden` | body is 0x0, or the frame is gone | re-assert `selectTab` and re-check **once**; then abort |
| `panel-elsewhere` | healthy panel, not on a view that renders the ledger | return it to the overview and re-check; not a loss |
| `panel-detached` | overview open on a **different** test | reopen the run's test from *view saved tests*, re-check **once**; then abort |
| `panel-orphaned` | the panel outlived a refresh of its own extension | **abort.** Not recoverable in place |
| `test-lost` | 404, or `is_active: false` | **abort** |
| `issues-lost` | fewer issues than the run already filed | **abort** |
| `server-unreachable` | non-JSON or non-200 from the API | retry once, then abort |

One bounded attempt each, never a loop. A recovery that needs a second attempt
is a run that has stopped being reproducible, which is the property the fixture
exists to protect.

### Proof: five deliberate breaks, five correct verdicts

`make ledger-check` builds a real ledger — scan, save, one manual issue filed
against `a#vague-link` — then breaks it. All five caught:

| Break | Verdict | Panel said | Server said |
|---|---|---|---|
| `start new scan` pressed | `panel-elsewhere` | live, no ledger view | 19 issues, 1 manual, intact |
| a **different** saved test opened | `panel-detached` | overview, wrong test name | intact |
| the test **deleted** server-side | `test-lost` | live, still naming the deleted test, still showing 19 | `404 Test not found` |
| `chrome.runtime.reload()` | `panel-orphaned` | live, correct name, correct counts | intact |
| DevTools window closed | `panel-hidden` | frame gone | intact |

The third row is the case the ticket was written for, staged deliberately: **a
live, correct-looking panel over a ledger that no longer exists.** The panel half
of the check reports every green light. Only the server half sees it.

Recovery was also proven, not assumed: after the panel walked away, pressing
*view saved tests* and clicking the test's own entry — an `<a>`, not a button —
returned a full `intact` verdict against the same baseline.

### Refreshing the extension does not destroy the saved test — it orphans the panel

**This contradicts CONTEXT.** *The ledger* currently reads "Closing or refreshing
the extension destroys it." Measured, `chrome.runtime.reload()`:

- tore down the service worker (1 -> 0),
- **left the panel document entirely intact** — a `window` property stamped
  before the reload survived it, the frame stayed attached, `document.body` held
  554x693, and the panel still rendered the correct test name and all 19 issues,
- and left the saved test and every filed issue untouched on the server.

What actually broke is the panel's connection to its extension. `chrome.runtime.id`
reads `null` afterwards. And the consequence is the worst available shape:
**the orphaned panel accepts work and drops it.** Driving the whole *Add Manual
Issue* form through it — combobox, catalog entry, Element Selector search,
`Select`, `Save` — raised no error, disabled no button and produced no warning,
and the server-side issue count did not move: 19 before, 19 after.

So the sentence in CONTEXT is right about the outcome and wrong about the
mechanism, and the mechanism is what a check has to key on. Nothing visible in
the panel changes. Geometry, headings, button names, issue counts and form
behaviour are all identical either side of the refresh. **`chrome.runtime.id` is
the only cheap tell**, and without it this check would have returned `intact` for
a panel that could no longer record anything. It is now the second of the five
checks.

The rule *never refresh or close the extension* therefore stands, and for a
sharper reason than "it destroys the ledger": the ledger survives, and the panel
lies about being able to reach it.

### What the orchestrator holds

The panel never shows the test id, and test names are not unique — the same
fixture run twice produces two tests with the same name. `resolveSavedTest`
takes the name and a timestamp from just before the save and returns the newest
match, so the fixture resolves the id **once**, at setup, right after it saves
the test. Everything afterwards is keyed on that id rather than on a name the
panel could be made to re-render.

### Notes for later tickets

- **The ledger has a server-side handle**, which [Settle the tool inventory](011-tool-inventory.md)
  should treat as a first-class fixture output: `{ testId, name, url, baseline counts }`.
  It makes `check_ledger` a tool that needs no panel at all in three of its five checks.
- **`GET /api/tests/{id}/manifests` is the per-IGT run record**, keyed by guide
  name (`structure`), holding each run's captured elements. That is a better
  completion signal for a whole run than the `IGT Completion Progress`
  progressbar 008 suggested, and it is readable without touching the panel.
- **`DELETE /api/tests/{id}` returns 204 and the test is then a hard 404.** Worth
  knowing that nothing in the extension guards it.
- The counts on `GET /api/users/{id}/tests` are `best_practice_count` +
  `violation_count` + `needs_review_count`; summed they match the panel's
  `TOTAL ISSUES` exactly. A cheaper check than fetching every issue, if the
  manual/guided split is ever not needed.
